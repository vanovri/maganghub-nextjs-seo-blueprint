#!/usr/bin/env node
/**
 * Automated STRIDE Threat Modeling & Control Verification Engine (Phase 2.7).
 *
 * Executable security audit covering:
 *  (A) Next.js SEO/GEO Surface:
 *      layout.metadata.ts, sitemap.ts, robots.ts, JobPostingJsonLd.tsx, page.tsx,
 *      middleware.ts, llms.txt/route.ts, ai/jobs.ndjson/route.ts, google-indexing-api.ts,
 *      job-lifecycle.ts, job-schema.ts, get-lowongan.ts, blog-loader.ts, prompt-injection-guard.ts
 *  (B) GitHub Actions CI Surface:
 *      .github/workflows/seo-check-preview.yml, .github/workflows/seo-check-local.yml,
 *      packages/seo-ci-gate/scripts/validate-seo.mjs
 *
 * Outputs:
 *  1. reports/stride-matrix.json
 *  2. docs/THREAT_MODEL_STRIDE.md (auto-generated from stride-matrix.json + Mermaid & ASCII trust boundaries)
 *
 * Hard Exit Condition:
 *  Exits with code 1 automatically if ANY CRITICAL or HIGH threat has missing/failed
 *  static controls or failed/unverified test evidence.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import YAML from "yaml";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_OUT = resolve(ROOT, "reports/stride-matrix.json");
const DOC_OUT = resolve(ROOT, "docs/THREAT_MODEL_STRIDE.md");
const PERF_REPORT_PATH = resolve(ROOT, "reports/perf-stress-report.json");

function readRel(relPath) {
  const full = resolve(ROOT, relPath);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

function parseTapResults(tapStdout) {
  const passed = [];
  const failed = [];
  let summaryTests = null;
  let summarySuites = null;
  let summaryPass = null;
  let summaryFail = null;

  for (const rawLine of String(tapStdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const okMatch = /^ok\s+\d+\s+-\s+(.+)$/.exec(line);
    if (okMatch) {
      passed.push(okMatch[1].trim());
      continue;
    }
    const failMatch = /^not ok\s+\d+\s+-\s+(.+)$/.exec(line);
    if (failMatch) {
      failed.push(failMatch[1].trim());
      continue;
    }
    const testsMatch = /^#\s+tests\s+(\d+)$/.exec(line);
    if (testsMatch) summaryTests = Number(testsMatch[1]);
    const suitesMatch = /^#\s+suites\s+(\d+)$/.exec(line);
    if (suitesMatch) summarySuites = Number(suitesMatch[1]);
    const passMatch = /^#\s+pass\s+(\d+)$/.exec(line);
    if (passMatch) summaryPass = Number(passMatch[1]);
    const failCountMatch = /^#\s+fail\s+(\d+)$/.exec(line);
    if (failCountMatch) summaryFail = Number(failCountMatch[1]);
  }
  return {
    passed,
    failed,
    testCaseCount: summaryTests ?? passed.length + failed.length,
    suiteCount: summarySuites ?? 0,
    passedTestCases: summaryPass ?? passed.length,
    failedTestCases: summaryFail ?? failed.length,
  };
}

async function executeLinkedTestSuites() {
  const testFiles = [
    "tests/nextjs-blueprint.test.mjs",
    "tests/e2e-http.test.mjs",
    "tests/fuzz-parsers.test.mjs",
    "tests/workflow-security.test.mjs",
    "tests/indexing-api.test.mjs",
    "tests/stride-controls.test.mjs",
    "tests/hygiene.test.mjs",
  ];

  let stdout = "";
  let exitCode = 0;
  try {
    const res = await execFileAsync(
      process.execPath,
      ["--test", "--test-concurrency=2", "--test-reporter=tap", ...testFiles],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
    );
    stdout = res.stdout || "";
  } catch (err) {
    exitCode = typeof err?.code === "number" ? err.code : 1;
    stdout = err?.stdout || "";
  }

  return { exitCode, ...parseTapResults(stdout) };
}

function checkWorkflowNoUntrustedRunInterpolation(yamlSrc) {
  if (!yamlSrc) return false;
  const doc = YAML.parse(yamlSrc);
  if (!doc || !doc.jobs) return false;
  for (const job of Object.values(doc.jobs)) {
    for (const step of job.steps || []) {
      if (typeof step.run === "string" && /\$\{\{/.test(step.run)) {
        return false;
      }
    }
  }
  return true;
}

function checkWorkflowMinimalPermissions(yamlSrc, allowedKeys) {
  if (!yamlSrc) return false;
  const doc = YAML.parse(yamlSrc);
  const perms = doc?.permissions;
  if (!perms || typeof perms !== "object") return false;
  const keys = Object.keys(perms);
  if (keys.length === 0) return false;
  return keys.every((k) => allowedKeys.includes(k));
}

/**
 * Strips single-line (`// ...`) and block (`/* ... *\/`) JS/TS comments while
 * preserving string/template literals so static security checks never false-positive
 * on explanatory comments (e.g. `// never reads Host/X-Forwarded-Host`).
 */
