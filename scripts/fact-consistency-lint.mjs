#!/usr/bin/env node
/**
 * FASE 7: Automated Adversarial Fact-Consistency Linter (The Final Judge)
 * Scans all text, Markdown, HTML, JSON, TS/JS, and PDF-extracted text across
 * final release targets and exits 1 on ANY error or warning.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCRATCH_ROOT = process.env.MAGANGHUB_SCRATCH_ROOT || path.resolve(REPO_ROOT, "..");
const PORTFOLIO_BLOG_DIR =
  process.env.PORTFOLIO_BLOG_DIR ||
  path.resolve(SCRATCH_ROOT, "..", "..", "..", "Projects", "ardhya-portfolio", "public", "blog", "teardown-maganghub-kemnaker-nextjs-seo");

const TARGETS = [
  {
    name: "maganghub-nextjs-seo-blueprint",
    dir: REPO_ROOT,
    isCodeRepo: true,
    requireCoreFacts: false,
  },
  {
    name: "maganghub-teardown",
    dir: path.join(SCRATCH_ROOT, "maganghub-teardown"),
    isCodeRepo: false,
    requireCoreFacts: true,
    coreFactFiles: ["PUBLISH_KIT.md", "index.html", "carousel.html", "maganghub-linkedin-carousel.pdf"],
  },
  {
    name: "maganghub-growth-blueprint",
    dir: path.join(SCRATCH_ROOT, "maganghub-growth-blueprint"),
    isCodeRepo: false,
    requireCoreFacts: true,
    onlyFiles: [
      "REPORT_4WAY_EMPIRICAL.md",
      "MAGANGHUB_STRATEGIC_BRIEFING.html",
      "MAGANGHUB_STRATEGIC_BRIEFING.pdf",
      "maganghub-command-center.html",
    ],
    coreFactFiles: [
      "REPORT_4WAY_EMPIRICAL.md",
      "MAGANGHUB_STRATEGIC_BRIEFING.html",
      "MAGANGHUB_STRATEGIC_BRIEFING.pdf",
      "maganghub-command-center.html",
    ],
  },
  {
    name: "ardhya-portfolio-blog",
    dir: PORTFOLIO_BLOG_DIR,
    isCodeRepo: false,
    requireCoreFacts: true,
    coreFactFiles: ["index.html"],
  },
];

// Files/paths explicitly allowed to contain adversarial test fixtures (e.g., negative tests checking for forbidden strings)
function isTestFile(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  return (
    norm.startsWith("tests/") ||
    norm.startsWith("test/") ||
    norm.includes("/tests/") ||
    norm.endsWith(".test.mjs") ||
    norm.endsWith(".test.ts") ||
    norm.startsWith("reports/") ||
    norm === "scripts/fact-consistency-lint.mjs"
  );
}

function extractPdfText(pdfPath) {
  // Use Python pymupdf / pypdf / markitdown via C:\Python314\python.exe
  const pyCode = `
import sys
p = sys.argv[1]
txt = ""
try:
    import pymupdf
    doc = pymupdf.open(p)
    txt = "\\n".join(page.get_text("text") for page in doc)
except Exception:
    try:
        from pypdf import PdfReader
        r = PdfReader(p)
        txt = "\\n".join((page.extract_text() or "") for page in r.pages)
    except Exception:
        from markitdown import MarkItDown
        txt = MarkItDown().convert(p).text_content
sys.stdout.buffer.write(txt.encode("utf-8"))
`;
  const res = spawnSync("C:\\Python314\\python.exe", ["-c", pyCode, pdfPath], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`PDF text extraction failed for ${pdfPath}: ${res.stderr}`);
  }
  return res.stdout;
}

const FORBIDDEN_PATTERNS = [
  { id: "FORBIDDEN_ZERO_ANALYTICS", regex: new RegExp("\\b(?:0|nol|zero)\\s+anal(?:ytics|itik)\\b", "gi"), msg: "Claims zero client analytics without acknowledging self-hosted Plausible" },
  { id: "FORBIDDEN_RELEASED_NOV16", regex: new RegExp("(?:dirilis\\s+pada\\s+16\\s+nov|pada\\s+16\\s+november\\s+2026|released\\s+on\\s+nov(?:ember)?\\s+16)", "gi"), msg: "Forbidden Wayback exact-release-date phrasing for Nov 16 snapshot" },
  { id: "FORBIDDEN_PROPORSI_B2B", regex: new RegExp("prop" + "orsi\\s+B2B", "gi"), msg: "Typo in B2B value proposition term (must be proposisi B2B)" },
  { id: "FORBIDDEN_PLACEHOLDER", regex: new RegExp("\\[Tanggal\\s+Mulai\\]|\\[DIISI_TIM_" + "KEMNAKER\\]", "gi"), msg: "Unfilled template placeholder in production file" },
  { id: "FORBIDDEN_CLICHE", regex: new RegExp("paradoks\\s+klasik|bukan\\s+sekadar\\s+.{1,40}\\s+melainkan|tanpa\\s+mengeluarkan\\s+satu\\s+rupiah\\s+pun", "gi"), msg: "AI cliche phrase detected" },
  { id: "FORBIDDEN_EM_DASH", regex: new RegExp("\\u2014|&m" + "dash;", "g"), msg: "Em-dash character (U+2014 or HTML mdash entity) forbidden" },
];

function checkHtmlMetaLengths(content, fileLabel, errors) {
  const titleMatch = content.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const title = titleMatch[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
    if (title.length > 65) {
      errors.push({ file: fileLabel, rule: "META_TITLE_LENGTH", detail: `<title> is ${title.length} chars (> 65): "${title}"` });
    }
  }
  const metaTags = content.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    }
    const name = (attrs.name || "").toLowerCase();
    const prop = (attrs.property || "").toLowerCase();
    const val = (attrs.content || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    if (name === "description") {
      if (val.length < 150 || val.length > 160) {
        errors.push({ file: fileLabel, rule: "META_DESC_LENGTH", detail: `<meta name="description"> is ${val.length} chars (must be 150-160)` });
      }
    }
    if (prop === "og:title" || name === "twitter:title") {
      if (val.length > 65) {
        errors.push({ file: fileLabel, rule: "OG_TITLE_LENGTH", detail: `${prop || name} is ${val.length} chars (> 65)` });
      }
    }
    if (prop === "og:description" || name === "twitter:description") {
      if (val.length > 160) {
        errors.push({ file: fileLabel, rule: "OG_DESC_LENGTH", detail: `${prop || name} is ${val.length} chars (> 160)` });
      }
    }
  }
}

function checkRaw404Routes(content, fileLabel, isTest, errors) {
  if (isTest) return;
  // Strip script/code comments checking 404 or competitor URLs line by line
  const lines = content.split(/\r?\n/);
  const routeRegex = /(?<!\/magang-nasional)(?<!dealls\.com)(?<!glints\.com)(?:^|[\s"'`(>])(\/lowongan|\/perusahaan|\/jadwal|\/sertifikasi|\/api\/lowongan\/active)(?=[\s"'`),.<\]]|$)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const windowCtx = lines.slice(Math.max(0, i - 6), Math.min(lines.length, i + 2)).join(" ");
    // Allow explicit mentions of 404 / asumsi / non-existent / legacy / anti-collision segments
    if (/404|asumsi|bukan rute|not found|non-existent|anti-tabrakan|anti-collision|reserved|segment|exclude|legacy draft|DEPRECATED|KNOWN_404|ASSUMED/i.test(windowCtx)) continue;
    const matches = [...line.matchAll(routeRegex)];
    if (matches.length > 0) {
      errors.push({
        file: `${fileLabel}:${i + 1}`,
        rule: "RAW_404_ROUTE_AS_LIVE",
        detail: `Raw 404 route (${matches.map((m) => m[1]).join(", ")}) mentioned without 404 context: "${line.trim().slice(0, 120)}"`,
      });
    }
  }
}

function checkStrayBackticksAndBrokenMd(content, ext, fileLabel, errors) {
  if (ext === ".html") {
    const visible = content
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<pre[\s\S]*?<\/pre>/gi, "")
      .replace(/<code[\s\S]*?<\/code>/gi, "");
    const ticks = visible.match(/`/g) || [];
    if (ticks.length > 0) {
      errors.push({ file: fileLabel, rule: "STRAY_BACKTICK_HTML", detail: `Found ${ticks.length} stray backtick(s) in visible HTML` });
    }
  } else if (ext === ".pdf") {
    const ticks = content.match(/`/g) || [];
    if (ticks.length > 0) {
      errors.push({ file: fileLabel, rule: "STRAY_BACKTICK_PDF", detail: `Found ${ticks.length} stray backtick(s) in extracted PDF text` });
    }
  } else if (ext === ".md") {
    // Broken bold+backtick nesting like **foo `bar**` or link inside backticks like `[foo](bar)`
    if (/\*\*[^*\n`]*`[^`\n*]*\*\*`/.test(content)) {
      errors.push({ file: fileLabel, rule: "BROKEN_BOLD_BACKTICK", detail: "Broken bold+backtick nesting in Markdown" });
    }
    if (/`\[[^\]]+\]\([^)]+\)`/.test(content)) {
      errors.push({ file: fileLabel, rule: "BROKEN_LINK_IN_BACKTICK", detail: "Markdown link wrapped inside backticks" });
    }
  }
}

function checkCoreFacts(content, fileLabel, errors) {
  const required = [
    { name: "2.93", re: /2[.,]93/ },
    { name: "2.06", re: /2[.,]06/ },
    { name: "51.957 / 51,957", re: /51[.,]957/ },
    { name: "Kenaker RI", re: /Kenaker RI/ },
    { name: "Plausible", re: /Plausible/i },
    { name: "8/8", re: /8\s*\/\s*8/ },
    { name: "Batch 3B", re: /Batch 3B/i },
  ];
  for (const r of required) {
    if (!r.re.test(content)) {
      errors.push({ file: fileLabel, rule: "MISSING_CORE_FACT", detail: `Required ledger fact missing: ${r.name}` });
    }
  }
}

function collectFiles(target) {
  const list = [];
  if (!fs.existsSync(target.dir)) {
    throw new Error(`Target directory missing: ${target.dir}`);
  }
  if (target.onlyFiles) {
    for (const rel of target.onlyFiles) {
      const full = path.join(target.dir, rel);
      if (fs.existsSync(full)) list.push({ full, rel });
    }
    return list;
  }
  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".git", "slides", "qa-slides", "fonts", "assets", "dist", ".next"].includes(ent.name)) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(md|html|json|ts|tsx|js|mjs|txt|yml|yaml|pdf)$/i.test(ent.name)) {
        list.push({ full, rel: path.relative(target.dir, full) });
      }
    }
  }
  walk(target.dir);
  return list;
}

const start = Date.now();
const errors = [];
const warnings = [];
let filesScanned = 0;
let pdfsScanned = 0;

for (const target of TARGETS) {
  const files = collectFiles(target);
  for (const { full, rel } of files) {
    const ext = path.extname(full).toLowerCase();
    const label = `${target.name}/${rel.replace(/\\/g, "/")}`;
    const testFlag = isTestFile(rel);

    let content = "";
    if (ext === ".pdf") {
      content = extractPdfText(full);
      pdfsScanned += 1;
    } else {
      content = fs.readFileSync(full, "utf8");
    }
    filesScanned += 1;

    // 1. Forbidden patterns (skip negative-assertion test files only for non-em-dash patterns; keep em-dash check strict on docs)
    for (const rule of FORBIDDEN_PATTERNS) {
      if (testFlag && rule.id !== "FORBIDDEN_EM_DASH") continue;
      if (rule.id === "FORBIDDEN_PLACEHOLDER" && target.isCodeRepo && rel.replace(/\\/g, "/").includes("validate-seo.mjs")) {
        // Validator script itself checks for placeholder tokens in scanned HTML/llms.txt
        continue;
      }
      const m = content.match(rule.regex);
      if (m && m.length > 0) {
        errors.push({ file: label, rule: rule.id, detail: `${rule.msg} (hits=${m.length}, sample="${m[0]}")` });
      }
    }

    // 2. HTML metadata exact length checks
    if (ext === ".html") {
      checkHtmlMetaLengths(content, label, errors);
    }

    // 3. Raw 404 routes used as live routes
    if (ext !== ".json") {
      checkRaw404Routes(content, label, testFlag, errors);
    }

    // 4. Stray backticks & broken markdown nesting
    if (!testFlag) {
      checkStrayBackticksAndBrokenMd(content, ext, label, errors);
    }

    // 5. Required core facts in flagship publication artifacts
    if (target.requireCoreFacts && target.coreFactFiles && target.coreFactFiles.includes(rel.replace(/\\/g, "/"))) {
      checkCoreFacts(content, label, errors);
    }
  }
}

const durationMs = Date.now() - start;
console.log(`FACT-CONSISTENCY-LINT: scanned ${filesScanned} files (${pdfsScanned} PDFs) in ${durationMs}ms`);
console.log(`ERRORS: ${errors.length} | WARNINGS: ${warnings.length}`);
for (const e of errors) {
  console.error(`  [ERROR] ${e.rule} @ ${e.file} -> ${e.detail}`);
}
for (const w of warnings) {
  console.warn(`  [WARN]  ${w.rule} @ ${w.file} -> ${w.detail}`);
}

if (errors.length > 0 || warnings.length > 0) {
  process.exit(1);
}
console.log("PASS: 0 ERRORS, 0 WARNINGS across all canonical publication, PDF, portfolio, and monorepo artifacts.");
