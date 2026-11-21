/**
 * Fail-closed JobPosting lifecycle & route guards for MagangHub Kemnaker (Next.js App Router).
 *
 * State machine:
 *   ACTIVE -> EXPIRED_GRACE (0..90 days, HTTP 200 without JobPosting + noindex,follow + role="status" banner)
 *          -> ARCHIVED_GONE (>=90 days or explicit ARCHIVED, HTTP 410 Gone + X-Robots-Tag: noindex,follow)
 */

export type VacancyStatus = "OPEN" | "CLOSED" | "FILLED" | "ARCHIVED" | "DRAFT" | "INTERNAL";

export const NON_PUBLIC_VACANCY_STATUSES: ReadonlySet<string> = new Set([
  "DRAFT",
  "INTERNAL",
]);

/**
 * Symmetric public-visibility guard (STRIDE-I-02).
 * Must be enforced identically in React.cache() loaders, generateMetadata(),
 * LowonganDetailPage(), sitemap.ts, and /ai/jobs.ndjson so DRAFT/INTERNAL
 * vacancies never leak metadata or content into public surfaces.
 */
export function isPublicVacancyStatus(status: string | null | undefined): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.trim().toUpperCase();
  if (!normalized || NON_PUBLIC_VACANCY_STATUSES.has(normalized)) {
    return false;
  }
  return true;
}

export type JobLifecycleState = "ACTIVE" | "EXPIRED_GRACE" | "ARCHIVED_GONE";

export interface VacancyLifecycleInput {
  status: VacancyStatus | (string & {});
  /** ISO-8601 timestamp with explicit timezone offset, e.g. "2026-12-01T23:59:59+07:00" */
  deadlineAt?: string | null;
  /** Optional explicit closure timestamp (when closed early before deadlineAt) */
  closedAt?: string | null;
  /** Optional explicit permanent-archive timestamp */
  archivedAt?: string | null;
}

export interface LifecycleEvaluation {
  state: JobLifecycleState;
  expired: boolean;
  archived: boolean;
  reason:
    | "active"
    | "invalid_or_missing_deadline"
    | "status_not_open"
    | "deadline_passed"
    | "status_archived"
    | "grace_window_elapsed";
  deadlineMs: number | null;
  daysSinceClosed: number | null;
}

export const DEFAULT_GRACE_PERIOD_DAYS = 90;
const MS_PER_DAY = 86_400_000;

/**
 * Strict ISO-8601 datetime with explicit timezone offset (`Z` or `+/-HH:MM`).
 * Rejects bare dates ("2026-12-01"), loose V8 Date.parse strings, invalid hour/minute,
 * and calendar rollovers such as 2026-02-30 or 2026-02-29 (non-leap year).
 */
const STRICT_ISO_TZ_RE =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,6}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function parseIsoDateWithTz(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = STRICT_ISO_TZ_RE.exec(trimmed);
  if (!match) return null;

  const expectedYear = Number(match[1]);
  const expectedMonth = Number(match[2]);
  const expectedDay = Number(match[3]);

  // Reject years below 1000 (prevents JS Date.UTC 0..99 -> 1900..1999 mapping)
  if (expectedYear < 1000) return null;

  // Verify calendar validity without rollover (rejects Feb 30, Feb 29 on non-leap years, Apr 31)
  const probe = new Date(Date.UTC(expectedYear, expectedMonth - 1, expectedDay));
  if (
    probe.getUTCFullYear() !== expectedYear ||
    probe.getUTCMonth() + 1 !== expectedMonth ||
    probe.getUTCDate() !== expectedDay
  ) {
    return null;
  }

  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;

  return ms;
}

/**
 * Fail-closed lifecycle evaluator for Google for Jobs compliance.
 */
