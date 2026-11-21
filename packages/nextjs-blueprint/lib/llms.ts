// Dynamic llmstxt.org builder and validator for MagangHub Kemnaker RI.
// Uses actual live routes (/magang-nasional/*, organizer.maganghub.kemnaker.go.id, BNSP SSO),
// real Batch 3B 2026 schedule, and structured AI feed references (/ai/jobs.ndjson, /ai/faq.json).

import {
  BANTUAN_KEMNAKER_URL,
  BASE_URL,
  BNSP_CERTIFICATION_URL,
  LEGACY_404_PATHS,
  LIVE_BATCH_3B_2026,
  ORGANIZER_PORTAL_URL,
  SIAPKERJA_URL,
  resolvePinnedBaseUrl,
  type BatchSchedule,
} from "./constants.ts";
import { sanitizeBatchSchedule } from "./prompt-injection-guard.ts";

export function buildLlmsTxt(
  schedule: BatchSchedule = LIVE_BATCH_3B_2026,
  options?: { activeVacanciesCount?: number; baseUrl?: string },
): string {
  // STRIDE-S-02 & STRIDE-T-03: Pin canonical origin + sanitize dynamic schedule fields
  // against control chars, Markdown delimiter breakout, and indirect prompt injection.
  const cleanBase = resolvePinnedBaseUrl(options?.baseUrl ?? BASE_URL);
  const safeSchedule = sanitizeBatchSchedule(schedule, LIVE_BATCH_3B_2026);
  const countLine =
    typeof options?.activeVacanciesCount === "number" &&
    Number.isFinite(options.activeVacanciesCount) &&
    options.activeVacanciesCount >= 0
      ? `- **Lowongan Aktif Terindeks:** ${Math.floor(options.activeVacanciesCount).toLocaleString("id-ID")} posisi`
      : null;

  return [
    "# MagangHub Kemnaker RI",
    "",
    "> Platform resmi Program Pemagangan Lulusan Perguruan Tinggi (Magang Nasional) bersubsidi pemerintah dari Kementerian Ketenagakerjaan Republik Indonesia, menghubungkan lulusan D3/S1 dengan perusahaan dan kementerian/lembaga mitra terverifikasi melalui ekosistem SIAPkerja.",
    "",
    `Terakhir diperbarui: ${safeSchedule.updatedAt} (${safeSchedule.batchLabel}).`,
    "",
    "- **Penyelenggara:** Kementerian Ketenagakerjaan Republik Indonesia (Kemnaker RI)",
    `- **Skema & Durasi:** Pemagangan ${safeSchedule.durationMonths} bulan bersubsidi pemerintah, uang saku bulanan setara UMK, dan sertifikasi resmi Kemnaker RI / BNSP`,
    `- **Kuota ${safeSchedule.year}:** ${safeSchedule.quotaNational} (target ${safeSchedule.batchLabel}: ${safeSchedule.quotaBatch})`,
    "- **Biaya Pendaftaran:** Gratis untuk peserta (wajib akun SIAPkerja terverifikasi)",
    "- **Kriteria Ringkas Peserta:** WNI lulusan D3/S1 perguruan tinggi terdaftar di Kemendikbudristek, maksimal 1 tahun setelah kelulusan",
    ...(countLine ? [countLine] : []),
    "",
    `### Jadwal Resmi ${safeSchedule.batchLabel}`,
    `- **Pendaftaran Perusahaan:** ${safeSchedule.companyRegistration}`,
    `- **Pendaftaran Peserta:** ${safeSchedule.participantRegistration}`,
    `- **Seleksi Perusahaan (Administrasi & Wawancara):** ${safeSchedule.companySelection}`,
    `- **Seleksi, Penetapan & Pengumuman oleh Kemnaker:** ${safeSchedule.kemnakerAnnouncement}`,
    `- **Mulai Pelaksanaan Magang:** ${safeSchedule.internshipStart}`,
    "",
    "## Tautan Inti",
    `- [Cari Lowongan Magang](${cleanBase}/magang-nasional/lowongan): Daftar lowongan magang aktif dengan filter tipe penyelenggara, jenjang (Diploma/Sarjana/Profesi), tipe wawancara, kota, dan program studi.`,
    `- [Daftar Penyelenggara Mitra](${cleanBase}/magang-nasional/penyelenggara): Direktori perusahaan dan kementerian/lembaga penyelenggara pemagangan nasional.`,
    `- [Syarat & Ketentuan Program](${cleanBase}/magang-nasional/persyaratan): Persyaratan resmi peserta dan penyelenggara program pemagangan lulusan perguruan tinggi.`,
    `- [Tentang Program Pemagangan Nasional](${cleanBase}/magang-nasional/tentang): Penjelasan skema 6 bulan, uang saku setara UMK, kuota nasional, dan alur program.`,
    `- [FAQ MagangHub](${cleanBase}/magang-nasional/faq): Jawaban pertanyaan umum seputar pendaftaran SIAPkerja, seleksi, dan pelaksanaan magang.`,
    `- [Pendaftaran Magang Nasional](${cleanBase}/pendaftaran/magang-nasional): Pintu masuk resmi pendaftaran program melalui SSO SIAPkerja.`,
    "",
    "## Structured AI Feeds",
    `- [Active Jobs NDJSON Feed](${cleanBase}/ai/jobs.ndjson): Feed NDJSON terstruktur berisi lowongan magang aktif berstatus OPEN dengan jadwal validThrough dan uang saku.`,
    `- [Official FAQ JSON Feed](${cleanBase}/ai/faq.json): Feed JSON resmi berisi tanya-jawab program, jadwal Batch 3B 2026, dan skema FAQPage JSON-LD.`,
    "",
    "## Ekosistem & Sertifikasi",
    `- [Portal Penyelenggara / HR Mitra](${ORGANIZER_PORTAL_URL}): Portal khusus perusahaan mitra untuk pendaftaran instansi dan pengelolaan lowongan bersubsidi.`,
    `- [Sertifikasi Profesi BNSP x MagangHub](${BNSP_CERTIFICATION_URL}): Tautan resmi daftar uji kompetensi dan sertifikasi profesi BNSP pascamagang.`,
    `- [Ekosistem SIAPkerja Kemnaker](${SIAPKERJA_URL}): Pembuatan akun tunggal, profil kandidat, dan pelacakan aktivitas lamaran.`,
    `- [Pusat Bantuan Kemnaker](${BANTUAN_KEMNAKER_URL}): Layanan bantuan teknis akun SIAPkerja dan layanan Kemnaker.`,
    "",
    "## Optional",
    "- [Kebijakan Privasi Kemnaker](https://kemnaker.go.id/information/privacy): Kebijakan privasi resmi Kementerian Ketenagakerjaan RI.",
    "- [Syarat & Ketentuan Kemnaker](https://kemnaker.go.id/information/terms): Ketentuan layanan ekosistem digital Kemnaker.",
    "- [Instagram @maganghub.kemnaker](https://www.instagram.com/maganghub.kemnaker/): Kanal pengumuman resmi program MagangHub.",
    "- [Instagram @kemnaker](https://www.instagram.com/kemnaker/): Kanal resmi Kementerian Ketenagakerjaan RI.",
    "- [X @KemnakerRI](https://x.com/KemnakerRI): Pembaruan jadwal dan informasi resmi Kemnaker RI.",
    "- [YouTube Kemnaker RI](https://www.youtube.com/channel/UCXX-orbQDc0LVXhVB1I0K3g): Sosialisasi dan panduan video resmi Kemnaker RI.",
    "- Kontak Resmi: Call Center 1500630 (Jam Kerja) | Aduan WhatsApp (text only) Perusahaan: 0813-2064-789 | Peserta: 0813-2064-787",
    "",
  ].join("\n");
}

