import http from "k6/http";
import { check } from "k6";

const SITEMAP_BASES = (__ENV.SITEMAP_BASE_URLS || __ENV.SITEMAP_BASE_URL || "http://127.0.0.1:18081")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MIDDLEWARE_BASES = (__ENV.MIDDLEWARE_BASE_URLS || __ENV.MIDDLEWARE_BASE_URL || "http://127.0.0.1:18082")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function setup() {
  // Warm up TCP keep-alive pool across all replicas before timed scenarios start
  for (const base of SITEMAP_BASES) {
    http.get(`${base}/sitemap.xml`, { headers: { "Accept-Encoding": "gzip" } });
    http.get(`${base}/sitemap/0.xml`, { headers: { "Accept-Encoding": "gzip" } });
  }
  for (const base of MIDDLEWARE_BASES) {
    http.get(`${base}/magang-nasional/lowongan/archived-batch1-0`);
    http.get(`${base}/magang-nasional/lowongan/active-batch3b-0`);
  }
}

export const options = {
  scenarios: {
    sitemap_warm_burst: {
      executor: "shared-iterations",
      vus: 12,
      iterations: 600,
      maxDuration: "30s",
      startTime: "0s",
      exec: "hitSitemap",
    },
    middleware_410_burst: {
      executor: "shared-iterations",
      vus: 16,
      iterations: 1200,
      maxDuration: "30s",
      startTime: "2s",
      exec: "hitMiddleware",
    },
  },
  thresholds: {
    "http_req_duration{scenario:sitemap_warm_burst}": ["p(99)<50"],
    "http_req_duration{scenario:middleware_410_burst}": ["p(99)<50"],
    checks: ["rate==1.0"],
  },
};

export function hitSitemap() {
  const base = SITEMAP_BASES[(__VU + __ITER) % SITEMAP_BASES.length];
  const path = __ITER % 2 === 0 ? "/sitemap.xml" : "/sitemap/0.xml";
  const res = http.get(`${base}${path}`, {
    headers: { "Accept-Encoding": "gzip" },
    responseType: "text",
  });
  check(res, {
    "sitemap status 200": (r) => r.status === 200,
    "sitemap valid XML header": (r) =>
      typeof r.body === "string" && r.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
  });
}

export function hitMiddleware() {
  const base = MIDDLEWARE_BASES[(__VU + __ITER) % MIDDLEWARE_BASES.length];
  const bucket = __ITER % 20;
  if (bucket < 8) {
    const slug = `archived-batch1-${bucket % 4}`;
    const res = http.get(`${base}/magang-nasional/lowongan/${slug}`);
    check(res, {
      "archived status 410": (r) => r.status === 410,
      "archived x-robots-tag noindex": (r) =>
        String(r.headers["X-Robots-Tag"] || r.headers["x-robots-tag"] || "")
          .toLowerCase()
          .includes("noindex"),
      "archived cache-control present": (r) =>
        Boolean(r.headers["Cache-Control"] || r.headers["cache-control"]),
    });
  } else if (bucket < 14) {
    const slug = `active-batch3b-${bucket % 5}`;
    const res = http.get(`${base}/magang-nasional/lowongan/${slug}`);
    check(res, {
      "active status 200": (r) => r.status === 200,
      "active pass-through header": (r) =>
        String(r.headers["X-Middleware-Next"] || r.headers["x-middleware-next"] || "") === "1",
    });
  } else if (bucket < 17) {
    const hub = bucket % 2 === 0 ? "/magang-nasional/lowongan/kota/jakarta" : "/magang-nasional/lowongan/bidang/it";
    const res = http.get(`${base}${hub}`);
    check(res, {
      "hub status 200": (r) => r.status === 200,
    });
  } else {
    const path =
      bucket === 17
        ? `/magang-nasional/lowongan/%FF%FE?utm_source=k6&cb=${__VU}-${__ITER}`
        : `/magang-nasional/lowongan/active-batch3b-0?utm_source=k6&fbclid=${__VU}-${__ITER}`;
    const res = http.get(`${base}${path}`);
    check(res, {
      "malformed/cache-bust status 200": (r) => r.status === 200,
    });
  }
}