export function evaluateJobLifecycle(
  job: VacancyLifecycleInput,
  options: { nowMs?: number; gracePeriodDays?: number } = {},
): LifecycleEvaluation {
  const nowMs =
    typeof options.nowMs === "number" && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const graceDays =
    typeof options.gracePeriodDays === "number" &&
    Number.isFinite(options.gracePeriodDays) &&
    options.gracePeriodDays >= 0
      ? options.gracePeriodDays
      : DEFAULT_GRACE_PERIOD_DAYS;

  const status = typeof job?.status === "string" ? job.status.trim().toUpperCase() : "";
  const deadlineMs = parseIsoDateWithTz(job?.deadlineAt);
  const closedMs = parseIsoDateWithTz(job?.closedAt);
  const archivedMs = parseIsoDateWithTz(job?.archivedAt);

  if (status === "ARCHIVED" || (archivedMs !== null && nowMs >= archivedMs)) {
    const refMs = closedMs ?? deadlineMs;
    return {
      state: "ARCHIVED_GONE",
      expired: true,
      archived: true,
      reason: "status_archived",
      deadlineMs,
      daysSinceClosed: refMs !== null ? Math.max(0, (nowMs - refMs) / MS_PER_DAY) : null,
    };
  }

  // Fail-closed: corrupt/missing deadline MUST NOT stay active and risk manual action spam
  if (deadlineMs === null) {
    return {
      state: "EXPIRED_GRACE",
      expired: true,
      archived: false,
      reason: "invalid_or_missing_deadline",
      deadlineMs: null,
      daysSinceClosed: null,
    };
  }

  const isStatusOpen = status === "OPEN";
  const isDeadlinePassed = nowMs >= deadlineMs;

  if (isStatusOpen && !isDeadlinePassed) {
    return {
      state: "ACTIVE",
      expired: false,
      archived: false,
      reason: "active",
      deadlineMs,
      daysSinceClosed: null,
    };
  }

  // Determine effective closure timestamp (earlier of explicit closedAt or deadlineAt)
  let effectiveCloseMs = deadlineMs;
  if (closedMs !== null && (!isStatusOpen || closedMs < deadlineMs)) {
    effectiveCloseMs = closedMs;
  } else if (!isStatusOpen && !isDeadlinePassed) {
    // Closed early without explicit closedAt: stay in grace window (0 days elapsed)
    effectiveCloseMs = nowMs;
  }

  const daysSinceClosed = Math.max(0, (nowMs - effectiveCloseMs) / MS_PER_DAY);
  if (daysSinceClosed >= graceDays) {
    return {
      state: "ARCHIVED_GONE",
      expired: true,
      archived: true,
      reason: "grace_window_elapsed",
      deadlineMs,
      daysSinceClosed,
    };
  }

  return {
    state: "EXPIRED_GRACE",
    expired: true,
    archived: false,
    reason: isStatusOpen ? "deadline_passed" : "status_not_open",
    deadlineMs,
    daysSinceClosed,
  };
}

export function isJobExpired(
  job: VacancyLifecycleInput,
  nowMs: number = Date.now(),
): boolean {
  return evaluateJobLifecycle(job, { nowMs }).expired;
}

/**
 * Prevents Next.js ISR / Full Route Cache from serving stale JobPosting JSON-LD
 * past deadlineAt. Always pair with on-demand revalidateTag("job-<slug>") on status updates.
 */
export function computeSafeRevalidateSeconds(
  job: VacancyLifecycleInput,
  options: {
    nowMs?: number;
    maxActiveTtlSec?: number;
    expiredTtlSec?: number;
    minTtlSec?: number;
  } = {},
): number {
  const nowMs =
    typeof options.nowMs === "number" && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const maxActiveTtlSec = options.maxActiveTtlSec ?? 3600;
  const expiredTtlSec = options.expiredTtlSec ?? 86_400;
  const minTtlSec = options.minTtlSec ?? 60;

  const evalResult = evaluateJobLifecycle(job, { nowMs });
  if (evalResult.expired || evalResult.deadlineMs === null) {
    return expiredTtlSec;
  }

  const remainingSec = Math.floor((evalResult.deadlineMs - nowMs) / 1000);
  if (remainingSec <= minTtlSec) {
    return minTtlSec;
  }
  return Math.min(maxActiveTtlSec, remainingSec);
}

