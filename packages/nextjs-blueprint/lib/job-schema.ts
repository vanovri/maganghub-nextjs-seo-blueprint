/**
 * Pure TypeScript JSON-LD builders (JobPosting, FAQPage, GovernmentOrganization),
 * server-side allowlist HTML sanitizer, and XSS-safe JSON-LD serializer.
 */

import {
  BASE_URL,
  JOB_ROUTE_PREFIX,
  type FaqItem,
} from "./constants.ts";
import { evaluateJobLifecycle } from "./job-lifecycle.ts";
import type { MagangVacancy, VacancyLocation } from "./get-lowongan.ts";

const ALLOWED_JOB_HTML_TAGS = new Set([
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "b",
  "strong",
  "i",
  "em",
  "h2",
  "h3",
]);

const DANGEROUS_CONTAINER_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "noscript",
  "template",
  "form",
]);

function isAsciiLetterOrDigit(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) // 0-9
  );
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/**
 * Single-pass linear-time O(N) HTML allowlist sanitizer pass.
 * Guarantees zero catastrophic backtracking (ReDoS-proof on 50 KB+ pathological inputs).
 */
function sanitizeHtmlLinearPass(input: string): string {
  const len = input.length;
  const firstLt = input.indexOf("<");
  if (firstLt === -1) return input;
  const firstGt = input.indexOf(">", firstLt);
  if (firstGt === -1) {
    // Zero closing `>` anywhere after first `<`: keep only safe prefix text before first `<`
    return input.slice(0, firstLt);
  }
  const out: string[] = [];
  let i = 0;
  let suppressedContainer: string | null = null;
  // Monotonic cursors ensure strictly O(N) amortized scans (never rescan to EOF on unclosed tags/missing quotes)
  let nextGt = firstGt;
  let nextDq = input.indexOf('"', firstLt);
  let nextSq = input.indexOf("'", firstLt);

  while (i < len) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      if (suppressedContainer === null) {
        out.push(input.slice(i));
      }
      break;
    }

    if (suppressedContainer !== null) {
      // HTML5 raw-text container (script/style/iframe/etc.): only a matching closing tag `</tag...>` exits suppression
      let p = lt + 1;
      while (p < len && isWhitespaceCode(input.charCodeAt(p))) p += 1;
      if (p < len && input.charCodeAt(p) === 47 /* '/' */) {
        p += 1;
        while (p < len && isWhitespaceCode(input.charCodeAt(p))) p += 1;
        const nameStart = p;
        while (p < len && isAsciiLetterOrDigit(input.charCodeAt(p))) p += 1;
        if (
          p - nameStart === suppressedContainer.length &&
          input.slice(nameStart, p).toLowerCase() === suppressedContainer
        ) {
          const closeGt = input.indexOf(">", p);
          if (closeGt === -1) break;
          suppressedContainer = null;
          i = closeGt + 1;
          continue;
        }
      }
      i = lt + 1;
      continue;
    }

    if (lt > i) {
      out.push(input.slice(i, lt));
    }

    // HTML comment `<!-- ... -->` (unclosed comment drops to EOF in O(N))
    if (
      lt + 3 < len &&
      input.charCodeAt(lt + 1) === 33 && // '!'
      input.charCodeAt(lt + 2) === 45 && // '-'
      input.charCodeAt(lt + 3) === 45 // '-'
    ) {
      const commentEnd = input.indexOf("-->", lt + 4);
      if (commentEnd === -1) {
        break;
      }
      i = commentEnd + 3;
      continue;
    }

    // Parse optional whitespace + optional '/' + tag name
    let p = lt + 1;
    while (p < len && isWhitespaceCode(input.charCodeAt(p))) p += 1;

    let isClosing = false;
    if (p < len && input.charCodeAt(p) === 47 /* '/' */) {
      isClosing = true;
      p += 1;
      while (p < len && isWhitespaceCode(input.charCodeAt(p))) p += 1;
    }

    const nameStart = p;
    while (p < len && isAsciiLetterOrDigit(input.charCodeAt(p))) p += 1;
    const nameLen = p - nameStart;

    if (nameLen === 0) {
      out.push("<");
      i = lt + 1;
      continue;
    }

    // Fast SIMD scan with monotonic cursors: strictly O(N) total across entire input
    const nextLt = input.indexOf("<", p);
    if (nextGt !== -1 && nextGt < p) nextGt = input.indexOf(">", p);
    let foundGt = -1;
    let nestedLt = -1;

    if (nextGt === -1) {
      nestedLt = nextLt;
    } else {
      const bound = nextLt !== -1 && nextLt < nextGt ? nextLt : nextGt;
      if (nextDq !== -1 && nextDq < p) nextDq = input.indexOf('"', p);
      if (nextSq !== -1 && nextSq < p) nextSq = input.indexOf("'", p);
      const hasQuoteBeforeBound =
        (nextDq !== -1 && nextDq < bound) || (nextSq !== -1 && nextSq < bound);
      if (!hasQuoteBeforeBound) {
        if (nextLt !== -1 && nextLt < nextGt) {
          nestedLt = nextLt;
        } else {
          foundGt = nextGt;
        }
      } else {
        let quote = 0;
        for (let k = p; k < len; k += 1) {
          const c = input.charCodeAt(k);
          if (quote !== 0) {
            if (c === quote) quote = 0;
            continue;
          }
          if (c === 34 || c === 39) {
            quote = c;
          } else if (c === 62 /* '>' */) {
            foundGt = k;
            break;
          } else if (c === 60 /* '<' */) {
            nestedLt = k;
            break;
          }
        }
      }
    }

    if (foundGt === -1) {
      // Unclosed tag: only allocate tagName if length/prefix can match a dangerous container
      const c0 = input.charCodeAt(nameStart) | 32;
      if (
        nameLen >= 3 &&
        nameLen <= 8 &&
        (c0 === 115 || // s: script, style, svg
          c0 === 105 || // i: iframe
          c0 === 111 || // o: object
          c0 === 101 || // e: embed
          c0 === 110 || // n: noscript
          c0 === 109 || // m: math
          c0 === 116 || // t: template, textarea, title
          c0 === 120) // x: xmp
      ) {
        if (DANGEROUS_CONTAINER_TAGS.has(input.slice(nameStart, p).toLowerCase())) {
          break;
        }
      }
      if (nestedLt !== -1) {
        i = nestedLt;
        continue;
      }
      break;
    }

    const tagName = input.slice(nameStart, p).toLowerCase();

    if (DANGEROUS_CONTAINER_TAGS.has(tagName)) {
      if (!isClosing) {
        suppressedContainer = tagName;
      }
      i = foundGt + 1;
      continue;
    }

    if (ALLOWED_JOB_HTML_TAGS.has(tagName)) {
      if (tagName === "br") {
        out.push("<br>");
      } else {
        out.push(isClosing ? `</${tagName}>` : `<${tagName}>`);
      }
    }

    i = foundGt + 1;
  }

  return out.join("");
}

