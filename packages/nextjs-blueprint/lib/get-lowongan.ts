/**
 * Request-memoized vacancy data loader using React cache().
 *
 * Fixes the double-query + race-condition defect where generateMetadata() and
 * LowonganDetailPage() independently fetched the vacancy without deduplication.
 * With cache(), both calls observe the exact same snapshot & lifecycle state
 * within a single SSR request, tagged for instant revalidateTag("job-<slug>") invalidation.
 */

import { cache } from "react";
import { isPublicVacancyStatus, type VacancyStatus } from "./job-lifecycle.ts";

export type WorkMode = "ONSITE" | "HYBRID" | "REMOTE";

export interface VacancyLocation {
  city: string;
  province: string;
  streetAddress?: string;
  postalCode?: string;
  country?: string;
}

export interface MagangVacancy {
  id: string;
  slug: string;
  title: string;
  descriptionHtml: string;
  status: VacancyStatus;
  /** ISO-8601 date or datetime with timezone, e.g. "2026-11-21T08:00:00+07:00" */
  datePosted: string;
  /** ISO-8601 datetime with explicit timezone offset, e.g. "2026-12-01T23:59:59+07:00" */
  validThrough: string;
  closedAt?: string | null;
  archivedAt?: string | null;
  updatedAt: string;
  companyName: string;
  companyUrl?: string;
  companyLogo?: string;
  city: string;
  province: string;
  streetAddress?: string;
  postalCode?: string;
  /** Optional multi-location array for placements across multiple branches/cities */
  locations?: VacancyLocation[];
  workMode: WorkMode;
  /** Monthly subsidized stipend (IDR, UMK equivalent). Must be > 0 to emit baseSalary. */
  stipendMonthly?: number;
  stipendMaxMonthly?: number;
  directApply?: boolean;
  batchName: string;
  durationMonths: number;
  educationLevel?: string;
  industry?: string;
  bidangSlug?: string;
  kotaSlug?: string;
}

export interface SimilarVacancySummary {
  slug: string;
  title: string;
  companyName: string;
  city: string;
  batchName: string;
}

export function getJobRevalidationTag(slug: string): string {
  return `job-${slug}`;
}

export function resolveInternalApiUrl(): string {
  const configured =
    process.env.INTERNAL_API_URL ||
    process.env.MAGANGHUB_INTERNAL_API_URL ||
    process.env.MAGANGHUB_API_URL ||
    "https://api.maganghub.kemnaker.go.id";
  return configured.replace(/\/+$/, "");
}

export async function fetchLowonganBySlugUncached(
  slug: string,
  fetchImpl: typeof fetch = fetch,
  options: { allowNonPublic?: boolean } = {},
): Promise<MagangVacancy | null> {
  const apiBase = resolveInternalApiUrl();
  try {
    const res = await fetchImpl(
      `${apiBase}/v1/lowongan/${encodeURIComponent(slug)}`,
      {
        next: {
          revalidate: 900,
          tags: ["lowongan-all", getJobRevalidationTag(slug)],
        },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) {
      throw new Error(`Upstream vacancy service unavailable (HTTP ${res.status})`);
    }
    const vacancy = (await res.json()) as MagangVacancy;
    // STRIDE-I-02: Symmetric guard inside React.cache() loader blocks DRAFT/INTERNAL leakage
    if (!options.allowNonPublic && !isPublicVacancyStatus(vacancy?.status)) {
      return null;
    }
    return vacancy;
  } catch {
    // STRIDE-I-03: Never expose INTERNAL_API_URL, upstream hostnames, or raw stack traces
    throw new Error("Upstream vacancy service temporarily unavailable");
  }
}

export const getLowonganBySlug = cache(
  async (slug: string): Promise<MagangVacancy | null> => {
    return fetchLowonganBySlugUncached(slug);
  },
);

export const getSimilarActiveLowongan = cache(
  async (
    vacancy: Pick<MagangVacancy, "slug" | "bidangSlug" | "kotaSlug">,
  ): Promise<SimilarVacancySummary[]> => {
    const apiBase = resolveInternalApiUrl();
    try {
      const qs = new URLSearchParams({
        exclude: vacancy.slug,
        limit: "6",
        status: "OPEN",
      });
      if (vacancy.bidangSlug) qs.set("bidang", vacancy.bidangSlug);
      if (vacancy.kotaSlug) qs.set("kota", vacancy.kotaSlug);

      const res = await fetch(`${apiBase}/v1/lowongan/similar?${qs.toString()}`, {
        next: { revalidate: 1800, tags: ["lowongan-all"] },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return [];
      return (await res.json()) as SimilarVacancySummary[];
    } catch {
      return [];
    }
  },
);
