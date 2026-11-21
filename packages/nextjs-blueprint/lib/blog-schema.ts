/**
 * Hardened Blog / MDX Frontmatter Zod Schema for MagangHub Kemnaker Editorial & Panduan.
 *
 * Security & SEO invariants enforced at parse/build time:
 * 1. `emptyToUndefined` preprocess + strict date parser guarantees YAML `null`, `""`,
 *    `false`, or `0` NEVER coerces to `1970-01-01T00:00:00.000Z` (the classic `z.coerce.date()` trap).
 * 2. Strict calendar validation rejects rollover dates like `2026-02-30` or `2026-02-29`.
 * 3. Exact SERP & Social metadata length guards:
 *    - `seoTitle`, `openGraph.title`, `twitter.title`: <= 65 chars
 *    - `description`: 150-160 chars (inclusive)
 *    - `openGraph.description`, `twitter.description`: <= 160 chars
 * 4. Canonical path guard forbids pointing article canonicals to `/` or `*.vercel.app`.
 */

import { z } from "zod";
import { METADATA_LIMITS } from "./constants.ts";

/**
 * Converts null, undefined, or whitespace-only strings to undefined so optional
 * YAML fields (e.g. `updatedDate: null` or `updatedDate: ""`) never trigger
 * epoch-zero date coercion (`1970-01-01`).
 */
export function emptyToUndefined(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

const STRICT_DATE_RE =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,6}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/**
 * Parses strictly valid Date instances or ISO-8601 date/datetime strings.
 * Explicitly rejects booleans (`false`/`true`), numbers (`0`), `null`, `""`,
 * and impossible calendar dates (`2026-02-30`) so nothing ever silently coerces to 1970-01-01.
 */
export function parseStrictFrontmatterDate(value: unknown): Date | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    if (value.getUTCFullYear() < 2000 || value.getUTCFullYear() > 2100) return null;
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const match = STRICT_DATE_RE.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100) return null;

  // Reject calendar rollover (e.g. 2026-02-30 or non-leap 2026-02-29)
  const calendarProbe = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarProbe.getUTCFullYear() !== year ||
    calendarProbe.getUTCMonth() + 1 !== month ||
    calendarProbe.getUTCDate() !== day
  ) {
    return null;
  }

  // If date-only YYYY-MM-DD, interpret cleanly as UTC midnight
  const isoString = trimmed.includes("T") ? trimmed : `${trimmed}T00:00:00Z`;
  const parsedMs = Date.parse(isoString);
  if (!Number.isFinite(parsedMs)) return null;

  return new Date(parsedMs);
}

const strictRequiredDateSchema = z
  .unknown()
  .transform((val, ctx) => {
    const parsed = parseStrictFrontmatterDate(val);
    if (!parsed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Invalid date: expected ISO-8601 date/datetime (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss+07:00) or Date >= year 2000; null/empty/0/false are rejected",
      });
      return z.NEVER;
    }
    return parsed;
  });

const strictOptionalDateSchema = z.preprocess(
  emptyToUndefined,
  strictRequiredDateSchema.optional(),
);

const optionalTrimmedString = (minLen: number, maxLen: number, label: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .min(minLen, `${label} must be at least ${minLen} characters`)
      .max(maxLen, `${label} must be at most ${maxLen} characters`)
      .optional(),
  );

const socialMetaSchema = z
  .object({
    title: optionalTrimmedString(10, METADATA_LIMITS.maxSocialTitleChars, "social.title"),
    description: optionalTrimmedString(
      50,
      METADATA_LIMITS.maxSocialDescriptionChars,
      "social.description",
    ),
  })
  .strict()
  .optional();

export const blogFrontmatterSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case"),
    title: z.string().trim().min(10).max(110),
    seoTitle: optionalTrimmedString(10, METADATA_LIMITS.maxTitleChars, "seoTitle"),
    description: z
      .string()
      .trim()
      .min(
        METADATA_LIMITS.minDescriptionChars,
        `description must be at least ${METADATA_LIMITS.minDescriptionChars} characters`,
      )
      .max(
        METADATA_LIMITS.maxDescriptionChars,
        `description must be at most ${METADATA_LIMITS.maxDescriptionChars} characters`,
      ),
    publishedDate: strictRequiredDateSchema,
    updatedDate: strictOptionalDateSchema,
    author: z.string().trim().min(2).max(80),
    tags: z.array(z.string().trim().min(2).max(40)).min(1).max(8),
    draft: z.boolean().default(false),
    canonicalPath: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .refine((p) => p.startsWith("/"), "canonicalPath must start with '/'")
        .refine((p) => p !== "/", "canonicalPath must not point to root homepage '/'")
        .refine((p) => !/\.vercel\.app/i.test(p), "canonicalPath must not reference vercel.app")
        .optional(),
    ),
    openGraph: socialMetaSchema,
    twitter: socialMetaSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    const resolvedTitle =
      typeof data.seoTitle === "string"
        ? data.seoTitle
        : typeof data.title === "string"
          ? data.title
          : "";
    if (resolvedTitle.length > METADATA_LIMITS.maxTitleChars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seoTitle"],
        message: `Resolved SEO title exceeds ${METADATA_LIMITS.maxTitleChars} chars (${resolvedTitle.length}); provide a shorter seoTitle <= ${METADATA_LIMITS.maxTitleChars} chars`,
      });
    }

    if (
      data.updatedDate instanceof Date &&
      data.publishedDate instanceof Date &&
      data.updatedDate.getTime() < data.publishedDate.getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedDate"],
        message: "updatedDate cannot be earlier than publishedDate",
      });
    }
  });

export type BlogFrontmatterInput = z.input<typeof blogFrontmatterSchema>;
export type BlogFrontmatter = z.output<typeof blogFrontmatterSchema>;

export function parseBlogFrontmatter(raw: unknown): BlogFrontmatter {
  return blogFrontmatterSchema.parse(raw);
}
