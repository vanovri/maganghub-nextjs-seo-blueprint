import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = resolve(ROOT, ".github/workflows");

function loadWorkflow(filename) {
  const fullPath = resolve(WORKFLOWS_DIR, filename);
  const raw = readFileSync(fullPath, "utf8");
  const doc = YAML.parseDocument(raw);
  assert.equal(
    doc.errors.length,
    0,
    `${filename} YAML parse errors: ${doc.errors.map((e) => e.message).join("; ")}`,
  );
  return { filename, raw, parsed: doc.toJS() };
}

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/i.test(f));

describe("GitHub Actions Workflow Security & YAML AST Audit", () => {
  it("contains both seo-check-preview.yml and seo-check-local.yml", () => {
    assert.ok(workflowFiles.includes("seo-check-preview.yml"));
    assert.ok(workflowFiles.includes("seo-check-local.yml"));
  });

  it("forbids ALL ${{ ... }} expression interpolation inside every run: block across all workflows", () => {
    for (const file of workflowFiles) {
      const { parsed } = loadWorkflow(file);
      assert.ok(parsed.jobs && typeof parsed.jobs === "object", `${file} missing jobs`);
      for (const [jobId, job] of Object.entries(parsed.jobs)) {
        for (const [idx, step] of (job.steps || []).entries()) {
          if (typeof step.run === "string") {
            assert.doesNotMatch(
              step.run,
              /\$\{\{/,
              `SECURITY VIOLATION in ${file} job=${jobId} step#${idx + 1} (${step.name || "unnamed"}): found \${{ }} inside run:`,
            );
          }
        }
      }
    }
  });

  it("enforces minimal permissions, concurrency cancellation, timeout-minutes, and pinned Node 24 actions across all workflows", () => {
    const allowedActionPrefixes = [
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "actions/upload-artifact@v4",
    ];

    for (const file of workflowFiles) {
      const { parsed } = loadWorkflow(file);
      assert.ok(parsed.permissions && typeof parsed.permissions === "object", `${file} missing top-level permissions`);
      assert.ok(parsed.concurrency?.group, `${file} missing concurrency.group`);
      assert.equal(parsed.concurrency["cancel-in-progress"], true, `${file} must cancel-in-progress`);

      for (const [jobId, job] of Object.entries(parsed.jobs)) {
        assert.ok(
          typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 15,
          `${file} job=${jobId} must set bounded timeout-minutes`,
        );

        let sawNode24 = false;
        for (const step of job.steps || []) {
          if (step.uses) {
            assert.ok(
              allowedActionPrefixes.includes(step.uses),
              `${file} uses unverified/unpinned action: ${step.uses}`,
            );
            if (step.uses.startsWith("actions/checkout@")) {
              assert.equal(
                step.with?.["persist-credentials"],
                false,
                `${file} checkout must set persist-credentials: false`,
              );
            }
            if (step.uses.startsWith("actions/setup-node@")) {
              assert.equal(
                String(step.with?.["node-version"]),
                "24",
                `${file} must pin Node.js 24 LTS`,
              );
              sawNode24 = true;
            }
          }
        }
        assert.equal(sawNode24, true, `${file} job=${jobId} must configure Node 24`);
      }
    }
  });

  it("hardens seo-check-preview.yml against Fork-PR Pwn Requests and includes sticky PR comment + commit status", () => {
    const { parsed } = loadWorkflow("seo-check-preview.yml");
    assert.ok("deployment_status" in parsed.on);
    assert.ok("workflow_dispatch" in parsed.on);
    assert.deepEqual(parsed.permissions, {
      contents: "read",
      statuses: "write",
      "pull-requests": "write",
    });

    const job = parsed.jobs["validate-seo-preview"];
    assert.ok(job, "Expected job validate-seo-preview");

    const checkoutStep = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    assert.ok(checkoutStep);
    assert.match(String(checkoutStep.with?.ref || ""), /github\.event\.repository\.default_branch/);
    assert.doesNotMatch(String(checkoutStep.with?.ref || ""), /deployment\.sha/);
    assert.match(
      String(checkoutStep.with?.["sparse-checkout"] || ""),
      /packages\/seo-ci-gate\/scripts\/validate-seo\.mjs/,
    );
    assert.equal(checkoutStep.with?.["persist-credentials"], false);

    // Verify HTTPS allowlist step guards bypass secret exposure
    const allowlistStep = job.steps.find((s) => s.id === "target");
    assert.ok(allowlistStep);
    assert.match(allowlistStep.run, /u\.protocol !== "https:"/);
    assert.match(allowlistStep.run, /vercel\\\.app/);

    const seoStep = job.steps.find((s) => s.id === "seo");
    assert.ok(seoStep);
    assert.match(
      String(seoStep.env?.VERCEL_AUTOMATION_BYPASS_SECRET || ""),
      /steps\.target\.outputs\.allow_bypass == 'true'/,
    );

    // Commit status step targets DEPLOY_SHA via env
    const statusStep = job.steps.find((s) => /commit status/i.test(s.name || ""));
    assert.ok(statusStep);
    assert.equal(statusStep.env?.DEPLOY_SHA, "${{ github.event.deployment.sha }}");
    assert.match(statusStep.run, /\/statuses\/\$\{DEPLOY_SHA\}/);

    // Sticky PR comment step posts or updates marked comment
    const prCommentStep = job.steps.find((s) => /sticky PR comment/i.test(s.name || ""));
    assert.ok(prCommentStep, "Missing automatic sticky PR comment step");
    assert.match(prCommentStep.run, /<!-- maganghub-seo-ci-gate -->/);
    assert.match(prCommentStep.run, /--method PATCH/);
    assert.match(prCommentStep.run, /--method POST/);
  });

  it("hardens seo-check-local.yml with set -euo pipefail, trap cleanup EXIT, crash-fast kill -0, and log dump on fail", () => {
    const { parsed } = loadWorkflow("seo-check-local.yml");
    assert.ok("pull_request" in parsed.on);
    assert.deepEqual(parsed.permissions, { contents: "read" });

    const job = parsed.jobs["validate-seo-local"];
    const runStep = job.steps.find((s) => /Start Next\.js server/i.test(s.name || ""));
    assert.ok(runStep);
    assert.match(runStep.run, /set -euo pipefail/);
    assert.match(runStep.run, /trap cleanup EXIT/);
    assert.match(runStep.run, /kill -0 "\$SERVER_PID"/);
    assert.match(runStep.run, /cat "\$LOG_FILE"/);
  });
});
