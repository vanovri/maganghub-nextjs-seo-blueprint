// app/layout.metadata.ts
// Patch #0 for live production Blocker #0 on maganghub.kemnaker.go.id (v1.18.23):
// Currently 8/8 public routes emit identical <link rel="canonical" href="https://maganghub.kemnaker.go.id"/>
// and identical <title>, folding sub-routes into the homepage.
// MUST remove `alternates.canonical` from root app/layout.tsx before deploying sitemap.xml.

import type { Metadata } from "next";
import { BASE_URL, METADATA_LIMITS } from "../lib/constants.ts";

/**
 * Export as `export const metadata` inside root `app/layout.tsx`.
 * Deliberately omits `alternates.canonical` so child routes NEVER inherit root `/`.
 */
export const rootMetadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: "Magang Nasional Bersubsidi Kemnaker RI | MagangHub",
    template: "%s | MagangHub",
  },
  description:
    "Platform resmi Program Pemagangan Nasional bersubsidi pemerintah dari Kemnaker RI bagi lulusan D3/S1 bersama perusahaan mitra terverifikasi di SIAPkerja.",
  openGraph: {
    type: "website",
    locale: "id_ID",
    siteName: "MagangHub Kemnaker RI",
    title: "Magang Nasional Bersubsidi Kemnaker RI | MagangHub",
    description:
      "Platform resmi Program Pemagangan Nasional bersubsidi pemerintah dari Kemnaker RI bagi lulusan D3/S1 bersama perusahaan mitra terverifikasi di SIAPkerja.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Magang Nasional Bersubsidi Kemnaker RI | MagangHub",
    description:
      "Platform resmi Program Pemagangan Nasional bersubsidi pemerintah dari Kemnaker RI bagi lulusan D3/S1 bersama perusahaan mitra terverifikasi di SIAPkerja.",
  },
};

export interface RouteMetadataInput {
  /** Page SEO title (rendered full title or standalone title <= 65 chars). */
  seoTitle: string;
  /** Meta description (150-160 chars inclusive for SERP compliance). */
  description: string;
  /** Route pathname starting with "/" (e.g. "/magang-nasional/lowongan"). */
  path: string;
  openGraphTitle?: string;
  openGraphDescription?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  noIndex?: boolean;
}

export interface MetadataValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateRouteMetadataInput(
  input: RouteMetadataInput,
): MetadataValidationResult {
  const errors: string[] = [];
  const title = input.seoTitle.trim();
  const desc = input.description.trim();
  const ogTitle = (input.openGraphTitle ?? title).trim();
  const ogDesc = (input.openGraphDescription ?? desc).trim();
  const twTitle = (input.twitterTitle ?? title).trim();
  const twDesc = (input.twitterDescription ?? desc).trim();

  if (!title || title.length > METADATA_LIMITS.maxTitleChars) {
    errors.push(
      `seoTitle must be 1-${METADATA_LIMITS.maxTitleChars} chars (got ${title.length})`,
    );
  }
  if (
    desc.length < METADATA_LIMITS.minDescriptionChars ||
    desc.length > METADATA_LIMITS.maxDescriptionChars
  ) {
    errors.push(
      `description must be ${METADATA_LIMITS.minDescriptionChars}-${METADATA_LIMITS.maxDescriptionChars} chars (got ${desc.length})`,
    );
  }
  if (!ogTitle || ogTitle.length > METADATA_LIMITS.maxSocialTitleChars) {
    errors.push(
      `openGraph.title must be 1-${METADATA_LIMITS.maxSocialTitleChars} chars (got ${ogTitle.length})`,
    );
  }
  if (!ogDesc || ogDesc.length > METADATA_LIMITS.maxSocialDescriptionChars) {
    errors.push(
      `openGraph.description must be 1-${METADATA_LIMITS.maxSocialDescriptionChars} chars (got ${ogDesc.length})`,
    );
  }
  if (!twTitle || twTitle.length > METADATA_LIMITS.maxSocialTitleChars) {
    errors.push(
      `twitter.title must be 1-${METADATA_LIMITS.maxSocialTitleChars} chars (got ${twTitle.length})`,
    );
  }
  if (!twDesc || twDesc.length > METADATA_LIMITS.maxSocialDescriptionChars) {
    errors.push(
      `twitter.description must be 1-${METADATA_LIMITS.maxSocialDescriptionChars} chars (got ${twDesc.length})`,
    );
  }

  const trimmedPath = input.path.trim();
  if (/^https?:\/\//i.test(trimmedPath) || /\.vercel\.app/i.test(trimmedPath)) {
    errors.push(`path must be a relative route pathname, not an absolute/preview URL: "${trimmedPath}"`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Helper for every child page.tsx so each route emits a unique <title>,
 * self-referencing <link rel="canonical">, and length-guarded OG/Twitter metadata.
 */
export function createPageMetadata(input: RouteMetadataInput): Metadata {
  const check = validateRouteMetadataInput(input);
  if (!check.valid) {
    throw new Error(`Invalid route metadata for "${input.path}": ${check.errors.join("; ")}`);
  }

  const rawPath = input.path.trim();
  const normalizedPath =
    rawPath === "/"
      ? "/"
      : (rawPath.startsWith("/") ? rawPath : `/${rawPath}`).replace(/\/+$/, "");

  const seoTitle = input.seoTitle.trim();
  const description = input.description.trim();
  const ogTitle = (input.openGraphTitle ?? seoTitle).trim();
  const ogDescription = (input.openGraphDescription ?? description).trim();
  const twitterTitle = (input.twitterTitle ?? seoTitle).trim();
  const twitterDescription = (input.twitterDescription ?? description).trim();

  return {
    title: { absolute: seoTitle },
    description,
    alternates: {
      canonical: normalizedPath,
    },
    openGraph: {
      type: "website",
      locale: "id_ID",
      siteName: "MagangHub Kemnaker RI",
      title: ogTitle,
      description: ogDescription,
      url: normalizedPath,
    },
    twitter: {
      card: "summary_large_image",
      title: twitterTitle,
      description: twitterDescription,
    },
    ...(input.noIndex
      ? {
          robots: {
            index: false,
            follow: true,
            googleBot: { index: false, follow: true },
          },
        }
      : {
          robots: {
            index: true,
            follow: true,
            googleBot: { index: true, follow: true },
          },
        }),
  };
}
