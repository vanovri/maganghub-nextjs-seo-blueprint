import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  fetchUrl,
  formatMarkdownSummary,
  runSeoValidation,
} from "../packages/seo-ci-gate/scripts/validate-seo.mjs";

const FIXED_NOW = "2026-11-21T12:00:00+07:00";
const BYPASS_SECRET = "vercel-super-secret-bypass-token-999";

const LONG_SSR_TEXT =
  "Program Pemagangan Nasional MagangHub Kementerian Ketenagakerjaan Republik Indonesia membuka peluang magang bersubsidi pemerintah selama enam bulan dengan uang saku setara UMK dan sertifikasi profesi BNSP bagi lulusan Diploma dan Sarjana melalui ekosistem SIAPkerja. ".repeat(
    5,
  );

function buildValidJobPosting(overrides = {}) {
  return {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Backend Engineer Intern",
    description:
      "<p>Mengembangkan API layanan publik MagangHub Kemnaker RI menggunakan TypeScript dan Node.js dengan standar keamanan tinggi.</p>",
    identifier: {
      "@type": "PropertyValue",
      name: "MagangHub Kemnaker RI",
      value: "job-001",
    },
    datePosted: "2026-11-18T08:00:00+07:00",
    validThrough: "2026-12-01T23:59:59+07:00",
    employmentType: "INTERN",
    directApply: true,
    hiringOrganization: {
      "@type": "Organization",
      name: "PT Telkom Indonesia (Persero) Tbk",
      sameAs: "https://www.telkom.co.id",
      logo: "https://maganghub.kemnaker.go.id/logos/telkom.png",
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: "Bandung",
        addressRegion: "Jawa Barat",
        addressCountry: "ID",
      },
    },
    baseSalary: {
      "@type": "MonetaryAmount",
      currency: "IDR",
      value: {
        "@type": "QuantitativeValue",
        value: 4500000,
        unitText: "MONTH",
      },
    },
    ...overrides,
  };
}

