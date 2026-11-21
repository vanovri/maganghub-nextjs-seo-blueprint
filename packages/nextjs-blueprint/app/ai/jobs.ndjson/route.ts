// app/ai/jobs.ndjson/route.ts
// Dealls-inspired structured AI NDJSON feed of active MagangHub vacancies.
// Enables GEO leapfrog over Glints (llmsTxt: null) by giving LLM crawlers & AI agents
// a clean, fail-closed stream of currently ACTIVE subsidized internships.

import { BASE_URL, JOB_ROUTE_PREFIX, resolvePinnedBaseUrl } from "../../../lib/constants.ts";
import type { MagangVacancy } from "../../../lib/get-lowongan.ts";
import {
  evaluateJobLifecycle,
  isPublicVacancyStatus,
  isValidVacancySlug,
} from "../../../lib/job-lifecycle.ts";
import { sanitizeJobDescriptionHtml } from "../../../lib/job-schema.ts";
import { sanitizeLlmText } from "../../../lib/prompt-injection-guard.ts";

export const revalidate = 1800; // 30-minute ISR cache

export interface AiJobFeedRecord {
  id: string;
  slug: string;
  title: string;
  company: string;
  city: string;
  province: string;
  workMode: "ONSITE" | "HYBRID" | "REMOTE";
  stipendMonthlyIdr: number | null;
  stipendMaxMonthlyIdr: number | null;
  batch: string;
  durationMonths: number;
  directApply: boolean;
  datePosted: string;
  validThrough: string;
  url: string;
  summary: string;
}

function stripHtmlToSummary(rawHtml: string, maxLen: number = 280): string {
  const plain = sanitizeJobDescriptionHtml(rawHtml)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeLlmText(plain, {
    maxLength: maxLen,
    stripMarkdownDelimiters: true,
  });
}

/**
 * Converts a vacancy array into strict single-line NDJSON containing ONLY public ACTIVE vacancies.
 * STRIDE-T-03 defense: Strips control chars, enforces field length limits, neutralizes Markdown
 * delimiters and indirect prompt injection directives, and isolates data inside strict JSON objects.
 */
export function buildJobsNdjson(
  vacancies: readonly MagangVacancy[],
  options: { nowMs?: number; baseUrl?: string; jobRoutePrefix?: string } = {},
): string {
  const nowMs = options.nowMs ?? Date.now();
  const baseUrl = resolvePinnedBaseUrl(options.baseUrl ?? BASE_URL);
  const jobRoutePrefix = (options.jobRoutePrefix ?? JOB_ROUTE_PREFIX).replace(/\/+$/, "");

  const lines: string[] = [];
  const seenIds = new Set<string>();

  for (const v of vacancies) {
    if (!v || !v.id || !v.slug || seenIds.has(v.id)) continue;
    if (!isPublicVacancyStatus(v.status)) continue;
    if (!isValidVacancySlug(v.slug.trim())) continue;
    const lifecycle = evaluateJobLifecycle(
      {
        status: v.status,
        deadlineAt: v.validThrough,
        closedAt: v.closedAt,
        archivedAt: v.archivedAt,
      },
      { nowMs },
    );
    if (lifecycle.state !== "ACTIVE") continue;

    seenIds.add(v.id);
    const stipend =
      typeof v.stipendMonthly === "number" &&
      Number.isFinite(v.stipendMonthly) &&
      v.stipendMonthly > 0
        ? Math.round(v.stipendMonthly)
        : null;
    const stipendMax =
      stipend !== null &&
      typeof v.stipendMaxMonthly === "number" &&
      Number.isFinite(v.stipendMaxMonthly) &&
      v.stipendMaxMonthly > stipend
        ? Math.round(v.stipendMaxMonthly)
        : null;

    const safeSlug = v.slug.trim();
    const record: AiJobFeedRecord = {
      id: sanitizeLlmText(v.id, { maxLength: 64, stripMarkdownDelimiters: true }),
      slug: safeSlug,
      title: sanitizeLlmText(v.title, { maxLength: 120, stripMarkdownDelimiters: true }),
      company: sanitizeLlmText(v.companyName, { maxLength: 100, stripMarkdownDelimiters: true }),
      city: sanitizeLlmText(v.city, { maxLength: 60, stripMarkdownDelimiters: true }),
      province: sanitizeLlmText(v.province, { maxLength: 60, stripMarkdownDelimiters: true }),
      workMode: v.workMode,
      stipendMonthlyIdr: stipend,
      stipendMaxMonthlyIdr: stipendMax,
      batch: sanitizeLlmText(v.batchName, { maxLength: 48, stripMarkdownDelimiters: true }),
      durationMonths: v.durationMonths,
      directApply: v.directApply ?? true,
      datePosted: v.datePosted,
      validThrough: v.validThrough,
      url: `${baseUrl}${jobRoutePrefix}/${encodeURIComponent(safeSlug)}`,
      summary: stripHtmlToSummary(v.descriptionHtml, 280),
    };
    const serialized = JSON.stringify(record)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    lines.push(serialized);
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

async function fetchActiveVacanciesForFeed(
  fetchImpl: typeof fetch = fetch,
): Promise<MagangVacancy[]> {
  const internalBase = process.env.INTERNAL_API_URL || process.env.MAGANGHUB_INTERNAL_API_URL;
  if (!internalBase) return [];

  try {
    const res = await fetchImpl(
      `${internalBase.replace(/\/+$/, "")}/v1/lowongan/ai-feed`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
        next: { revalidate: 1800, tags: ["lowongan-all"] },
      },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as MagangVacancy[] | { data?: MagangVacancy[] };
    return Array.isArray(data) ? data : (data?.data ?? []);
  } catch {
    return [];
  }
}

export async function GET(): Promise<Response> {
  const vacancies = await fetchActiveVacanciesForFeed();
  const ndjson = buildJobsNdjson(vacancies);

  return new Response(ndjson, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=7200",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, follow",
    },
  });
}
