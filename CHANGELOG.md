# Changelog

All notable changes to `maganghub-nextjs-seo-blueprint` are documented here.

## [1.0.0] - 2026-11-21

### Added
- Canonical Next.js App Router Technical SEO & GEO blueprint for `maganghub.kemnaker.go.id`:
  - Patch #0 root layout metadata guard removing global `alternates.canonical` lock across 8/8 public routes.
  - Explicit `robots.ts` and sharded `sitemap.ts` (50,000 URL cap, fail-closed ACTIVE filter, `INTERNAL_API_URL` guard).
  - Google for Jobs `JobPosting` JSON-LD generator (`job-schema.ts`) supporting `ONSITE`, `HYBRID`, and `REMOTE` (`TELECOMMUTE`), multi-location arrays, strict ISO-8601 timezone validation, and allowlist HTML sanitization.
  - Expired Job Lifecycle state machine (`ACTIVE -> EXPIRED_GRACE -> ARCHIVED_GONE`) with semantic HTTP 410 Gone recovery page and Edge middleware bounded LRU cache (`400 ms` fail-open timeout).
  - Dynamic `/llms.txt`, `/ai/jobs.ndjson`, and `/ai/faq.json` GEO discovery endpoints protected by `prompt-injection-guard.ts`.
  - Zero-dependency RS256 JWT Google Indexing API client (`google-indexing-api.ts`) using `node:crypto` only.
  - Hardened Blog/MDX Zod frontmatter schema (`blog-schema.ts`) preventing `1970-01-01` date coercion.
- Zero-dependency 8-gate CI validator (`packages/seo-ci-gate/scripts/validate-seo.mjs`) and hardened GitHub Actions workflows (`seo-check-preview.yml`, `seo-check-local.yml`, `ci.yml`).
- Stress harness (`scripts/perf-stress.mjs`, `tests/k6-seo-stress.js`) and automated STRIDE threat modeling engine (`scripts/stride-audit.mjs`, `docs/THREAT_MODEL_STRIDE.md`).

### Verified
- `npm run test:all`: 83/83 deterministic tests PASS, `tsc --noEmit` 0 errors, 1,518 adversarial fuzz iterations (50 KB ReDoS max 6.00 ms).
- `npm run security:stride`: 15/15 CRITICAL/HIGH STRIDE threats MITIGATED (0 OPEN).
- `npm run perf:stress`: p99 15.99 ms (10k), 41.92 ms (50k), 27.21 ms (410 @ 14,273 RPS); `k6 v2.4.0` 4.53 ms middleware / 30.49 ms sitemap (3,794/3,794 checks).
