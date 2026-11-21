import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

// Provide a lightweight per-test React.cache() hook in Node 24 so lib/get-lowongan.ts
// and lib/blog-loader.ts execute their real `import { cache } from "react"` without
// requiring React to be installed in node_modules.
let activeRequestMemo = new Map();
export function resetSimulatedRequestScope() {
  activeRequestMemo = new Map();
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "react") {
      return {
        shortCircuit: true,
        url: "virtual:react-cache-shim",
      };
    }
    if (specifier === "next/server") {
      return {
        shortCircuit: true,
        url: "virtual:next-server-shim",
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "virtual:react-cache-shim") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          export function cache(fn) {
            return function memoized(...args) {
              const store = globalThis.__MAGANGHUB_TEST_REACT_CACHE__;
              if (!store) return fn(...args);
              let fnMap = store.get(fn);
              if (!fnMap) {
                fnMap = new Map();
                store.set(fn, fnMap);
              }
              const key = JSON.stringify(args);
              if (fnMap.has(key)) return fnMap.get(key);
              const val = fn(...args);
              fnMap.set(key, val);
              return val;
            };
          }
        `,
      };
    }
    if (url === "virtual:next-server-shim") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          export class NextResponse extends Response {
            static next(init) {
              return new NextResponse(null, { status: 200, headers: { "x-middleware-next": "1", ...(init?.headers || {}) } });
            }
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const {
  BASE_URL,
  LEGACY_404_PATHS,
  LIVE_BATCH_3B_2026,
  LIVE_FAQ_ITEMS,
  VERIFIED_STATIC_ROUTES,
} = await import("../packages/nextjs-blueprint/lib/constants.ts");
const {
  createPageMetadata,
  rootMetadata,
  validateRouteMetadataInput,
} = await import("../packages/nextjs-blueprint/app/layout.metadata.ts");
const {
  computeSafeRevalidateSeconds,
  evaluateJobLifecycle,
  extractJobDetailSlug,
  normalizePathname,
  parseIsoDateWithTz,
} = await import("../packages/nextjs-blueprint/lib/job-lifecycle.ts");
const {
  buildFaqPageSchema,
  buildGovernmentOrganizationSchema,
  buildJobPostingSchema,
  sanitizeJobDescriptionHtml,
  serializeSafeJsonLd,
} = await import("../packages/nextjs-blueprint/lib/job-schema.ts");
const {
  buildSitemapEntries,
  chunkSitemapEntries,
  generateSitemaps,
  renderSitemapIndexXml,
  renderSitemapXml,
  resolveSafeInternalVacanciesEndpoint,
} = await import("../packages/nextjs-blueprint/app/sitemap.ts");
const { default: robots, renderRobotsTxt } = await import(
  "../packages/nextjs-blueprint/app/robots.ts"
);
const { buildGoneHtml } = await import(
  "../packages/nextjs-blueprint/lib/gone-page.ts"
);
const { buildLlmsTxt, validateLlmsTxt } = await import(
  "../packages/nextjs-blueprint/lib/llms.ts"
);
const { GET: getLlmsTxt } = await import(
  "../packages/nextjs-blueprint/app/llms.txt/route.ts"
);
const { buildJobsNdjson } = await import(
  "../packages/nextjs-blueprint/app/ai/jobs.ndjson/route.ts"
);
const { buildAiFaqFeedPayload, GET: getAiFaqJson } = await import(
  "../packages/nextjs-blueprint/app/ai/faq.json/route.ts"
);
const {
  blogFrontmatterSchema,
  emptyToUndefined,
  parseBlogFrontmatter,
  parseStrictFrontmatterDate,
} = await import("../packages/nextjs-blueprint/lib/blog-schema.ts");
const {
  generateBlogPostMetadata,
  getPublishedBlogPost,
  setBlogPostRepository,
} = await import("../packages/nextjs-blueprint/lib/blog-loader.ts");
const {
  fetchLowonganBySlugUncached,
  getJobRevalidationTag,
} = await import("../packages/nextjs-blueprint/lib/get-lowongan.ts");

const NOW_MS = Date.parse("2026-11-21T12:00:00+07:00");

function makeActiveVacancy(overrides = {}) {
  return {
    id: "vac-2026-001",
    slug: "software-engineer-intern-telkom-2026",
    title: "Software Engineer Intern",
    descriptionHtml:
      "<p>Mengembangkan layanan web Next.js dan API backend berskala nasional bersama tim engineering.</p><ul><li>Lulusan D3/S1 Informatika</li></ul>",
    status: "OPEN",
    datePosted: "2026-11-18T09:00:00+07:00",
    validThrough: "2026-12-01T23:59:59+07:00",
    updatedAt: "2026-11-20T10:00:00+07:00",
    companyName: "PT Telkom Indonesia (Persero) Tbk",
    companyUrl: "https://www.telkom.co.id",
    companyLogo: "https://maganghub.kemnaker.go.id/logos/telkom.png",
    city: "Bandung",
    province: "Jawa Barat",
    streetAddress: "Jl. Japati No. 1",
    postalCode: "40133",
    workMode: "ONSITE",
    stipendMonthly: 4_500_000,
    batchName: "Batch 3B 2026",
    durationMonths: 6,
    educationLevel: "Sarjana",
    industry: "Teknologi Informasi",
    ...overrides,
  };
}

function makeValidBlogFrontmatter(overrides = {}) {
  // Exact 154-char description (within 150-160 inclusive)
  const desc154 =
    "Panduan lengkap mendaftar Program Pemagangan Nasional MagangHub Kemnaker RI Batch 3B 2026 melalui akun SIAPkerja beserta jadwal seleksi resmi pemerintah.";
  return {
    slug: "panduan-daftar-maganghub-batch-3b-2026",
    title: "Panduan Daftar MagangHub Kemnaker Batch 3B 2026",
    seoTitle: "Panduan Daftar MagangHub Batch 3B 2026 | Kemnaker RI",
    description: desc154,
    publishedDate: "2026-11-21T08:00:00+07:00",
    updatedDate: "2026-11-21T10:00:00+07:00",
    author: "Tim Editorial MagangHub",
    tags: ["maganghub", "kemnaker", "batch-3b"],
    draft: false,
    ...overrides,
  };
}

describe("Patch #0: Root Layout Metadata & Length Guardrails", () => {
  it("omits alternates.canonical from rootMetadata and sets metadataBase", () => {
    assert.equal(rootMetadata.alternates, undefined);
    assert.equal(rootMetadata.metadataBase?.toString(), `${BASE_URL}/`);
    assert.ok(
      typeof rootMetadata.title === "object" &&
        rootMetadata.title !== null &&
        "default" in rootMetadata.title &&
        rootMetadata.title.default.length <= 65,
    );
    assert.ok(
      typeof rootMetadata.description === "string" &&
        rootMetadata.description.length >= 150 &&
        rootMetadata.description.length <= 160,
      `rootMetadata description length=${rootMetadata.description?.length} must be 150-160`,
    );
  });

  it("enforces self-canonical and exact 65/150-160 char bounds in createPageMetadata", () => {
    const desc150 = "a".repeat(150);
    const desc160 = "b".repeat(160);
    const title65 = "t".repeat(65);

    const meta = createPageMetadata({
      seoTitle: title65,
      description: desc150,
      path: "/magang-nasional/lowongan/",
      openGraphTitle: title65,
      openGraphDescription: desc160,
      twitterTitle: title65,
      twitterDescription: desc160,
    });
    assert.equal(meta.alternates?.canonical, "/magang-nasional/lowongan");
    assert.equal(meta.openGraph?.url, "/magang-nasional/lowongan");

    // Boundary rejections: 66-char title, 149-char desc, 161-char desc, vercel.app path
    assert.equal(
      validateRouteMetadataInput({
        seoTitle: "t".repeat(66),
        description: desc150,
        path: "/magang-nasional/faq",
      }).valid,
      false,
    );
    assert.equal(
      validateRouteMetadataInput({
        seoTitle: "Valid Title 123",
        description: "a".repeat(149),
        path: "/magang-nasional/faq",
      }).valid,
      false,
    );
    assert.equal(
      validateRouteMetadataInput({
        seoTitle: "Valid Title 123",
        description: "a".repeat(161),
        path: "/magang-nasional/faq",
      }).valid,
      false,
    );
    assert.throws(() =>
      createPageMetadata({
        seoTitle: "Valid Title 123",
        description: desc150,
        path: "https://preview-abc.vercel.app/magang-nasional/faq",
      }),
    );
  });
});

describe("Job Lifecycle State Machine & Slug Extraction", () => {
  it("parses strict ISO-8601+TZ and rejects bare dates, non-leap Feb 29, Feb 30, and year < 1000", () => {
    assert.ok(parseIsoDateWithTz("2026-12-01T23:59:59+07:00") !== null);
    assert.ok(parseIsoDateWithTz("2024-02-29T12:00:00Z") !== null);
    assert.ok(parseIsoDateWithTz("2028-02-29T00:00:00+07:00") !== null);

    assert.equal(parseIsoDateWithTz("2026-12-01"), null);
    assert.equal(parseIsoDateWithTz("2026-02-29T23:59:59+07:00"), null);
    assert.equal(parseIsoDateWithTz("2026-02-30T23:59:59+07:00"), null);
    assert.equal(parseIsoDateWithTz("2026-04-31T10:00:00Z"), null);
    assert.equal(parseIsoDateWithTz("0050-01-01T00:00:00Z"), null);
    assert.equal(parseIsoDateWithTz("not-a-date"), null);
    assert.equal(parseIsoDateWithTz(null), null);
  });

  it("transitions deterministically across ACTIVE -> EXPIRED_GRACE -> ARCHIVED_GONE and fails closed on bad deadlines", () => {
    const active = evaluateJobLifecycle(
      { status: "OPEN", deadlineAt: "2026-12-01T23:59:59+07:00" },
      { nowMs: NOW_MS },
    );
    assert.equal(active.state, "ACTIVE");
    assert.equal(active.expired, false);

    const grace = evaluateJobLifecycle(
      { status: "OPEN", deadlineAt: "2026-11-01T23:59:59+07:00" },
      { nowMs: NOW_MS },
    );
    assert.equal(grace.state, "EXPIRED_GRACE");
    assert.equal(grace.expired, true);
    assert.equal(grace.archived, false);

    const gone = evaluateJobLifecycle(
      { status: "OPEN", deadlineAt: "2026-07-01T23:59:59+07:00" },
      { nowMs: NOW_MS },
    );
    assert.equal(gone.state, "ARCHIVED_GONE");
    assert.equal(gone.archived, true);

    const corrupt = evaluateJobLifecycle(
      { status: "OPEN", deadlineAt: "2026-02-30T23:59:59+07:00" },
      { nowMs: NOW_MS },
    );
    assert.equal(corrupt.state, "EXPIRED_GRACE");
    assert.equal(corrupt.expired, true);
    assert.equal(corrupt.reason, "invalid_or_missing_deadline");
  });

  it("caps ISR revalidate seconds before deadlineAt", () => {
    const tenMinLeft = new Date(NOW_MS + 600_000).toISOString();
    const ttl = computeSafeRevalidateSeconds(
      { status: "OPEN", deadlineAt: tenMinLeft },
      { nowMs: NOW_MS, maxActiveTtlSec: 3600 },
    );
    assert.equal(ttl, 600);
  });

  it("extracts valid vacancy slugs while refusing hub routes (/kota, /bidang, /perusahaan) and traversal", () => {
    assert.equal(
      extractJobDetailSlug("/magang-nasional/lowongan/data-analyst-bumn-2026"),
      "data-analyst-bumn-2026",
    );
    assert.equal(extractJobDetailSlug("/lowongan/frontend-intern/"), "frontend-intern");
    assert.equal(extractJobDetailSlug("/magang-nasional/lowongan"), null);
    assert.equal(extractJobDetailSlug("/magang-nasional/lowongan/kota"), null);
    assert.equal(extractJobDetailSlug("/magang-nasional/lowongan/kota/jakarta"), null);
    assert.equal(extractJobDetailSlug("/lowongan/bidang/elektro"), null);
    assert.equal(extractJobDetailSlug("/lowongan/perusahaan/telkom"), null);
    assert.equal(extractJobDetailSlug("/magang-nasional/lowongan/..%2Fadmin"), null);
    assert.equal(normalizePathname("https://maganghub.kemnaker.go.id/magang-nasional/lowongan/?page=2"), "/magang-nasional/lowongan");
  });
});

describe("JobPosting, GovernmentOrganization & FAQPage JSON-LD Builders", () => {
  it("builds ONSITE, HYBRID, REMOTE (TELECOMMUTE), and multi-location schemas accurately", () => {
    const onsite = buildJobPostingSchema(makeActiveVacancy(), { nowMs: NOW_MS });
    assert.ok(onsite);
    assert.equal(onsite.directApply, true);
    assert.equal(onsite.jobLocationType, undefined);
    assert.equal(onsite.baseSalary?.value.value, 4_500_000);

    const multiLoc = buildJobPostingSchema(
      makeActiveVacancy({
        workMode: "HYBRID",
        locations: [
          { city: "Jakarta Selatan", province: "DKI Jakarta", postalCode: "12190" },
          { city: "Bandung", province: "Jawa Barat", postalCode: "40133" },
        ],
        stipendMonthly: 4_000_000,
        stipendMaxMonthly: 5_200_000,
      }),
      { nowMs: NOW_MS },
    );
    assert.ok(multiLoc);
    assert.ok(Array.isArray(multiLoc.jobLocation));
    assert.equal(multiLoc.jobLocation.length, 2);
    assert.equal(multiLoc.jobLocationType, "TELECOMMUTE");
    assert.equal(multiLoc.applicantLocationRequirements?.name, "Indonesia");
    assert.equal(multiLoc.baseSalary?.value.minValue, 4_000_000);
    assert.equal(multiLoc.baseSalary?.value.maxValue, 5_200_000);

    const remote = buildJobPostingSchema(
      makeActiveVacancy({ workMode: "REMOTE", stipendMonthly: 0 }),
      { nowMs: NOW_MS },
    );
    assert.ok(remote);
    assert.equal(remote.jobLocation, undefined);
    assert.equal(remote.jobLocationType, "TELECOMMUTE");
    assert.equal(remote.baseSalary, undefined);
  });

  it("returns null for non-ACTIVE vacancies (defense in depth) and neutralizes XSS", () => {
    assert.equal(
      buildJobPostingSchema(makeActiveVacancy({ status: "CLOSED" }), { nowMs: NOW_MS }),
      null,
    );
    assert.equal(
      buildJobPostingSchema(
        makeActiveVacancy({ validThrough: "2026-11-01T00:00:00+07:00" }),
        { nowMs: NOW_MS },
      ),
      null,
    );

    const maliciousHtml =
      '<p onclick="alert(1)">Role</p><scr<script>ipt>alert(2)</script><a href="javascript:evil()">Click</a><img src=x onerror=alert(3)>';
    const sanitized = sanitizeJobDescriptionHtml(maliciousHtml);
    assert.doesNotMatch(sanitized, /script|onerror|onclick|javascript:/i);
    assert.match(sanitized, /<p>Role<\/p>/);

    const serialized = serializeSafeJsonLd({
      text: "</script><script>alert(1)</script>&\u2028\u2029",
    });
    assert.doesNotMatch(serialized, /<\/script>|<|>|&|\u2028|\u2029/);
    assert.match(serialized, /\\u003c\/script\\u003e/);
    assert.match(serialized, /\\u2028\\u2029/);
  });

  it("builds GovernmentOrganization and FAQPage JSON-LD schemas", () => {
    const org = buildGovernmentOrganizationSchema();
    assert.equal(org["@type"], "GovernmentOrganization");
    assert.equal(org.contactPoint.telephone, "+62-1500630");

    const faq = buildFaqPageSchema(LIVE_FAQ_ITEMS);
    assert.equal(faq["@type"], "FAQPage");
    assert.equal(faq.mainEntity.length, LIVE_FAQ_ITEMS.length);
  });
});

describe("Sitemap, Robots, Gone HTML, llms.txt & AI Feeds", () => {
  it("guards against self-HTTP fetch in sitemap and filters fail-closed ACTIVE vacancies with sharding", async () => {
    assert.equal(
      resolveSafeInternalVacanciesEndpoint("https://maganghub.kemnaker.go.id/api/lowongan", BASE_URL),
      null,
    );
    assert.equal(
      resolveSafeInternalVacanciesEndpoint("http://internal-api.kemnaker.local/v1/lowongan", BASE_URL),
      "http://internal-api.kemnaker.local/v1/lowongan",
    );

    const now = new Date(NOW_MS);
    const entries = await buildSitemapEntries({
      now,
      fetchVacancies: async () => [
        { slug: "active-1", status: "OPEN", validThrough: "2026-12-01T23:59:59+07:00", updatedAt: "2026-11-20T00:00:00Z" },
        { slug: "active-1", status: "OPEN", validThrough: "2026-12-01T23:59:59+07:00", updatedAt: "2026-11-20T00:00:00Z" },
        { slug: "expired-1", status: "OPEN", validThrough: "2026-11-01T00:00:00+07:00", updatedAt: "2026-11-01T00:00:00Z" },
        { slug: "closed-1", status: "CLOSED", validThrough: "2026-12-01T23:59:59+07:00", updatedAt: "2026-11-20T00:00:00Z" },
        { slug: "corrupt-1", status: "OPEN", validThrough: "2026-02-30T00:00:00+07:00", updatedAt: "2026-11-20T00:00:00Z" },
      ],
    });

    assert.equal(entries.length, VERIFIED_STATIC_ROUTES.length + 1);
    const urls = entries.map((e) => e.url);
    assert.ok(urls.includes(`${BASE_URL}/magang-nasional/lowongan/active-1`));
    for (const legacy of LEGACY_404_PATHS) {
      assert.ok(!urls.includes(`${BASE_URL}${legacy}`), `Legacy 404 route leaked: ${legacy}`);
    }

    const shards = await generateSitemaps({
      now,
      urlLimit: 4,
      fetchVacancies: async () => [
        { slug: "a", status: "OPEN", validThrough: "2026-12-01T23:59:59+07:00" },
        { slug: "b", status: "OPEN", validThrough: "2026-12-01T23:59:59+07:00" },
      ],
    });
    assert.equal(shards.length, Math.ceil((VERIFIED_STATIC_ROUTES.length + 2) / 4));
    assert.equal(chunkSitemapEntries(entries, 5).length, 2);

    const xml = renderSitemapXml(entries);
    assert.match(xml, /<urlset /);
    const idxXml = renderSitemapIndexXml([`${BASE_URL}/sitemap/0.xml`], now);
    assert.match(idxXml, /<sitemapindex /);
  });

  it("generates robots.txt, 410 Gone HTML, dynamic llms.txt, jobs.ndjson, and faq.json cleanly", async () => {
    const r = robots();
    assert.equal(r.sitemap, `${BASE_URL}/sitemap.xml`);
    const rTxt = renderRobotsTxt();
    assert.match(rTxt, /^User-agent: \*/m);
    assert.match(rTxt, /^Disallow: \/dashboard\//m);
    assert.match(rTxt, /^Disallow: \/api\//m);
    assert.match(rTxt, /^Sitemap: https:\/\/maganghub\.kemnaker\.go\.id\/sitemap\.xml$/m);

    const gone = buildGoneHtml('<img src=x onerror="alert(1)">');
    assert.match(gone, /<meta name="robots" content="noindex, follow">/);
    assert.doesNotMatch(gone, /<img/);

    const llms = buildLlmsTxt(LIVE_BATCH_3B_2026, { activeVacanciesCount: 1250 });
    const lint = validateLlmsTxt(llms);
    assert.equal(lint.valid, true, lint.errors.join("; "));
    assert.match(llms, /17-26 Nov 2026/);
    assert.match(llms, /23 Nov-1 Des 2026/);
    assert.match(llms, /2-10 Des 2026/);
    assert.match(llms, /11 Des 2026/);
    assert.match(llms, /14 Des 2026/);
    assert.match(llms, /organizer\.maganghub\.kemnaker\.go\.id/);
    assert.match(llms, /\/ai\/jobs\.ndjson/);

    const llmsRes = await getLlmsTxt();
    assert.equal(llmsRes.status, 200);
    assert.match(llmsRes.headers.get("content-type") || "", /text\/plain/);

    const ndjson = buildJobsNdjson(
      [
        makeActiveVacancy(),
        makeActiveVacancy({ id: "vac-exp", slug: "expired", status: "CLOSED" }),
      ],
      { nowMs: NOW_MS },
    );
    const lines = ndjson.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsedLine = JSON.parse(lines[0]);
    assert.equal(parsedLine.id, "vac-2026-001");
    assert.equal(parsedLine.stipendMonthlyIdr, 4_500_000);

    const faqPayload = buildAiFaqFeedPayload();
    assert.equal(faqPayload.items.length, LIVE_FAQ_ITEMS.length);
    assert.equal(faqPayload.jsonLd["@type"], "FAQPage");
    const faqRes = await getAiFaqJson();
    assert.equal(faqRes.status, 200);
  });
});

describe("Hardened Blog/MDX Zod Schema & React.cache() Symmetric Draft Guard", () => {
  it("never coerces YAML null, empty string, 0, or false into 1970-01-01", () => {
    assert.equal(emptyToUndefined(null), undefined);
    assert.equal(emptyToUndefined(""), undefined);
    assert.equal(emptyToUndefined("   "), undefined);

    // Optional updatedDate: null / "" -> undefined (never 1970-01-01)
    const withNullUpdated = parseBlogFrontmatter(
      makeValidBlogFrontmatter({ updatedDate: null }),
    );
    assert.equal(withNullUpdated.updatedDate, undefined);

    const withEmptyUpdated = parseBlogFrontmatter(
      makeValidBlogFrontmatter({ updatedDate: "" }),
    );
    assert.equal(withEmptyUpdated.updatedDate, undefined);

    // Reject 0, false, null, "", Feb 30 on publishedDate & 0/false on updatedDate
    for (const badVal of [null, "", "   ", 0, false, true, "2026-02-30", "1970-01-01"]) {
      assert.equal(parseStrictFrontmatterDate(badVal), null);
      assert.equal(
        blogFrontmatterSchema.safeParse(
          makeValidBlogFrontmatter({ publishedDate: badVal }),
        ).success,
        false,
        `publishedDate=${JSON.stringify(badVal)} must be rejected`,
      );
    }

    for (const badUpdated of [0, false, "2026-02-30", "2026-11-01T00:00:00+07:00"]) {
      assert.equal(
        blogFrontmatterSchema.safeParse(
          makeValidBlogFrontmatter({ updatedDate: badUpdated }),
        ).success,
        false,
        `updatedDate=${JSON.stringify(badUpdated)} must be rejected`,
      );
    }
  });

  it("enforces exact metadata length bounds on seoTitle, description, openGraph & twitter", () => {
    const valid = parseBlogFrontmatter(
      makeValidBlogFrontmatter({
        seoTitle: "s".repeat(65),
        description: "d".repeat(160),
        openGraph: { title: "o".repeat(65), description: "g".repeat(160) },
        twitter: { title: "t".repeat(65), description: "w".repeat(160) },
      }),
    );
    assert.equal(valid.seoTitle?.length, 65);
    assert.equal(valid.description.length, 160);

    // Exceeding any bound by 1 char must fail
    assert.equal(
      blogFrontmatterSchema.safeParse(makeValidBlogFrontmatter({ seoTitle: "s".repeat(66) })).success,
      false,
    );
    assert.equal(
      blogFrontmatterSchema.safeParse(makeValidBlogFrontmatter({ description: "d".repeat(149) })).success,
      false,
    );
    assert.equal(
      blogFrontmatterSchema.safeParse(makeValidBlogFrontmatter({ description: "d".repeat(161) })).success,
      false,
    );
    assert.equal(
      blogFrontmatterSchema.safeParse(
        makeValidBlogFrontmatter({ openGraph: { title: "o".repeat(66) } }),
      ).success,
      false,
    );
    assert.equal(
      blogFrontmatterSchema.safeParse(
        makeValidBlogFrontmatter({ twitter: { description: "w".repeat(161) } }),
      ).success,
      false,
    );
    assert.equal(
      blogFrontmatterSchema.safeParse(
        makeValidBlogFrontmatter({ canonicalPath: "/" }),
      ).success,
      false,
    );
  });

  it("deduplicates reads via React.cache() and enforces symmetric draft guard between metadata and page", async () => {
    let repoReads = 0;
    const draftRecord = {
      frontmatter: makeValidBlogFrontmatter({
        slug: "rahasia-draft-internal",
        title: "Rahasia Draft Internal Batch 4 Belum Rilis",
        seoTitle: "Rahasia Draft Internal Batch 4 Belum Rilis",
        draft: true,
      }),
      bodyHtml: "<p>Draft body</p>",
    };
    const publishedRecord = {
      frontmatter: makeValidBlogFrontmatter({
        slug: "panduan-siapkerja-2026",
        draft: false,
      }),
      bodyHtml: "<p>Published body</p>",
    };

    setBlogPostRepository(async (slug) => {
      repoReads += 1;
      if (slug === "rahasia-draft-internal") return draftRecord;
      if (slug === "panduan-siapkerja-2026") return publishedRecord;
      return null;
    });

    // Simulate single SSR request scope for draft post (production: allowDrafts=false)
    globalThis.__MAGANGHUB_TEST_REACT_CACHE__ = new Map();
    const draftMeta = await generateBlogPostMetadata("rahasia-draft-internal", {
      allowDrafts: false,
    });
    const draftPost = await getPublishedBlogPost("rahasia-draft-internal", {
      allowDrafts: false,
    });
    assert.equal(repoReads, 1, "React.cache() must deduplicate metadata + page read into 1 call");
    assert.equal(draftPost, null, "BlogPostPage must hide draft post");
    assert.equal(draftMeta.title, "Artikel Tidak Ditemukan | MagangHub Kemnaker RI");
    assert.deepEqual(draftMeta.robots, { index: false, follow: false });

    // Same draft visible when allowDrafts=true
    const previewMeta = await generateBlogPostMetadata("rahasia-draft-internal", {
      allowDrafts: true,
    });
    const previewPost = await getPublishedBlogPost("rahasia-draft-internal", {
      allowDrafts: true,
    });
    assert.ok(previewPost !== null);
    assert.equal(previewMeta.title, "Rahasia Draft Internal Batch 4 Belum Rilis");

    // New request scope for published post
    repoReads = 0;
    globalThis.__MAGANGHUB_TEST_REACT_CACHE__ = new Map();
    const pubMeta = await generateBlogPostMetadata("panduan-siapkerja-2026");
    const pubPost = await getPublishedBlogPost("panduan-siapkerja-2026");
    assert.equal(repoReads, 1);
    assert.ok(pubPost !== null);
    assert.equal(
      pubMeta.alternates?.canonical,
      `${BASE_URL}/panduan/panduan-siapkerja-2026`,
    );
    delete globalThis.__MAGANGHUB_TEST_REACT_CACHE__;
  });

  it("tags vacancy fetches with revalidateTag job-<slug> and handles 404/410 cleanly", async () => {
    assert.equal(getJobRevalidationTag("intern-abc"), "job-intern-abc");

    let capturedInit = null;
    const vacancy = await fetchLowonganBySlugUncached("intern-abc", async (_url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify(makeActiveVacancy({ slug: "intern-abc" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    assert.equal(vacancy?.slug, "intern-abc");
    assert.deepEqual(capturedInit?.next?.tags, ["lowongan-all", "job-intern-abc"]);

    const gone = await fetchLowonganBySlugUncached("old-slug", async () => {
      return new Response("Gone", { status: 410 });
    });
    assert.equal(gone, null);
  });
});

describe("Granular Edge Cases: Lifecycle, Middleware, Sitemap Sharding, AI Feeds & Metadata", () => {
  it("handles early closure (CLOSED before deadlineAt) without closedAt in EXPIRED_GRACE (0 days elapsed)", () => {
    const res = evaluateJobLifecycle(
      { status: "CLOSED", deadlineAt: "2026-12-20T23:59:59+07:00" },
      { nowMs: NOW_MS },
    );
    assert.equal(res.state, "EXPIRED_GRACE");
    assert.equal(res.reason, "status_not_open");
    assert.equal(res.daysSinceClosed, 0);
  });

  it("transitions early-closed job with explicit closedAt >= 90d ago into ARCHIVED_GONE", () => {
    const res = evaluateJobLifecycle(
      {
        status: "FILLED",
        deadlineAt: "2026-12-20T23:59:59+07:00",
        closedAt: "2026-08-01T00:00:00+07:00",
      },
      { nowMs: NOW_MS },
    );
    assert.equal(res.state, "ARCHIVED_GONE");
    assert.equal(res.reason, "grace_window_elapsed");
    assert.ok((res.daysSinceClosed ?? 0) >= 90);
  });

  it("forces ARCHIVED_GONE immediately when archivedAt <= nowMs even if status is OPEN", () => {
    const res = evaluateJobLifecycle(
      {
        status: "OPEN",
        deadlineAt: "2026-12-20T23:59:59+07:00",
        archivedAt: "2026-11-20T00:00:00+07:00",
      },
      { nowMs: NOW_MS },
    );
    assert.equal(res.state, "ARCHIVED_GONE");
    assert.equal(res.reason, "status_archived");
  });

  it("enforces minTtlSec floor in computeSafeRevalidateSeconds when deadline is seconds away", () => {
    const tenSecLeft = new Date(NOW_MS + 10_000).toISOString();
    const ttl = computeSafeRevalidateSeconds(
      { status: "OPEN", deadlineAt: tenSecLeft },
      { nowMs: NOW_MS, minTtlSec: 60 },
    );
    assert.equal(ttl, 60);
  });

  it("returns expiredTtlSec in computeSafeRevalidateSeconds when vacancy is already expired", () => {
    const ttl = computeSafeRevalidateSeconds(
      { status: "CLOSED", deadlineAt: "2026-11-01T00:00:00+07:00" },
      { nowMs: NOW_MS, expiredTtlSec: 86_400 },
    );
    assert.equal(ttl, 86_400);
  });

  it("omits baseSalary when stipendMonthly is negative, zero, NaN, or Infinity", () => {
    for (const badStipend of [0, -500_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const schema = buildJobPostingSchema(
        makeActiveVacancy({ stipendMonthly: badStipend }),
        { nowMs: NOW_MS },
      );
      assert.ok(schema);
      assert.equal(schema.baseSalary, undefined);
    }
  });

  it("strips javascript: and data: URIs from hiringOrganization sameAs and logo", () => {
    const schema = buildJobPostingSchema(
      makeActiveVacancy({
        companyUrl: "javascript:alert(1)",
        companyLogo: "data:text/html,<script>alert(1)</script>",
      }),
      { nowMs: NOW_MS },
    );
    assert.ok(schema);
    assert.equal(schema.hiringOrganization.sameAs, undefined);
    assert.equal(schema.hiringOrganization.logo, undefined);
  });

  it("degrades gracefully in sitemap when upstream fetch throws network timeout error", async () => {
    const entries = await buildSitemapEntries({
      now: new Date(NOW_MS),
      fetchVacancies: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    assert.equal(entries.length, VERIFIED_STATIC_ROUTES.length);
  });

  it("returns empty shard cleanly when requesting out-of-range shard id in sitemap", async () => {
    const { default: sitemapDefault } = await import(
      "../packages/nextjs-blueprint/app/sitemap.ts"
    );
    const emptyShard = await sitemapDefault(
      { id: 99 },
      {
        now: new Date(NOW_MS),
        fetchVacancies: async () => [],
      },
    );
    assert.deepEqual(emptyShard, []);
  });

  it("returns non-zero links and fails lint when legacy 404 routes or placeholders leak into llms.txt", () => {
    const fakePlaceholder = "[" + "Tanggal " + "Mulai]";
    const broken = `# Title\n> Summary\n## Links\n- [Bad](https://maganghub.kemnaker.go.id/lowongan)\n- Jadwal: ${fakePlaceholder}`;
    const lint = validateLlmsTxt(broken);
    assert.equal(lint.valid, false);
    assert.ok(lint.errors.some((e) => /404 route/i.test(e)));
    assert.ok(lint.errors.some((e) => /placeholder/i.test(e)));
  });

  it("deduplicates vacancy IDs and filters invalid stipends in /ai/jobs.ndjson builder", () => {
    const ndjson = buildJobsNdjson(
      [
        makeActiveVacancy({ id: "dup-1", slug: "s1", stipendMonthly: -10 }),
        makeActiveVacancy({ id: "dup-1", slug: "s1-copy", stipendMonthly: 5_000_000 }),
        makeActiveVacancy({ id: "ok-2", slug: "s2", stipendMonthly: 4_200_000, stipendMaxMonthly: 5_100_000 }),
      ],
      { nowMs: NOW_MS },
    );
    const parsed = ndjson
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].stipendMonthlyIdr, null);
    assert.equal(parsed[1].stipendMonthlyIdr, 4_200_000);
    assert.equal(parsed[1].stipendMaxMonthlyIdr, 5_100_000);
  });

  it("includes exact Batch 3B 2026 schedule and ecosystem URLs inside /ai/faq.json payload", () => {
    const payload = buildAiFaqFeedPayload();
    assert.equal(payload.batchSchedule.companyRegistration, "17-26 Nov 2026");
    assert.equal(payload.batchSchedule.participantRegistration, "23 Nov-1 Des 2026");
    assert.equal(payload.batchSchedule.companySelection, "2-10 Des 2026");
    assert.equal(payload.batchSchedule.kemnakerAnnouncement, "11 Des 2026");
    assert.equal(payload.batchSchedule.internshipStart, "14 Des 2026");
    assert.equal(payload.ecosystem.organizerPortal, "https://organizer.maganghub.kemnaker.go.id");
    assert.match(payload.ecosystem.bnspCertification, /bnsp\.go\.id/);
  });

  it("fails open to origin when Edge KV archive lookup exceeds 400ms timeout or returns 500", async () => {
    const { isPermanentlyArchived } = await import(
      "../packages/nextjs-blueprint/middleware.ts"
    );
    const archivedTrue = await isPermanentlyArchived("old-job", {
      edgeUrl: "https://edge-kv.example.internal",
      fetchImpl: async () =>
        new Response(JSON.stringify({ archived: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    assert.equal(archivedTrue, true);

    const archivedErr = await isPermanentlyArchived("old-job", {
      edgeUrl: "https://edge-kv.example.internal",
      fetchImpl: async () => new Response("Error", { status: 503 }),
    });
    assert.equal(archivedErr, false);

    const archivedTimeout = await isPermanentlyArchived("old-job", {
      edgeUrl: "https://edge-kv.example.internal",
      timeoutMs: 30,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Timeout")));
        }),
    });
    assert.equal(archivedTimeout, false);
  });

  it("enforces createPageMetadata noIndex option and rejects invalid title/OG lengths", () => {
    const noIdx = createPageMetadata({
      seoTitle: "Arsip Lowongan | MagangHub Kemnaker RI",
      description: "d".repeat(155),
      path: "/magang-nasional/lowongan/closed-job",
      noIndex: true,
    });
    assert.deepEqual(noIdx.robots, {
      index: false,
      follow: true,
      googleBot: { index: false, follow: true },
    });
    assert.equal(
      validateRouteMetadataInput({
        seoTitle: "Judul Valid",
        description: "d".repeat(155),
        path: "/magang-nasional/faq",
        openGraphTitle: "x".repeat(66),
      }).valid,
      false,
    );
    assert.equal(
      validateRouteMetadataInput({
        seoTitle: "Judul Valid",
        description: "d".repeat(155),
        path: "/magang-nasional/faq",
        twitterDescription: "y".repeat(161),
      }).valid,
      false,
    );
  });

  it("rejects non-strict unknown frontmatter keys and invalid kebab-case slugs in blogFrontmatterSchema", () => {
    assert.equal(
      blogFrontmatterSchema.safeParse(
        makeValidBlogFrontmatter({ unknownKey: "nope" }),
      ).success,
      false,
    );
    assert.equal(
      blogFrontmatterSchema.safeParse(
        makeValidBlogFrontmatter({ slug: "Invalid_Slug With Spaces" }),
      ).success,
      false,
    );
    assert.equal(
      blogFrontmatterSchema.safeParse(
        makeValidBlogFrontmatter({ canonicalPath: "https://preview-1.vercel.app/post" }),
      ).success,
      false,
    );
  });

  it("intercepts legacy /be/v1/api/list/vacancies-active with HTTP 410 + X-Robots-Tag: noindex, follow and passes through hub routes", async () => {
    const { middleware } = await import(
      "../packages/nextjs-blueprint/middleware.ts"
    );
    const legacyRes = await middleware({
      nextUrl: { pathname: "/be/v1/api/list/vacancies-active" },
    });
    assert.equal(legacyRes.status, 410);
    assert.equal(legacyRes.headers.get("x-robots-tag"), "noindex, follow");

    const hubRes = await middleware({
      nextUrl: { pathname: "/magang-nasional/lowongan/kota/jakarta" },
    });
    assert.equal(hubRes.headers.get("x-middleware-next"), "1");
  });

  it("rejects blog post when title > 65 chars and seoTitle is omitted", () => {
    assert.equal(
      blogFrontmatterSchema.safeParse(
        makeValidBlogFrontmatter({
          title: "Judul Artikel Sangat Panjang Sekali Yang Melebihi Batas Enam Puluh Lima Karakter",
          seoTitle: undefined,
        }),
      ).success,
      false,
    );
  });
});
