#!/usr/bin/env node
/**
 * MagangHub Kemnaker - Zero-Dependency 8-Gate Technical SEO, Google for Jobs,
 * Expired Job Lifecycle & GEO AI Feeds CI Validator.
 *
 * Requires Node.js >= 24 LTS (zero runtime npm dependencies).
 *
 * 8 Gates:
 *   G1-HOME-SSR                Homepage SSR & Core Meta
 *   G2-INDEXING                Indexing Safety & Preview Noindex Trap Awareness
 *   G3-ROBOTS                  robots.txt Crawlability & Sitemap Directive
 *   G4-SITEMAP                 sitemap.xml & <sitemapindex> Validation
 *   G5-CANONICAL-ROOT-GUARD    Inner-Route Self-Canonical Guard (Blocker #0 & vercel.app leak)
 *   G6-JOBPOSTING-ACTIVE       Active Job Detail SSR & Google for Jobs JobPosting JSON-LD
 *   G7-EXPIRED-JOB-LIFECYCLE   Expired Job Guard (410 / strip-schema / soft-404 / Preview trap)
 *   G8-LLMS-TXT-AND-AI-FEEDS   GEO llms.txt & Structured AI Feeds (/ai/jobs.ndjson, /ai/faq.json)
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * STRIDE-I-01: Masks VERCEL_AUTOMATION_BYPASS_SECRET and Bearer/token values
 * across stderr logs, JSON reports, and GitHub Step Summary outputs.
 */
export function redactSecrets(input, secrets = []) {
  let out = String(input ?? "");
  const envSecrets = [
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    process.env.GH_TOKEN,
    process.env.GITHUB_TOKEN,
    ...secrets,
  ].filter((s) => typeof s === "string" && s.length >= 6);

  for (const secret of envSecrets) {
    out = out.split(secret).join("[REDACTED]");
  }
  out = out
    .replace(/(x-vercel-protection-bypass\s*[:=]\s*)([^\s,;'"`]+)/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]");
  return out;
}

function redactDeep(value, secrets = []) {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, secrets);
    }
    return out;
  }
  return value;
}

const DEFAULT_CANONICAL_ORIGIN = "https://maganghub.kemnaker.go.id";
const DEFAULT_USER_AGENT = "MagangHub-SEO-CI-Gate/3.0 (+https://maganghub.kemnaker.go.id)";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const MAX_SITEMAP_URLS = 50_000;
const SITEMAP_SLOW_MS = 3_000;

const VALID_EMPLOYMENT_TYPES = new Set([
  "FULL_TIME",
  "PART_TIME",
  "CONTRACTOR",
  "TEMPORARY",
  "INTERN",
  "VOLUNTEER",
  "PER_DIEM",
  "OTHER",
]);

const VALID_SALARY_UNITS = new Set(["HOUR", "DAY", "WEEK", "MONTH", "YEAR"]);

const PLACEHOLDER_PATTERNS = [
  /\[Tanggal\s+Mulai\]/i,
  /\[Tanggal\s+Selesai\]/i,
  /\[DIISI_TIM_KEMNAKER\]/i,
  /\[TODO[^\]]*\]/i,
  /\[TBD[^\]]*\]/i,
  /\{\{\s*[A-Z0-9_]+\s*\}\}/,
  /<INSERT_[^>]+>/i,
];

const LEGACY_404_PATHS = new Set([
  "/lowongan",
  "/perusahaan",
  "/jadwal",
  "/sertifikasi",
  "/api/lowongan/active",
]);

const HUB_SEGMENTS = new Set([
  "kota",
  "bidang",
  "perusahaan",
  "kategori",
  "provinsi",
  "batch",
  "sektor",
  "page",
  "filter",
  "search",
  "feed",
]);

const STRICT_ISO_TZ_RE =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,6}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const ISO_DATE_OR_DATETIME_RE =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,6}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/;

// ---------------------------------------------------------------------------
// Date & Path Helpers
// ---------------------------------------------------------------------------

function isValidCalendarDate(year, month, day) {
  if (year < 1000) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() + 1 === month &&
    probe.getUTCDate() === day
  );
}

export function isStrictIsoDateWithTz(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const m = STRICT_ISO_TZ_RE.exec(trimmed);
  if (!m) return false;
  if (!isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  return Number.isFinite(Date.parse(trimmed));
}

export function isValidIsoDate(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const m = ISO_DATE_OR_DATETIME_RE.exec(trimmed);
  if (!m) return false;
  if (!isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  return Number.isFinite(Date.parse(trimmed));
}

export function normalizePathname(raw) {
  let pathname = String(raw || "").trim();
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return "/";
    }
  }
  pathname = pathname.split(/[?#]/, 1)[0] || "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep raw pathname if percent-encoding is malformed
  }
  pathname = pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  return pathname;
}

// ---------------------------------------------------------------------------
// SSRF & Host Security Guards (Blocks RFC1918, Loopback, Metadata, IPv6 & IP Encoding Bypasses)
// ---------------------------------------------------------------------------

function parseIpv4Part(part) {
  if (!part) return null;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const val = Number.parseInt(part.slice(2), 16);
    return Number.isSafeInteger(val) && val >= 0 ? val : null;
  }
  if (/^0[0-7]+$/.test(part)) {
    const val = Number.parseInt(part, 8);
    return Number.isSafeInteger(val) && val >= 0 ? val : null;
  }
  if (/^(?:0|[1-9]\d*)$/.test(part)) {
    const val = Number.parseInt(part, 10);
    return Number.isSafeInteger(val) && val >= 0 ? val : null;
  }
  return null;
}

/**
 * Parses standard dotted IPv4 as well as WHATWG/inet_aton obfuscated forms:
 * - Single 32-bit decimal: 2130706433 (127.0.0.1), 2852039166 (169.254.169.254)
 * - Hexadecimal: 0x7f000001, 0x7f.0.0.1
 * - Octal: 0177.0.0.1, 0177.1
 * - 2-part / 3-part shorthand: 127.1, 169.254.43518
 */
export function parseIpv4ToUint32(host) {
  if (!host || typeof host !== "string") return null;
  const clean = host.replace(/\.$/, "");
  if (!clean) return null;
  const parts = clean.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const nums = [];
  for (const part of parts) {
    const n = parseIpv4Part(part);
    if (n === null) return null;
    nums.push(n);
  }

  // Last component absorbs remaining bytes in 1/2/3-part inet_aton syntax
  const last = nums[nums.length - 1];
  const lastMax = 256 ** (5 - nums.length) - 1;
  if (last > lastMax) return null;
  for (let i = 0; i < nums.length - 1; i += 1) {
    if (nums[i] > 255) return null;
  }

  let ip = last;
  for (let i = 0; i < nums.length - 1; i += 1) {
    ip += nums[i] * 256 ** (3 - i);
  }
  return ip >>> 0;
}

function isRestrictedIpv4Uint32(ip) {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  const c = (ip >>> 8) & 0xff;
  // 0.0.0.0/8 (unspecified / "this host")
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC1918)
  if (a === 10) return true;
  // 100.64.0.0/10 (Carrier-Grade NAT RFC6598)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments RFC6890)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking RFC2544)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved / Broadcast)
  if (a >= 224) return true;
  return false;
}

/**
 * Expands any valid IPv6 address (including :: compression and embedded dotted IPv4 tail
 * such as ::ffff:169.254.169.254, ::ffff:0:169.254.169.254, ::127.0.0.1, or 64:ff9b::169.254.169.254)
 * into 8 x 16-bit numeric groups.
 */
export function expandIpv6(rawHost) {
  let host = String(rawHost || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  // Strip IPv6 zone identifier (%eth0 / %25eth0)
  const zoneIdx = host.indexOf("%");
  if (zoneIdx !== -1) host = host.slice(0, zoneIdx);
  if (!host.includes(":")) return null;

  // Handle embedded IPv4 tail like ::ffff:169.254.169.254, ::ffff:0:169.254.169.254, ::127.0.0.1, 64:ff9b::169.254.169.254
  let embeddedIpv4Groups = [];
  const lastColon = host.lastIndexOf(":");
  const tail = host.slice(lastColon + 1);
  if (tail.includes(".")) {
    const ipv4 = parseIpv4ToUint32(tail);
    if (ipv4 === null) return null;
    embeddedIpv4Groups = [(ipv4 >>> 16) & 0xffff, ipv4 & 0xffff];
    if (lastColon > 0 && host.charCodeAt(lastColon - 1) === 58 /* ':' */) {
      // Preserve "::" marker intact when original was "::127.0.0.1" or "64:ff9b::169.254.169.254"
      host = host.slice(0, lastColon + 1);
    } else {
      host = host.slice(0, lastColon);
    }
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;

  const parseHexPart = (str) => {
    if (!str) return [];
    const tokens = str.split(":");
    const out = [];
    for (const t of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(t)) return null;
      out.push(Number.parseInt(t, 16));
    }
    return out;
  };

  const left = parseHexPart(halves[0]);
  const right = halves.length === 2 ? parseHexPart(halves[1]) : [];
  if (left === null || right === null) return null;

  const rightTotal = [...right, ...embeddedIpv4Groups];
  if (halves.length === 1) {
    const combined = [...left, ...embeddedIpv4Groups];
    return combined.length === 8 ? combined : null;
  }

  const missing = 8 - (left.length + rightTotal.length);
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...rightTotal];
}

export function parseIpv6Groups(rawHost) {
  return expandIpv6(rawHost);
}

function isRestrictedIpv6Groups(groups) {
  // Unspecified ::
  if (groups.every((g) => g === 0)) return true;
  // Loopback ::1
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // Link-local fe80::/10 (0xfe80..0xfebf) & deprecated site-local fec0::/10
  if ((groups[0] & 0xffc0) === 0xfe80 || (groups[0] & 0xffc0) === 0xfec0) return true;
  // Unique Local fc00::/7 (0xfc00..0xfdff)
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // Multicast ff00::/8
  if ((groups[0] & 0xff00) === 0xff00) return true;

  const firstFourZero =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0;
  // IPv4-mapped IPv6 (::ffff:0:0/96) or IPv4-compatible IPv6 (::0:0/96)
  if (firstFourZero && groups[4] === 0 && (groups[5] === 0xffff || groups[5] === 0x0000)) {
    const ipv4 = (((groups[6] << 16) | groups[7]) >>> 0);
    return isRestrictedIpv4Uint32(ipv4);
  }
  // IPv4-translated IPv6 (::ffff:0:0:0/96, RFC 2765 SIIT)
  if (firstFourZero && groups[4] === 0xffff && groups[5] === 0x0000) {
    const ipv4 = (((groups[6] << 16) | groups[7]) >>> 0);
    return isRestrictedIpv4Uint32(ipv4);
  }
  // NAT64 Well-Known Prefix (64:ff9b::/96, RFC 6052) including WHATWG hex [64:ff9b::a9fe:a9fe]
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    const ipv4 = (((groups[6] << 16) | groups[7]) >>> 0);
    return isRestrictedIpv4Uint32(ipv4);
  }
  // NAT64 Local-Use Prefix (64:ff9b:1::/48, RFC 8215)
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
    return true;
  }
  // 6to4 (2002::/16, RFC 3056) with embedded IPv4 in groups[1..2]
  if (groups[0] === 0x2002) {
    const ipv4 = (((groups[1] << 16) | groups[2]) >>> 0);
    return isRestrictedIpv4Uint32(ipv4);
  }
  // Teredo (2001:0000::/32, RFC 4380) with obfuscated IPv4 in groups[6..7]
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    const ipv4 = ((((groups[6] << 16) | groups[7]) ^ 0xffffffff) >>> 0);
    return isRestrictedIpv4Uint32(ipv4);
  }
  return false;
}

/**
 * Checks whether a hostname targets a private, loopback, link-local, metadata,
 * mDNS (.local), or obfuscated-IP SSRF destination.
 * Only canonical `localhost`, `127.0.0.1`, or `::1` are allowed when `allowLocalhost: true`.
 */
