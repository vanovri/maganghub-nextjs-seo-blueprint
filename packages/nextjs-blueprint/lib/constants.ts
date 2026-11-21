// Shared constants aligned with live maganghub.kemnaker.go.id (v1.18.23, audited 2026-11-21).
// Production HTML already loads self-hosted Plausible Analytics (https://plausible.kemnaker.go.id/js/script.js);
// ad pixels, GTM, GA4, Clarity/Hotjar, and external CRM scripts remain absent.

export const CANONICAL_HOST = "maganghub.kemnaker.go.id";

export const PINNED_ALLOWED_HOSTS: readonly string[] = [
  CANONICAL_HOST,
  "organizer.maganghub.kemnaker.go.id",
] as const;

/**
 * Resolves the canonical public origin from a strictly validated HTTPS allowlist.
 * STRIDE-S-02 defense: NEVER derive canonical/sitemap origins from raw request
 * `Host` or `X-Forwarded-Host` headers, and refuse non-allowlisted env overrides.
 */
export function resolvePinnedBaseUrl(
  rawUrl?: string,
  extraAllowedHosts: readonly string[] = [],
): string {
  const fallback = `https://${CANONICAL_HOST}`;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return fallback;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:") {
      return fallback;
    }
    const host = parsed.hostname.toLowerCase();
    const isPinned =
      host === CANONICAL_HOST ||
      host.endsWith(`.${CANONICAL_HOST}`) ||
      PINNED_ALLOWED_HOSTS.includes(host) ||
      extraAllowedHosts.some((h) => h.toLowerCase() === host);
    if (!isPinned) {
      return fallback;
    }
    return parsed.origin;
  } catch {
    return fallback;
  }
}

export const BASE_URL = resolvePinnedBaseUrl(
  typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_SITE_URL : undefined,
);

export const JOB_ROUTE_PREFIX =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_JOB_ROUTE_PREFIX?.replace(/\/+$/, "")) ||
  "/magang-nasional/lowongan";

export const SITEMAP_URL_LIMIT = 50_000;

export const ORGANIZER_PORTAL_URL = "https://organizer.maganghub.kemnaker.go.id";
export const BNSP_CERTIFICATION_URL =
  "https://bnsp.go.id/sisfo/kemnaker-login?redirect_link=https://bnsp.go.id/list-sertifikasi-maganghub";
export const SIAPKERJA_URL = "https://siapkerja.kemnaker.go.id/";
export const BANTUAN_KEMNAKER_URL = "https://bantuan.kemnaker.go.id";
export const PLAUSIBLE_SCRIPT_URL = "https://plausible.kemnaker.go.id/js/script.js";

export interface StaticRouteSpec {
  path: string;
  label: string;
  changeFrequency: "daily" | "hourly" | "weekly" | "monthly";
  priority: number;
}

/**
 * Live-verified HTTP 200 public routes on maganghub.kemnaker.go.id (v1.18.23).
 * Replaces legacy draft paths (/lowongan, /perusahaan, /jadwal, /sertifikasi, /api/lowongan/active)
 * which all return HTTP 404 in production.
 */
export const VERIFIED_STATIC_ROUTES: readonly StaticRouteSpec[] = [
  { path: "/", label: "Beranda", changeFrequency: "daily", priority: 1.0 },
  { path: "/magang-nasional/lowongan", label: "Lowongan Magang", changeFrequency: "hourly", priority: 0.9 },
  { path: "/magang-nasional/penyelenggara", label: "Penyelenggara Magang", changeFrequency: "weekly", priority: 0.8 },
  { path: "/magang-nasional/persyaratan", label: "Syarat & Ketentuan Program", changeFrequency: "weekly", priority: 0.8 },
  { path: "/magang-nasional/tentang", label: "Tentang Program Pemagangan Nasional", changeFrequency: "weekly", priority: 0.8 },
  { path: "/magang-nasional/faq", label: "FAQ MagangHub", changeFrequency: "weekly", priority: 0.7 },
  { path: "/pendaftaran", label: "Daftar Program Pemagangan", changeFrequency: "weekly", priority: 0.7 },
  { path: "/pendaftaran/magang-nasional", label: "Pendaftaran Magang Nasional", changeFrequency: "daily", priority: 0.8 },
] as const;

export const LEGACY_404_PATHS = [
  "/lowongan",
  "/perusahaan",
  "/jadwal",
  "/sertifikasi",
  "/api/lowongan/active",
] as const;