/**
 * Reserved hub sub-routes under /lowongan/ and /magang-nasional/lowongan/
 * that MUST NOT be intercepted as individual vacancy slugs in middleware.ts.
 */
export const RESERVED_HUB_SEGMENTS = new Set([
  "kota",
  "bidang",
  "perusahaan",
  "provinsi",
  "batch",
  "kategori",
  "search",
  "feed",
  "page",
  "filter",
  "sektor",
]);

export const STRICT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/;
const JOB_DETAIL_PREFIXES = ["/magang-nasional/lowongan/", "/lowongan/"] as const;

export function isValidVacancySlug(slug: string | null | undefined): boolean {
  if (typeof slug !== "string") return false;
  if (slug.length === 0 || slug.length > 160) return false;
  if (!STRICT_SLUG_RE.test(slug)) return false;
  if (RESERVED_HUB_SEGMENTS.has(slug)) return false;
  return true;
}

/**
 * Extracts a single-segment vacancy slug from either:
 *  - /magang-nasional/lowongan/<slug> (actual live MagangHub route tree)
 *  - /lowongan/<slug> (generic Next.js blueprint route)
 *
 * STRIDE-E-02 defense: Enforces strict `[a-z0-9-]+` allowlist after safe
 * decodeURIComponent, blocking path traversal (`../dashboard`, `%2e%2e`),
 * hub collisions (`/kota/*`, `/bidang/*`, `/perusahaan/*`), malformed UTF-8,
 * and oversized ReDoS inputs in linear O(N) time.
 */
export function extractJobDetailSlug(pathname: string): string | null {
  if (typeof pathname !== "string") return null;
  // Linear O(N) scan with hard length cap before decoding (anti-ReDoS STRIDE-D-01)
  const qIdx = pathname.indexOf("?");
  const hIdx = pathname.indexOf("#");
  let endIdx = pathname.length;
  if (qIdx !== -1 && qIdx < endIdx) endIdx = qIdx;
  if (hIdx !== -1 && hIdx < endIdx) endIdx = hIdx;
  while (endIdx > 0 && pathname.charCodeAt(endIdx - 1) === 47 /* '/' */) {
    endIdx -= 1;
  }
  const clean = endIdx === pathname.length ? pathname : pathname.slice(0, endIdx);

  for (let i = 0; i < JOB_DETAIL_PREFIXES.length; i += 1) {
    const prefix = JOB_DETAIL_PREFIXES[i]!;
    if (!clean.startsWith(prefix)) continue;
    const remainder = clean.slice(prefix.length);
    if (
      !remainder ||
      remainder.length > 480 ||
      remainder.includes("/") ||
      remainder.includes("\\")
    ) {
      return null;
    }

    let decoded = remainder;
    if (remainder.includes("%")) {
      try {
        decoded = decodeURIComponent(remainder);
      } catch {
        return null;
      }
    }

    if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) {
      return null;
    }
    if (!isValidVacancySlug(decoded)) return null;
    return decoded;
  }

  return null;
}

/**
 * Normalizes a URL pathname for reliable sitemap vs expired-path matching
 * (handles origin stripping, query/fragment removal, trailing slashes, and percent-encoding).
 */
export function normalizePathname(rawPath: string): string {
  let pathname = String(rawPath ?? "").trim();
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return "/";
    }
  }
  pathname = pathname.split(/[?#]/, 1)[0] ?? "/";
  if (!pathname.startsWith("/")) {
    pathname = `/${pathname}`;
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep raw pathname if percent-encoding is malformed
  }
  pathname = pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1) {
    pathname = pathname.replace(/\/+$/, "");
  }
  return pathname;
}