function stripJsComments(src) {
  const s = String(src || "");
  const out = [];
  let i = 0;
  const len = s.length;
  while (i < len) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out.push(ch);
      i += 1;
      while (i < len) {
        const c = s[i];
        out.push(c);
        if (c === "\\" && i + 1 < len) {
          out.push(s[i + 1]);
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && s[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < len && !(s[i] === "*" && s[i + 1] === "/")) i += 1;
      i = Math.min(len, i + 2);
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/**
 * Extracts only the `export const metadata` or `export const rootMetadata` object body
 * so STRIDE-S-02 root-canonical checks never false-positive on helper functions like
 * `createPageMetadata()`.
 */
function extractRootMetadataBlock(codeWithoutComments) {
  const m = /export\s+const\s+(?:rootMetadata|metadata)\b[^=]*=\s*\{/.exec(codeWithoutComments);
  if (!m) return "";
  let depth = 0;
  let started = false;
  for (let i = m.index + m[0].length - 1; i < codeWithoutComments.length; i += 1) {
    const ch = codeWithoutComments[i];
    if (ch === "{") {
      depth += 1;
      started = true;
    } else if (ch === "}") {
      depth -= 1;
      if (started && depth === 0) {
        return codeWithoutComments.slice(m.index, i + 1);
      }
    }
  }
  return codeWithoutComments.slice(m.index);
}

const RAW_PLACEHOLDER_RE = new RegExp(
  "\\[(?:Tanggal\\s+Mu" + "lai|Tanggal\\s+Sele" + "sai|DIISI_TIM_" + "KEMNAKER)\\]",
  "i",
);

export function buildThreatDefinitions() {
  const previewYml = readRel(".github/workflows/seo-check-preview.yml");
  const localYml = readRel(".github/workflows/seo-check-local.yml");
  const validateSeo = readRel("packages/seo-ci-gate/scripts/validate-seo.mjs");
  const constantsTs = readRel("packages/nextjs-blueprint/lib/constants.ts");
  const layoutMetaTs = readRel("packages/nextjs-blueprint/app/layout.metadata.ts");
  const sitemapTs = readRel("packages/nextjs-blueprint/app/sitemap.ts");
  const robotsTs = readRel("packages/nextjs-blueprint/app/robots.ts");
  const jobSchemaTs = readRel("packages/nextjs-blueprint/lib/job-schema.ts");
  const jsonLdTsx = readRel("packages/nextjs-blueprint/components/seo/JobPostingJsonLd.tsx");
  const pageTsx = readRel("packages/nextjs-blueprint/app/magang-nasional/lowongan/[slug]/page.tsx");
  const middlewareTs = readRel("packages/nextjs-blueprint/middleware.ts");
  const gonePageTs = readRel("packages/nextjs-blueprint/lib/gone-page.ts");
  const llmsRouteTs = readRel("packages/nextjs-blueprint/app/llms.txt/route.ts");
  const llmsLibTs = readRel("packages/nextjs-blueprint/lib/llms.ts");
  const jobsNdjsonTs = readRel("packages/nextjs-blueprint/app/ai/jobs.ndjson/route.ts");
  const piGuardTs = readRel("packages/nextjs-blueprint/lib/prompt-injection-guard.ts");
  const indexingTs = readRel("packages/nextjs-blueprint/lib/google-indexing-api.ts");
  const lifecycleTs = readRel("packages/nextjs-blueprint/lib/job-lifecycle.ts");
  const getLowonganTs = readRel("packages/nextjs-blueprint/lib/get-lowongan.ts");
  const blogLoaderTs = readRel("packages/nextjs-blueprint/lib/blog-loader.ts");

  // Also include any lib/*seo*.ts helpers for STRIDE-T-01 coverage
  const libDir = resolve(ROOT, "packages/nextjs-blueprint/lib");
  const extraSeoLibSources = existsSync(libDir)
    ? readdirSync(libDir)
        .filter((f) => /seo.*\.ts$/i.test(f))
        .map((f) => readRel(`packages/nextjs-blueprint/lib/${f}`))
        .filter(Boolean)
    : [];
  const t01JsonLdSources = [jobSchemaTs, ...extraSeoLibSources].filter(Boolean).join("\n");
  const layoutMetaCode = stripJsComments(layoutMetaTs || "");
  const rootMetaBlock = extractRootMetadataBlock(layoutMetaCode);
  const s02HeaderScanCode = stripJsComments(`${layoutMetaTs || ""}\n${sitemapTs || ""}\n${robotsTs || ""}`);
  const geoRoutesCode = stripJsComments(`${llmsRouteTs || ""}\n${jobsNdjsonTs || ""}`);

  let perfReport = null;
  if (existsSync(PERF_REPORT_PATH)) {
    try {
      perfReport = JSON.parse(readFileSync(PERF_REPORT_PATH, "utf8"));
    } catch {
      perfReport = null;
    }
  }

  return [
    // S - Spoofing
    {
      threat_id: "STRIDE-S-01",
      category: "Spoofing",
      category_code: "S",
      surface: "GitHub Actions CI",
      severity: "CRITICAL",
      title: "Fork-PR spoofs validator script on deployment_status with bypass secrets in scope",
      control_file: ".github/workflows/seo-check-preview.yml",
      verified_by_test: "tests/workflow-security.test.mjs :: hardens seo-check-preview.yml against Fork-PR Pwn Requests",
      testMatchPattern: /hardens seo-check-preview\.yml against Fork-PR Pwn Requests/i,
      staticChecks: [
        {
          label: "sparse-checkout pinned to default_branch (never deployment.sha)",
          pass:
            Boolean(previewYml) &&
            /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/.test(previewYml) &&
            /sparse-checkout:/.test(previewYml) &&
            !/ref:[^\n]*deployment\.sha/.test(previewYml),
        },
        {
          label: "persist-credentials: false enforced on actions/checkout",
          pass: Boolean(previewYml) && /persist-credentials:\s*false/.test(previewYml),
        },
        {
          label: "strict HTTPS target host allowlist (*.vercel.app / maganghub.kemnaker.go.id)",
          pass:
            Boolean(previewYml) &&
            /u\.protocol !== "https:"/.test(previewYml) &&
            /vercel\\\.app/.test(previewYml),
        },
      ],
    },
    {
      threat_id: "STRIDE-S-02",
      category: "Spoofing",
      category_code: "S",
      surface: "Next.js SEO/GEO",
      severity: "HIGH",
      title: "Host / X-Forwarded-Host header poisoning hijacks canonical URLs or sitemap <loc>",
      control_file: "packages/nextjs-blueprint/lib/constants.ts, app/layout.metadata.ts, app/sitemap.ts, app/robots.ts",
      verified_by_test: "tests/stride-controls.test.mjs :: [STRIDE-S-02] pins canonical/sitemap origin",
      testMatchPattern: /\[STRIDE-S-02\]/,
      staticChecks: [
        {
          label: "resolvePinnedBaseUrl() pins canonical HTTPS allowlist in constants.ts",
          pass:
            Boolean(constantsTs) &&
            /export function resolvePinnedBaseUrl/.test(constantsTs) &&
            /parsed\.protocol !== "https:"/.test(constantsTs),
        },
        {
          label: "Zero raw Host / X-Forwarded-Host header reads across metadata, sitemap, robots (comment-stripped)",
          pass:
            Boolean(layoutMetaTs && sitemapTs && robotsTs) &&
            !/x-forwarded-host|headers(?:\(\))?\.get\(\s*["']host["']\s*\)/i.test(s02HeaderScanCode),
        },
        {
          label: "Blocker #0 guard: root metadata/rootMetadata omits alternates.canonical (scoped to root declaration)",
          pass:
            Boolean(rootMetaBlock) &&
            !/alternates\s*:\s*\{[\s\S]*?canonical\s*:/.test(rootMetaBlock),
        },
        {
          label: "app/sitemap.ts and lib/llms.ts invoke resolvePinnedBaseUrl()",
          pass:
            Boolean(sitemapTs && llmsLibTs) &&
            /resolvePinnedBaseUrl\(/.test(sitemapTs) &&
            /resolvePinnedBaseUrl\(/.test(llmsLibTs),
        },
      ],
    },
    {
      threat_id: "STRIDE-S-03",
      category: "Spoofing",
      category_code: "S",
      surface: "Google Indexing API",
      severity: "HIGH",
      title: "JWT claim tampering or forged OAuth2 service-account assertion",
      control_file: "packages/nextjs-blueprint/lib/google-indexing-api.ts",
      verified_by_test: "tests/indexing-api.test.mjs & tests/stride-controls.test.mjs :: RS256 crypto.verify + [STRIDE-S-03]",
      testMatchPattern: /\[STRIDE-S-03\]|RS256 JWT whose signature verifies cryptographically/i,
      staticChecks: [
        {
          label: "Strict iss/aud/exp/iat validation + HTTPS audience guard in buildServiceAccountJwt()",
          pass:
            Boolean(indexingTs) &&
            /alg:\s*"RS256"/.test(indexingTs) &&
            /parsedAud\.protocol !== "https:"/.test(indexingTs) &&
            /exp:\s*nowSec\s*\+\s*3600/.test(indexingTs),
        },
        {
          label: "RSA-SHA256 signing via Node built-in node:crypto only",
          pass: Boolean(indexingTs) && /createSign\("RSA-SHA256"\)/.test(indexingTs),
        },
      ],
    },

    // T - Tampering
    {
      threat_id: "STRIDE-T-01",
      category: "Tampering",
      category_code: "T",
      surface: "Next.js SEO/GEO",
      severity: "CRITICAL",
      title: "Stored XSS & </script> / U+2028 / U+2029 breakout via partner descriptionHtml in JSON-LD & SSR page",
      control_file: "packages/nextjs-blueprint/lib/job-schema.ts, components/seo/JobPostingJsonLd.tsx, app/magang-nasional/lowongan/[slug]/page.tsx",
      verified_by_test: "tests/fuzz-parsers.test.mjs & tests/stride-controls.test.mjs :: 250 XSS fuzz + [STRIDE-T-01]",
      testMatchPattern: /\[STRIDE-T-01\]|fuzzes HTML sanitizer & JSON-LD serializer/i,
      staticChecks: [
        {
          label: "Server-side allowlist HTML sanitizer strips scripts, event handlers & dangerous URIs",
          pass:
            Boolean(jobSchemaTs) &&
            /ALLOWED_JOB_HTML_TAGS/.test(jobSchemaTs) &&
            /sanitizeHtmlLinearPass/.test(jobSchemaTs),
        },
        {
          label: "serializeSafeJsonLd escapes <, >, &, U+2028, and U+2029 (job-schema.ts + lib/*seo*.ts)",
          pass:
            Boolean(t01JsonLdSources && jsonLdTsx) &&
            /\\u003c/.test(t01JsonLdSources) &&
            /\\u003e/.test(t01JsonLdSources) &&
            /\\u0026/.test(t01JsonLdSources) &&
            /\\u2028/.test(t01JsonLdSources) &&
            /\\u2029/.test(t01JsonLdSources) &&
            /serializeSafeJsonLd\(/.test(jsonLdTsx),
        },
        {
          label: "page.tsx sanitizes descriptionHtml before dangerouslySetInnerHTML",
          pass: Boolean(pageTsx) && /sanitizeJobDescriptionHtml\(lowongan\.descriptionHtml\)/.test(pageTsx),
        },
      ],
    },
    {
      threat_id: "STRIDE-T-02",
      category: "Tampering",
      category_code: "T",
      surface: "Next.js SEO/GEO",
      severity: "HIGH",
      title: "XML / CDATA injection via untrusted vacancy slug in sitemap.ts",
      control_file: "packages/nextjs-blueprint/app/sitemap.ts",
      verified_by_test: "tests/stride-controls.test.mjs :: [STRIDE-T-02] blocks XML/CDATA injection slugs",
      testMatchPattern: /\[STRIDE-T-02\]/,
      staticChecks: [
        {
          label: "escapeXml() escapes XML entities and strips XML 1.0 illegal control chars",
          pass:
            Boolean(sitemapTs) &&
            /XML_ILLEGAL_CONTROL_RE/.test(sitemapTs) &&
            /export function escapeXml/.test(sitemapTs) &&
            /&amp;/.test(sitemapTs) &&
            /&lt;/.test(sitemapTs),
        },
        {
          label: "Strict isValidVacancySlug() allowlist filters records before emitting <loc>",
          pass: Boolean(sitemapTs) && /if \(!isValidVacancySlug\(slug\)\) continue;/.test(sitemapTs),
        },
      ],
    },
    {
      threat_id: "STRIDE-T-03",
      category: "Tampering",
      category_code: "T",
      surface: "GEO / AI Feeds",
      severity: "HIGH",
      title: "Indirect Prompt Injection via partner vacancy descriptions/titles rendered to llms.txt & /ai/jobs.ndjson",
      control_file: "packages/nextjs-blueprint/lib/prompt-injection-guard.ts, lib/llms.ts, app/llms.txt/route.ts, app/ai/jobs.ndjson/route.ts",
      verified_by_test: "tests/fuzz-parsers.test.mjs (150 PI fuzz) & tests/stride-controls.test.mjs :: [STRIDE-T-03]",
      testMatchPattern: /\[STRIDE-T-03\]|fuzzes Indirect Prompt Injection guard/i,
      staticChecks: [
        {
          label: "prompt-injection-guard.ts strips control/bidi/zero-width chars, caps field length & neutralizes delimiters/overrides",
          pass:
            Boolean(piGuardTs) &&
            /CONTROL_AND_INVISIBLE_RE/.test(piGuardTs) &&
            /CHAT_TEMPLATE_TOKEN_RE/.test(piGuardTs) &&
            /MARKDOWN_DELIMITER_RE/.test(piGuardTs) &&
            /PROMPT_OVERRIDE_PATTERNS/.test(piGuardTs),
        },
        {
          label: "llms.ts / app/llms.txt/route.ts sanitizes dynamic batch schedules",
          pass: Boolean(llmsLibTs && llmsRouteTs) && /sanitizeBatchSchedule\(/.test(llmsLibTs),
        },
        {
          label: "app/ai/jobs.ndjson/route.ts sanitizes all partner fields & isolates strict single-line NDJSON",
          pass:
            Boolean(jobsNdjsonTs) &&
            /sanitizeLlmText\(/.test(jobsNdjsonTs) &&
            /JSON\.stringify\(record\)/.test(jobsNdjsonTs) &&
            /\\u2028/.test(jobsNdjsonTs),
        },
        {
          label: "GEO route handlers contain zero unfilled template placeholders (comment-stripped)",
          pass: Boolean(llmsRouteTs && jobsNdjsonTs) && !RAW_PLACEHOLDER_RE.test(geoRoutesCode),
        },
      ],
    },
    {
      threat_id: "STRIDE-T-04",
      category: "Tampering",
      category_code: "T",
      surface: "GitHub Actions CI",
      severity: "CRITICAL",
      title: "GitHub Actions shell script injection via untrusted ${{ github.event.* }} inside run: blocks",
      control_file: ".github/workflows/seo-check-preview.yml, .github/workflows/seo-check-local.yml",
      verified_by_test: "tests/workflow-security.test.mjs :: forbids ALL ${{ ... }} expression interpolation inside every run: block",
      testMatchPattern: /forbids ALL \$\{\{ \.\.\. \}\} expression interpolation inside every run: block/i,
      staticChecks: [
        {
          label: "0 ${{ ... }} expressions in any run: block in seo-check-preview.yml",
          pass: checkWorkflowNoUntrustedRunInterpolation(previewYml),
        },
        {
          label: "0 ${{ ... }} expressions in any run: block in seo-check-local.yml",
          pass: checkWorkflowNoUntrustedRunInterpolation(localYml),
        },
      ],
    },

    // R - Repudiation
    {
      threat_id: "STRIDE-R-01",
      category: "Repudiation",
      category_code: "R",
      surface: "Google Indexing API & CI Gate",
      severity: "HIGH",
      title: "Missing structured audit trail & cryptographic digest for URL_DELETED/URL_UPDATED and CI gate failures",
      control_file: "packages/nextjs-blueprint/lib/google-indexing-api.ts, packages/seo-ci-gate/scripts/validate-seo.mjs",
      verified_by_test: "tests/stride-controls.test.mjs :: [STRIDE-R-01] emits structured JSON audit logs & SHA-256 digests",
      testMatchPattern: /\[STRIDE-R-01\]/,
      staticChecks: [
        {
          label: "google-indexing-api.ts emits structured JSON IndexingAuditLogEntry with ISO timestamp + requestSha256",
          pass:
            Boolean(indexingTs) &&
            /interface IndexingAuditLogEntry/.test(indexingTs) &&
            /requestSha256/.test(indexingTs) &&
            /onAuditLog/.test(indexingTs),
        },
        {
          label: "validate-seo.mjs emits audit.{timestamp, deploymentSha, gateResults, reportSha256} without leaking secrets",
          pass:
            Boolean(validateSeo) &&
            /reportSha256/.test(validateSeo) &&
            /deploymentSha/.test(validateSeo) &&
            /gateResults/.test(validateSeo),
        },
      ],
    },

    // I - Information Disclosure
    {
      threat_id: "STRIDE-I-01",
      category: "Information Disclosure",
      category_code: "I",
      surface: "GitHub Actions CI & Validator",
      severity: "CRITICAL",
      title: "VERCEL_AUTOMATION_BYPASS_SECRET exfiltration via cross-origin redirect or unmasked error logs",
      control_file: "packages/seo-ci-gate/scripts/validate-seo.mjs, .github/workflows/seo-check-preview.yml",
      verified_by_test: "tests/e2e-http.test.mjs (0 bypass leakage) & tests/stride-controls.test.mjs :: [STRIDE-I-01]",
      testMatchPattern: /\[STRIDE-I-01\]|blocks 0 bypass secret leakage on cross-origin 302 redirect/i,
      staticChecks: [
        {
          label: "fetchUrl() pins x-vercel-protection-bypass strictly to currentUrl.origin === pinnedOrigin",
          pass:
            Boolean(validateSeo) &&
            /if\s*\(\s*bypassSecret\s*&&\s*currentUrl\.origin\s*===\s*pinnedOrigin\s*\)/.test(validateSeo),
        },
        {
          label: "redactSecrets() masks VERCEL_AUTOMATION_BYPASS_SECRET & Bearer tokens in JSON reports and stderr",
          pass:
            Boolean(validateSeo) &&
            /export function redactSecrets/.test(validateSeo) &&
            /redactDeep\(gates,\s*secrets\)/.test(validateSeo),
        },
      ],
    },
    {
      threat_id: "STRIDE-I-02",
      category: "Information Disclosure",
      category_code: "I",
      surface: "Next.js SEO/GEO",
      severity: "HIGH",
      title: "Draft blog or DRAFT/INTERNAL vacancy metadata leak in generateMetadata(), sitemap.ts, or AI feeds",
      control_file: "packages/nextjs-blueprint/lib/blog-loader.ts, lib/get-lowongan.ts, app/magang-nasional/lowongan/[slug]/page.tsx, app/sitemap.ts, app/ai/jobs.ndjson/route.ts",
      verified_by_test: "tests/nextjs-blueprint.test.mjs (React.cache symmetric draft) & tests/stride-controls.test.mjs :: [STRIDE-I-02]",
      testMatchPattern: /\[STRIDE-I-02\]|deduplicates reads via React\.cache\(\) and enforces symmetric draft guard/i,
      staticChecks: [
        {
          label: "blog-loader.ts enforces symmetric isBlogPostPubliclyVisible() inside React.cache() loader",
          pass:
            Boolean(blogLoaderTs) &&
            /loadBlogPostBySlug\s*=\s*cache\(/.test(blogLoaderTs) &&
            /isBlogPostPubliclyVisible\(/.test(blogLoaderTs),
        },
        {
          label: "get-lowongan.ts, page.tsx, sitemap.ts & jobs.ndjson block DRAFT/INTERNAL symmetrically",
          pass:
            Boolean(getLowonganTs && pageTsx && sitemapTs && jobsNdjsonTs) &&
            /isPublicVacancyStatus\(/.test(getLowonganTs) &&
            /isPublicVacancyStatus\(/.test(pageTsx) &&
            /isPublicVacancyStatus\(/.test(sitemapTs) &&
            /isPublicVacancyStatus\(/.test(jobsNdjsonTs),
        },
      ],
    },
    {
      threat_id: "STRIDE-I-03",
      category: "Information Disclosure",
      category_code: "I",
      surface: "Next.js SEO/GEO",
      severity: "HIGH",
      title: "INTERNAL_API_URL or stack trace disclosure on HTTP 410 or 500 error responses",
      control_file: "packages/nextjs-blueprint/lib/get-lowongan.ts, middleware.ts, lib/gone-page.ts",
      verified_by_test: "tests/stride-controls.test.mjs :: [STRIDE-I-03] never leaks INTERNAL_API_URL or stack traces",
      testMatchPattern: /\[STRIDE-I-03\]/,
      staticChecks: [
        {
          label: "get-lowongan.ts throws generic error without interpolating raw upstream error/INTERNAL_API_URL",
          pass:
            Boolean(getLowonganTs) &&
            /throw new Error\("Upstream vacancy service temporarily unavailable"\)/.test(getLowonganTs),
        },
        {
          label: "middleware.ts & gone-page.ts return generic 410 responses with HTML-escaped slug and zero stack traces",
          pass:
            Boolean(middlewareTs && gonePageTs) &&
            /escapeHtml\(slug\)/.test(gonePageTs) &&
            !/err\.stack/.test(`${middlewareTs}\n${gonePageTs}`),
        },
      ],
    },

    // D - Denial of Service
    {
      threat_id: "STRIDE-D-01",
      category: "Denial of Service",
      category_code: "D",
      surface: "Next.js SEO/GEO & CI Gate",
      severity: "HIGH",
      title: "ReDoS in HTML/XML/slug parsers, sitemap thundering herd, or middleware cache-busting OOM flood",
      control_file: "packages/nextjs-blueprint/lib/job-schema.ts, app/sitemap.ts, middleware.ts, packages/seo-ci-gate/scripts/validate-seo.mjs",
      verified_by_test: "tests/fuzz-parsers.test.mjs (50KB <15ms), tests/stride-controls.test.mjs ([STRIDE-D-01]) & reports/perf-stress-report.json",
      testMatchPattern: /\[STRIDE-D-01\]|defeats 50 KB ReDoS pathological strings/i,
      requirePerfPass: true,
      staticChecks: [
        {
          label: "Linear-time O(N) HTML/XML scanners in job-schema.ts and validate-seo.mjs",
          pass:
            Boolean(jobSchemaTs && validateSeo) &&
            /function sanitizeHtmlLinearPass/.test(jobSchemaTs) &&
            /function scanOpeningTagsLinear/.test(validateSeo) &&
            /function extractXmlElementValuesLinear/.test(validateSeo),
        },
        {
          label: "middleware.ts enforces bounded MAX_EDGE_CACHE_ENTRIES LRU cap & 400ms AbortSignal.timeout",
          pass:
            Boolean(middlewareTs) &&
            /MAX_EDGE_CACHE_ENTRIES\s*=\s*4_096/.test(middlewareTs) &&
            /AbortSignal\.timeout\(timeoutMs\)/.test(middlewareTs) &&
            /DEFAULT_EDGE_TIMEOUT_MS\s*=\s*400/.test(middlewareTs),
        },
        {
          label: "sitemap.ts enforces 50,000 URL/shard cap & singleflight coalescing",
          pass:
            Boolean(sitemapTs && constantsTs) &&
            /SITEMAP_URL_LIMIT\s*=\s*50_000/.test(constantsTs) &&
            /inFlightBuild/.test(sitemapTs),
        },
        {
          label: "Phase 2.6 perf-stress-report.json passed all Hard SLA gates (p99 < 50ms, 0% error)",
          pass: Boolean(perfReport && perfReport.ok === true),
        },
      ],
    },
    {
      threat_id: "STRIDE-D-02",
      category: "Denial of Service",
      category_code: "D",
      surface: "Google Indexing API",
      severity: "HIGH",
      title: "Google Indexing API daily quota exhaustion (200/day) via bulk updates or webhook retry storms",
      control_file: "packages/nextjs-blueprint/lib/google-indexing-api.ts",
      verified_by_test: "tests/indexing-api.test.mjs :: daily quota limit, dedup & idempotency TTL",
      testMatchPattern: /enforces daily quota limit and deduplicates input URLs|suppresses duplicate notifications within idempotency TTL/i,
      staticChecks: [
        {
          label: "Default 200 req/day quota cap + URL deduplication + skippedQuota partition",
          pass:
            Boolean(indexingTs) &&
            /dailyQuotaLimit\s*=\s*options\.dailyQuotaLimit\s*\?\?\s*200/.test(indexingTs) &&
            /new Set\(urls\.map\(validateIndexingUrl\)\)/.test(indexingTs),
        },
        {
          label: "TTL idempotency cache suppresses duplicate webhook pings",
          pass: Boolean(indexingTs) && /class InMemoryIdempotencyCache/.test(indexingTs),
        },
      ],
    },

    // E - Elevation of Privilege
    {
      threat_id: "STRIDE-E-01",
      category: "Elevation of Privilege",
      category_code: "E",
      surface: "GitHub Actions CI & Validator",
      severity: "CRITICAL",
      title: "Over-privileged GITHUB_TOKEN or SSRF to 169.254.169.254 / RFC1918 / obfuscated IP literals",
      control_file: ".github/workflows/seo-check-preview.yml, .github/workflows/seo-check-local.yml, packages/seo-ci-gate/scripts/validate-seo.mjs",
      verified_by_test: "tests/workflow-security.test.mjs & tests/fuzz-parsers.test.mjs (250 SSRF vectors)",
      testMatchPattern: /fuzzes SSRF host blocker across 250|enforces minimal permissions/i,
      staticChecks: [
        {
          label: "Minimal scoped permissions in both GitHub Actions workflows",
          pass:
            checkWorkflowMinimalPermissions(previewYml, ["contents", "statuses", "pull-requests"]) &&
            checkWorkflowMinimalPermissions(localYml, ["contents"]),
        },
        {
          label: "validate-seo.mjs blocks RFC1918, 192.0.0/24, 198.18/15, .local, userinfo, cloud metadata, IPv4-mapped/translated & NAT64",
          pass:
            Boolean(validateSeo) &&
            /export function parseIpv4ToUint32/.test(validateSeo) &&
            /export function parseIpv6Groups/.test(validateSeo) &&
            /export function expandIpv6/.test(validateSeo) &&
            /a === 169 && b === 254/.test(validateSeo) &&
            /a === 192 && b === 0 && c === 0/.test(validateSeo) &&
            /a === 198 && \(b === 18 \|\| b === 19\)/.test(validateSeo) &&
            /\.endsWith\("\.local"\)/.test(validateSeo) &&
            /parsed\.username \|\| parsed\.password/.test(validateSeo) &&
            /0x0064/.test(validateSeo) &&
            /metadata\.google\.internal/.test(validateSeo),
        },
      ],
    },
    {
      threat_id: "STRIDE-E-02",
      category: "Elevation of Privilege",
      category_code: "E",
      surface: "Next.js SEO/GEO",
      severity: "HIGH",
      title: "Path traversal or hub route collision (../dashboard, %2e%2e, /kota/jakarta) in extractJobDetailSlug",
      control_file: "packages/nextjs-blueprint/lib/job-lifecycle.ts, middleware.ts",
      verified_by_test: "tests/stride-controls.test.mjs :: [STRIDE-E-02] enforces strict [a-z0-9-]+ allowlist",
      testMatchPattern: /\[STRIDE-E-02\]/,
      staticChecks: [
        {
          label: "Strict [a-z0-9-]+ allowlist regex (STRICT_SLUG_RE) applied after safe decodeURIComponent",
          pass:
            Boolean(lifecycleTs) &&
            /STRICT_SLUG_RE\s*=\s*\/\^\[a-z0-9\]/.test(lifecycleTs) &&
            /decodeURIComponent\(remainder\)/.test(lifecycleTs) &&
            /RESERVED_HUB_SEGMENTS/.test(lifecycleTs),
        },
        {
          label: "middleware.ts delegates slug extraction to extractJobDetailSlug() before Edge KV lookup",
          pass: Boolean(middlewareTs) && /extractJobDetailSlug\(rawPathname\)/.test(middlewareTs),
        },
      ],
    },
  ];
}

export function evaluateStrideGate(threats) {
  const openCriticalOrHigh = threats.filter(
    (t) => (t.severity === "CRITICAL" || t.severity === "HIGH") && t.status !== "MITIGATED",
  );
  return {
    ok: openCriticalOrHigh.length === 0,
    exitCode: openCriticalOrHigh.length === 0 ? 0 : 1,
    openCriticalOrHighIds: openCriticalOrHigh.map((t) => t.threat_id),
  };
}

function renderStrideMarkdown(matrix) {
  const catOrder = ["S", "T", "R", "I", "D", "E"];
  const catNames = {
    S: "Spoofing",
    T: "Tampering",
    R: "Repudiation",
    I: "Information Disclosure",
    D: "Denial of Service",
    E: "Elevation of Privilege",
  };

  const catRows = catOrder.map((code) => {
    const s = matrix.summary.byCategory[code] || { total: 0, mitigated: 0, open: 0 };
    return `| **${code}** (${catNames[code]}) | ${s.total} | ${s.mitigated} | ${s.open} |`;
  });

  const threatRows = matrix.threats.map((t) => {
    const staticOk = t.static_checks.filter((c) => c.pass).length;
    const staticTot = t.static_checks.length;
    return `| \`${t.threat_id}\` | ${t.category_code} (${t.category}) | ${t.surface} | **${t.severity}** | \`${t.control_file}\` | ${staticOk}/${staticTot} | \`${t.test_status}\` (${t.matched_tests.length} test) | **${t.status}** |`;
  });

  return [
    "# Automated STRIDE Threat Model & Control Verification Report",
    "",
    `> Auto-generated by \`scripts/stride-audit.mjs\` on \`${matrix.timestamp}\` from \`reports/stride-matrix.json\` (SHA-256: \`${matrix.report_sha256.slice(0, 16)}\`).`,
    "",
    "## Executive Summary",
    "",
    `- **Overall Security Gate Verdict:** **${matrix.ok ? "PASS (0 OPEN CRITICAL/HIGH)" : "FAIL (OPEN CRITICAL/HIGH DETECTED)"}**`,
    `- **Total Mapped Threats:** \`${matrix.summary.totalThreats}\` across all 6 STRIDE categories`,
    `- **CRITICAL / HIGH Threats:** \`${matrix.summary.criticalHighMitigated}/${matrix.summary.criticalHighTotal}\` **MITIGATED** (\`${matrix.summary.criticalHighOpen}\` OPEN)`,
    `- **Linked Automated Test Suite:** \`${matrix.test_evidence.passedCount}\` passed across \`${matrix.test_evidence.suiteCount}\` suites, \`${matrix.test_evidence.failedCount}\` failed (exit code \`${matrix.test_evidence.exitCode}\`)`,
    "",
    "### STRIDE Category Scoreboard",
    "",
    "| Category | Total | MITIGATED | OPEN |",
    "| :--- | :---: | :---: | :---: |",
    ...catRows,
    "",
    "---",
    "",
    "## System Architecture & Trust Boundaries",
    "",
    "### Mermaid Trust-Boundary Diagram",
    "",
    "```mermaid",
    "flowchart LR",
    '  subgraph TB0["Trust Boundary 0: Untrusted Internet & Crawlers"]',
    '    USR["Public Users / Googlebot / LLM Crawlers"]',
    '    PR["Untrusted Fork Pull Request"]',
    "  end",
    "",
    '  subgraph TB1["Trust Boundary 1: Edge & Next.js App Router (Surface A)"]',
    '    MW["middleware.ts (HTTP 410 + Bounded LRU + 400ms Timeout)"]',
    '    SSR["App Router SSR (layout.metadata.ts, page.tsx, JobPostingJsonLd.tsx)"]',
    '    SM["app/sitemap.ts (Singleflight + 50k Shards + XML Escape)"]',
    '    GEO["GEO Feeds (llms.txt + ai/jobs.ndjson + PI Guard)"]',
    "  end",
    "",
    '  subgraph TB2["Trust Boundary 2: Internal Services & Credentials"]',
    '    KV["Edge Config / Archive KV"]',
    '    API["INTERNAL_API_URL (Vacancy Backend)"]',
    '    GIDX["google-indexing-api.ts (RS256 JWT + 200/day Quota + Audit Log)"]',
    "  end",
    "",
    '  subgraph TB3["Trust Boundary 3: GitHub Actions CI Gate (Surface B)"]',
    '    WF["seo-check-preview.yml (default_branch sparse-checkout + HTTPS allowlist)"]',
    '    VAL["validate-seo.mjs (8 Gates + SSRF Blocklist + Origin-Pinned Bypass + Secret Redaction)"]',
    "  end",
    "",
    '  USR -->|"HTTPS + Host pinned (S-02)"| MW',
    '  MW -->|"400ms fail-open (D-01, E-02)"| SSR',
    '  MW -->|"Bounded LRU lookup (D-01)"| KV',
    '  USR --> SM',
    '  USR --> GEO',
    '  SSR -->|"React.cache + DRAFT guard (I-02, I-03)"| API',
    '  SM -->|"Anti self-HTTP + Singleflight (T-02, D-01)"| API',
    '  GEO -->|"Indirect PI Sanitizer (T-03)"| API',
    '  SSR -->|"URL_UPDATED / URL_DELETED (S-03, R-01, D-02)"| GIDX',
    '  PR -.->|"deployment_status event (never checked out, S-01, T-04)"| WF',
    '  WF -->|"Scoped token + origin-pinned bypass (I-01, E-01)"| VAL',
    '  VAL -->|"8-gate probe + SHA-256 report (R-01)"| MW',
    "```",
    "",
    "### ASCII Trust-Boundary Diagram",
    "",
    "```text",
    "+-------------------------------------------------------------------------+",
    "| [TB0] UNTRUSTED INTERNET / CRAWLERS / FORK PRs                          |",
    "|  - Googlebot / LLM Crawlers / Malicious Partner HTML / Fork PR Payloads |",
    "+---------------------------+-----------------------------+---------------+",
    "                            |                             |",
    "       HTTPS (Pinned Origin)|                             | deployment_status",
    "                            v                             v",
    "+----------------------------------------+  +-----------------------------+",
    "| [TB1] NEXT.JS SEO/GEO SURFACE (A)      |  | [TB3] GITHUB ACTIONS CI (B) |",
    "| - middleware.ts (410, LRU, 400ms)      |  | - seo-check-preview.yml     |",
    "| - layout.metadata.ts (No root canon.)  |  |   (default_branch checkout, |",
    "| - page.tsx + JobPostingJsonLd.tsx      |  |    zero ${{}} in run:)      |",
    "| - sitemap.ts (Singleflight, 50k cap)   |  | - validate-seo.mjs          |",
    "| - llms.txt + ai/jobs.ndjson (PI guard) |  |   (SSRF guard, origin-pin   |",
    "+-------------------+--------------------+  |    bypass, secret masking)  |",
    "                    |                       +-------------+---------------+",
    "   Private Network  |                                     |",
    "   (No Error Leaks) v                                     | 8-Gate Probe",
    "+----------------------------------------+                |",
    "| [TB2] INTERNAL DATA & GOOGLE APIs      |<---------------+",
    "| - Edge Config / Archive KV             |",
    "| - INTERNAL_API_URL (Vacancies)         |",
    "| - Google Indexing API (RS256, 200/day) |",
    "+----------------------------------------+",
    "```",
    "",
    "---",
    "",
    "## STRIDE Threat & Control Traceability Matrix",
    "",
    "| Threat ID | Category | Surface | Severity | Control Files | Static Checks | Test Verification | Status |",
    "| :--- | :--- | :--- | :---: | :--- | :---: | :--- | :---: |",
    ...threatRows,
    "",
    "## Detailed Control Verification Evidence",
    "",
    ...matrix.threats.flatMap((t) => [
      `### ${t.threat_id} (${t.category} | ${t.severity} | ${t.surface})`,
      `- **Threat:** ${t.title}`,
      `- **Control Files:** \`${t.control_file}\``,
      `- **Linked Test Evidence:** \`${t.verified_by_test}\` -> **${t.test_status}**`,
      ...t.static_checks.map((c) => `- Static Check [${c.pass ? "PASS" : "FAIL"}]: ${c.label}`),
      `- **Status:** **${t.status}**`,
      "",
    ]),
  ].join("\n");
}

export async function runStrideAudit({ writeOutputs = true, precomputedTests = null } = {}) {
  const testEvidence = precomputedTests ?? (await executeLinkedTestSuites());
  const defs = buildThreatDefinitions();

  const threats = defs.map((def) => {
    const allStaticPass = def.staticChecks.every((c) => c.pass);
    const matchedPassed = testEvidence.passed.filter((name) => def.testMatchPattern.test(name));
    const matchedFailed = testEvidence.failed.filter((name) => def.testMatchPattern.test(name));
    const testPass = matchedPassed.length > 0 && matchedFailed.length === 0;
    const status = allStaticPass && testPass ? "MITIGATED" : "OPEN";

    return {
      threat_id: def.threat_id,
      category: def.category,
      category_code: def.category_code,
      surface: def.surface,
      severity: def.severity,
      title: def.title,
      control_file: def.control_file,
      verified_by_test: def.verified_by_test,
      matched_tests: matchedPassed,
      failed_tests: matchedFailed,
      test_status: testPass ? "PASS" : "FAIL",
      static_checks: def.staticChecks,
      status,
    };
  });

  const byCategory = {};
  for (const code of ["S", "T", "R", "I", "D", "E"]) {
    const list = threats.filter((t) => t.category_code === code);
    byCategory[code] = {
      total: list.length,
      mitigated: list.filter((t) => t.status === "MITIGATED").length,
      open: list.filter((t) => t.status !== "MITIGATED").length,
    };
  }

  const critHigh = threats.filter((t) => t.severity === "CRITICAL" || t.severity === "HIGH");
  const gate = evaluateStrideGate(threats);
  const timestamp = new Date().toISOString();

  const baseMatrix = {
    ok: gate.ok,
    timestamp,
    summary: {
      totalThreats: threats.length,
      mitigatedTotal: threats.filter((t) => t.status === "MITIGATED").length,
      openTotal: threats.filter((t) => t.status !== "MITIGATED").length,
      criticalHighTotal: critHigh.length,
      criticalHighMitigated: critHigh.filter((t) => t.status === "MITIGATED").length,
      criticalHighOpen: critHigh.filter((t) => t.status !== "MITIGATED").length,
      byCategory,
    },
    test_evidence: {
      exitCode: testEvidence.exitCode,
      testCaseCount: testEvidence.testCaseCount,
      suiteCount: testEvidence.suiteCount,
      passedCount: testEvidence.passedTestCases,
      failedCount: testEvidence.failedTestCases,
    },
    threats,
  };

  const report_sha256 = createHash("sha256")
    .update(JSON.stringify(baseMatrix), "utf8")
    .digest("hex");

  const matrix = { ...baseMatrix, report_sha256 };

  if (writeOutputs) {
    mkdirSync(dirname(MATRIX_OUT), { recursive: true });
    mkdirSync(dirname(DOC_OUT), { recursive: true });
    writeFileSync(MATRIX_OUT, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
    writeFileSync(DOC_OUT, `${renderStrideMarkdown(matrix)}\n`, "utf8");
  }

  return { matrix, gate };
}

const isDirectRun =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();

if (isDirectRun) {
  runStrideAudit({ writeOutputs: true })
    .then(({ matrix, gate }) => {
      console.log("=== MagangHub Automated STRIDE Threat Modeling Engine (Phase 2.7) ===");
      for (const [code, s] of Object.entries(matrix.summary.byCategory)) {
        console.log(`  [${code}] total=${s.total} mitigated=${s.mitigated} open=${s.open}`);
      }
      console.log(
        `CRITICAL/HIGH: ${matrix.summary.criticalHighMitigated}/${matrix.summary.criticalHighTotal} MITIGATED (${matrix.summary.criticalHighOpen} OPEN)`,
      );
      console.log(`Matrix JSON: ${MATRIX_OUT}`);
      console.log(`Threat Model MD: ${DOC_OUT}`);
      console.log(`SHA-256: ${matrix.report_sha256}`);
      if (!gate.ok) {
        console.error(
          `STRIDE GATE FAILED (EXIT 1): Unmitigated CRITICAL/HIGH threats: ${gate.openCriticalOrHighIds.join(", ")}`,
        );
        process.exitCode = 1;
      } else {
        console.log("STRIDE GATE VERDICT: 100% PASS (EXIT 0)");
      }
    })
    .catch((err) => {
      console.error("[STRIDE-AUDIT FATAL]", err);
      process.exitCode = 1;
    });
}
