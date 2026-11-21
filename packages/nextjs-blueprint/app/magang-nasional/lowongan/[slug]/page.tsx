/**
 * Production Next.js App Router Vacancy Detail Page (Hybrid Phase 1).
 *
 * Lifecycle behavior:
 * - ACTIVE: HTTP 200, index/follow, self-canonical, emits Google for Jobs JobPosting JSON-LD.
 * - EXPIRED_GRACE: HTTP 200, strips JobPosting JSON-LD completely, emits HTML
 *   <meta name="robots" content="noindex, follow">, renders accessible role="status" banner
 *   and similar active internship internal links (retains social/referral traffic cleanly).
 * - ARCHIVED_GONE (>90d or ARCHIVED): intercepted at edge by middleware.ts -> HTTP 410 Gone
 *   (and if origin is reached during edge failover, still strips JobPosting + emits noindex).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JobPostingJsonLd } from "../../../../components/seo/JobPostingJsonLd.tsx";
import {
  BASE_URL,
  JOB_ROUTE_PREFIX,
  METADATA_LIMITS,
} from "../../../../lib/constants.ts";
import {
  getLowonganBySlug,
  getSimilarActiveLowongan,
  type MagangVacancy,
} from "../../../../lib/get-lowongan.ts";
import { evaluateJobLifecycle, isPublicVacancyStatus } from "../../../../lib/job-lifecycle.ts";
import { sanitizeJobDescriptionHtml } from "../../../../lib/job-schema.ts";

/**
 * Bounded 15-minute ISR window so Date.now() never stays stale for days past validThrough.
 * Pair with on-demand revalidateTag("job-<slug>") + revalidatePath(...) inside close-vacancy webhook.
 */
export const revalidate = 900;

function fitTitle(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length <= METADATA_LIMITS.maxTitleChars) return clean;
  return `${clean.slice(0, METADATA_LIMITS.maxTitleChars - 3).trimEnd()}...`;
}

function fitDescription(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length <= METADATA_LIMITS.maxDescriptionChars) return clean;
  return `${clean.slice(0, METADATA_LIMITS.maxDescriptionChars - 3).trimEnd()}...`;
}

export function buildVacancyMetadata(
  lowongan: MagangVacancy,
  nowMs: number = Date.now(),
): Metadata {
  // STRIDE-I-02 defense-in-depth: never emit DRAFT or INTERNAL vacancy titles/descriptions in <head>
  if (!isPublicVacancyStatus(lowongan.status)) {
    return {
      title: { absolute: "Lowongan Tidak Ditemukan | MagangHub Kemnaker RI" },
      robots: { index: false, follow: false },
    };
  }

  const lifecycle = evaluateJobLifecycle(
    {
      status: lowongan.status,
      deadlineAt: lowongan.validThrough,
      closedAt: lowongan.closedAt,
      archivedAt: lowongan.archivedAt,
    },
    { nowMs },
  );

  const canonicalUrl = `${BASE_URL}${JOB_ROUTE_PREFIX}/${encodeURIComponent(lowongan.slug)}`;
  const rawTitle = lifecycle.expired
    ? `[Ditutup] ${lowongan.title} | MagangHub`
    : `${lowongan.title} - ${lowongan.companyName} | MagangHub`;
  const title = fitTitle(rawTitle);

  const rawDesc = lifecycle.expired
    ? `Pendaftaran magang ${lowongan.title} di ${lowongan.companyName} (${lowongan.city}) telah ditutup. Jelajahi lowongan magang nasional bersubsidi aktif lainnya di MagangHub Kemnaker RI.`
    : `Lamar magang nasional bersubsidi ${lowongan.title} di ${lowongan.companyName} (${lowongan.city}, ${lowongan.province}) dengan uang saku UMK di MagangHub Kemnaker RI.`;
  const description = fitDescription(rawDesc);

  return {
    title: { absolute: title },
    description,
    // Self-canonical prevents Blocker #0 root-canonical bug and soft-404 signals
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      type: "website",
      locale: "id_ID",
      siteName: "MagangHub Kemnaker RI",
      title,
      description,
      url: canonicalUrl,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    robots: lifecycle.expired
      ? {
          index: false,
          follow: true,
          googleBot: { index: false, follow: true },
        }
      : {
          index: true,
          follow: true,
          googleBot: { index: true, follow: true },
        },
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const lowongan = await getLowonganBySlug(slug);
  if (!lowongan) {
    return {
      title: { absolute: "Lowongan Tidak Ditemukan | MagangHub Kemnaker RI" },
      robots: { index: false, follow: false },
    };
  }
  return buildVacancyMetadata(lowongan);
}

export default async function LowonganDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const lowongan = await getLowonganBySlug(slug);
  if (!lowongan || !isPublicVacancyStatus(lowongan.status)) notFound();

  const lifecycle = evaluateJobLifecycle({
    status: lowongan.status,
    deadlineAt: lowongan.validThrough,
    closedAt: lowongan.closedAt,
    archivedAt: lowongan.archivedAt,
  });

  const similarActive = lifecycle.expired
    ? await getSimilarActiveLowongan(lowongan)
    : [];

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      {/* REQUIRED: Emit JobPosting JSON-LD ONLY when lifecycle.state === "ACTIVE" */}
      {lifecycle.state === "ACTIVE" && <JobPostingJsonLd vacancy={lowongan} />}

      {lifecycle.expired && (
        <div
          role="status"
          aria-live="polite"
          className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950"
        >
          <p className="font-semibold">
            Pendaftaran lowongan ini telah ditutup.
          </p>
          <p className="mt-1 text-sm">
            Lowongan dari {lowongan.companyName} ({lowongan.batchName}) tidak lagi
            menerima lamaran baru. Jelajahi lowongan magang aktif serupa di bawah
            agar pencarianmu tetap berlanjut.
          </p>
        </div>
      )}

      <article>
        <header className="border-b pb-4">
          <h1 className="text-2xl font-bold">{lowongan.title}</h1>
          <p className="mt-1 text-sm text-neutral-600">
            {lowongan.companyName} | {lowongan.city}, {lowongan.province} |{" "}
            {lowongan.batchName}
          </p>
        </header>

        <section className="prose mt-6 max-w-none">
          <h2>Deskripsi &amp; Kualifikasi</h2>
          <div
            dangerouslySetInnerHTML={{
              __html: sanitizeJobDescriptionHtml(lowongan.descriptionHtml),
            }}
          />
        </section>
      </article>

      {lifecycle.expired && (
        <aside aria-labelledby="similar-jobs-heading" className="mt-10 border-t pt-6">
          <h2 id="similar-jobs-heading" className="text-lg font-semibold">
            Lowongan Magang Aktif Serupa
          </h2>
          {similarActive.length > 0 ? (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {similarActive.map((item) => (
                <li key={item.slug} className="rounded-md border p-3">
                  <Link
                    href={`${JOB_ROUTE_PREFIX}/${item.slug}`}
                    className="font-medium underline"
                  >
                    {item.title}
                  </Link>
                  <p className="text-sm text-neutral-600">
                    {item.companyName} | {item.city} ({item.batchName})
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm">
              <Link href={JOB_ROUTE_PREFIX} className="font-medium underline">
                Lihat seluruh lowongan magang aktif di MagangHub
              </Link>
            </p>
          )}
        </aside>
      )}
    </main>
  );
}
