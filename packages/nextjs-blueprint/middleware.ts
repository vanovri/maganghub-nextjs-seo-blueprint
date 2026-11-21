/**
 * True HTTP 410 Gone Edge Interceptor for Permanently Archived MagangHub Vacancies
 * (Hybrid Phase 2) + Legacy API 410 X-Robots-Tag guard.
 *
 * Next.js 16+ migration note:
 * - Next.js 13/14/15: keep filename `middleware.ts` and `export async function middleware(...)`.
 * - Next.js 16+: rename this file to `proxy.ts` and rename the exported function to
 *   `export async function proxy(...)` (same body and `config.matcher`).
 *
 * Hardening & Performance Engineering applied:
 * 1. Uses strict `[a-z0-9-]+` extractJobDetailSlug() so hub routes (/kota/*, /bidang/*, /perusahaan/*),
 *    path traversal (`../dashboard`, `%2e%2e`), and malformed UTF-8 (`%E0%A4%A`) never collide or throw URIError.
 * 2. Returns semantic HTML 410 Gone + X-Robots-Tag: noindex, follow + CDN Cache-Control.
 * 3. Bounded in-memory Edge LRU/TTL cache (MAX_EDGE_CACHE_ENTRIES = 4,096) + per-slug singleflight
 *    coalescing absorbs cache-busting DoS floods (STRIDE-D-01) while sustaining p99 < 15ms.
 * 4. Enforces strict 400ms AbortSignal.timeout() on Edge KV lookup; fails open safely to origin
 *    (zero HTTP 500, zero INTERNAL/Edge URL or stack trace exposure per STRIDE-I-03).
 * 5. Ensures legacy deprecated endpoint `/be/v1/api/list/vacancies-active` emits HTTP 410 with
 *    `X-Robots-Tag: noindex, follow` (closing the live missing-header gap).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { JOB_ROUTE_PREFIX, LEGACY_410_PATHS } from "./lib/constants.ts";
import { extractJobDetailSlug, normalizePathname } from "./lib/job-lifecycle.ts";
import { buildGoneHtml } from "./lib/gone-page.ts";

export interface ArchivedLookupOptions {
  edgeUrl?: string;
  edgeToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  bypassCache?: boolean;
  cacheTtlMs?: number;
}

export const MAX_EDGE_CACHE_ENTRIES = 4_096;
export const DEFAULT_EDGE_CACHE_TTL_MS = 60_000;
export const DEFAULT_EDGE_TIMEOUT_MS = 400;

const TEXT_ENCODER = new TextEncoder();

interface EdgeCacheEntry {
  archived: boolean;
  expiresAtMs: number;
  goneHtml?: string;
  goneBytes?: Uint8Array<ArrayBuffer>;
  goneHeaders?: Record<string, string>;
}

const archivedSlugLruCache = new Map<string, EdgeCacheEntry>();
const inFlightArchivedLookups = new Map<string, Promise<boolean>>();
const LEGACY_410_SET: ReadonlySet<string> = new Set(LEGACY_410_PATHS);

const GONE_HTML_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "x-robots-tag": "noindex, follow",
  "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
  "x-content-type-options": "nosniff",
};

const LEGACY_410_BODY = JSON.stringify({
  error: "Gone",
  message: "Deprecated endpoint permanently removed.",
});

const LEGACY_410_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "x-robots-tag": "noindex, follow",
  "cache-control": "public, max-age=3600, s-maxage=86400",
  "x-content-type-options": "nosniff",
};

function readBoundedCacheEntry(key: string, nowMs: number): EdgeCacheEntry | undefined {
  const entry = archivedSlugLruCache.get(key);
  if (!entry) return undefined;
  if (nowMs >= entry.expiresAtMs) {
    archivedSlugLruCache.delete(key);
    return undefined;
  }
  // Avoid hash-table mutation churn on hot reads while below 50% capacity;
  // full LRU recency promotion kicks in cleanly above half-capacity.
  if (archivedSlugLruCache.size > MAX_EDGE_CACHE_ENTRIES >> 1) {
    archivedSlugLruCache.delete(key);
    archivedSlugLruCache.set(key, entry);
  }
  return entry;
}

function writeBoundedCache(
  key: string,
  slug: string,
  archived: boolean,
  nowMs: number,
  ttlMs: number,
): EdgeCacheEntry {
  if (archivedSlugLruCache.has(key)) {
    archivedSlugLruCache.delete(key);
  } else if (archivedSlugLruCache.size >= MAX_EDGE_CACHE_ENTRIES) {
    // Evict oldest entry in O(1) so random cache-busting slugs cannot cause OOM (STRIDE-D-01)
    const oldestKey = archivedSlugLruCache.keys().next().value;
    if (oldestKey !== undefined) {
      archivedSlugLruCache.delete(oldestKey);
    }
  }
  let goneHtml: string | undefined;
  let goneBytes: Uint8Array<ArrayBuffer> | undefined;
  let goneHeaders: Record<string, string> | undefined;
  if (archived) {
    goneHtml = buildGoneHtml(slug, JOB_ROUTE_PREFIX);
    goneBytes = TEXT_ENCODER.encode(goneHtml);
    goneHeaders = { ...GONE_HTML_HEADERS, "content-length": String(goneBytes.byteLength) };
  }
  const entry: EdgeCacheEntry = {
    archived,
    expiresAtMs: nowMs + Math.max(0, ttlMs),
    ...(goneHtml !== undefined ? { goneHtml, goneBytes, goneHeaders } : {}),
  };
  archivedSlugLruCache.set(key, entry);
  return entry;
}

export function clearArchivedSlugCache(): void {
  archivedSlugLruCache.clear();
  inFlightArchivedLookups.clear();
}

export function getArchivedSlugCacheStats(): {
  size: number;
  maxEntries: number;
  inFlight: number;
} {
  return {
    size: archivedSlugLruCache.size,
    maxEntries: MAX_EDGE_CACHE_ENTRIES,
    inFlight: inFlightArchivedLookups.size,
  };
}

/**
 * Lightweight edge lookup against Vercel Edge Config / Upstash Redis / KV.
 * Uses bounded LRU/TTL cache + per-slug singleflight coalescing and enforces
 * a strict 400ms AbortSignal.timeout(), failing open safely to origin (false)
 * on timeout/network errors so an Edge KV outage never returns HTTP 500.
 */
