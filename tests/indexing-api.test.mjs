import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const {
  InMemoryIdempotencyCache,
  buildServiceAccountJwt,
  fetchGoogleAccessToken,
  notifyGoogleIndexingBatch,
  validateIndexingUrl,
} = await import("../packages/nextjs-blueprint/lib/google-indexing-api.ts");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function base64UrlToBuffer(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

describe("Google Indexing API Client (Zero-Dep RS256 JWT, Quota, Idempotency & Retry)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const serviceAccount = {
    client_email: "seo-indexing-bot@maganghub-prod.iam.gserviceaccount.com",
    private_key: privateKey,
  };

  it("has ZERO third-party runtime imports (only node:crypto)", () => {
    const src = readFileSync(
      resolve(ROOT, "packages/nextjs-blueprint/lib/google-indexing-api.ts"),
      "utf8",
    );
    const imports = [...src.matchAll(/^\s*import\s+[\s\S]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    assert.deepEqual(imports, ["node:crypto"]);
  });

  it("generates an RS256 JWT whose signature verifies cryptographically against the RSA-2048 public key", () => {
    const nowSec = 1795176000;
    const jwt = buildServiceAccountJwt(serviceAccount, nowSec);
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);

    const header = JSON.parse(base64UrlToBuffer(parts[0]).toString("utf8"));
    const payload = JSON.parse(base64UrlToBuffer(parts[1]).toString("utf8"));
    assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
    assert.equal(payload.iss, serviceAccount.client_email);
    assert.equal(payload.scope, "https://www.googleapis.com/auth/indexing");
    assert.equal(payload.iat, nowSec);
    assert.equal(payload.exp, nowSec + 3600);

    const unsigned = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const signature = base64UrlToBuffer(parts[2]);

    const verified = verify("RSA-SHA256", unsigned, publicKey, signature);
    assert.equal(verified, true, "RS256 JWT signature must verify cleanly");

    // Tampered payload MUST fail verification
    const tampered = Buffer.from(`${parts[0]}.${parts[1]}x`, "utf8");
    assert.equal(verify("RSA-SHA256", tampered, publicKey, signature), false);
  });

  it("exchanges RS256 assertion for OAuth2 access token via fetchGoogleAccessToken", async () => {
    let capturedBody = "";
    const token = await fetchGoogleAccessToken(serviceAccount, async (_url, init) => {
      capturedBody = String(init?.body || "");
      return new Response(JSON.stringify({ access_token: "ya29.mock-token-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    assert.equal(token, "ya29.mock-token-123");
    assert.match(capturedBody, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
    assert.match(capturedBody, /assertion=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });

  it("validates HTTPS canonical URLs and blocks HTTP or *.vercel.app preview URLs", () => {
    assert.equal(
      validateIndexingUrl("https://maganghub.kemnaker.go.id/magang-nasional/lowongan/intern-1"),
      "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/intern-1",
    );
    assert.throws(() => validateIndexingUrl("http://maganghub.kemnaker.go.id/magang-nasional/lowongan/intern-1"));
    assert.throws(() => validateIndexingUrl("https://preview-abc.vercel.app/magang-nasional/lowongan/intern-1"));
    assert.throws(() => validateIndexingUrl("not a url"));
  });

  it("enforces daily quota limit and deduplicates input URLs", async () => {
    const urls = [
      "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/job-1",
      "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/job-1", // duplicate
      "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/job-2",
      "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/job-3",
      "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/job-4",
    ];
    const result = await notifyGoogleIndexingBatch(urls, "URL_DELETED", {
      dailyQuotaLimit: 200,
      alreadyUsedToday: 198,
      dryRun: true,
    });
    assert.equal(result.sent.length, 2);
    assert.equal(result.skippedQuota.length, 2);
    assert.equal(result.sent[0].type, "URL_DELETED");
  });

  it("suppresses duplicate notifications within idempotency TTL and allows resend after expiry", async () => {
    const cache = new InMemoryIdempotencyCache();
    let apiCalls = 0;
    const mockFetch = async () => {
      apiCalls += 1;
      return new Response(JSON.stringify({ urlNotificationMetadata: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const target = ["https://maganghub.kemnaker.go.id/magang-nasional/lowongan/job-idem"];
    const t0 = 1_795_176_000_000;

    const first = await notifyGoogleIndexingBatch(target, "URL_UPDATED", {
      accessToken: "token",
      idempotencyStore: cache,
      idempotencyTtlMs: 60_000,
      nowMs: t0,
      fetchImpl: mockFetch,
    });
    assert.equal(first.sent.length, 1);
    assert.equal(first.skippedIdempotent.length, 0);
    assert.equal(apiCalls, 1);

    // Within 60s TTL -> skipped without calling API or spending quota
    const second = await notifyGoogleIndexingBatch(target, "URL_UPDATED", {
      accessToken: "token",
      idempotencyStore: cache,
      idempotencyTtlMs: 60_000,
      nowMs: t0 + 30_000,
      fetchImpl: mockFetch,
    });
    assert.equal(second.sent.length, 0);
    assert.equal(second.skippedIdempotent.length, 1);
    assert.equal(apiCalls, 1);

    // Different action type (URL_DELETED) is NOT suppressed by URL_UPDATED key
    const deleted = await notifyGoogleIndexingBatch(target, "URL_DELETED", {
      accessToken: "token",
      idempotencyStore: cache,
      idempotencyTtlMs: 60_000,
      nowMs: t0 + 35_000,
      fetchImpl: mockFetch,
    });
    assert.equal(deleted.sent.length, 1);
    assert.equal(apiCalls, 2);

    // After TTL expiration -> allowed again
    const afterTtl = await notifyGoogleIndexingBatch(target, "URL_UPDATED", {
      accessToken: "token",
      idempotencyStore: cache,
      idempotencyTtlMs: 60_000,
      nowMs: t0 + 61_000,
      fetchImpl: mockFetch,
    });
    assert.equal(afterTtl.sent.length, 1);
    assert.equal(apiCalls, 3);
  });

  it("retries HTTP 429 and 503 with exponential backoff and stops immediately on HTTP 400", async () => {
    const statuses = [429, 503, 200];
    let idx = 0;
    const sleeps = [];

    const result = await notifyGoogleIndexingBatch(
      ["https://maganghub.kemnaker.go.id/magang-nasional/lowongan/job-retry"],
      "URL_UPDATED",
      {
        accessToken: "token",
        maxRetries: 4,
        baseDelayMs: 100,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
        fetchImpl: async () => {
          const st = statuses[idx++] ?? 200;
          return new Response(JSON.stringify({ status: st }), {
            status: st,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );

    assert.equal(result.sent[0].ok, true);
    assert.equal(result.sent[0].attempts, 3);
    assert.deepEqual(sleeps, [100, 200]);
    assert.deepEqual(result.retryDelaysMs, [100, 200]);

    // Non-retryable 400 fails fast on attempt 1
    let badCalls = 0;
    const badRes = await notifyGoogleIndexingBatch(
      ["https://maganghub.kemnaker.go.id/magang-nasional/lowongan/job-bad"],
      "URL_UPDATED",
      {
        accessToken: "token",
        maxRetries: 3,
        baseDelayMs: 50,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          badCalls += 1;
          return new Response("Bad Request", { status: 400 });
        },
      },
    );
    assert.equal(badRes.sent[0].ok, false);
    assert.equal(badRes.sent[0].attempts, 1);
    assert.equal(badCalls, 1);
  });
});