export function isRestrictedHost(hostname, { allowLocalhost = false } = {}) {
  if (typeof hostname !== "string" || !hostname.trim()) return true;
  const raw = hostname.trim().toLowerCase();
  const unbracketed = raw.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!unbracketed) return true;

  // Reject control chars, spaces, or credentials embedded in hostname
  if (/[\s@\\/]/.test(unbracketed)) return true;

  // Canonical localhost allowance ONLY when explicitly enabled
  if (unbracketed === "localhost" || unbracketed === "127.0.0.1" || unbracketed === "::1") {
    return !allowLocalhost;
  }

  // Block *.localhost, *.local (mDNS), *.internal, and cloud metadata hostnames unconditionally
  if (
    unbracketed.endsWith(".localhost") ||
    unbracketed === "local" ||
    unbracketed.endsWith(".local") ||
    unbracketed === "metadata.google.internal" ||
    unbracketed === "metadata.goog" ||
    unbracketed === "metadata" ||
    unbracketed === "instance-data" ||
    unbracketed.endsWith(".internal")
  ) {
    return true;
  }

  // Check IPv6 (mapped, translated, compatible, NAT64, 6to4, Teredo, ULA, link-local)
  if (unbracketed.includes(":")) {
    const groups = expandIpv6(unbracketed);
    if (!groups) return true; // Fail-closed on malformed IPv6 literal
    return isRestrictedIpv6Groups(groups);
  }

  // Check IPv4 (including decimal 2130706433, hex 0x7f000001, octal 0177.0.0.1, shorthand 127.1)
  const ipv4 = parseIpv4ToUint32(unbracketed);
  if (ipv4 !== null) {
    return isRestrictedIpv4Uint32(ipv4);
  }

  // Block single-label numeric/octal/hex hosts that fail standard DNS TLD format
  if (/^0[xX][0-9a-fA-F]+$/.test(unbracketed) || /^\d+$/.test(unbracketed)) {
    return true;
  }

  return false;
}