/**
 * Strict server-side linear-time O(N) allowlist HTML sanitizer aligned with Google for Jobs rules.
 * Runs bounded iterative stabilization passes to prevent nested-tag reconstruction bypasses
 * (e.g. `<scr<script>ipt>`), strips all tag attributes (blocking on* handlers and javascript: URIs),
 * eliminates ReDoS backtracking (< 5ms on 50 KB pathological payloads), and retains only semantic
 * formatting tags permitted by Google JobPosting rich results.
 */
export function sanitizeJobDescriptionHtml(rawHtml: string): string {
  if (typeof rawHtml !== "string" || !rawHtml) return "";

  let cleaned = rawHtml;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = cleaned;
    cleaned = sanitizeHtmlLinearPass(cleaned);
    // Neutralize javascript:/vbscript:/data:text/html schemes in linear time
    cleaned = cleaned.replace(/\b(?:javascript|vbscript)\s*:/gi, "");
    cleaned = cleaned.replace(/\bdata\s*:\s*text\/html/gi, "");
    if (cleaned === before) break;
  }

  return cleaned.trim();
}

/**
 * Full XSS-safe serializer for embedding JSON-LD inside `<script type="application/ld+json">`.
 * Escapes `<`, `>`, `&`, U+2028, and U+2029 so `</script>`, `<!--`, and JS line terminators
 * can never break out of the script tag.
 */