export interface LlmsTxtLintResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  linkCount: number;
}

const PLACEHOLDER_RE =
  /\[(?:Tanggal\s+(?:Mulai|Selesai)|DIISI_TIM_KEMNAKER|TODO[^\]]*|TBD[^\]]*)\]|\{\{\s*[A-Z0-9_]+\s*\}\}/i;

export function validateLlmsTxt(content: string): LlmsTxtLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/^#\s+.+/m.test(content)) errors.push("Missing top-level H1 (# Title) required by llmstxt.org");
  if (!/^>\s+.+/m.test(content)) errors.push("Missing blockquote (> summary) required by llmstxt.org");
  if (!/^##\s+.+/m.test(content)) errors.push("Missing H2 link sections (## ...)");

  const placeholderMatch = PLACEHOLDER_RE.exec(content);
  if (placeholderMatch) {
    errors.push(`Unfilled template placeholder detected: ${placeholderMatch[0]}`);
  }

  const urls = Array.from(content.matchAll(/https?:\/\/maganghub\.kemnaker\.go\.id(\/[^\s)]*)/g)).map(
    (m) => m[1] ?? "/",
  );
  for (const path of urls) {
    if ((LEGACY_404_PATHS as readonly string[]).includes(path)) {
      errors.push(`Broken HTTP 404 route referenced: ${path}`);
    }
  }

  const allLinks = content.match(/^-\s+\[[^\]]+\]\(https?:\/\/[^)]+\)/gm) ?? [];
  if (allLinks.length < 4) warnings.push("Fewer than 4 structured Markdown links in H2 sections");
  if (!/^##\s+Optional$/m.test(content)) warnings.push("Consider adding an '## Optional' section per llmstxt.org");

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    linkCount: allLinks.length,
  };
}