export const LEGACY_410_PATHS = [
  "/be/v1/api/list/vacancies-active",
] as const;

export const DISALLOWED_CRAWL_PATHS = [
  "/dashboard/",
  "/api/",
  "/api/naco/",
  "/admin/",
] as const;

export interface BatchSchedule {
  batchLabel: string;
  year: number;
  quotaNational: string;
  quotaBatch: string;
  durationMonths: number;
  companyRegistration: string;
  participantRegistration: string;
  companySelection: string;
  kemnakerAnnouncement: string;
  internshipStart: string;
  updatedAt: string;
}

/**
 * Live-verified Batch 3B 2026 schedule from maganghub.kemnaker.go.id (audited 2026-11-21).
 */
export const LIVE_BATCH_3B_2026: BatchSchedule = {
  batchLabel: "Batch 3B 2026",
  year: 2026,
  quotaNational: "150.000 peserta (3 batch sepanjang 2026)",
  quotaBatch: "50.000 talenta muda",
  durationMonths: 6,
  companyRegistration: "17-26 Nov 2026",
  participantRegistration: "23 Nov-1 Des 2026",
  companySelection: "2-10 Des 2026",
  kemnakerAnnouncement: "11 Des 2026",
  internshipStart: "14 Des 2026",
  updatedAt: "2026-11-21",
};

export interface FaqItem {
  question: string;
  answer: string;
  sourceUrl: string;
}

export const LIVE_FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: "Siapa saja yang memenuhi syarat mendaftar Program Pemagangan Nasional MagangHub Kemnaker RI?",
    answer:
      "Warga Negara Indonesia (WNI) lulusan Diploma (D3/D4) atau Sarjana (S1) dari perguruan tinggi terdaftar di Kemendikbudristek dengan batas kelulusan maksimal 1 tahun terakhir serta memiliki akun SIAPkerja terverifikasi.",
    sourceUrl: `${BASE_URL}/magang-nasional/persyaratan`,
  },
  {
    question: "Berapa durasi magang dan fasilitas uang saku pada MagangHub Kemnaker RI?",
    answer:
      "Durasi pemagangan berlangsung selama 6 bulan bersubsidi pemerintah dengan uang saku bulanan setara UMK setempat dan kesempatan mengikuti sertifikasi profesi resmi Kemnaker RI / BNSP.",
    sourceUrl: `${BASE_URL}/magang-nasional/tentang`,
  },
  {
    question: "Kapan jadwal resmi MagangHub Batch 3B 2026 berlangsung?",
    answer:
      "Jadwal Batch 3B 2026: pendaftaran perusahaan 17-26 Nov 2026, pendaftaran peserta 23 Nov-1 Des 2026, seleksi perusahaan 2-10 Des 2026, penetapan dan pengumuman Kemnaker 11 Des 2026, serta mulai pelaksanaan magang 14 Des 2026.",
    sourceUrl: `${BASE_URL}/pendaftaran/magang-nasional`,
  },
  {
    question: "Apakah pendaftaran peserta MagangHub Kemnaker RI dipungut biaya?",
    answer:
      "Tidak. Pendaftaran peserta sepenuhnya gratis dan dilakukan secara resmi melalui portal MagangHub menggunakan akun tunggal SIAPkerja Kemnaker.",
    sourceUrl: `${BASE_URL}/magang-nasional/faq`,
  },
  {
    question: "Di mana perusahaan atau instansi mendaftar sebagai penyelenggara magang mitra?",
    answer:
      "Perusahaan, BUMN, dan kementerian/lembaga mendaftar dan mengelola kuota lowongan melalui portal khusus penyelenggara di https://organizer.maganghub.kemnaker.go.id.",
    sourceUrl: ORGANIZER_PORTAL_URL,
  },
  {
    question: "Bagaimana akses sertifikasi profesi BNSP untuk peserta MagangHub?",
    answer:
      "Peserta mengakses daftar skema uji kompetensi dan pendaftaran sertifikasi profesi melalui SSO Kemnaker ke portal resmi BNSP.",
    sourceUrl: BNSP_CERTIFICATION_URL,
  },
] as const;

export const METADATA_LIMITS = {
  maxTitleChars: 65,
  minDescriptionChars: 150,
  maxDescriptionChars: 160,
  maxSocialTitleChars: 65,
  maxSocialDescriptionChars: 160,
} as const;
