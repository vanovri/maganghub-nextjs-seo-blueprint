import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXTS = new Set([".ts", ".tsx", ".mjs", ".js", ".json", ".md", ".yml", ".yaml", ".d.ts"]);

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "reports" || entry === "package-lock.json") {
      continue;
    }
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (TEXT_EXTS.has(extname(entry).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

describe("Monorepo Hygiene, Immutable Fact Ledger & Zero Runtime Dependency Guarantees", () => {
  const files = walkFiles(ROOT);

  it("contains ZERO em-dashes (U+2014) across all docs, code, workflows, and tests", () => {
    const violations = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (text.includes("\u2014")) {
        violations.push(relative(ROOT, f));
      }
    }
    assert.deepEqual(violations, [], `Em-dash (U+2014) found in: ${violations.join(", ")}`);
  });

  it("contains ZERO banned factual errors ('0 analytics', 'nol analytics', 'dirilis pada 16 Nov', 'pada 16 November 2026')", () => {
    const bannedPatterns = [
      /\b0\s+analytics\b/i,
      /\bnol\s+analytics\b/i,
      /dirilis\s+pada\s+16\s+Nov/i,
      /pada\s+16\s+November\s+2026/i,
    ];
    const violations = [];
    for (const f of files) {
      if (relative(ROOT, f).replace(/\\/g, "/") === "tests/hygiene.test.mjs") continue;
      const text = readFileSync(f, "utf8");
      for (const re of bannedPatterns) {
        if (re.test(text)) {
          violations.push(`${relative(ROOT, f)} matched ${re}`);
        }
      }
    }
    assert.deepEqual(violations, [], `Banned factual phrase found: ${violations.join("; ")}`);
  });

  it("contains ZERO unfilled placeholders in README, blueprint outputs, and workflows", () => {
    const placeholderRe = /\[(?:Tanggal\s+Mulai|Tanggal\s+Selesai|DIISI_TIM_KEMNAKER)\]/i;
    const violations = [];
    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      // Regex definitions intentionally naming placeholder patterns in linters/tests are excluded
      if (
        rel === "packages/seo-ci-gate/scripts/validate-seo.mjs" ||
        rel === "packages/nextjs-blueprint/lib/llms.ts" ||
        rel === "tests/hygiene.test.mjs"
      ) {
        continue;
      }
      const text = readFileSync(f, "utf8");
      if (placeholderRe.test(text)) {
        violations.push(rel);
      }
    }
    assert.deepEqual(violations, [], `Placeholder leaked into: ${violations.join(", ")}`);
  });

  it("guarantees ZERO runtime dependencies in packages/seo-ci-gate and validate-seo.mjs", () => {
    const gatePkg = JSON.parse(
      readFileSync(resolve(ROOT, "packages/seo-ci-gate/package.json"), "utf8"),
    );
    assert.deepEqual(gatePkg.dependencies || {}, {});

    const gateSrc = readFileSync(
      resolve(ROOT, "packages/seo-ci-gate/scripts/validate-seo.mjs"),
      "utf8",
    );
    const imports = [...gateSrc.matchAll(/^\s*import\s+[\s\S]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    for (const spec of imports) {
      assert.ok(spec.startsWith("node:"), `Non-builtin runtime import in validate-seo.mjs: ${spec}`);
    }
  });
});
