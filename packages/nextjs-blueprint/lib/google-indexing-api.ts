/**
 * Zero-dependency Google Indexing API client for JobPosting (URL_UPDATED / URL_DELETED).
 *
 * Uses only Node.js built-in `node:crypto` (ZERO runtime npm dependencies):
 * - RS256 JWT service-account OAuth2 token exchange
 * - Daily quota guard (default 200 requests/day per Google project quota)
 * - TTL-based idempotency cache (prevents duplicate webhook retries from burning quota)
 * - Exponential backoff retry on HTTP 429 / 5xx and transient network errors
 * - Strict HTTPS canonical URL validation + safe dryRun mode
 */

import { createHash, createSign } from "node:crypto";

export type IndexingNotificationType = "URL_UPDATED" | "URL_DELETED";

export interface IndexingAuditLogEntry {
  timestamp: string;
  event: "google_indexing_notification";
  action: IndexingNotificationType;
  url: string;
  ok: boolean;
  status: number;
  dryRun: boolean;
  attempts: number;
  requestSha256: string;
  skippedReason?: "idempotency_cache" | "daily_quota_limit";
  error?: string;
}

/**
 * STRIDE-R-01 & STRIDE-I-01: Scrubs OAuth tokens, Bearer headers, and PEM key fragments
 * from structured audit logs and error strings.
 */