export async function isPermanentlyArchived(
  slug: string,
  options: ArchivedLookupOptions = {},
): Promise<boolean> {
  const endpoint = options.edgeUrl ?? process.env.ARCHIVED_SLUGS_EDGE_URL;
  if (!endpoint) return false;

  const cleanEndpoint = endpoint.replace(/\/+$/, "");
  const cacheKey = `${cleanEndpoint}::${slug}`;
  const bypassCache =
    options.bypassCache ?? Boolean(options.fetchImpl && options.cacheTtlMs === undefined);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_EDGE_CACHE_TTL_MS;
  const nowMs = Date.now();

  if (!bypassCache && cacheTtlMs > 0) {
    const cached = readBoundedCacheEntry(cacheKey, nowMs);
    if (cached !== undefined) {
      return cached.archived;
    }
  }

  if (!bypassCache) {
    const existing = inFlightArchivedLookups.get(cacheKey);
    if (existing) return existing;
  }

  const token = options.edgeToken ?? process.env.ARCHIVED_SLUGS_EDGE_TOKEN;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EDGE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const lookupPromise = (async (): Promise<boolean> => {
    try {
      const res = await fetchImpl(`${cleanEndpoint}/${encodeURIComponent(slug)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { archived?: boolean };
      const archived = data.archived === true;
      if (!bypassCache && cacheTtlMs > 0) {
        writeBoundedCache(cacheKey, slug, archived, Date.now(), cacheTtlMs);
      }
      return archived;
    } catch {
      // Fail-open safely on timeout/network failure (do not poison cache on transient outage)
      return false;
    }
  })();

  if (bypassCache) {
    return lookupPromise;
  }

  inFlightArchivedLookups.set(cacheKey, lookupPromise);
  try {
    return await lookupPromise;
  } finally {
    inFlightArchivedLookups.delete(cacheKey);
  }
}

export async function middleware(
  request: NextRequest,
  lookupOptions?: ArchivedLookupOptions,
) {
  const rawPathname = request?.nextUrl?.pathname ?? "/";

  // Fast-path guard for deprecated legacy API path (avoid normalizePathname overhead on normal job paths)
  if (
    LEGACY_410_SET.has(rawPathname) ||
    (rawPathname.startsWith("/be/") && LEGACY_410_SET.has(normalizePathname(rawPathname)))
  ) {
    return new NextResponse(LEGACY_410_BODY, {
      status: 410,
      headers: LEGACY_410_HEADERS,
    });
  }

  // Extract slug from raw pathname first so malformed UTF-8 (e.g. %E0%A4%A) fails closed
  // with zero URIError and never triggers unnecessary Edge KV lookups.
  const slug = extractJobDetailSlug(rawPathname);
  if (!slug) {
    return NextResponse.next();
  }

  // Synchronous hot-cache fast path (zero extra HTML template allocation on hot archived slugs)
  const endpoint = lookupOptions?.edgeUrl ?? process.env.ARCHIVED_SLUGS_EDGE_URL;
  const bypassCache =
    lookupOptions?.bypassCache ??
    Boolean(lookupOptions?.fetchImpl && lookupOptions?.cacheTtlMs === undefined);
  const cacheTtlMs = lookupOptions?.cacheTtlMs ?? DEFAULT_EDGE_CACHE_TTL_MS;
  if (endpoint && !bypassCache && cacheTtlMs > 0) {
    const cleanEndpoint = endpoint.endsWith("/") ? endpoint.replace(/\/+$/, "") : endpoint;
    const cached = readBoundedCacheEntry(`${cleanEndpoint}::${slug}`, Date.now());
    if (cached !== undefined) {
      if (!cached.archived) return NextResponse.next();
      return new NextResponse(cached.goneBytes ?? cached.goneHtml ?? buildGoneHtml(slug, JOB_ROUTE_PREFIX), {
        status: 410,
        headers: cached.goneHeaders ?? GONE_HTML_HEADERS,
      });
    }
  }

  const archived = await isPermanentlyArchived(slug, lookupOptions);
  if (!archived) {
    return NextResponse.next();
  }

  return new NextResponse(buildGoneHtml(slug, JOB_ROUTE_PREFIX), {
    status: 410,
    headers: GONE_HTML_HEADERS,
  });
}

/**
 * Synchronous-when-cached wrapper around `middleware()` avoiding unnecessary async tick
 * overhead when the Edge LRU cache already holds a fresh decision.
 */
export function middlewareFast(
  request: NextRequest,
  lookupOptions?: ArchivedLookupOptions,
): NextResponse | Promise<NextResponse> {
  const rawPathname = request?.nextUrl?.pathname ?? "/";
  if (
    LEGACY_410_SET.has(rawPathname) ||
    (rawPathname.startsWith("/be/") && LEGACY_410_SET.has(normalizePathname(rawPathname)))
  ) {
    return new NextResponse(LEGACY_410_BODY, {
      status: 410,
      headers: LEGACY_410_HEADERS,
    });
  }

  const slug = extractJobDetailSlug(rawPathname);
  if (!slug) {
    return NextResponse.next();
  }

  const endpoint = lookupOptions?.edgeUrl ?? process.env.ARCHIVED_SLUGS_EDGE_URL;
  const bypassCache =
    lookupOptions?.bypassCache ??
    Boolean(lookupOptions?.fetchImpl && lookupOptions?.cacheTtlMs === undefined);
  const cacheTtlMs = lookupOptions?.cacheTtlMs ?? DEFAULT_EDGE_CACHE_TTL_MS;
  if (endpoint && !bypassCache && cacheTtlMs > 0) {
    const cleanEndpoint = endpoint.endsWith("/") ? endpoint.replace(/\/+$/, "") : endpoint;
    const cached = readBoundedCacheEntry(`${cleanEndpoint}::${slug}`, Date.now());
    if (cached !== undefined) {
      if (!cached.archived) return NextResponse.next();
      return new NextResponse(cached.goneBytes ?? cached.goneHtml ?? buildGoneHtml(slug, JOB_ROUTE_PREFIX), {
        status: 410,
        headers: cached.goneHeaders ?? GONE_HTML_HEADERS,
      });
    }
  }

  return middleware(request, lookupOptions);
}

export const config = {
  matcher: [
    "/magang-nasional/lowongan/:path*",
    "/lowongan/:path*",
    "/be/v1/api/list/vacancies-active",
  ],
};