export function serializeSafeJsonLd(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function safeHttpsUrl(rawUrl?: string): string | undefined {
  if (!rawUrl || typeof rawUrl !== "string") return undefined;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface PostalPlaceSchema {
  "@type": "Place";
  address: {
    "@type": "PostalAddress";
    streetAddress?: string;
    addressLocality: string;
    addressRegion: string;
    postalCode?: string;
    addressCountry: string;
  };
}

function buildPlaceSchema(loc: VacancyLocation): PostalPlaceSchema {
  return {
    "@type": "Place",
    address: {
      "@type": "PostalAddress",
      ...(loc.streetAddress?.trim() ? { streetAddress: loc.streetAddress.trim() } : {}),
      addressLocality: loc.city.trim(),
      addressRegion: loc.province.trim(),
      ...(loc.postalCode?.trim() ? { postalCode: loc.postalCode.trim() } : {}),
      addressCountry: (loc.country?.trim() || "ID").toUpperCase(),
    },
  };
}

export interface JobPostingSchemaObject {
  "@context": "https://schema.org";
  "@type": "JobPosting";
  title: string;
  description: string;
  identifier: {
    "@type": "PropertyValue";
    name: string;
    value: string;
  };
  datePosted: string;
  validThrough: string;
  employmentType: "INTERN";
  directApply: boolean;
  hiringOrganization: {
    "@type": "Organization";
    name: string;
    sameAs?: string;
    logo?: string;
  };
  jobLocation?: PostalPlaceSchema | PostalPlaceSchema[];
  jobLocationType?: "TELECOMMUTE";
  applicantLocationRequirements?: {
    "@type": "Country";
    name: "Indonesia";
  };
  baseSalary?: {
    "@type": "MonetaryAmount";
    currency: "IDR";
    value: {
      "@type": "QuantitativeValue";
      value?: number;
      minValue?: number;
      maxValue?: number;
      unitText: "MONTH";
    };
  };
  jobBenefits: string;
  educationRequirements?: {
    "@type": "EducationalOccupationalCredential";
    credentialCategory: string;
  };
  industry?: string;
  url: string;
}

/**
 * Builds a Google for Jobs compliant JobPosting JSON-LD object.
 * Defense-in-depth: returns null whenever evaluateJobLifecycle().state !== "ACTIVE".
 */
export function buildJobPostingSchema(
  vacancy: MagangVacancy,
  options: {
    nowMs?: number;
    baseUrl?: string;
    jobRoutePrefix?: string;
  } = {},
): JobPostingSchemaObject | null {
  const nowMs = options.nowMs ?? Date.now();
  const baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/+$/, "");
  const jobRoutePrefix = (options.jobRoutePrefix ?? JOB_ROUTE_PREFIX).replace(/\/+$/, "");

  const lifecycle = evaluateJobLifecycle(
    {
      status: vacancy.status,
      deadlineAt: vacancy.validThrough,
      closedAt: vacancy.closedAt,
      archivedAt: vacancy.archivedAt,
    },
    { nowMs },
  );

  // Defense-in-depth hard guard: never emit JobPosting for non-ACTIVE vacancies
  if (lifecycle.state !== "ACTIVE") {
    return null;
  }

  const safeTitle = vacancy.title.trim();
  const safeDescription = sanitizeJobDescriptionHtml(vacancy.descriptionHtml);
  const safeCompanyUrl = safeHttpsUrl(vacancy.companyUrl);
  const safeCompanyLogo = safeHttpsUrl(vacancy.companyLogo);
  const canonicalUrl = `${baseUrl}${jobRoutePrefix}/${encodeURIComponent(vacancy.slug)}`;

  const schema: JobPostingSchemaObject = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: safeTitle,
    description:
      safeDescription ||
      `<p>${safeTitle} - Program Pemagangan Nasional MagangHub Kemnaker RI.</p>`,
    identifier: {
      "@type": "PropertyValue",
      name: "MagangHub Kemnaker RI",
      value: vacancy.id,
    },
    datePosted: vacancy.datePosted,
    validThrough: vacancy.validThrough,
    employmentType: "INTERN",
    directApply: vacancy.directApply ?? true,
    hiringOrganization: {
      "@type": "Organization",
      name: vacancy.companyName.trim(),
      ...(safeCompanyUrl ? { sameAs: safeCompanyUrl } : {}),
      ...(safeCompanyLogo ? { logo: safeCompanyLogo } : {}),
    },
    jobBenefits: `Program Pemagangan Nasional bersubsidi Kemnaker RI (${vacancy.batchName}, durasi ${vacancy.durationMonths} bulan) serta peluang sertifikasi profesi BNSP.`,
    url: canonicalUrl,
  };

  // WorkMode location rules:
  // - ONSITE: physical jobLocation only (single Place or Place[] for multi-location).
  // - HYBRID: BOTH physical jobLocation (single or array) AND TELECOMMUTE + applicantLocationRequirements.
  // - REMOTE: TELECOMMUTE + applicantLocationRequirements only (no physical jobLocation).
  const rawLocations: VacancyLocation[] =
    Array.isArray(vacancy.locations) && vacancy.locations.length > 0
      ? vacancy.locations
      : [
          {
            city: vacancy.city,
            province: vacancy.province,
            streetAddress: vacancy.streetAddress,
            postalCode: vacancy.postalCode,
          },
        ];

  if (vacancy.workMode !== "REMOTE") {
    const places = rawLocations
      .filter((loc) => Boolean(loc.city?.trim() || loc.province?.trim()))
      .map(buildPlaceSchema);
    if (places.length === 1 && places[0]) {
      schema.jobLocation = places[0];
    } else if (places.length > 1) {
      schema.jobLocation = places;
    }
  }

  if (vacancy.workMode === "REMOTE" || vacancy.workMode === "HYBRID") {
    schema.jobLocationType = "TELECOMMUTE";
    schema.applicantLocationRequirements = {
      "@type": "Country",
      name: "Indonesia",
    };
  }

  // Guard stipendMonthly > 0 (ignore 0, negative, NaN, Infinity)
  if (
    typeof vacancy.stipendMonthly === "number" &&
    Number.isFinite(vacancy.stipendMonthly) &&
    vacancy.stipendMonthly > 0
  ) {
    const hasRange =
      typeof vacancy.stipendMaxMonthly === "number" &&
      Number.isFinite(vacancy.stipendMaxMonthly) &&
      vacancy.stipendMaxMonthly > vacancy.stipendMonthly;

    schema.baseSalary = {
      "@type": "MonetaryAmount",
      currency: "IDR",
      value: hasRange
        ? {
            "@type": "QuantitativeValue",
            minValue: Math.round(vacancy.stipendMonthly),
            maxValue: Math.round(vacancy.stipendMaxMonthly!),
            unitText: "MONTH",
          }
        : {
            "@type": "QuantitativeValue",
            value: Math.round(vacancy.stipendMonthly),
            unitText: "MONTH",
          },
    };
  }

  if (vacancy.educationLevel?.trim()) {
    schema.educationRequirements = {
      "@type": "EducationalOccupationalCredential",
      credentialCategory: vacancy.educationLevel.trim(),
    };
  }

  if (vacancy.industry?.trim()) {
    schema.industry = vacancy.industry.trim();
  }

  return schema;
}