export function redactSensitiveText(input: string, secrets: readonly string[] = []): string {
  let out = String(input ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  out = out
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
  return out;
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface IndexingNotificationResult {
  url: string;
  type: IndexingNotificationType;
  ok: boolean;
  status: number;
  dryRun: boolean;
  attempts: number;
  skippedReason?: "idempotency_cache";
  body?: unknown;
  error?: string;
}

export interface IndexingIdempotencyStore {
  hasFresh(key: string, nowMs: number): boolean;
  markSent(key: string, nowMs: number, ttlMs: number): void;
  prune?(nowMs: number): void;
}

export class InMemoryIdempotencyCache implements IndexingIdempotencyStore {
  private readonly entries = new Map<string, number>();

  hasFresh(key: string, nowMs: number = Date.now()): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (nowMs >= expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  markSent(key: string, nowMs: number = Date.now(), ttlMs: number = 600_000): void {
    this.entries.set(key, nowMs + Math.max(0, ttlMs));
  }

  prune(nowMs: number = Date.now()): void {
    for (const [k, exp] of this.entries.entries()) {
      if (nowMs >= exp) this.entries.delete(k);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export const INDEXING_ENDPOINT =
  "https://indexing.googleapis.com/v3/urlNotifications:publish";
export const INDEXING_SCOPE = "https://www.googleapis.com/auth/indexing";
export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
export const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 minutes

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function buildServiceAccountJwt(
  sa: GoogleServiceAccount,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const clientEmail = sa.client_email?.trim() ?? "";
  if (!clientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    throw new Error("Service account client_email must be a valid email identity");
  }
  if (!sa.private_key?.trim()) {
    throw new Error("Service account private_key is required");
  }
  const audience = (sa.token_uri ?? DEFAULT_TOKEN_URI).trim();
  let parsedAud: URL;
  try {
    parsedAud = new URL(audience);
  } catch {
    throw new Error("Invalid OAuth2 token_uri audience");
  }
  if (parsedAud.protocol !== "https:") {
    throw new Error("OAuth2 token_uri audience must use HTTPS");
  }
  if (!Number.isFinite(nowSec) || nowSec <= 0) {
    throw new Error("JWT iat timestamp must be a positive finite integer");
  }

  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: clientEmail,
      scope: INDEXING_SCOPE,
      aud: parsedAud.toString(),
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );

  const unsigned = `${header}.${claimSet}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = base64UrlEncode(signer.sign(sa.private_key));
  return `${unsigned}.${signature}`;
}

export function validateIndexingUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL for Google Indexing API: "${rawUrl}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Google Indexing API requires HTTPS canonical URL, got: "${rawUrl}"`);
  }
  if (parsed.hostname.toLowerCase().endsWith(".vercel.app")) {
    throw new Error(
      `Refusing to submit ephemeral preview URL to Google Indexing API: "${rawUrl}"`,
    );
  }
  return parsed.toString();
}

export async function fetchGoogleAccessToken(
  sa: GoogleServiceAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const assertion = buildServiceAccountJwt(sa);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetchImpl(sa.token_uri ?? DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google OAuth2 token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Google OAuth2 response missing access_token");
  }
  return json.access_token;
}

export function buildIdempotencyKey(type: IndexingNotificationType, url: string): string {
  return `${type}:${url}`;
}

export interface NotifyBatchOptions {
  serviceAccount?: GoogleServiceAccount;
  accessToken?: string;
  dailyQuotaLimit?: number;
  alreadyUsedToday?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxRetryDelayMs?: number;
  dryRun?: boolean;
  idempotencyStore?: IndexingIdempotencyStore;
  idempotencyTtlMs?: number;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** STRIDE-R-01: Optional structured JSON audit sink (never receives accessToken or private_key). */
  onAuditLog?: (entry: IndexingAuditLogEntry) => void;
}

export interface NotifyBatchResult {
  sent: IndexingNotificationResult[];
  skippedIdempotent: string[];
  skippedQuota: string[];
  retryDelaysMs: number[];
  auditLogs: IndexingAuditLogEntry[];
}

export async function notifyGoogleIndexingBatch(
  urls: string[],
  type: IndexingNotificationType,
  options: NotifyBatchOptions = {},
): Promise<NotifyBatchResult> {
  const dailyQuotaLimit = options.dailyQuotaLimit ?? 200;
  const alreadyUsedToday = options.alreadyUsedToday ?? 0;
  const maxRetries = Math.max(1, options.maxRetries ?? 3);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 500);
  const maxRetryDelayMs = Math.max(baseDelayMs, options.maxRetryDelayMs ?? 15_000);
  const dryRun = options.dryRun ?? false;
  const idempotencyStore = options.idempotencyStore;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const nowMs = options.nowMs ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl =
    options.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const auditLogs: IndexingAuditLogEntry[] = [];
  const emitAudit = (entry: IndexingAuditLogEntry): void => {
    auditLogs.push(entry);
    options.onAuditLog?.(entry);
  };

  const uniqueUrls = [...new Set(urls.map(validateIndexingUrl))];
  const skippedIdempotent: string[] = [];
  const candidateUrls: string[] = [];

  for (const url of uniqueUrls) {
    const key = buildIdempotencyKey(type, url);
    if (idempotencyStore && idempotencyStore.hasFresh(key, nowMs)) {
      skippedIdempotent.push(url);
      emitAudit({
        timestamp: new Date(nowMs).toISOString(),
        event: "google_indexing_notification",
        action: type,
        url,
        ok: true,
        status: 304,
        dryRun,
        attempts: 0,
        requestSha256: sha256Hex(JSON.stringify({ url, type })),
        skippedReason: "idempotency_cache",
      });
      continue;
    }
    candidateUrls.push(url);
  }

  const remainingQuota = Math.max(0, dailyQuotaLimit - alreadyUsedToday);
  const allowedUrls = candidateUrls.slice(0, remainingQuota);
  const skippedQuota = candidateUrls.slice(remainingQuota);

  for (const url of skippedQuota) {
    emitAudit({
      timestamp: new Date(nowMs).toISOString(),
      event: "google_indexing_notification",
      action: type,
      url,
      ok: false,
      status: 429,
      dryRun,
      attempts: 0,
      requestSha256: sha256Hex(JSON.stringify({ url, type })),
      skippedReason: "daily_quota_limit",
    });
  }

  let token = options.accessToken ?? "";
  if (!dryRun && allowedUrls.length > 0 && !token) {
    if (!options.serviceAccount) {
      throw new Error(
        "Either accessToken or serviceAccount is required when dryRun is false.",
      );
    }
    token = await fetchGoogleAccessToken(options.serviceAccount, fetchImpl);
  }

  const secretsToScrub = [token, options.serviceAccount?.private_key ?? ""].filter(Boolean);
  const sent: IndexingNotificationResult[] = [];
  const retryDelaysMs: number[] = [];

  for (const url of allowedUrls) {
    const idemKey = buildIdempotencyKey(type, url);
    const requestPayload = JSON.stringify({ url, type });
    const requestSha256 = sha256Hex(requestPayload);

    if (dryRun) {
      idempotencyStore?.markSent(idemKey, nowMs, idempotencyTtlMs);
      sent.push({
        url,
        type,
        ok: true,
        status: 200,
        dryRun: true,
        attempts: 0,
        body: { url, type, simulated: true },
      });
      emitAudit({
        timestamp: new Date(nowMs).toISOString(),
        event: "google_indexing_notification",
        action: type,
        url,
        ok: true,
        status: 200,
        dryRun: true,
        attempts: 0,
        requestSha256,
      });
      continue;
    }

    let lastStatus = 0;
    let lastError = "";
    let successBody: unknown;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attempts = attempt;
      let retryAfterMs: number | null = null;

      try {
        const res = await fetchImpl(INDEXING_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: requestPayload,
          signal: AbortSignal.timeout(10_000),
        });
        lastStatus = res.status;

        if (res.ok) {
          successBody = await res.json().catch(() => ({}));
          lastError = "";
          break;
        }

        const retryAfterHeader = res.headers?.get("retry-after");
        if (retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim())) {
          retryAfterMs = Math.min(maxRetryDelayMs, Number(retryAfterHeader.trim()) * 1000);
        }

        lastError = redactSensitiveText(
          await res.text().catch(() => `HTTP ${res.status}`),
          secretsToScrub,
        );
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === maxRetries) break;
      } catch (err) {
        lastError = redactSensitiveText(
          err instanceof Error ? err.message : String(err),
          secretsToScrub,
        );
        if (attempt === maxRetries) break;
      }

      const expDelay = Math.min(maxRetryDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const waitMs = retryAfterMs !== null ? Math.max(expDelay, retryAfterMs) : expDelay;
      retryDelaysMs.push(waitMs);
      await sleepImpl(waitMs);
    }

    const ok = lastStatus >= 200 && lastStatus < 300;
    if (ok) {
      idempotencyStore?.markSent(idemKey, nowMs, idempotencyTtlMs);
    }

    sent.push({
      url,
      type,
      ok,
      status: lastStatus,
      dryRun: false,
      attempts,
      ...(successBody !== undefined ? { body: successBody } : {}),
      ...(lastError ? { error: lastError } : {}),
    });

    emitAudit({
      timestamp: new Date(nowMs).toISOString(),
      event: "google_indexing_notification",
      action: type,
      url,
      ok,
      status: lastStatus,
      dryRun: false,
      attempts,
      requestSha256,
      ...(lastError ? { error: lastError.slice(0, 200) } : {}),
    });
  }

  return { sent, skippedIdempotent, skippedQuota, retryDelaysMs, auditLogs };
}