function buildHtmlPage({
  title = "Magang Nasional Bersubsidi Kemnaker RI | MagangHub",
  description = "Platform resmi Program Pemagangan Nasional bersubsidi pemerintah dari Kemnaker RI bagi lulusan D3/S1 bersama perusahaan mitra terverifikasi di SIAPkerja.",
  canonical = "https://maganghub.kemnaker.go.id/",
  metaRobotsTag = "",
  jsonLdRaw = "",
  body = `<main><h1>Program Pemagangan Nasional</h1><p>${LONG_SSR_TEXT}</p></main>`,
} = {}) {
  const canonicalTag = canonical ? `<link rel="canonical" href="${canonical}">` : "";
  const ldTag = jsonLdRaw ? `<script type="application/ld+json">${jsonLdRaw}</script>` : "";
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  ${canonicalTag}
  ${metaRobotsTag}
  ${ldTag}
</head>
<body>${body}</body>
</html>`;
}

const VALID_LLMS_TXT = `# MagangHub Kemnaker RI

> Platform resmi Program Pemagangan Lulusan Perguruan Tinggi (Magang Nasional) bersubsidi pemerintah dari Kementerian Ketenagakerjaan Republik Indonesia.

## Tautan Inti
- [Lowongan Magang](https://maganghub.kemnaker.go.id/magang-nasional/lowongan): Daftar lowongan aktif Batch 3B 2026.
- [Penyelenggara](https://maganghub.kemnaker.go.id/magang-nasional/penyelenggara): Daftar instansi mitra.
- [Portal HR](https://organizer.maganghub.kemnaker.go.id): Portal penyelenggara mitra.
`;

function listenOnEphemeralPort(server) {
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolvePromise({ port: addr.port, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("Multi-Origin E2E HTTP Harness (3 Parallel Servers: Primary, Cross-Origin Trap, Chaos)", () => {
  let primaryServer;
  let trapServer;
  let chaosServer;
  let primaryOrigin;
  let trapOrigin;
  let chaosOrigin;
  let tempDir;

  // Mutable test state for Server A (Primary), Server B (Trap), Server C (Chaos)
  let primaryState;
  const trapObservedHeaders = [];
  let chaosAttemptCounter = 0;

  function resetPrimaryState() {
    primaryState = {
      requireBypass: false,
      homeXRobotsTag: "",
      sitemapMode: "urlset", // "urlset" | "sitemapindex"
      includeExpiredInSitemap: false,
      activeJobCanonical: "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/backend-intern",
      activeJobJsonLdRaw: JSON.stringify(buildValidJobPosting()),
      expiredBehavior: "strip-schema-clean", // "strip-schema-clean" | "preview-trap" | "410" | "302-soft404" | "leaked-schema"
      expiredXRobotsTag: "noindex",
      redirectRootToTrap: false,
    };
  }

  before(async () => {
    resetPrimaryState();
    tempDir = mkdtempSync(join(tmpdir(), "maganghub-e2e-"));

    // Server B: Cross-Origin Redirect Trap (different port = different origin!)
    trapServer = createServer((req, res) => {
      trapObservedHeaders.push({
        url: req.url,
        bypass: req.headers["x-vercel-protection-bypass"],
        bypassCookie: req.headers["x-vercel-set-bypass-cookie"],
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>Trap origin reached</body></html>");
    });

    // Server C: Slow / Timeout / 503 Chaos Server
    chaosServer = createServer((req, res) => {
      if (req.url === "/slow") {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("too late");
          }
        }, 600).unref();
        return;
      }
      if (req.url === "/flaky-503") {
        chaosAttemptCounter += 1;
        if (chaosAttemptCounter < 3) {
          res.writeHead(503, { "content-type": "text/plain" });
          res.end("Service Unavailable");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("recovered-after-retries");
        return;
      }
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Chaos 500");
    });

    // Server A: Primary Preview / Production App
    primaryServer = createServer((req, res) => {
      const pathname = new URL(req.url, primaryOrigin).pathname;

      if (primaryState.redirectRootToTrap && pathname === "/redirect-trap") {
        res.writeHead(302, { location: `${trapOrigin}/stolen` });
        res.end();
        return;
      }

      if (primaryState.requireBypass) {
        const provided = req.headers["x-vercel-protection-bypass"];
        if (provided !== BYPASS_SECRET) {
          res.writeHead(401, {
            "content-type": "text/html; charset=utf-8",
            "x-vercel-id": "sin1::mock-id",
            "x-vercel-mitigated": "challenge",
          });
          res.end("<html><body>Authentication Required - vercel.com/sso</body></html>");
          return;
        }
      }

      if (pathname === "/") {
        const headers = { "content-type": "text/html; charset=utf-8" };
        if (primaryState.homeXRobotsTag) headers["x-robots-tag"] = primaryState.homeXRobotsTag;
        res.writeHead(200, headers);
        res.end(
          buildHtmlPage({
            jsonLdRaw: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "GovernmentOrganization",
              name: "MagangHub Kemnaker RI",
            }),
          }),
        );
        return;
      }

      if (pathname === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(
          "User-agent: *\nAllow: /\nDisallow: /dashboard/\nDisallow: /api/\n\nSitemap: https://maganghub.kemnaker.go.id/sitemap.xml\n",
        );
        return;
      }

      if (pathname === "/sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
        if (primaryState.sitemapMode === "sitemapindex") {
          res.end(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc><![CDATA[https://maganghub.kemnaker.go.id/sitemap-0.xml?shard=0&amp;v=1]]></loc></sitemap>
  <sitemap><loc>https://maganghub.kemnaker.go.id/sitemap-1.xml?shard=1&amp;v=1</loc></sitemap>
</sitemapindex>`);
          return;
        }
        const expiredEntry = primaryState.includeExpiredInSitemap
          ? "<url><loc>https://maganghub.kemnaker.go.id/magang-nasional/lowongan/expired-intern</loc></url>"
          : "";
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://maganghub.kemnaker.go.id/</loc></url>
  <url><loc>https://maganghub.kemnaker.go.id/magang-nasional/lowongan</loc></url>
  <url><loc>https://maganghub.kemnaker.go.id/magang-nasional/lowongan/kota/jakarta</loc></url>
  <url><loc>https://maganghub.kemnaker.go.id/magang-nasional/lowongan/backend-intern</loc></url>
  ${expiredEntry}
</urlset>`);
        return;
      }

      if (pathname === "/sitemap-0.xml") {
        res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc><![CDATA[https://maganghub.kemnaker.go.id/]]></loc></url>
  <url><loc>https://maganghub.kemnaker.go.id/magang-nasional/lowongan/kota/bandung</loc></url>
</urlset>`);
        return;
      }

      if (pathname === "/sitemap-1.xml") {
        res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://maganghub.kemnaker.go.id/magang-nasional/lowongan/backend-intern?utm=a&amp;ref=b</loc></url>
</urlset>`);
        return;
      }

      if (pathname === "/magang-nasional/lowongan/backend-intern") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          buildHtmlPage({
            title: "Backend Engineer Intern - PT Telkom Indonesia | MagangHub",
            canonical: primaryState.activeJobCanonical,
            jsonLdRaw: primaryState.activeJobJsonLdRaw,
          }),
        );
        return;
      }

      if (pathname === "/magang-nasional/lowongan/expired-intern") {
        if (primaryState.expiredBehavior === "302-soft404") {
          res.writeHead(302, { location: "/magang-nasional/lowongan" });
          res.end();
          return;
        }
        if (primaryState.expiredBehavior === "410") {
          res.writeHead(410, {
            "content-type": "text/html; charset=utf-8",
            "x-robots-tag": "noindex, follow",
          });
          res.end('<!doctype html><html lang="id"><head><meta name="robots" content="noindex, follow"></head><body><h1>410 Gone</h1></body></html>');
          return;
        }
        if (primaryState.expiredBehavior === "preview-trap") {
          // Has platform X-Robots-Tag: noindex header, but MISSING HTML <meta name="robots">!
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "x-robots-tag": "noindex",
          });
          res.end(
            buildHtmlPage({
              title: "[Ditutup] Backend Intern | MagangHub",
              canonical: "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/expired-intern",
              metaRobotsTag: "",
              jsonLdRaw: "",
            }),
          );
          return;
        }
        if (primaryState.expiredBehavior === "leaked-schema") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            buildHtmlPage({
              title: "[Ditutup] Backend Intern | MagangHub",
              canonical: "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/expired-intern",
              metaRobotsTag: '<meta content="noindex, follow" name="robots">',
              jsonLdRaw: JSON.stringify(buildValidJobPosting()),
            }),
          );
          return;
        }
        // strip-schema-clean: HTTP 200, 0 JobPosting, reversed attribute order <meta content=... name=robots>
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          ...(primaryState.expiredXRobotsTag ? { "x-robots-tag": primaryState.expiredXRobotsTag } : {}),
        });
        res.end(
          buildHtmlPage({
            title: "[Ditutup] Backend Intern | MagangHub",
            canonical: "https://maganghub.kemnaker.go.id/magang-nasional/lowongan/expired-intern",
            metaRobotsTag: `<meta\n  content='noindex, follow'\n  name=robots\n>`,
            jsonLdRaw: "",
          }),
        );
        return;
      }

      if (pathname === "/llms.txt") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(VALID_LLMS_TXT);
        return;
      }

      if (pathname === "/ai/jobs.ndjson") {
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
        res.end(`${JSON.stringify({ id: "job-001", title: "Backend Engineer Intern" })}\n`);
        return;
      }

      if (pathname === "/ai/faq.json") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            schemaVersion: "1.0",
            items: [{ question: "Gratis?", answer: "Ya, gratis." }],
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    });

    const [p, t, c] = await Promise.all([
      listenOnEphemeralPort(primaryServer),
      listenOnEphemeralPort(trapServer),
      listenOnEphemeralPort(chaosServer),
    ]);
    primaryOrigin = p.origin;
    trapOrigin = t.origin;
    chaosOrigin = c.origin;
  });

  after(async () => {
    await Promise.all([
      new Promise((r) => primaryServer.close(r)),
      new Promise((r) => trapServer.close(r)),
      new Promise((r) => chaosServer.close(r)),
    ]);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes all 8 gates cleanly on compliant deployment and writes --save-ssr snapshot", async () => {
    resetPrimaryState();
    const ssrDumpPath = join(tempDir, "ssr-job.html");
    const report = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      expiredJobPath: "/magang-nasional/lowongan/expired-intern",
      expiredJobMode: "strip-schema",
      requireAiFeeds: true,
      saveSsrPath: ssrDumpPath,
      now: FIXED_NOW,
    });

    assert.equal(report.ok, true, JSON.stringify(report.gates.filter((g) => g.status === "FAIL"), null, 2));
    assert.equal(report.gates.length, 8);
    assert.equal(report.counts.FAIL, 0);

    const dumped = readFileSync(ssrDumpPath, "utf8");
    assert.match(dumped, /Backend Engineer Intern/);
    const md = formatMarkdownSummary(report);
    assert.doesNotMatch(md, /\u2014/);
    assert.match(md, /G8-LLMS-TXT-AND-AI-FEEDS/);
  });

  it("blocks 0 bypass secret leakage on cross-origin 302 redirect (Server A -> Server B)", async () => {
    resetPrimaryState();
    primaryState.redirectRootToTrap = true;
    trapObservedHeaders.length = 0;

    const res = await fetchUrl(`${primaryOrigin}/redirect-trap`, {
      baseOrigin: primaryOrigin,
      bypassSecret: BYPASS_SECRET,
      allowLocalhost: true,
      maxRetries: 0,
    });

    assert.equal(res.status, 200);
    assert.equal(res.redirectChain.length, 1);
    assert.equal(res.redirectChain[0].crossOrigin, true);
    assert.equal(trapObservedHeaders.length, 1);
    assert.equal(trapObservedHeaders[0].bypass, undefined, "Bypass secret MUST NOT leak to cross-origin redirect!");
    assert.equal(trapObservedHeaders[0].bypassCookie, undefined);
  });

  it("detects Vercel 401 Protection without secret and succeeds with bypass header", async () => {
    resetPrimaryState();
    primaryState.requireBypass = true;
    primaryState.homeXRobotsTag = "noindex";

    const blocked = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "preview",
      allowLocalhost: true,
      maxRetries: 0,
      now: FIXED_NOW,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.gates[0].details.vercelProtected, true);

    const unlocked = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "preview",
      bypassSecret: BYPASS_SECRET,
      allowLocalhost: true,
      expiredJobPath: "/magang-nasional/lowongan/expired-intern",
      expiredJobMode: "strip-schema",
      previewPlatformNoindex: true,
      now: FIXED_NOW,
    });
    assert.equal(unlocked.ok, true, JSON.stringify(unlocked.gates, null, 2));
  });

  it("catches Preview X-Robots-Tag: noindex false-positive trap when app omits HTML meta robots", async () => {
    resetPrimaryState();
    primaryState.homeXRobotsTag = "noindex";
    primaryState.expiredBehavior = "preview-trap";

    const report = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "preview",
      allowLocalhost: true,
      expiredJobPath: "/magang-nasional/lowongan/expired-intern",
      expiredJobMode: "strip-schema",
      previewPlatformNoindex: true,
      now: FIXED_NOW,
    });

    assert.equal(report.ok, false);
    const g7 = report.gates.find((g) => g.id === "G7-EXPIRED-JOB-LIFECYCLE");
    assert.equal(g7.status, "FAIL");
    assert.equal(g7.details.previewTrapDetected, true);
    assert.match(g7.summary, /PREVIEW NOINDEX TRAP/i);
  });

  it("rejects soft-404 302 redirect on expired job and accepts true HTTP 410 Gone in mode 410", async () => {
    resetPrimaryState();
    primaryState.expiredBehavior = "302-soft404";

    const soft404 = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      expiredJobPath: "/magang-nasional/lowongan/expired-intern",
      expiredJobMode: "any",
      now: FIXED_NOW,
    });
    assert.equal(soft404.ok, false);
    const g7Soft = soft404.gates.find((g) => g.id === "G7-EXPIRED-JOB-LIFECYCLE");
    assert.match(g7Soft.summary, /Soft-404 risk.*redirect HTTP 302/i);

    primaryState.expiredBehavior = "410";
    const gone410 = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      expiredJobPath: "/magang-nasional/lowongan/expired-intern",
      expiredJobMode: "410",
      now: FIXED_NOW,
    });
    assert.equal(gone410.ok, true, JSON.stringify(gone410.gates, null, 2));
  });

  it("rejects Blocker #0 root-locked canonical '/' and *.vercel.app canonical leak on inner route", async () => {
    resetPrimaryState();
    primaryState.activeJobCanonical = "https://maganghub.kemnaker.go.id/";

    const rootLocked = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      now: FIXED_NOW,
    });
    assert.equal(rootLocked.ok, false);
    const g5 = rootLocked.gates.find((g) => g.id === "G5-CANONICAL-ROOT-GUARD");
    assert.equal(g5.status, "FAIL");
    assert.match(g5.summary, /BLOCKER #0/i);

    primaryState.activeJobCanonical = "https://preview-abc.vercel.app/magang-nasional/lowongan/backend-intern";
    const previewLeak = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      now: FIXED_NOW,
    });
    assert.equal(previewLeak.ok, false);
    const g5Leak = previewLeak.gates.find((g) => g.id === "G5-CANONICAL-ROOT-GUARD");
    assert.match(g5Leak.summary, /preview host/i);
  });

  it("rejects expired validThrough and unescaped </script> XSS inside JSON-LD", async () => {
    resetPrimaryState();
    primaryState.activeJobJsonLdRaw = JSON.stringify(
      buildValidJobPosting({ validThrough: "2026-10-01T23:59:59+07:00" }),
    );
    const expiredRes = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      now: FIXED_NOW,
    });
    assert.equal(expiredRes.ok, false);
    const g6Exp = expiredRes.gates.find((g) => g.id === "G6-JOBPOSTING-ACTIVE");
    assert.match(g6Exp.summary, /Expired JobPosting/i);

    resetPrimaryState();
    primaryState.activeJobJsonLdRaw = `{"@context":"https://schema.org","@type":"JobPosting","title":"X","description":"<!-- evil -->"}`;
    const xssRes = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      now: FIXED_NOW,
    });
    assert.equal(xssRes.ok, false);
    const g6Xss = xssRes.gates.find((g) => g.id === "G6-JOBPOSTING-ACTIVE");
    assert.match(g6Xss.summary, /unescaped HTML comment or <\/script>/i);
  });

  it("supports nested @graph, multi-shard <sitemapindex> + CDATA + &amp;, TELECOMMUTE, and jobLocation[]", async () => {
    resetPrimaryState();
    primaryState.sitemapMode = "sitemapindex";
    const remoteAndMultiGraph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "MagangHub" },
        buildValidJobPosting({
          "@type": ["JobPosting", "Thing"],
          jobLocationType: "TELECOMMUTE",
          applicantLocationRequirements: { "@type": "Country", name: "Indonesia" },
          jobLocation: [
            {
              "@type": "Place",
              address: {
                "@type": "PostalAddress",
                addressLocality: "Jakarta",
                addressRegion: "DKI Jakarta",
                addressCountry: "ID",
              },
            },
            {
              "@type": "Place",
              address: {
                "@type": "PostalAddress",
                addressLocality: "Surabaya",
                addressRegion: "Jawa Timur",
                addressCountry: "ID",
              },
            },
          ],
        }),
      ],
    };
    primaryState.activeJobJsonLdRaw = JSON.stringify(remoteAndMultiGraph);

    const report = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      now: FIXED_NOW,
    });

    assert.equal(report.ok, true, JSON.stringify(report.gates, null, 2));
    const g4 = report.gates.find((g) => g.id === "G4-SITEMAP");
    assert.equal(g4.details.kind, "sitemapindex");
    assert.equal(g4.details.childSitemapsChecked, 2);
    const g6 = report.gates.find((g) => g.id === "G6-JOBPOSTING-ACTIVE");
    assert.equal(g6.status, "PASS");
    assert.equal(g6.details.jobLocationType, "TELECOMMUTE");
  });

  it("aborts slow upstream within < 150ms and recovers from transient 503 via bounded retries (Server C)", async () => {
    const start = performance.now();
    await assert.rejects(
      () =>
        fetchUrl(`${chaosOrigin}/slow`, {
          baseOrigin: chaosOrigin,
          allowLocalhost: true,
          timeoutMs: 60,
          maxRetries: 0,
        }),
      /abort|timeout/i,
    );
    const elapsedMs = performance.now() - start;
    assert.ok(elapsedMs < 150, `Expected abort timeout < 150ms, got ${Math.round(elapsedMs)}ms`);

    chaosAttemptCounter = 0;
    const recovered = await fetchUrl(`${chaosOrigin}/flaky-503`, {
      baseOrigin: chaosOrigin,
      allowLocalhost: true,
      timeoutMs: 1000,
      maxRetries: 3,
      retryBaseDelayMs: 10,
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body, "recovered-after-retries");
    assert.equal(chaosAttemptCounter, 3);
  });

  it("rejects expired job still listed in sitemap.xml", async () => {
    resetPrimaryState();
    primaryState.includeExpiredInSitemap = true;
    const report = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      expiredJobPath: "/magang-nasional/lowongan/expired-intern",
      expiredJobMode: "strip-schema",
      now: FIXED_NOW,
    });
    assert.equal(report.ok, false);
    const g7 = report.gates.find((g) => g.id === "G7-EXPIRED-JOB-LIFECYCLE");
    assert.match(g7.summary, /still listed in sitemap\.xml/i);
  });

  it("rejects expired job on HTTP 200 that still leaks JobPosting JSON-LD", async () => {
    resetPrimaryState();
    primaryState.expiredBehavior = "leaked-schema";
    const report = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      expiredJobPath: "/magang-nasional/lowongan/expired-intern",
      expiredJobMode: "strip-schema",
      now: FIXED_NOW,
    });
    assert.equal(report.ok, false);
    const g7 = report.gates.find((g) => g.id === "G7-EXPIRED-JOB-LIFECYCLE");
    assert.match(g7.summary, /still emits 1 JobPosting/i);
  });

  it("fails production G2-INDEXING if homepage accidentally emits X-Robots-Tag: noindex", async () => {
    resetPrimaryState();
    primaryState.homeXRobotsTag = "noindex";
    const report = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      now: FIXED_NOW,
    });
    assert.equal(report.ok, false);
    const g2 = report.gates.find((g) => g.id === "G2-INDEXING");
    assert.equal(g2.status, "FAIL");
    assert.match(g2.summary, /Production homepage emits noindex/i);
  });

  it("validates REMOTE-only TELECOMMUTE JobPosting without physical jobLocation", async () => {
    resetPrimaryState();
    const remoteOnly = buildValidJobPosting({
      jobLocationType: "TELECOMMUTE",
      applicantLocationRequirements: { "@type": "Country", name: "Indonesia" },
    });
    delete remoteOnly.jobLocation;
    primaryState.activeJobJsonLdRaw = JSON.stringify(remoteOnly);

    const report = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      now: FIXED_NOW,
    });
    assert.equal(report.ok, true, JSON.stringify(report.gates, null, 2));
  });

  it("rejects REMOTE TELECOMMUTE JobPosting missing applicantLocationRequirements", async () => {
    resetPrimaryState();
    const invalidRemote = buildValidJobPosting({
      jobLocationType: "TELECOMMUTE",
    });
    delete invalidRemote.jobLocation;
    primaryState.activeJobJsonLdRaw = JSON.stringify(invalidRemote);

    const report = await runSeoValidation({
      baseUrl: primaryOrigin,
      mode: "production",
      allowLocalhost: true,
      now: FIXED_NOW,
    });
    assert.equal(report.ok, false);
    const g6 = report.gates.find((g) => g.id === "G6-JOBPOSTING-ACTIVE");
    assert.match(g6.summary, /applicantLocationRequirements/i);
  });

  it("writes --json-out and $GITHUB_STEP_SUMMARY cleanly via CLI subprocess", async () => {
    resetPrimaryState();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const jsonOutPath = join(tempDir, "cli-report.json");
    const summaryPath = join(tempDir, "step-summary.md");
    const ssrOutPath = join(tempDir, "cli-ssr.html");

    await execFileAsync(
      process.execPath,
      [
        "packages/seo-ci-gate/scripts/validate-seo.mjs",
        "--url",
        primaryOrigin,
        "--mode",
        "production",
        "--allow-localhost",
        "--expired-job",
        "/magang-nasional/lowongan/expired-intern",
        "--expired-mode",
        "strip-schema",
        "--require-ai-feeds",
        "--json-out",
        jsonOutPath,
        "--save-ssr",
        ssrOutPath,
      ],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
      },
    );

    const parsedJson = JSON.parse(readFileSync(jsonOutPath, "utf8"));
    assert.equal(parsedJson.ok, true);
    assert.equal(parsedJson.gates.length, 8);
    const summaryMd = readFileSync(summaryPath, "utf8");
    assert.match(summaryMd, /MagangHub SEO & GEO CI Gate: \*\*PASS\*\*/);
    assert.doesNotMatch(summaryMd, /\u2014/);
    assert.match(readFileSync(ssrOutPath, "utf8"), /Backend Engineer Intern/);
  });
});