export function normalizeBaseUrl(rawUrl, { allowLocalhost = false } = {}) {
  const trimmed = String(rawUrl || "").trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid BASE_URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" in BASE_URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Blocked restricted/SSRF URL containing userinfo credentials");
  }
  // Inspect BOTH raw authority host (catches 0x7f000001 / 0177.0.0.1 / 2130706433 / user@ before URL normalization)
  // AND parsed.hostname!
  const rawHostMatch = /^https?:\/\/([^/?#]+)/i.exec(trimmed);
  const rawAuthority = rawHostMatch ? rawHostMatch[1] : "";
  if (rawAuthority.includes("@")) {
    throw new Error("Blocked restricted/SSRF URL containing userinfo authority (@)");
  }
  const rawHostOnly = rawAuthority.startsWith("[")
    ? rawAuthority.slice(0, rawAuthority.indexOf("]") + 1)
    : rawAuthority.split(":")[0];

  if (
    isRestrictedHost(rawHostOnly, { allowLocalhost }) ||
    isRestrictedHost(parsed.hostname, { allowLocalhost })
  ) {
    throw new Error(
      `Blocked restricted/SSRF target host "${rawHostOnly || parsed.hostname}". Pass --allow-localhost only for local testing.`,
    );
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

export function isPlatformPreviewHost(baseUrl) {
  try {
    const { hostname } = new URL(baseUrl);
    const host = hostname.toLowerCase();
    return (
      host.endsWith(".vercel.app") ||
      host.endsWith(".netlify.app") ||
      host.endsWith(".pages.dev")
    );
  } catch {
    return false;
  }
}

export function detectMode(baseUrl, explicitMode = "auto") {
  const normalized = String(explicitMode || "auto").toLowerCase();
  if (normalized === "preview" || normalized === "production" || normalized === "local") {
    return normalized;
  }
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "local";
  }
  if (isPlatformPreviewHost(baseUrl) || host.includes("preview") || host.includes("staging")) {
    return "preview";
  }
  return "production";
}

// ---------------------------------------------------------------------------
// Hardened Fetch Wrapper (Manual Redirects, Origin-Pinned Bypass Secret, SSRF Guard)
// ---------------------------------------------------------------------------

export async function fetchUrl(
  rawUrl,
  {
    baseOrigin,
    bypassSecret = "",
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_MS,
    redirect = "follow",
    allowLocalhost = false,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const initialUrl = new URL(rawUrl);
  const pinnedOrigin = baseOrigin || initialUrl.origin;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      let currentUrl = initialUrl;
      const redirectChain = [];
      const startedAt = performance.now();

      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        if (currentUrl.protocol !== "https:" && currentUrl.protocol !== "http:") {
          throw new Error(`Blocked redirect to non-HTTP(S) protocol: ${currentUrl.protocol}`);
        }
        if (currentUrl.username || currentUrl.password) {
          throw new Error("Blocked SSRF target URL containing userinfo credentials");
        }
        if (isRestrictedHost(currentUrl.hostname, { allowLocalhost })) {
          throw new Error(`Blocked SSRF target host: ${currentUrl.hostname}`);
        }

        const headers = {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        };

        // SECURITY INVARIANT: Attach Vercel Protection Bypass secret ONLY on exact initialOrigin
        if (bypassSecret && currentUrl.origin === pinnedOrigin) {
          headers["x-vercel-protection-bypass"] = bypassSecret;
          headers["x-vercel-set-bypass-cookie"] = "true";
        }

        const res = await fetchImpl(currentUrl.toString(), {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });

        const locationHeader = res.headers.get("location");
        const isRedirect = res.status >= 300 && res.status < 400 && Boolean(locationHeader);
        if (isRedirect && redirect === "follow") {
          if (hop === maxRedirects) {
            throw new Error(`Too many redirects (>${maxRedirects}) starting at ${rawUrl}`);
          }
          const resolvedNext = new URL(locationHeader, currentUrl);
          if (resolvedNext.username || resolvedNext.password) {
            throw new Error("Blocked SSRF redirect containing userinfo credentials");
          }
          // Validate next hop host BEFORE storing/following
          const rawNextHostMatch = /^https?:\/\/([^/?#]+)/i.exec(locationHeader.trim());
          const rawNextAuthority = rawNextHostMatch ? rawNextHostMatch[1] : "";
          if (rawNextAuthority.includes("@")) {
            throw new Error("Blocked SSRF redirect containing userinfo authority (@)");
          }
          const rawNextHost = rawNextAuthority.startsWith("[")
            ? rawNextAuthority.slice(0, rawNextAuthority.indexOf("]") + 1)
            : rawNextAuthority.split(":")[0];
          if (rawNextHost && isRestrictedHost(rawNextHost, { allowLocalhost })) {
            throw new Error(`Blocked SSRF redirect to restricted host: ${rawNextHost}`);
          }
          if (isRestrictedHost(resolvedNext.hostname, { allowLocalhost })) {
            throw new Error(`Blocked SSRF redirect to restricted host: ${resolvedNext.hostname}`);
          }

          redirectChain.push({
            from: currentUrl.toString(),
            status: res.status,
            to: resolvedNext.toString(),
            crossOrigin: resolvedNext.origin !== pinnedOrigin,
          });
          try {
            await res.arrayBuffer();
          } catch {
            // ignore drain failure
          }
          currentUrl = resolvedNext;
          continue;
        }

        const body = await res.text();
        const durationMs = Math.round(performance.now() - startedAt);

        if ([429, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
          lastError = new Error(`Transient HTTP ${res.status} on ${currentUrl.toString()}`);
          await new Promise((r) => setTimeout(r, retryBaseDelayMs * 2 ** attempt));
          break;
        }

        const headerMap = {};
        for (const [k, v] of res.headers.entries()) {
          headerMap[k.toLowerCase()] = v;
        }

        const vercelProtected =
          (res.status === 401 || res.status === 403) &&
          (Boolean(headerMap["x-vercel-id"]) ||
            headerMap["x-vercel-mitigated"] === "challenge" ||
            /vercel\.com\/sso|Authentication Required|_vercel\/sso-api/i.test(body));

        return {
          ok: res.ok,
          status: res.status,
          url: currentUrl.toString(),
          origin: currentUrl.origin,
          sameOrigin: currentUrl.origin === pinnedOrigin,
          headers: headerMap,
          body,
          durationMs,
          redirectChain,
          vercelProtected,
        };
      }
    } catch (err) {
      lastError = err;
      const isTimeoutOrNetwork =
        err?.name === "TimeoutError" ||
        err?.name === "AbortError" ||
        Boolean(err?.cause?.code) ||
        /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(String(err?.message || ""));
      if (isTimeoutOrNetwork && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryBaseDelayMs * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error(`Failed to fetch ${rawUrl}`);
}

// ---------------------------------------------------------------------------
// Order-Independent HTML, XML, Robots, JSON-LD & GEO Parsers (Strict O(N), charCodeAt)
// ---------------------------------------------------------------------------

const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

const ENTITY_SINGLE_PASS_RE = /&(amp|lt|gt|quot|apos|#39);/gi;

function decodeEntitiesSinglePass(str) {
  if (!str || str.indexOf("&") === -1) return str;
  return str.replace(ENTITY_SINGLE_PASS_RE, (full, name) => ENTITY_MAP[name.toLowerCase()] ?? full);
}

export function decodeHtmlEntities(str) {
  const raw = String(str || "");
  if (!raw) return "";
  const decoded = decodeEntitiesSinglePass(raw);
  if (!/[\t\r\n]|^\s|\s$|  /.test(decoded)) return decoded;
  return decoded.replace(/\s+/g, " ").trim();
}

export function decodeXmlValue(raw) {
  let value = String(raw || "").trim();
  if (
    value.length >= 12 &&
    value.slice(0, 9).toLowerCase() === "<![cdata[" &&
    value.endsWith("]]>")
  ) {
    value = value.slice(9, -3).trim();
  }
  return decodeEntitiesSinglePass(value).trim();
}

const ASCII_SINGLE_CHAR = Array.from({ length: 128 }, (_, c) =>
  String.fromCharCode(c >= 65 && c <= 90 ? c + 32 : c),
);

/**
 * Pure charCodeAt O(N) HTML tag attribute parser (zero regex inside char loop).
 * Order-independent, follows HTML5 §13.2.5.33 (first duplicate attribute wins),
 * and handles double-quoted, single-quoted, unquoted, multiline, and '>' inside quotes.
 */
export function parseTagAttributes(tagText) {
  const attrs = {};
  if (typeof tagText !== "string") return attrs;
  const len = tagText.length;
  if (len < 3) return attrs;

  let end = len;
  while (end > 0 && tagText.charCodeAt(end - 1) <= 32) end -= 1;
  if (end > 0 && tagText.charCodeAt(end - 1) === 62 /* '>' */) end -= 1;
  while (end > 0 && tagText.charCodeAt(end - 1) <= 32) end -= 1;
  if (end > 0 && tagText.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;

  let i = 0;
  while (i < end && tagText.charCodeAt(i) <= 32) i += 1;
  if (i < end && tagText.charCodeAt(i) === 60 /* '<' */) {
    i += 1;
    while (i < end && tagText.charCodeAt(i) <= 32) i += 1;
    while (i < end) {
      const c = tagText.charCodeAt(i);
      if (c <= 32 || c === 47 || c === 62) break;
      i += 1;
    }
  }

  const tagHasAmp = tagText.indexOf("&") !== -1;
  const tagHasCtrlWs =
    tagText.indexOf("\n") !== -1 ||
    tagText.indexOf("\r") !== -1 ||
    tagText.indexOf("\t") !== -1 ||
    tagText.indexOf("  ") !== -1;

  while (i < end) {
    while (i < end) {
      const c = tagText.charCodeAt(i);
      if (c > 32 && c !== 47) break;
      i += 1;
    }
    if (i >= end) break;

    const nameStart = i;
    let hasUpper = false;
    while (i < end) {
      const c = tagText.charCodeAt(i);
      if (c <= 32 || c === 61 /* '=' */ || c === 47 || c === 62) break;
      if (c >= 65 && c <= 90) hasUpper = true;
      i += 1;
    }
    const nameLen = i - nameStart;
    if (nameLen === 0) {
      i += 1;
      continue;
    }

    let key;
    if (nameLen === 1) {
      const ch = tagText.charCodeAt(nameStart);
      key = ch < 128 ? ASCII_SINGLE_CHAR[ch] : tagText[nameStart].toLowerCase();
    } else {
      const rawKey = tagText.slice(nameStart, i);
      key = hasUpper ? rawKey.toLowerCase() : rawKey;
    }

    const skipValue =
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      Object.prototype.hasOwnProperty.call(attrs, key);

    while (i < end && tagText.charCodeAt(i) <= 32) i += 1;

    let rawVal = "";
    if (i < end && tagText.charCodeAt(i) === 61 /* '=' */) {
      i += 1;
      while (i < end && tagText.charCodeAt(i) <= 32) i += 1;
      if (i < end) {
        const qc = tagText.charCodeAt(i);
        if (qc === 34 /* '"' */ || qc === 39 /* "'" */) {
          const quoteChar = qc === 34 ? '"' : "'";
          i += 1;
          const vStart = i;
          const closeIdx = tagText.indexOf(quoteChar, i);
          if (closeIdx === -1 || closeIdx >= end) {
            if (!skipValue) rawVal = tagText.slice(vStart, end);
            i = end;
          } else {
            if (!skipValue) rawVal = tagText.slice(vStart, closeIdx);
            i = closeIdx + 1;
          }
        } else {
          const vStart = i;
          while (i < end) {
            const c = tagText.charCodeAt(i);
            if (c <= 32 || c === 62) break;
            i += 1;
          }
          if (!skipValue) rawVal = tagText.slice(vStart, i);
        }
      }
    }

    if (skipValue) {
      continue;
    }

    if (rawVal.length === 0) {
      attrs[key] = "";
    } else if (
      rawVal.charCodeAt(0) <= 32 ||
      rawVal.charCodeAt(rawVal.length - 1) <= 32 ||
      (tagHasAmp && rawVal.indexOf("&") !== -1) ||
      (tagHasCtrlWs &&
        (rawVal.indexOf("\n") !== -1 ||
          rawVal.indexOf("\r") !== -1 ||
          rawVal.indexOf("\t") !== -1 ||
          rawVal.indexOf("  ") !== -1))
    ) {
      attrs[key] = decodeHtmlEntities(rawVal);
    } else {
      attrs[key] = rawVal;
    }
  }

  return attrs;
}

function isTagBoundaryCode(code) {
  return (
    code === 32 || // space
    code === 9 || // \t
    code === 10 || // \n
    code === 13 || // \r
    code === 47 || // /
    code === 62 // >
  );
}

/**
 * STRIDE-D-01 (Anti-ReDoS): Strips HTML/XML comments (`<!-- ... -->`) in strict O(N) time.
 */
function stripCommentsLinear(src) {
  const str = String(src || "");
  if (str.indexOf("<!--") === -1) return str;
  const out = [];
  let i = 0;
  const len = str.length;
  while (i < len) {
    const start = str.indexOf("<!--", i);
    if (start === -1) {
      out.push(str.slice(i));
      break;
    }
    if (start > i) out.push(str.slice(i, start));
    const end = str.indexOf("-->", start + 4);
    if (end === -1) break;
    i = end + 3;
  }
  return out.join("");
}

/**
 * STRIDE-D-01 (Anti-ReDoS): Finds the closing `>` of an HTML/XML tag starting after `<tagName`,
 * respecting single/double quotes (so `data-x="1 > 2"` never cuts the tag early) via native
 * SIMD indexOf and aborting linearly on unclosed `<` so 50 KB pathological payloads run in < 2ms.
 * Always returns >= 0 (index of `>`) or -1 (unclosed).
 */
function findTagEndLinear(str, startIdx) {
  const len = str.length;
  let i = startIdx;
  while (i < len) {
    const c = str.charCodeAt(i);
    if (c === 34 /* '"' */ || c === 39 /* "'" */) {
      const closeQ = str.indexOf(c === 34 ? '"' : "'", i + 1);
      if (closeQ === -1) return -1;
      i = closeQ + 1;
      continue;
    }
    if (c === 62 /* '>' */) {
      return i;
    }
    if (c === 60 /* '<' */) {
      return -1;
    }
    i += 1;
  }
  return -1;
}

/**
 * STRIDE-D-01 (Anti-ReDoS): Scans opening tags matching `targetName` (case-insensitive) in O(N).
 */
function scanOpeningTagsLinear(html, targetName, preLower = null) {
  const src = String(html || "");
  if (src.indexOf(">") === -1) return [];
  const lower = preLower ?? src.toLowerCase();
  const needle = `<${targetName.toLowerCase()}`;
  const needleLen = needle.length;
  const len = src.length;
  const results = [];
  let pos = 0;

  while (pos < len) {
    const idx = lower.indexOf(needle, pos);
    if (idx === -1) break;
    const afterName = idx + needleLen;
    if (afterName < len && !isTagBoundaryCode(lower.charCodeAt(afterName))) {
      pos = afterName;
      continue;
    }
    const end = findTagEndLinear(src, afterName);
    if (end === -1) {
      pos = afterName;
      continue;
    }
    results.push({
      start: idx,
      end: end + 1,
      raw: src.slice(idx, end + 1),
    });
    pos = end + 1;
  }
  return results;
}

/**
 * STRIDE-D-01 (Anti-ReDoS): Extracts `<tag ...>body</tag>` pairs in O(N) time without backtracking.
 */
function extractElementsLinear(html, targetName, preLower = null) {
  const src = String(html || "");
  if (src.indexOf(">") === -1) return [];
  const lower = preLower ?? src.toLowerCase();
  const openNeedle = `<${targetName.toLowerCase()}`;
  const closeNeedle = `</${targetName.toLowerCase()}`;
  const openLen = openNeedle.length;
  const closeLen = closeNeedle.length;
  const len = src.length;
  const elements = [];
  let pos = 0;

  while (pos < len) {
    const idx = lower.indexOf(openNeedle, pos);
    if (idx === -1) break;
    const afterName = idx + openLen;
    if (afterName < len && !isTagBoundaryCode(lower.charCodeAt(afterName))) {
      pos = afterName;
      continue;
    }
    const openEnd = findTagEndLinear(src, afterName);
    if (openEnd === -1) {
      pos = afterName;
      continue;
    }
    const closeIdx = lower.indexOf(closeNeedle, openEnd + 1);
    if (closeIdx === -1) {
      break;
    }
    const closeEnd = lower.indexOf(">", closeIdx + closeLen);
    if (closeEnd === -1) break;
    elements.push({
      openTag: src.slice(idx, openEnd + 1),
      body: src.slice(openEnd + 1, closeIdx),
    });
    pos = closeEnd + 1;
  }
  return elements;
}

/**
 * STRIDE-D-01 (Anti-ReDoS): Strips dangerous/non-visible elements and HTML tags in strict O(N).
 */
function extractVisibleTextLinear(html, preLower = null) {
  const src = String(html || "");
  const firstLt = src.indexOf("<");
  if (firstLt === -1) return src;
  const firstGt = src.indexOf(">", firstLt);
  if (firstGt === -1) return src;
  const lower = preLower ?? src.toLowerCase();
  const len = src.length;
  const out = [];
  let i = 0;
  let skipUntil = null;
  let lastWasSpace = true;
  // Monotonic cursors guarantee strictly O(N) amortized SIMD scans
  let nextGt = firstGt;
  let nextDq = src.indexOf('"', firstLt);
  let nextSq = src.indexOf("'", firstLt);

  while (i < len) {
    if (skipUntil !== null) {
      const closeIdx = lower.indexOf(skipUntil, i);
      if (closeIdx === -1) break;
      const closeGt = lower.indexOf(">", closeIdx + skipUntil.length);
      if (closeGt === -1) break;
      i = closeGt + 1;
      skipUntil = null;
      continue;
    }

    const lt = src.indexOf("<", i);
    if (lt === -1) {
      out.push(src.slice(i));
      break;
    }
    if (lt > i) {
      out.push(src.slice(i, lt));
      lastWasSpace = false;
    }

    const c1 = lower.charCodeAt(lt + 1);
    if (c1 === 60 /* '<' */) {
      if (!lastWasSpace) {
        out.push(" ");
        lastWasSpace = true;
      }
      i = lt + 1;
      while (i + 1 < len && src.charCodeAt(i + 1) === 60) i += 1;
      if (i + 1 >= len) break;
      continue;
    }
    if (c1 === 115 /* 's' */) {
      if (lower.startsWith("<script", lt) && isTagBoundaryCode(lower.charCodeAt(lt + 7))) {
        const gt = findTagEndLinear(src, lt + 7);
        if (gt === -1) break;
        skipUntil = "</script";
        i = gt + 1;
        continue;
      }
      if (lower.startsWith("<style", lt) && isTagBoundaryCode(lower.charCodeAt(lt + 6))) {
        const gt = findTagEndLinear(src, lt + 6);
        if (gt === -1) break;
        skipUntil = "</style";
        i = gt + 1;
        continue;
      }
    } else if (c1 === 110 /* 'n' */) {
      if (lower.startsWith("<noscript", lt) && isTagBoundaryCode(lower.charCodeAt(lt + 9))) {
        const gt = findTagEndLinear(src, lt + 9);
        if (gt === -1) break;
        skipUntil = "</noscript";
        i = gt + 1;
        continue;
      }
    }

    // Fast SIMD scan with monotonic cursors for closing '>' or nested '<'
    const p = lt + 1;
    const nextLt = src.indexOf("<", p);
    if (nextGt !== -1 && nextGt < p) nextGt = src.indexOf(">", p);
    let gt = -1;
    let nestedLt = -1;

    if (nextGt === -1) {
      nestedLt = nextLt;
    } else {
      const bound = nextLt !== -1 && nextLt < nextGt ? nextLt : nextGt;
      if (nextDq !== -1 && nextDq < p) nextDq = src.indexOf('"', p);
      if (nextSq !== -1 && nextSq < p) nextSq = src.indexOf("'", p);
      const hasQuoteBeforeBound =
        (nextDq !== -1 && nextDq < bound) || (nextSq !== -1 && nextSq < bound);
      if (!hasQuoteBeforeBound) {
        if (nextLt !== -1 && nextLt < nextGt) {
          nestedLt = nextLt;
        } else {
          gt = nextGt;
        }
      } else {
        let k = p;
        while (k < len) {
          const ch = src.charCodeAt(k);
          if (ch === 34 /* '"' */ || ch === 39 /* "'" */) {
            const closeQ = src.indexOf(ch === 34 ? '"' : "'", k + 1);
            if (closeQ === -1) {
              k = len;
              break;
            }
            k = closeQ + 1;
            continue;
          }
          if (ch === 62 /* '>' */) {
            gt = k;
            break;
          }
          if (ch === 60 /* '<' */) {
            nestedLt = k;
            break;
          }
          k += 1;
        }
      }
    }

    if (gt === -1) {
      if (!lastWasSpace) {
        out.push(" ");
        lastWasSpace = true;
      }
      if (nestedLt !== -1) {
        i = nestedLt;
        continue;
      }
      break;
    }
    if (!lastWasSpace) {
      out.push(" ");
      lastWasSpace = true;
    }
    i = gt + 1;
  }
  return out.join("");
}

export function parseMetaTags(html, preLower = null) {
  return scanOpeningTagsLinear(html, "meta", preLower).map((t) => parseTagAttributes(t.raw));
}

export function extractCanonicalUrls(html, preLower = null) {
  const canonicals = [];
  for (const tag of scanOpeningTagsLinear(html, "link", preLower)) {
    const attrs = parseTagAttributes(tag.raw);
    const relTokens = (attrs.rel || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (relTokens.includes("canonical") && attrs.href) {
      canonicals.push(attrs.href.trim());
    }
  }
  return canonicals;
}

export function hasHtmlMetaNoindex(html) {
  const metas = parseMetaTags(html);
  for (const attrs of metas) {
    const name = (attrs.name || "").toLowerCase();
    if (name === "robots" || name === "googlebot") {
      if (/\bnoindex\b/i.test(attrs.content || "")) {
        return true;
      }
    }
  }
  return false;
}

export function extractHtmlMetadata(html) {
  const src = String(html || "");
  const lower = src.toLowerCase();
  const htmlTags = scanOpeningTagsLinear(src, "html", lower);
  const htmlAttrs = htmlTags[0] ? parseTagAttributes(htmlTags[0].raw) : {};
  const titleEls = extractElementsLinear(src, "title", lower);

  const metaTags = parseMetaTags(src, lower);
  let description = null;
  let metaRobots = null;
  const og = {};
  const twitter = {};

  for (const attrs of metaTags) {
    const name = (attrs.name || "").toLowerCase();
    const prop = (attrs.property || "").toLowerCase();
    const content = attrs.content;
    if (name === "description" && content != null) description = content;
    if ((name === "robots" || name === "googlebot") && content != null) {
      metaRobots = metaRobots ? `${metaRobots}, ${content}` : content;
    }
    if (prop.startsWith("og:") && content != null) og[prop] = content;
    if (name.startsWith("twitter:") && content != null) twitter[name] = content;
  }

  const canonicals = extractCanonicalUrls(src, lower);
  const canonical = canonicals[0] || null;

  const h1s = extractElementsLinear(src, "h1", lower)
    .map((el) => decodeHtmlEntities(extractVisibleTextLinear(el.body)))
    .filter(Boolean);

  const visibleText = extractVisibleTextLinear(src, lower);
  const decodedVisible = visibleText.indexOf("&") !== -1 ? decodeEntitiesSinglePass(visibleText) : visibleText;
  let wordCount = 0;
  let curWordLen = 0;
  for (let wi = 0; wi < decodedVisible.length; wi += 1) {
    if (decodedVisible.charCodeAt(wi) <= 32) {
      if (curWordLen > 1) wordCount += 1;
      curWordLen = 0;
    } else {
      curWordLen += 1;
    }
  }
  if (curWordLen > 1) wordCount += 1;

  const jsonLdRawBlocks = [];
  for (const el of extractElementsLinear(src, "script", lower)) {
    const attrs = parseTagAttributes(el.openTag);
    const typeVal = (attrs.type || "").split(";")[0].trim().toLowerCase();
    if (typeVal === "application/ld+json") {
      jsonLdRawBlocks.push(el.body);
    }
  }

  return {
    lang: htmlAttrs.lang || null,
    title: titleEls[0] ? decodeHtmlEntities(titleEls[0].body) : null,
    description,
    metaRobots,
    hasHtmlNoindex: /\bnoindex\b/i.test(metaRobots || ""),
    canonical,
    canonicals,
    og,
    twitter,
    h1s,
    wordCount,
    jsonLdRawBlocks,
  };
}

/**
 * STRIDE-D-01 (Anti-ReDoS): Linear-time XML element extractor supporting optional XML namespaces
 * (e.g. `<sm:loc>...</sm:loc>` and `<loc>...</loc>`) in strict O(N), verifying exact tag name
 * boundaries (never matching `<location>` for `loc`).
 */
function extractXmlElementValuesLinear(xml, localTagName, preLower = null) {
  const len = xml.length;
  const lower = preLower ?? xml.toLowerCase();
  const target = localTagName.toLowerCase();
  const values = [];
  let i = 0;

  while (i < len) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;

    // Skip CDATA blocks outside tags
    if (lower.startsWith("<![cdata[", lt)) {
      const cEnd = xml.indexOf("]]>", lt + 9);
      if (cEnd === -1) break;
      i = cEnd + 3;
      continue;
    }

    // Parse opening tag name (optional namespace prefix + ':' + localTagName)
    let p = lt + 1;
    while (p < len && xml.charCodeAt(p) <= 32) {
      p += 1;
    }
    if (p >= len) break;
    const firstC = xml.charCodeAt(p);
    if (firstC === 47 || firstC === 33 || firstC === 63) {
      i = lt + 1;
      continue;
    }
    const nameStart = p;
    while (p < len) {
      const c = lower.charCodeAt(p);
      const isNameChar =
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 58 || // ':'
        c === 45 || // '-'
        c === 95; // '_'
      if (!isNameChar) break;
      p += 1;
    }
    const fullName = lower.slice(nameStart, p);
    const colon = fullName.indexOf(":");
    const local = colon === -1 ? fullName : fullName.slice(colon + 1);
    if (local !== target || (p < len && !isTagBoundaryCode(lower.charCodeAt(p)))) {
      i = p > lt ? p : lt + 1;
      continue;
    }

    const openGt = findTagEndLinear(xml, p);
    if (openGt === -1) {
      i = p;
      continue;
    }

    // Self-closing tag `<loc/>` has no body
    if (openGt > p && xml.charCodeAt(openGt - 1) === 47 /* '/' */) {
      i = openGt + 1;
      continue;
    }

    // Scan forward linearly for matching closing tag `</[ns:]target>` (skipping CDATA safely)
    let scan = openGt + 1;
    let foundCloseStart = -1;
    let foundCloseEnd = -1;
    while (scan < len) {
      const nextLt = xml.indexOf("<", scan);
      if (nextLt === -1) break;
      if (lower.startsWith("<![cdata[", nextLt)) {
        const cEnd = xml.indexOf("]]>", nextLt + 9);
        if (cEnd === -1) {
          scan = len;
          break;
        }
        scan = cEnd + 3;
        continue;
      }
      if (xml.charCodeAt(nextLt + 1) === 47 /* '/' */) {
        let cp = nextLt + 2;
        while (cp < len && xml.charCodeAt(cp) <= 32) cp += 1;
        const cStart = cp;
        while (cp < len) {
          const c = lower.charCodeAt(cp);
          const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 58 || c === 45 || c === 95;
          if (!ok) break;
          cp += 1;
        }
        const closeFull = lower.slice(cStart, cp);
        const cColon = closeFull.indexOf(":");
        const closeLocal = cColon === -1 ? closeFull : closeFull.slice(cColon + 1);
        if (closeLocal === target && (cp < len && (xml.charCodeAt(cp) === 62 || xml.charCodeAt(cp) <= 32))) {
          const closeGt = xml.indexOf(">", cp);
          if (closeGt !== -1) {
            foundCloseStart = nextLt;
            foundCloseEnd = closeGt;
            break;
          }
        }
      }
      scan = nextLt + 1;
    }

    if (foundCloseStart === -1) {
      // No closing tag anywhere ahead -> stop immediately in O(1) (prevents O(N^2) on `<loc><loc>...`)
      break;
    }
    const val = decodeXmlValue(xml.slice(openGt + 1, foundCloseStart));
    if (val) values.push(val);
    i = foundCloseEnd + 1;
  }
  return values;
}

export function parseSitemapXml(xml) {
  const cleaned = stripCommentsLinear(xml);
  const lower = cleaned.toLowerCase();

  // Reject XML DOCTYPE/ENTITY declarations fail-closed (anti-XXE)
  if (lower.includes("<!doctype") || lower.includes("<!entity")) {
    return {
      validRoot: false,
      kind: "rejected_xxe",
      locs: [],
      lastmods: [],
    };
  }

  const isSitemapIndex = /<\s*(?:[a-z0-9_-]{1,32}:)?sitemapindex(?:\s|\/|>)/i.test(cleaned);
  const isUrlSet = /<\s*(?:[a-z0-9_-]{1,32}:)?urlset(?:\s|\/|>)/i.test(cleaned);

  const locs = extractXmlElementValuesLinear(cleaned, "loc", lower);
  const lastmods = extractXmlElementValuesLinear(cleaned, "lastmod", lower);

  return {
    validRoot: isSitemapIndex || isUrlSet,
    kind: isSitemapIndex ? "sitemapindex" : isUrlSet ? "urlset" : "unknown",
    locs,
    lastmods,
  };
}

export function selectSampleJobPath(locs, customRegex = null) {
  const matcher =
    customRegex instanceof RegExp
      ? customRegex
      : /^\/(?:magang-nasional\/)?lowongan\/([^/?#]+)\/?$/i;

  for (const loc of locs) {
    let pathname;
    try {
      pathname = new URL(loc).pathname;
    } catch {
      continue;
    }
    const m = matcher.exec(pathname);
    if (!m) continue;
    const seg1 = (m[1] || "").toLowerCase();
    if (HUB_SEGMENTS.has(seg1)) continue;
    return normalizePathname(pathname);
  }
  return null;
}

export function parseRobotsTxt(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sitemaps = [];
  const agentRules = new Map();
  let currentAgents = [];
  let directiveCount = 0;

  for (const rawLine of lines) {
    const stripped = rawLine.replace(/#.*$/, "").trim();
    if (!stripped) continue;
    const colonIdx = stripped.indexOf(":");
    if (colonIdx === -1) continue;

    const field = stripped.slice(0, colonIdx).trim().toLowerCase();
    const value = stripped.slice(colonIdx + 1).trim();
    directiveCount += 1;

    if (field === "user-agent") {
      const ua = value.toLowerCase();
      if (currentAgents.length > 0 && agentRules.get(currentAgents[0])?.hasRules) {
        currentAgents = [];
      }
      currentAgents.push(ua);
      if (!agentRules.has(ua)) {
        agentRules.set(ua, { allow: [], disallow: [], hasRules: false });
      }
    } else if (field === "sitemap") {
      sitemaps.push(value);
    } else if (field === "disallow" || field === "allow") {
      for (const ua of currentAgents) {
        const entry = agentRules.get(ua);
        if (!entry) continue;
        entry.hasRules = true;
        if (value !== "") entry[field].push(value);
      }
    }
  }

  return { sitemaps, agentRules, directiveCount };
}

export function isPathBlockedByRules(targetPath, rules) {
  if (!rules) return false;
  let bestAllow = -1;
  let bestDisallow = -1;

  const matchesRule = (pattern, p) => {
    const endAnchored = pattern.endsWith("$");
    const core = endAnchored ? pattern.slice(0, -1) : pattern;
    const escaped = core
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const expr = endAnchored ? `^${escaped}$` : `^${escaped}`;
    return new RegExp(expr).test(p);
  };

  for (const rule of rules.allow || []) {
    if (matchesRule(rule, targetPath)) bestAllow = Math.max(bestAllow, rule.length);
  }
  for (const rule of rules.disallow || []) {
    if (matchesRule(rule, targetPath)) bestDisallow = Math.max(bestDisallow, rule.length);
  }

  if (bestDisallow === -1) return false;
  return bestDisallow > bestAllow;
}

export function validateRobotsTxt(body, canonicalOrigin) {
  const issues = [];
  const warnings = [];
  const parsed = parseRobotsTxt(body);
  const hasUserAgent = parsed.agentRules.size > 0;
  const hasCloudflareSignals = /content-signal|EU DIRECTIVE 2019\/790/i.test(String(body || ""));

  if (!hasUserAgent) {
    issues.push(
      hasCloudflareSignals
        ? "robots.txt contains only Cloudflare Content Signals comments and zero User-agent directives"
        : "robots.txt is missing a User-agent directive",
    );
  }

  const validSitemaps = parsed.sitemaps.filter((s) => /^https?:\/\/.+/i.test(s));
  if (validSitemaps.length === 0) {
    issues.push("robots.txt is missing an absolute Sitemap: directive pointing to sitemap.xml");
  } else {
    const expectedPrefix = canonicalOrigin.replace(/\/+$/, "");
    if (!validSitemaps.some((s) => s.startsWith(expectedPrefix))) {
      warnings.push(
        `Sitemap directive (${validSitemaps.join(", ")}) does not match canonical origin ${expectedPrefix}`,
      );
    }
  }

  const effectiveRules = parsed.agentRules.get("googlebot") || parsed.agentRules.get("*");
  for (const criticalPath of ["/", "/magang-nasional/lowongan", "/lowongan/sample"]) {
    if (isPathBlockedByRules(criticalPath, effectiveRules)) {
      issues.push(`robots.txt blocks crawlable path "${criticalPath}"`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    sitemaps: validSitemaps,
    directiveCount: parsed.directiveCount,
    hasUserAgent,
    hasCloudflareSignals,
  };
}

/**
 * Extracts and recursively flattens all JSON-LD nodes (objects, arrays, and nested @graph)
 * while enforcing XSS script/comment breakout detection on raw script bodies.
 */
export function parseJsonLdBlocks(rawBlocks) {
  const nodes = [];
  const parseErrors = [];
  const securityIssues = [];

  const collect = (item, inheritedContext) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) collect(child, inheritedContext);
      return;
    }
    const ctx = item["@context"] ?? inheritedContext;
    if (Array.isArray(item["@graph"])) {
      for (const child of item["@graph"]) collect(child, ctx);
    }
    if (item["@type"]) {
      nodes.push(ctx && !item["@context"] ? { "@context": ctx, ...item } : item);
    }
  };

  (rawBlocks || []).forEach((raw, idx) => {
    const text = String(raw ?? "");
    if (/<!--|<\/script/i.test(text)) {
      securityIssues.push(
        `JSON-LD block #${idx + 1} contains unescaped HTML comment or </script> sequence (escape '<' as \\u003c)`,
      );
    }
    if (!text.trim()) {
      parseErrors.push(`JSON-LD block #${idx + 1} is empty`);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      collect(parsed, null);
    } catch (err) {
      parseErrors.push(
        `JSON-LD block #${idx + 1} failed JSON.parse: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return { nodes, parseErrors, securityIssues };
}

function nodeHasType(node, expectedType) {
  const t = node?.["@type"];
  if (typeof t === "string") return t === expectedType;
  if (Array.isArray(t)) return t.includes(expectedType);
  return false;
}

export function validateJobPosting(node, { now = new Date(), requiredEmploymentType = "INTERN" } = {}) {
  const errors = [];
  const warnings = [];

  if (!node || typeof node !== "object") {
    return { ok: false, errors: ["No JobPosting JSON-LD object found"], warnings };
  }

  const ctx = typeof node["@context"] === "string"
    ? node["@context"]
    : JSON.stringify(node["@context"] || "");
  if (!/schema\.org/i.test(ctx)) {
    errors.push(`Invalid or missing @context ("${ctx}"); expected "https://schema.org"`);
  }

  if (typeof node.title !== "string" || node.title.trim().length < 3) {
    errors.push("Missing or too-short required field: title");
  }

  const rawDesc = typeof node.description === "string" ? node.description : "";
  const plainDesc = rawDesc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (plainDesc.length < 40) {
    errors.push("Missing or too-short required field: description (min 40 chars for Google for Jobs)");
  }
  if (/<script\b|on[a-z]+\s*=|javascript:/i.test(rawDesc)) {
    errors.push("Security violation: unsanitized script/event/javascript URI found in JobPosting description");
  }

  if (!isValidIsoDate(node.datePosted)) {
    errors.push(`Invalid or missing required ISO-8601 datePosted: ${JSON.stringify(node.datePosted)}`);
  }

  // hiringOrganization
  const org = node.hiringOrganization;
  if (!org || typeof org !== "object" || typeof org.name !== "string" || !org.name.trim()) {
    errors.push("Missing required field: hiringOrganization.name");
  } else {
    const logoUrl = typeof org.logo === "string" ? org.logo : org.logo?.url;
    if (logoUrl && !/^https:\/\//i.test(String(logoUrl))) {
      warnings.push(`hiringOrganization.logo should be an absolute HTTPS URL (got "${logoUrl}")`);
    }
    if (!org.sameAs) warnings.push("Recommended field missing: hiringOrganization.sameAs");
  }

  // jobLocation (single OR array) and TELECOMMUTE rules
  const isTelecommute = String(node.jobLocationType || "").toUpperCase() === "TELECOMMUTE";
  const locations = Array.isArray(node.jobLocation)
    ? node.jobLocation
    : node.jobLocation
      ? [node.jobLocation]
      : [];

  const hasValidPhysicalLocation = locations.length > 0 && locations.every((loc) => {
    const addr = loc?.address;
    return (
      addr &&
      typeof addr === "object" &&
      typeof addr.addressCountry === "string" &&
      addr.addressCountry.trim().length >= 2 &&
      (typeof addr.addressLocality === "string" || typeof addr.addressRegion === "string")
    );
  });

  if (!isTelecommute && !hasValidPhysicalLocation) {
    errors.push(
      "Missing or invalid jobLocation.address (addressCountry + addressLocality/addressRegion) or TELECOMMUTE configuration",
    );
  }
  if (isTelecommute) {
    const reqs = Array.isArray(node.applicantLocationRequirements)
      ? node.applicantLocationRequirements
      : node.applicantLocationRequirements
        ? [node.applicantLocationRequirements]
        : [];
    const hasValidReq = reqs.some(
      (r) => r && typeof r === "object" && typeof r.name === "string" && r.name.trim().length > 0,
    );
    if (!hasValidReq) {
      errors.push(
        'jobLocationType="TELECOMMUTE" requires applicantLocationRequirements with name (e.g. Country: Indonesia)',
      );
    }
    if (locations.length > 0 && !hasValidPhysicalLocation) {
      errors.push("Hybrid jobLocation entries must include valid PostalAddress fields");
    }
  }

  // Strict validThrough + timezone + expiry guard
  if (!node.validThrough || typeof node.validThrough !== "string") {
    errors.push("Missing required internship deadline field: validThrough");
  } else if (!isStrictIsoDateWithTz(node.validThrough)) {
    errors.push(
      `Invalid validThrough (must be valid calendar ISO-8601 datetime with explicit timezone Z or +/-HH:MM): ${JSON.stringify(node.validThrough)}`,
    );
  } else {
    const expiryMs = Date.parse(node.validThrough);
    if (expiryMs <= now.getTime()) {
      errors.push(
        `Expired JobPosting detected: validThrough (${node.validThrough}) is in the past; suppress JSON-LD or return 410/noindex`,
      );
    }
    if (isValidIsoDate(node.datePosted) && expiryMs < Date.parse(node.datePosted)) {
      errors.push(`validThrough (${node.validThrough}) is earlier than datePosted (${node.datePosted})`);
    }
  }

  // employmentType
  const empTypes = Array.isArray(node.employmentType)
    ? node.employmentType
    : node.employmentType
      ? [node.employmentType]
      : [];
  if (empTypes.length === 0) {
    warnings.push('Recommended field missing: employmentType (use "INTERN" for MagangHub)');
  } else {
    const normalizedEmp = empTypes.map((et) => String(et).toUpperCase());
    for (const et of normalizedEmp) {
      if (!VALID_EMPLOYMENT_TYPES.has(et)) {
        errors.push(`Invalid employmentType "${et}"`);
      }
    }
    if (requiredEmploymentType && requiredEmploymentType !== "ANY" && !normalizedEmp.includes(requiredEmploymentType)) {
      warnings.push(`employmentType ${JSON.stringify(empTypes)} does not include "${requiredEmploymentType}"`);
    }
  }

  // baseSalary
  if (node.baseSalary !== undefined && node.baseSalary !== null) {
    const currency = node.baseSalary.currency;
    const valObj = node.baseSalary.value;
    if (!currency || !/^[A-Z]{3}$/.test(String(currency))) {
      errors.push(`baseSalary.currency must be 3-letter ISO-4217 code (got ${JSON.stringify(currency)})`);
    }
    if (!valObj || typeof valObj !== "object") {
      errors.push("baseSalary.value must be a QuantitativeValue object");
    } else {
      const exactVal = typeof valObj.value === "number" && Number.isFinite(valObj.value) ? valObj.value : null;
      const minVal = typeof valObj.minValue === "number" && Number.isFinite(valObj.minValue) ? valObj.minValue : null;
      const maxVal = typeof valObj.maxValue === "number" && Number.isFinite(valObj.maxValue) ? valObj.maxValue : null;
      if ((exactVal === null || exactVal <= 0) && (minVal === null || minVal <= 0)) {
        errors.push("baseSalary.value must contain a positive numeric value or minValue");
      }
      if (minVal !== null && maxVal !== null && minVal > maxVal) {
        errors.push(`baseSalary.value.minValue (${minVal}) exceeds maxValue (${maxVal})`);
      }
      if (!valObj.unitText || !VALID_SALARY_UNITS.has(String(valObj.unitText).toUpperCase())) {
        errors.push(`baseSalary.value.unitText must be HOUR/DAY/WEEK/MONTH/YEAR (got ${JSON.stringify(valObj.unitText)})`);
      }
    }
  } else {
    warnings.push("Recommended field missing: baseSalary (subsidized UMK stipend)");
  }

  if (typeof node.directApply !== "boolean") {
    warnings.push("Recommended boolean field missing: directApply");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function validateLlmsTxt(body) {
  const errors = [];
  const warnings = [];
  const trimmed = String(body || "").trim();

  if (/^<!doctype\s+html|^<html\b/i.test(trimmed)) {
    errors.push("llms.txt returned an HTML document (possible SPA/404 fallback) instead of Markdown text");
    return { ok: false, errors, warnings, linkCount: 0 };
  }
  if (trimmed.length < 100) {
    errors.push(`llms.txt is too short (${trimmed.length} chars; minimum 100 chars)`);
  }
  if (!/^#\s+\S+/m.test(trimmed)) {
    errors.push("llms.txt must start with an H1 title (# ...) per llmstxt.org spec");
  }
  if (!/^>\s+\S+/m.test(trimmed)) {
    warnings.push("llms.txt is missing a blockquote summary (> ...) per llmstxt.org spec");
  }
  if (!/^##\s+\S+/m.test(trimmed)) {
    warnings.push("llms.txt has no H2 sections (## ...)");
  }

  const mdLinks = [...trimmed.matchAll(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g)];
  if (mdLinks.length === 0) {
    warnings.push("llms.txt contains zero Markdown HTTPS links");
  }

  for (const re of PLACEHOLDER_PATTERNS) {
    const match = re.exec(trimmed);
    if (match) {
      errors.push(`Unresolved template placeholder leaked into llms.txt: "${match[0]}"`);
    }
  }

  const siteUrls = [...trimmed.matchAll(/https?:\/\/maganghub\.kemnaker\.go\.id(\/[^\s)]*)/g)].map(
    (m) => normalizePathname(m[1] || "/"),
  );
  for (const p of siteUrls) {
    if (LEGACY_404_PATHS.has(p)) {
      errors.push(`Broken legacy 404 route referenced in llms.txt: "${p}"`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, linkCount: mdLinks.length };
}

function isCanonicalRootLocked(canonicalHref, baseUrl) {
  try {
    return normalizePathname(new URL(canonicalHref, baseUrl).pathname) === "/";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator: Execute All 8 Gates
// ---------------------------------------------------------------------------

export async function runSeoValidation(options = {}) {
  const allowLocalhost = Boolean(
    options.allowLocalhost ??
      (process.env.ALLOW_LOCALHOST === "1" || process.env.ALLOW_LOCALHOST === "true"),
  );
  const rawBaseUrl = options.baseUrl || process.env.SEO_TEST_URL || "http://127.0.0.1:3000";
  const baseUrl = normalizeBaseUrl(rawBaseUrl, { allowLocalhost });
  const baseOrigin = new URL(baseUrl).origin;
  const canonicalOrigin = (
    options.canonicalOrigin ||
    process.env.CANONICAL_ORIGIN ||
    DEFAULT_CANONICAL_ORIGIN
  ).replace(/\/+$/, "");
  const mode = detectMode(baseUrl, options.mode || process.env.SEO_MODE || "auto");
  const bypassSecret = options.bypassSecret ?? process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
  const sampleJobPathInput = String(options.sampleJobPath ?? process.env.SAMPLE_JOB_PATH ?? "").trim();
  const expiredJobPathInput = String(options.expiredJobPath ?? process.env.EXPIRED_JOB_PATH ?? "").trim();
  const expiredJobMode = String(
    options.expiredJobMode ?? process.env.EXPIRED_JOB_MODE ?? "any",
  ).toLowerCase();
  const requireNoindexExpired =
    options.requireNoindexExpired ?? process.env.REQUIRE_NOINDEX_EXPIRED !== "false";
  const previewStrictNoindex = Boolean(
    options.previewPlatformNoindex ??
      (process.env.PREVIEW_PLATFORM_NOINDEX === "true" ||
        (process.env.PREVIEW_PLATFORM_NOINDEX !== "false" &&
          (mode === "preview" || isPlatformPreviewHost(baseUrl)))),
  );
  const requireLlmsTxt = options.requireLlmsTxt ?? process.env.REQUIRE_LLMS_TXT !== "0";
  const requireAiFeeds = Boolean(options.requireAiFeeds ?? process.env.REQUIRE_AI_FEEDS === "true");
  const timeoutMs = Number(options.timeoutMs ?? process.env.SEO_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxRetries = Number(options.maxRetries ?? process.env.SEO_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);
  const retryBaseDelayMs = Number(options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS);
  const maxChildSitemaps = Number(options.maxChildSitemaps ?? process.env.SEO_MAX_CHILD_SITEMAPS ?? 5);
  const saveSsrPath = options.saveSsrPath || "";
  const now = options.now ? new Date(options.now) : new Date();

  const fetchOpts = {
    baseOrigin,
    bypassSecret,
    timeoutMs,
    maxRetries,
    retryBaseDelayMs,
    allowLocalhost,
    fetchImpl: options.fetchImpl || globalThis.fetch,
  };

  const gates = [];
  const addGate = (id, name, status, summary, details = {}) => {
    gates.push({ id, name, status, summary, details });
  };

  const buildUrl = (pathOrUrl) => {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      const u = new URL(pathOrUrl);
      return `${baseUrl}${u.pathname}${u.search}`;
    }
    const cleanPath = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
    return `${baseUrl}${cleanPath}`;
  };

  let ssrSnapshotHtml = "";

  // =========================================================================
  // G1-HOME-SSR & G2-INDEXING
  // =========================================================================
  let homeRes;
  let homeMeta = null;
  try {
    homeRes = await fetchUrl(buildUrl("/"), fetchOpts);
    ssrSnapshotHtml = homeRes.body;

    if (homeRes.vercelProtected) {
      addGate(
        "G1-HOME-SSR",
        "Homepage SSR & Core Meta",
        "FAIL",
        `HTTP ${homeRes.status} - Preview deployment is locked by Vercel Authentication.`,
        {
          hint: "Set VERCEL_AUTOMATION_BYPASS_SECRET from Vercel Project Settings -> Deployment Protection.",
          status: homeRes.status,
          url: homeRes.url,
          vercelProtected: true,
        },
      );
      return finalizeReport({ baseUrl, canonicalOrigin, mode, gates, startedAt: now, ssrSnapshotHtml, saveSsrPath });
    }

    homeMeta = extractHtmlMetadata(homeRes.body);
    const homeErrors = [];
    const homeWarnings = [];

    if (homeRes.status !== 200) {
      homeErrors.push(`Homepage returned HTTP ${homeRes.status} (expected 200)`);
    }
    if (homeMeta.wordCount < 100) {
      homeErrors.push(
        `Possible empty SPA shell regression: SSR wordCount=${homeMeta.wordCount} (<100 words)`,
      );
    }
    if (!homeMeta.lang || !homeMeta.lang.toLowerCase().startsWith("id")) {
      homeWarnings.push(`<html lang="${homeMeta.lang || "missing"}"> (expected "id")`);
    }
    if (!homeMeta.title || homeMeta.title.length < 10) {
      homeErrors.push(`Missing or too-short <title>: "${homeMeta.title || ""}"`);
    } else if (homeMeta.title.length > 65) {
      homeWarnings.push(`<title> is ${homeMeta.title.length} chars (>65 SERP guard)`);
    }
    if (!homeMeta.description || homeMeta.description.length < 50) {
      homeErrors.push(`Missing or too-short meta description (${homeMeta.description?.length || 0} chars)`);
    } else if (homeMeta.description.length < 150 || homeMeta.description.length > 160) {
      homeWarnings.push(`Meta description is ${homeMeta.description.length} chars (target 150-160)`);
    }
    if (homeMeta.h1s.length === 0) {
      homeErrors.push("Homepage is missing an SSR <h1> heading");
    } else if (homeMeta.h1s.length > 1) {
      homeWarnings.push(`Homepage has ${homeMeta.h1s.length} <h1> tags`);
    }
    if (!homeMeta.og["og:title"] || !homeMeta.og["og:description"]) {
      homeWarnings.push("Missing Open Graph og:title or og:description tags");
    }

    const homeJsonLd = parseJsonLdBlocks(homeMeta.jsonLdRawBlocks);
    homeErrors.push(...homeJsonLd.securityIssues, ...homeJsonLd.parseErrors);
    const homeTypes = homeJsonLd.nodes.map((n) => n["@type"]).filter(Boolean);
    if (homeTypes.length === 0) {
      homeWarnings.push("Homepage has 0 JSON-LD blocks (recommended: GovernmentOrganization)");
    }

    addGate(
      "G1-HOME-SSR",
      "Homepage SSR & Core Meta",
      homeErrors.length > 0 ? "FAIL" : homeWarnings.length > 0 ? "WARN" : "PASS",
      homeErrors.length > 0
        ? homeErrors[0]
        : `HTTP 200 | ${homeMeta.wordCount} SSR words | H1="${homeMeta.h1s[0] || ""}" | ${homeRes.durationMs}ms`,
      {
        status: homeRes.status,
        durationMs: homeRes.durationMs,
        wordCount: homeMeta.wordCount,
        lang: homeMeta.lang,
        title: homeMeta.title,
        descriptionLength: homeMeta.description?.length ?? 0,
        h1Count: homeMeta.h1s.length,
        jsonLdTypes: homeTypes,
        errors: homeErrors,
        warnings: homeWarnings,
      },
    );

    // G2-INDEXING: Preview vs Production Indexing Safety + Preview Noindex Trap Awareness
    const idxErrors = [];
    const idxWarnings = [];
    const xRobots = (homeRes.headers["x-robots-tag"] || "").toLowerCase();
    const headerHasNoindex = /\bnoindex\b/i.test(xRobots);
    const htmlHasNoindex = homeMeta.hasHtmlNoindex;

    if (mode === "preview") {
      if (!headerHasNoindex && !htmlHasNoindex) {
        idxWarnings.push("Preview deployment is missing X-Robots-Tag: noindex (risk of indexing preview URL)");
      }
      if (htmlHasNoindex) {
        idxErrors.push("Preview homepage emits HTML <meta name=\"robots\" content=\"noindex\"> in app code (will block indexing if shipped to production)");
      }
    } else if (mode === "production") {
      if (headerHasNoindex || htmlHasNoindex) {
        idxErrors.push(
          `CRITICAL: Production homepage emits noindex (X-Robots-Tag="${homeRes.headers["x-robots-tag"] || ""}", meta="${homeMeta.metaRobots || ""}")`,
        );
      }
    }

    if (!homeMeta.canonical) {
      idxWarnings.push(`Missing <link rel="canonical"> on homepage (expected ${canonicalOrigin}/)`);
    } else if (/\.vercel\.app/i.test(homeMeta.canonical)) {
      idxErrors.push(
        `Homepage canonical leaks ephemeral preview host: "${homeMeta.canonical}" (expected ${canonicalOrigin})`,
      );
    } else if (!homeMeta.canonical.startsWith(canonicalOrigin)) {
      idxWarnings.push(
        `Homepage canonical "${homeMeta.canonical}" differs from canonicalOrigin "${canonicalOrigin}"`,
      );
    }

    addGate(
      "G2-INDEXING",
      `Indexing Safety & Preview Noindex Guard (${mode})`,
      idxErrors.length > 0 ? "FAIL" : idxWarnings.length > 0 ? "WARN" : "PASS",
      idxErrors.length > 0
        ? idxErrors[0]
        : `mode=${mode} | previewStrictMetaNoindex=${String(previewStrictNoindex)} | x-robots-tag="${homeRes.headers["x-robots-tag"] || "none"}"`,
      {
        mode,
        previewStrictNoindex,
        xRobotsTag: homeRes.headers["x-robots-tag"] || null,
        metaRobots: homeMeta.metaRobots || null,
        canonical: homeMeta.canonical || null,
        errors: idxErrors,
        warnings: idxWarnings,
      },
    );
  } catch (err) {
    addGate("G1-HOME-SSR", "Homepage SSR & Core Meta", "FAIL", `Fetch failed: ${err.message}`, {
      error: err.message,
    });
    return finalizeReport({ baseUrl, canonicalOrigin, mode, gates, startedAt: now, ssrSnapshotHtml, saveSsrPath });
  }

  // =========================================================================
  // G3-ROBOTS
  // =========================================================================
  try {
    const robotsRes = await fetchUrl(buildUrl("/robots.txt"), fetchOpts);
    if (robotsRes.status !== 200) {
      addGate("G3-ROBOTS", "robots.txt Crawlability", "FAIL", `HTTP ${robotsRes.status} on /robots.txt`, {
        status: robotsRes.status,
      });
    } else {
      const check = validateRobotsTxt(robotsRes.body, canonicalOrigin);
      addGate(
        "G3-ROBOTS",
        "robots.txt Crawlability",
        check.ok ? (check.warnings.length > 0 ? "WARN" : "PASS") : "FAIL",
        check.ok
          ? `HTTP 200 | User-agent present | Sitemaps=${check.sitemaps.length}`
          : check.issues[0],
        {
          status: robotsRes.status,
          durationMs: robotsRes.durationMs,
          errors: check.issues,
          ...check,
        },
      );
    }
  } catch (err) {
    addGate("G3-ROBOTS", "robots.txt Crawlability", "FAIL", `Fetch failed: ${err.message}`, {
      error: err.message,
    });
  }

  // =========================================================================
  // G4-SITEMAP (Supports <urlset> & sharded <sitemapindex> + CDATA + &amp;)
  // =========================================================================
  let allSitemapLocs = [];
  const sitemapPathnames = new Set();
  try {
    const smRes = await fetchUrl(buildUrl("/sitemap.xml"), fetchOpts);
    const smErrors = [];
    const smWarnings = [];
    const ct = (smRes.headers["content-type"] || "").toLowerCase();
    let kind = "unknown";
    let childSitemapsChecked = 0;

    if (smRes.status !== 200) {
      smErrors.push(`/sitemap.xml returned HTTP ${smRes.status} (expected 200)`);
    } else {
      if (!ct.includes("xml")) {
        smErrors.push(`/sitemap.xml returned non-XML Content-Type "${ct || "empty"}"`);
      }
      if (smRes.durationMs > SITEMAP_SLOW_MS) {
        smWarnings.push(`sitemap.xml slow TTFB (${smRes.durationMs}ms > ${SITEMAP_SLOW_MS}ms)`);
      }

      const parsed = parseSitemapXml(smRes.body);
      kind = parsed.kind;

      if (!parsed.validRoot) {
        smErrors.push("/sitemap.xml missing valid <urlset> or <sitemapindex> root element");
      } else if (parsed.locs.length === 0) {
        smErrors.push("/sitemap.xml contains 0 <loc> URLs");
      } else if (parsed.kind === "sitemapindex") {
        const children = parsed.locs.slice(0, maxChildSitemaps);
        for (const childUrl of children) {
          childSitemapsChecked += 1;
          let targetChild;
          try {
            targetChild = buildUrl(childUrl);
          } catch {
            smErrors.push(`Invalid child sitemap URL: ${childUrl}`);
            continue;
          }
          const childRes = await fetchUrl(targetChild, fetchOpts);
          if (childRes.status !== 200) {
            smErrors.push(`Child sitemap ${childUrl} returned HTTP ${childRes.status}`);
            continue;
          }
          const childCt = (childRes.headers["content-type"] || "").toLowerCase();
          if (!childCt.includes("xml")) {
            smErrors.push(`Child sitemap ${childUrl} returned non-XML Content-Type "${childCt}"`);
          }
          const childParsed = parseSitemapXml(childRes.body);
          if (childParsed.locs.length > MAX_SITEMAP_URLS) {
            smErrors.push(`Child sitemap ${childUrl} exceeds 50,000 URL limit (${childParsed.locs.length})`);
          }
          allSitemapLocs.push(...childParsed.locs);
        }
      } else {
        allSitemapLocs = parsed.locs;
        if (allSitemapLocs.length > MAX_SITEMAP_URLS) {
          smErrors.push(`sitemap.xml exceeds 50,000 URL limit (${allSitemapLocs.length}); shard with generateSitemaps()`);
        }
      }

      if (allSitemapLocs.length === 0 && smErrors.length === 0) {
        smErrors.push("sitemap.xml resolved 0 URLs");
      }

      const normalizedLocs = allSitemapLocs.map((u) => {
        try {
          const p = new URL(u);
          return `${p.origin}${normalizePathname(p.pathname)}${p.search}`;
        } catch {
          return u;
        }
      });
      const dupCount = normalizedLocs.length - new Set(normalizedLocs).size;
      if (dupCount > 0) {
        smErrors.push(`sitemap.xml contains ${dupCount} duplicate URL(s)`);
      }

      const invalidLoc = allSitemapLocs.find((u) => {
        try {
          const p = new URL(u);
          return p.protocol !== "http:" && p.protocol !== "https:";
        } catch {
          return true;
        }
      });
      if (invalidLoc) {
        smErrors.push(`sitemap.xml contains invalid <loc> URL: ${invalidLoc}`);
      }

      const vercelLeak = allSitemapLocs.find((u) => /\.vercel\.app/i.test(u));
      if (vercelLeak) {
        smErrors.push(`sitemap.xml leaks preview host URL "${vercelLeak}" instead of ${canonicalOrigin}`);
      }

      for (const u of allSitemapLocs) {
        sitemapPathnames.add(normalizePathname(u));
      }
    }

    addGate(
      "G4-SITEMAP",
      "sitemap.xml & Sitemapindex Discovery",
      smErrors.length > 0 ? "FAIL" : smWarnings.length > 0 ? "WARN" : "PASS",
      smErrors.length > 0
        ? smErrors[0]
        : `HTTP 200 | ${kind} | ${allSitemapLocs.length} URLs | canonical origin clean`,
      {
        status: smRes.status,
        kind,
        contentType: ct,
        durationMs: smRes.durationMs,
        urlCount: allSitemapLocs.length,
        childSitemapsChecked,
        sampleUrls: allSitemapLocs.slice(0, 5),
        errors: smErrors,
        warnings: smWarnings,
      },
    );
  } catch (err) {
    addGate("G4-SITEMAP", "sitemap.xml & Sitemapindex Discovery", "FAIL", `Fetch failed: ${err.message}`, {
      error: err.message,
    });
  }

  // =========================================================================
  // G5-CANONICAL-ROOT-GUARD & G6-JOBPOSTING-ACTIVE
  // =========================================================================
  const customJobRegex = process.env.JOB_PATH_REGEX ? new RegExp(process.env.JOB_PATH_REGEX) : null;
  const resolvedJobPath =
    (sampleJobPathInput ? normalizePathname(sampleJobPathInput) : null) ||
    selectSampleJobPath(allSitemapLocs, customJobRegex);

  let jobRes = null;
  let jobMeta = null;

  // Always audit at least one inner route for Blocker #0 root-canonical bug
  const innerRouteToAudit = resolvedJobPath || "/magang-nasional/lowongan";
  try {
    const innerRes = await fetchUrl(buildUrl(innerRouteToAudit), {
      ...fetchOpts,
      redirect: "manual",
    });

    if (resolvedJobPath) {
      jobRes = innerRes;
      if (innerRes.status === 200 && innerRes.body) {
        jobMeta = extractHtmlMetadata(innerRes.body);
        ssrSnapshotHtml = innerRes.body;
      }
    }

    const innerMeta = jobMeta || extractHtmlMetadata(innerRes.body);
    const canonErrors = [];
    const canonWarnings = [];

    if (innerRes.status >= 300 && innerRes.status < 400) {
      canonErrors.push(
        `Inner route "${innerRouteToAudit}" redirected HTTP ${innerRes.status} -> ${innerRes.headers["location"] || "(unknown)"}`,
      );
    } else if (innerRes.status !== 200) {
      canonErrors.push(`Inner route "${innerRouteToAudit}" returned HTTP ${innerRes.status} (expected 200)`);
    } else {
      if (innerMeta.canonicals.length === 0) {
        canonWarnings.push(`Inner route "${innerRouteToAudit}" is missing <link rel="canonical">`);
      } else {
        for (const href of innerMeta.canonicals) {
          if (/\.vercel\.app/i.test(href)) {
            canonErrors.push(
              `Inner route "${innerRouteToAudit}" canonical leaks preview host: "${href}"`,
            );
          } else if (isCanonicalRootLocked(href, baseUrl)) {
            canonErrors.push(
              `BLOCKER #0 DETECTED: Inner route "${innerRouteToAudit}" has <link rel="canonical" href="${href}"> locked to root "/"`,
            );
          } else if (!href.startsWith(canonicalOrigin)) {
            canonWarnings.push(
              `Inner route "${innerRouteToAudit}" canonical "${href}" differs from canonicalOrigin "${canonicalOrigin}"`,
            );
          }
        }
      }

      if (homeMeta?.title && innerMeta.title && homeMeta.title === innerMeta.title) {
        canonWarnings.push(
          `Inner route "${innerRouteToAudit}" shares identical <title> with homepage ("${innerMeta.title}")`,
        );
      }
    }

    addGate(
      "G5-CANONICAL-ROOT-GUARD",
      "Inner-Route Self-Canonical Guard",
      canonErrors.length > 0 ? "FAIL" : canonWarnings.length > 0 ? "WARN" : "PASS",
      canonErrors.length > 0
        ? canonErrors[0]
        : `HTTP 200 | ${innerRouteToAudit} | canonical="${innerMeta.canonical || "missing"}"`,
      {
        auditedRoute: innerRouteToAudit,
        status: innerRes.status,
        canonical: innerMeta.canonical,
        canonicals: innerMeta.canonicals,
        title: innerMeta.title,
        errors: canonErrors,
        warnings: canonWarnings,
      },
    );
  } catch (err) {
    addGate(
      "G5-CANONICAL-ROOT-GUARD",
      "Inner-Route Self-Canonical Guard",
      "FAIL",
      `Fetch failed for ${innerRouteToAudit}: ${err.message}`,
      { auditedRoute: innerRouteToAudit, error: err.message },
    );
  }

  // G6-JOBPOSTING-ACTIVE
  if (!resolvedJobPath) {
    addGate(
      "G6-JOBPOSTING-ACTIVE",
      "Active JobPosting JSON-LD",
      "FAIL",
      "Could not resolve a sample job detail URL (sitemap.xml has 0 vacancy detail URLs and SAMPLE_JOB_PATH is unset).",
      {
        hint: "Publish /magang-nasional/lowongan/<slug> URLs in sitemap.xml or pass --sample-job.",
      },
    );
  } else if (!jobRes) {
    addGate(
      "G6-JOBPOSTING-ACTIVE",
      "Active JobPosting JSON-LD",
      "FAIL",
      `Failed to fetch active job detail route "${resolvedJobPath}".`,
      { path: resolvedJobPath },
    );
  } else {
    const ldErrors = [];
    const ldWarnings = [];

    if (jobRes.status >= 300 && jobRes.status < 400) {
      ldErrors.push(
        `Active job "${resolvedJobPath}" returned redirect HTTP ${jobRes.status} -> ${jobRes.headers["location"] || "(unknown)"}`,
      );
    } else if (jobRes.status !== 200) {
      ldErrors.push(`Active job "${resolvedJobPath}" returned HTTP ${jobRes.status} (expected 200)`);
    } else if (jobMeta) {
      if (jobMeta.hasHtmlNoindex) {
        ldErrors.push(`Active job "${resolvedJobPath}" contains HTML <meta name="robots" content="noindex">`);
      }
      if (jobMeta.wordCount < 40) {
        ldErrors.push(`Active job "${resolvedJobPath}" has only ${jobMeta.wordCount} SSR words`);
      }

      const parsedLd = parseJsonLdBlocks(jobMeta.jsonLdRawBlocks);
      ldErrors.push(...parsedLd.securityIssues, ...parsedLd.parseErrors);

      const jobPostingNode = parsedLd.nodes.find((n) => nodeHasType(n, "JobPosting"));
      if (!jobPostingNode) {
        ldErrors.push(`No @type="JobPosting" JSON-LD found on active job page "${resolvedJobPath}"`);
      } else {
        const jpResult = validateJobPosting(jobPostingNode, { now });
        ldErrors.push(...jpResult.errors);
        ldWarnings.push(...jpResult.warnings);
      }

      addGate(
        "G6-JOBPOSTING-ACTIVE",
        "Active JobPosting JSON-LD",
        ldErrors.length > 0 ? "FAIL" : ldWarnings.length > 0 ? "WARN" : "PASS",
        ldErrors.length > 0
          ? ldErrors[0]
          : `Valid JobPosting | title="${jobPostingNode.title}" | org="${jobPostingNode.hiringOrganization?.name}"`,
        {
          path: resolvedJobPath,
          status: jobRes.status,
          blocksFound: jobMeta.jsonLdRawBlocks.length,
          typesFound: parsedLd.nodes.map((n) => n["@type"]).filter(Boolean),
          title: jobPostingNode?.title || null,
          hiringOrganization: jobPostingNode?.hiringOrganization?.name || null,
          validThrough: jobPostingNode?.validThrough || null,
          jobLocationType: jobPostingNode?.jobLocationType || null,
          errors: ldErrors,
          warnings: ldWarnings,
        },
      );
    }
    if (jobRes.status !== 200) {
      addGate(
        "G6-JOBPOSTING-ACTIVE",
        "Active JobPosting JSON-LD",
        "FAIL",
        ldErrors[0] || `HTTP ${jobRes.status} on ${resolvedJobPath}`,
        { path: resolvedJobPath, status: jobRes.status, errors: ldErrors },
      );
    }
  }

  // =========================================================================
  // G7-EXPIRED-JOB-LIFECYCLE (410 / strip-schema / soft-404 / Preview Noindex Trap)
  // =========================================================================
  if (!expiredJobPathInput) {
    addGate(
      "G7-EXPIRED-JOB-LIFECYCLE",
      "Expired Job Lifecycle Guard",
      "WARN",
      "Skipped: pass --expired-job (or EXPIRED_JOB_PATH) to enforce expired vacancy lifecycle gate.",
      { skipped: true, expiredJobMode },
    );
  } else {
    const normalizedExpiredPath = normalizePathname(expiredJobPathInput);
    const expErrors = [];
    const expWarnings = [];
    let expStatus = null;
    let trapDetected = false;

    if (!["any", "410", "strip-schema"].includes(expiredJobMode)) {
      expErrors.push(`Invalid expiredJobMode "${expiredJobMode}" (expected any, 410, or strip-schema)`);
    }

    if (sitemapPathnames.has(normalizedExpiredPath)) {
      expErrors.push(`Expired job is still listed in sitemap.xml: ${normalizedExpiredPath}`);
    }

    try {
      const expRes = await fetchUrl(buildUrl(normalizedExpiredPath), {
        ...fetchOpts,
        redirect: "manual",
      });
      expStatus = expRes.status;

      if (expRes.status >= 300 && expRes.status < 400) {
        expErrors.push(
          `Soft-404 risk: expired job "${normalizedExpiredPath}" returned redirect HTTP ${expRes.status} -> ${expRes.headers["location"] || "(unknown)"}`,
        );
      } else if (expiredJobMode === "410") {
        if (expRes.status !== 410) {
          expErrors.push(`Mode "410" active, but "${normalizedExpiredPath}" returned HTTP ${expRes.status}`);
        } else {
          const parsedLd = parseJsonLdBlocks(extractHtmlMetadata(expRes.body).jsonLdRawBlocks);
          const leakedJobs = parsedLd.nodes.filter((n) => nodeHasType(n, "JobPosting"));
          if (leakedJobs.length > 0) {
            expErrors.push(`HTTP 410 response still contains ${leakedJobs.length} JobPosting JSON-LD block(s)`);
          }
          if (requireNoindexExpired) {
            const hasHeaderNoindex = /\bnoindex\b/i.test(expRes.headers["x-robots-tag"] || "");
            const hasHtmlNoindex = hasHtmlMetaNoindex(expRes.body);
            if (!hasHeaderNoindex && !hasHtmlNoindex) {
              expErrors.push("HTTP 410 response is missing X-Robots-Tag: noindex or HTML meta noindex");
            }
          }
        }
      } else if (expRes.status === 410 || expRes.status === 404) {
        if (expiredJobMode === "strip-schema") {
          expErrors.push(`Mode "strip-schema" expects HTTP 200, but received HTTP ${expRes.status}`);
        } else {
          const parsedLd = parseJsonLdBlocks(extractHtmlMetadata(expRes.body).jsonLdRawBlocks);
          const leakedJobs = parsedLd.nodes.filter((n) => nodeHasType(n, "JobPosting"));
          if (leakedJobs.length > 0) {
            expErrors.push(`HTTP ${expRes.status} response still leaks JobPosting JSON-LD`);
          }
        }
      } else if (expRes.status === 200) {
        const expMeta = extractHtmlMetadata(expRes.body);
        const parsedLd = parseJsonLdBlocks(expMeta.jsonLdRawBlocks);
        expErrors.push(...parsedLd.securityIssues, ...parsedLd.parseErrors);

        const leakedJobs = parsedLd.nodes.filter((n) => nodeHasType(n, "JobPosting"));
        if (leakedJobs.length > 0) {
          expErrors.push(
            `Expired job "${normalizedExpiredPath}" still emits ${leakedJobs.length} JobPosting JSON-LD block(s) on HTTP 200`,
          );
        }

        // Soft-404 guard: expired page MUST NOT canonicalize to homepage / or vercel.app
        for (const href of expMeta.canonicals) {
          if (isCanonicalRootLocked(href, baseUrl)) {
            expErrors.push(`Expired job "${normalizedExpiredPath}" canonicalizes to root "/" (${href})`);
          } else if (/\.vercel\.app/i.test(href)) {
            expErrors.push(`Expired job "${normalizedExpiredPath}" canonical leaks preview host (${href})`);
          }
        }

        if (requireNoindexExpired) {
          const htmlNoindex = expMeta.hasHtmlNoindex;
          const headerNoindex = /\bnoindex\b/i.test(expRes.headers["x-robots-tag"] || "");

          // CRITICAL: Vercel/Netlify/CF Preview X-Robots-Tag false-positive trap detector!
          if (previewStrictNoindex) {
            if (!htmlNoindex) {
              trapDetected = headerNoindex;
              expErrors.push(
                headerNoindex
                  ? `PREVIEW NOINDEX TRAP DETECTED: "${normalizedExpiredPath}" only has platform X-Robots-Tag: noindex header, but is missing app-level <meta name="robots" content="noindex"> in HTML!`
                  : `Expired job "${normalizedExpiredPath}" on HTTP 200 is missing HTML <meta name="robots" content="noindex">`,
              );
            }
          } else if (!htmlNoindex && !headerNoindex) {
            expErrors.push(
              `Expired job "${normalizedExpiredPath}" on HTTP 200 is missing both HTML <meta name="robots" content="noindex"> and X-Robots-Tag: noindex`,
            );
          }
        }
      } else {
        expErrors.push(`Unexpected HTTP ${expRes.status} on expired job "${normalizedExpiredPath}"`);
      }
    } catch (err) {
      expErrors.push(`Failed to fetch expired job "${normalizedExpiredPath}": ${err.message}`);
    }

    addGate(
      "G7-EXPIRED-JOB-LIFECYCLE",
      "Expired Job Lifecycle Guard",
      expErrors.length > 0 ? "FAIL" : expWarnings.length > 0 ? "WARN" : "PASS",
      expErrors.length > 0
        ? expErrors[0]
        : `HTTP ${expStatus} | mode=${expiredJobMode} | 0 JobPosting leaked | previewStrict=${String(previewStrictNoindex)}`,
      {
        path: normalizedExpiredPath,
        mode: expiredJobMode,
        status: expStatus,
        previewStrictNoindex,
        previewTrapDetected: trapDetected,
        errors: expErrors,
        warnings: expWarnings,
      },
    );
  }

  // =========================================================================
  // G8-LLMS-TXT-AND-AI-FEEDS (/llms.txt + /ai/jobs.ndjson + /ai/faq.json)
  // =========================================================================
  const geoErrors = [];
  const geoWarnings = [];
  const geoDetails = {
    llmsTxt: null,
    jobsNdjson: null,
    faqJson: null,
  };

  try {
    const llmsRes = await fetchUrl(buildUrl("/llms.txt"), fetchOpts);
    if (llmsRes.status !== 200) {
      const msg = `HTTP ${llmsRes.status} on /llms.txt (missing AI discovery manifesto)`;
      if (requireLlmsTxt) geoErrors.push(msg);
      else geoWarnings.push(msg);
      geoDetails.llmsTxt = { status: llmsRes.status, durationMs: llmsRes.durationMs, ok: false };
    } else {
      const check = validateLlmsTxt(llmsRes.body);
      geoErrors.push(...check.errors);
      geoWarnings.push(...check.warnings);
      geoDetails.llmsTxt = { status: llmsRes.status, durationMs: llmsRes.durationMs, ...check };
    }
  } catch (err) {
    const msg = `Failed to fetch /llms.txt: ${err.message}`;
    if (requireLlmsTxt) geoErrors.push(msg);
    else geoWarnings.push(msg);
    geoDetails.llmsTxt = { error: err.message, ok: false };
  }

  // Probe structured AI feed: /ai/jobs.ndjson
  try {
    const ndRes = await fetchUrl(buildUrl("/ai/jobs.ndjson"), fetchOpts);
    if (ndRes.status === 200) {
      const lines = ndRes.body
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      let parseFailures = 0;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (!obj || typeof obj !== "object") parseFailures += 1;
        } catch {
          parseFailures += 1;
        }
      }
      if (parseFailures > 0) {
        geoErrors.push(`/ai/jobs.ndjson has ${parseFailures} malformed JSON line(s)`);
      }
      geoDetails.jobsNdjson = { status: ndRes.status, lines: lines.length, parseFailures, ok: parseFailures === 0 };
    } else {
      const msg = `/ai/jobs.ndjson returned HTTP ${ndRes.status}`;
      if (requireAiFeeds) geoErrors.push(msg);
      else geoWarnings.push(`${msg} (optional AI feed not yet deployed)`);
      geoDetails.jobsNdjson = { status: ndRes.status, ok: false };
    }
  } catch (err) {
    if (requireAiFeeds) geoErrors.push(`Failed to fetch /ai/jobs.ndjson: ${err.message}`);
    geoDetails.jobsNdjson = { error: err.message, ok: false };
  }

  // Probe structured AI feed: /ai/faq.json
  try {
    const faqRes = await fetchUrl(buildUrl("/ai/faq.json"), fetchOpts);
    if (faqRes.status === 200) {
      try {
        const parsedFaq = JSON.parse(faqRes.body);
        const itemCount = Array.isArray(parsedFaq?.items) ? parsedFaq.items.length : 0;
        if (itemCount === 0) {
          geoErrors.push("/ai/faq.json returned valid JSON but 0 FAQ items");
        }
        geoDetails.faqJson = { status: faqRes.status, itemCount, ok: itemCount > 0 };
      } catch (err) {
        geoErrors.push(`/ai/faq.json returned invalid JSON: ${err.message}`);
        geoDetails.faqJson = { status: faqRes.status, ok: false };
      }
    } else {
      const msg = `/ai/faq.json returned HTTP ${faqRes.status}`;
      if (requireAiFeeds) geoErrors.push(msg);
      else geoWarnings.push(`${msg} (optional AI feed not yet deployed)`);
      geoDetails.faqJson = { status: faqRes.status, ok: false };
    }
  } catch (err) {
    if (requireAiFeeds) geoErrors.push(`Failed to fetch /ai/faq.json: ${err.message}`);
    geoDetails.faqJson = { error: err.message, ok: false };
  }

  addGate(
    "G8-LLMS-TXT-AND-AI-FEEDS",
    "GEO llms.txt & AI Feeds",
    geoErrors.length > 0 ? "FAIL" : geoWarnings.length > 0 ? "WARN" : "PASS",
    geoErrors.length > 0
      ? geoErrors[0]
      : `llms.txt HTTP ${geoDetails.llmsTxt?.status ?? "err"} | jobs.ndjson HTTP ${geoDetails.jobsNdjson?.status ?? "err"} | faq.json HTTP ${geoDetails.faqJson?.status ?? "err"}`,
    {
      ...geoDetails,
      errors: geoErrors,
      warnings: geoWarnings,
    },
  );

  return finalizeReport({
    baseUrl,
    canonicalOrigin,
    mode,
    gates,
    startedAt: now,
    ssrSnapshotHtml,
    saveSsrPath,
    bypassSecret,
    deploymentSha: options.deploymentSha || process.env.DEPLOY_SHA || process.env.GITHUB_SHA || null,
  });
}

function finalizeReport({
  baseUrl,
  canonicalOrigin,
  mode,
  gates,
  startedAt,
  ssrSnapshotHtml,
  saveSsrPath,
  bypassSecret = "",
  deploymentSha = null,
}) {
  const secrets = bypassSecret ? [bypassSecret] : [];

  if (saveSsrPath && ssrSnapshotHtml) {
    mkdirSync(dirname(resolve(saveSsrPath)), { recursive: true });
    writeFileSync(saveSsrPath, redactSecrets(ssrSnapshotHtml, secrets), "utf8");
  }

  const sanitizedGates = redactDeep(gates, secrets);
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  const gateResults = {};
  for (const g of sanitizedGates) {
    counts[g.status] = (counts[g.status] || 0) + 1;
    gateResults[g.id] = g.status;
  }
  const ok = counts.FAIL === 0;
  const timestamp = startedAt.toISOString();
  const basePayload = {
    ok,
    timestamp,
    targetUrl: redactSecrets(baseUrl, secrets),
    canonicalOrigin: redactSecrets(canonicalOrigin, secrets),
    mode,
    counts,
    gates: sanitizedGates,
  };
  // STRIDE-R-01: Cryptographic SHA-256 audit digest + structured audit metadata (zero secret leakage)
  const reportSha256 = createHash("sha256")
    .update(JSON.stringify(basePayload), "utf8")
    .digest("hex");

  return {
    ...basePayload,
    audit: {
      timestamp,
      deploymentSha: deploymentSha ? redactSecrets(String(deploymentSha), secrets) : null,
      gateResults,
      reportSha256,
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting (Terminal, JSON Artifact & GitHub Step Summary)
// ---------------------------------------------------------------------------

export function formatMarkdownSummary(report) {
  const badge = report.ok ? "PASS" : "FAIL";
  const lines = [
    `## MagangHub SEO & GEO CI Gate: **${badge}**`,
    "",
    `- **Target URL:** \`${redactSecrets(report.targetUrl)}\``,
    `- **Mode:** \`${report.mode}\` | **Canonical Origin:** \`${redactSecrets(report.canonicalOrigin)}\``,
    `- **Score:** \`${report.counts.PASS}\` pass | \`${report.counts.WARN}\` warn | \`${report.counts.FAIL}\` fail`,
    `- **Timestamp:** \`${report.timestamp}\`${report.audit?.reportSha256 ? ` | **Report SHA-256:** \`${report.audit.reportSha256.slice(0, 16)}\`` : ""}`,
    "",
    "| Gate | Check | Status | Summary |",
    "| :--- | :--- | :---: | :--- |",
  ];

  for (const g of report.gates) {
    const safeSummary = String(g.summary || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    lines.push(`| \`${g.id}\` | ${g.name} | **${g.status}** | ${safeSummary} |`);
  }

  const failures = report.gates.filter((g) => g.status === "FAIL");
  if (failures.length > 0) {
    lines.push("", "### Failure Details");
    for (const f of failures) {
      lines.push(`- **${f.id} (${f.name}):** ${f.summary}`);
      if (Array.isArray(f.details?.errors) && f.details.errors.length > 1) {
        for (const extra of f.details.errors.slice(1)) {
          lines.push(`  - ${extra}`);
        }
      }
      if (f.details?.hint) {
        lines.push(`  - Hint: ${f.details.hint}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function parseCliArgs(argv) {
  const args = {
    url: undefined,
    mode: undefined,
    canonical: undefined,
    sampleJob: undefined,
    expiredJob: undefined,
    expiredMode: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    jsonOut: undefined,
    saveSsr: undefined,
    previewStrict: undefined,
    requireAiFeeds: false,
    auditOnly: false,
    allowLocalhost: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) args.url = argv[++i];
    else if (a === "--mode" && argv[i + 1]) args.mode = argv[++i];
    else if (a === "--canonical" && argv[i + 1]) args.canonical = argv[++i];
    else if (a === "--sample-job" && argv[i + 1]) args.sampleJob = argv[++i];
    else if (a === "--expired-job" && argv[i + 1]) args.expiredJob = argv[++i];
    else if (a === "--expired-mode" && argv[i + 1]) args.expiredMode = argv[++i];
    else if (a === "--timeout" && argv[i + 1]) args.timeoutMs = Number(argv[++i]);
    else if (a === "--max-retries" && argv[i + 1]) args.maxRetries = Number(argv[++i]);
    else if ((a === "--json-out" || a === "--json") && argv[i + 1]) args.jsonOut = argv[++i];
    else if (a === "--save-ssr" && argv[i + 1]) args.saveSsr = argv[++i];
    else if (a === "--preview-strict") args.previewStrict = true;
    else if (a === "--require-ai-feeds") args.requireAiFeeds = true;
    else if (a === "--audit-only") args.auditOnly = true;
    else if (a === "--allow-localhost") args.allowLocalhost = true;
  }
  return args;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const report = await runSeoValidation({
    baseUrl: cli.url,
    mode: cli.mode,
    canonicalOrigin: cli.canonical,
    sampleJobPath: cli.sampleJob,
    expiredJobPath: cli.expiredJob,
    expiredJobMode: cli.expiredMode,
    timeoutMs: cli.timeoutMs,
    maxRetries: cli.maxRetries,
    previewPlatformNoindex: cli.previewStrict,
    requireAiFeeds: cli.requireAiFeeds,
    saveSsrPath: cli.saveSsr,
    allowLocalhost: cli.allowLocalhost || undefined,
  });

  const md = formatMarkdownSummary(report);
  console.log(md);

  if (cli.jsonOut) {
    mkdirSync(dirname(resolve(cli.jsonOut)), { recursive: true });
    writeFileSync(cli.jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`JSON report written to ${cli.jsonOut}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`, "utf8");
  }

  if (!report.ok && !cli.auditOnly) {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();

if (isDirectRun) {
  main().catch((err) => {
    console.error(`[SEO-CI-GATE FATAL] ${redactSecrets(err?.message || err)}`);
    process.exitCode = 1;
  });
}
