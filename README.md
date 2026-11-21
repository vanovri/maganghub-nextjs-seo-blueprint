# MagangHub Kemnaker RI: Canonical Next.js SEO, Google for Jobs & GEO Blueprint

![Tests 83/83 PASS](https://img.shields.io/badge/tests-83%2F83%20PASS-0b6b46)
![STRIDE 15/15 Mitigated](https://img.shields.io/badge/STRIDE-15%2F15%20MITIGATED-0b5fc4)
![Perf p99 15.99ms](https://img.shields.io/badge/p99%2010k-15.99ms-0b6b46)
![Zero Runtime Deps](https://img.shields.io/badge/runtime%20deps-0-111317)
![License MIT](https://img.shields.io/badge/license-MIT-blue)

Canonical TypeScript + Node.js 24 LTS monorepo consolidating Technical SEO, Google for Jobs `JobPosting` JSON-LD, Expired Job Lifecycle Protection, GEO Discovery (`llms.txt` + structured AI feeds), Google Indexing API, Hardened Blog/MDX Zod Schema, and a Zero-Dependency 8-Gate CI Validator for `maganghub.kemnaker.go.id`.

Full teardown case study: [ardhyanovri.my.id/blog/teardown-maganghub-kemnaker-nextjs-seo](https://ardhyanovri.my.id/blog/teardown-maganghub-kemnaker-nextjs-seo)

## Verified Benchmark & Security Summary

| Verification Gate | Result |
| :--- | :--- |
| TypeScript (`tsc --noEmit`) | `0` errors |
| Deterministic & Adversarial Suite (`npm run test:all`) | **`83/83` PASS** (`12` suites) |
| Randomized Fuzz & 50 KB ReDoS Guard | **`1,518` iterations**, max 50 KB ReDoS `6.00 ms` (`job-schema.ts` `0.12-0.96 ms`) |
| Automated STRIDE Threat Model (`npm run security:stride`) | **`15/15` MITIGATED (`0` OPEN)** |
| Local Stress Harness (`npm run perf:stress`) | `p99 15.99 ms` (10k), `41.92 ms` (50k), `27.21 ms` (`410` @ `14,273 RPS`) |
| `k6 v2.4.0` Load Cross-Check | `4.53 ms` middleware, `30.49 ms` sitemap (`3,794/3,794` checks) |

## Verified Live Production Baseline (2026-11-21, `v1.18.23`)

1. **Architecture transition (Wayback E13):** MagangHub berpindah dari SPA kosong ke Next.js full SSR antara Mei dan November 2026 (terekam utuh di snapshot 16 Nov 2026), setelah sebelumnya tampil sebagai SPA kosong pada snapshot `2025-10-10`, `2025-11-03`, dan `2026-05-16`.
2. **Live analytics posture:** Production HTML already loads self-hosted Plausible Analytics (`https://plausible.kemnaker.go.id/js/script.js`). Absent layers are ad pixels, GTM, GA4, Clarity/Hotjar, and external CRM trackers.
3. **Blocker #0 (Root Canonical Lock):** 8/8 public routes (`/`, `/magang-nasional/lowongan`, `/magang-nasional/penyelenggara`, `/magang-nasional/persyaratan`, `/magang-nasional/tentang`, `/magang-nasional/faq`, `/pendaftaran`, `/pendaftaran/magang-nasional`) emit identical `<link rel="canonical" href="https://maganghub.kemnaker.go.id"/>` and `<title>`. Remove `alternates.canonical` from root `app/layout.tsx` before deploying `sitemap.xml`.
4. **Live route topology:** Actual public listings live under `/magang-nasional/*`, HR partner management runs on `https://organizer.maganghub.kemnaker.go.id`, and competency certification uses SSO BNSP. Legacy `/be/v1/api/list/vacancies-active` returns HTTP 410 Gone without `X-Robots-Tag: noindex`, while assumed paths (`/lowongan`, `/perusahaan`, `/jadwal`, `/sertifikasi`, `/api/lowongan/active`) return HTTP 404.
5. **Batch 3B 2026 schedule:** Pendaftaran perusahaan `17-26 Nov 2026`, pendaftaran peserta `23 Nov-1 Des 2026`, seleksi perusahaan `2-10 Des 2026`, penetapan dan pengumuman Kemnaker `11 Des 2026`, mulai pelaksanaan magang `14 Des 2026`.

## Monorepo Structure

```text
maganghub-nextjs-seo-blueprint/
├── .github/workflows/
│   ├── seo-check-preview.yml          # deployment_status + sticky PR comment + anti Pwn-Request
│   └── seo-check-local.yml            # PR local Next.js build + crash-fast readiness probe
├── packages/
│   ├── nextjs-blueprint/
│   │   ├── app/
│   │   │   ├── layout.metadata.ts     # Patch #0: removes root alternates.canonical + length guards
│   │   │   ├── robots.ts              # Explicit User-agent, Allow, Disallow, Sitemap
│   │   │   ├── sitemap.ts             # INTERNAL_API_URL guard, fail-closed ACTIVE filter, 50k sharding
│   │   │   ├── magang-nasional/lowongan/[slug]/page.tsx
│   │   │   ├── llms.txt/route.ts      # Dynamic llmstxt.org Route Handler (Batch 3B 2026)
│   │   │   └── ai/
│   │   │       ├── jobs.ndjson/route.ts
│   │   │       └── faq.json/route.ts
│   │   ├── components/seo/JobPostingJsonLd.tsx
│   │   ├── lib/
│   │   │   ├── constants.ts
│   │   │   ├── job-lifecycle.ts       # ACTIVE -> EXPIRED_GRACE -> ARCHIVED_GONE state machine
│   │   │   ├── get-lowongan.ts        # React.cache() deduplication + revalidateTag("job-<slug>")
│   │   │   ├── job-schema.ts          # ONSITE/HYBRID/REMOTE, multi-location, allowlist HTML sanitizer
│   │   │   ├── gone-page.ts           # Semantic HTML 410 Gone recovery page
│   │   │   ├── llms.ts                # llms.txt builder + linter
│   │   │   ├── prompt-injection-guard.ts # Indirect Prompt Injection guard for GEO feeds
│   │   │   ├── google-indexing-api.ts # Zero-dep RS256 JWT + quota guard + idempotency + audit log
│   │   │   ├── blog-schema.ts         # Hardened Zod schema (emptyToUndefined anti-1970-01-01)
│   │   │   └── blog-loader.ts         # React.cache() + symmetric draft guard
│   │   ├── examples/
│   │   │   ├── astro-content-config.ts
│   │   │   └── blog-post-page.tsx
│   │   ├── middleware.ts              # Edge 410 Gone + bounded LRU + 400ms timeout
│   │   └── types/next-shim.d.ts       # Standalone strict TypeScript ambient shims
│   └── seo-ci-gate/
│       └── scripts/validate-seo.mjs   # Zero-dependency 8-gate CI validator + SHA-256 audit
├── scripts/
│   ├── perf-stress.mjs                # Phase 2.6 load/stress harness (4 profiles + k6, p99 < 50ms)
│   ├── perf-server-worker.mjs         # Multi-core keep-alive HTTP/1.1 worker for sitemap & middleware
│   └── stride-audit.mjs               # Phase 2.7 automated STRIDE threat modeling engine
├── docs/
│   └── THREAT_MODEL_STRIDE.md         # Auto-generated STRIDE report + Mermaid & ASCII diagrams
├── tests/
│   ├── nextjs-blueprint.test.mjs
│   ├── e2e-http.test.mjs
│   ├── fuzz-parsers.test.mjs          # 1,500+ adversarial fuzz iterations + 50 KB ReDoS (< 15ms)
│   ├── workflow-security.test.mjs
│   ├── indexing-api.test.mjs
│   ├── stride-controls.test.mjs       # 12 deterministic STRIDE control & EXIT-1 gate tests
│   ├── k6-seo-stress.js               # k6 cross-check load script (sitemap + middleware)
│   └── hygiene.test.mjs
└── reports/
    ├── live-baseline-canonical.json
    ├── perf-stress-report.json
    └── stride-matrix.json
```

## Quick Commands

```bash
# Strict TypeScript verification (0 errors, no Next.js install required)
npm run typecheck

# Full verification suite (typecheck + 83 deterministic tests + 1,500+ fuzz + STRIDE + hygiene)
npm run test:all

# Phase 2.6 local load & stress-test harness (Hard SLA: p99 < 50ms, 0% error, k6 cross-check)
npm run perf:stress

# Phase 2.7 automated STRIDE threat modeling & control verification (0 OPEN CRITICAL/HIGH)
npm run security:stride

# Live baseline audit against https://maganghub.kemnaker.go.id
npm run validate:live

# Full God-Mode pipeline (test:all + perf:stress + security:stride)
npm run test:godmode
```

## 8-Gate CI Validator (`packages/seo-ci-gate/scripts/validate-seo.mjs`)

| Gate ID | Purpose |
| :--- | :--- |
| `G1-HOME-SSR` | Verifies HTTP 200, SSR word count (>= 100), `<html lang>`, `<title>`, meta description, `<h1>`, OG tags, and XSS-safe JSON-LD. |
| `G2-INDEXING` | Enforces preview vs production indexing safety and detects preview host canonical leaks. |
| `G3-ROBOTS` | Ensures `User-agent`, `Allow`, and `Sitemap:` exist and catches Cloudflare comment-only stubs or global `Disallow: /`. |
| `G4-SITEMAP` | Validates `<urlset>` and sharded `<sitemapindex>` (CDATA, `&amp;`), deduplication, 50,000 URL cap, and canonical origin hygiene. |
| `G5-CANONICAL-ROOT-GUARD` | Audits inner public routes and blocks root-locked `/` canonicals (Blocker #0) and `*.vercel.app` leaks. |
| `G6-JOBPOSTING-ACTIVE` | Validates SSR `JobPosting` JSON-LD (`@graph`, array `@type`, `TELECOMMUTE`, `jobLocation[]`, strict ISO+TZ `validThrough`, XSS safety). |
| `G7-EXPIRED-JOB-LIFECYCLE` | Verifies expired jobs are absent from sitemap, never 3xx soft-404 redirect, emit 0 `JobPosting`, and pass Preview `X-Robots-Tag` trap detection. |
| `G8-LLMS-TXT-AND-AI-FEEDS` | Validates `/llms.txt` (zero placeholders, zero 404 legacy routes) and structured AI feeds (`/ai/jobs.ndjson`, `/ai/faq.json`). |

## Zero Runtime Dependencies Guarantee

- `packages/seo-ci-gate` declares `"dependencies": {}` and imports only Node.js built-ins (`node:fs`, `node:path`, `node:url`).
- `packages/nextjs-blueprint/lib/google-indexing-api.ts` imports only `node:crypto` for RS256 JWT signing.