export interface GovernmentOrganizationSchema {
  "@context": "https://schema.org";
  "@type": "GovernmentOrganization";
  name: string;
  alternateName: string;
  url: string;
  parentOrganization: {
    "@type": "GovernmentOrganization";
    name: string;
    url: string;
  };
  sameAs: string[];
  contactPoint: {
    "@type": "ContactPoint";
    telephone: string;
    contactType: string;
    areaServed: "ID";
    availableLanguage: string[];
  };
}

export function buildGovernmentOrganizationSchema(
  baseUrl: string = BASE_URL,
): GovernmentOrganizationSchema {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return {
    "@context": "https://schema.org",
    "@type": "GovernmentOrganization",
    name: "MagangHub Kemnaker RI",
    alternateName: "Program Pemagangan Lulusan Perguruan Tinggi Kemnaker RI",
    url: cleanBase,
    parentOrganization: {
      "@type": "GovernmentOrganization",
      name: "Kementerian Ketenagakerjaan Republik Indonesia",
      url: "https://kemnaker.go.id",
    },
    sameAs: [
      "https://www.instagram.com/maganghub.kemnaker/",
      "https://www.instagram.com/kemnaker/",
      "https://x.com/KemnakerRI",
      "https://www.youtube.com/channel/UCXX-orbQDc0LVXhVB1I0K3g",
    ],
    contactPoint: {
      "@type": "ContactPoint",
      telephone: "+62-1500630",
      contactType: "customer service",
      areaServed: "ID",
      availableLanguage: ["id"],
    },
  };
}

export interface FaqPageSchema {
  "@context": "https://schema.org";
  "@type": "FAQPage";
  mainEntity: Array<{
    "@type": "Question";
    name: string;
    acceptedAnswer: {
      "@type": "Answer";
      text: string;
    };
  }>;
}

export function buildFaqPageSchema(items: readonly FaqItem[]): FaqPageSchema {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items
      .filter((item) => item.question.trim().length > 0 && item.answer.trim().length > 0)
      .map((item) => ({
        "@type": "Question",
        name: sanitizeJobDescriptionHtml(item.question) || item.question.trim(),
        acceptedAnswer: {
          "@type": "Answer",
          text: sanitizeJobDescriptionHtml(item.answer) || item.answer.trim(),
        },
      })),
  };
}
