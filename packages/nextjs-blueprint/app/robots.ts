// app/robots.ts
// Production-grade robots.txt for maganghub.kemnaker.go.id.
// Cloudflare Managed Content Signals note:
// Live /robots.txt (audited 2026-11-21) currently emits only Cloudflare EU Directive
// 2019/790 comments with 0 User-agent/Allow/Sitemap directives.
// Deploy this file at origin AND configure Cloudflare AI Crawl Control / Managed robots.txt
// to append rather than overwrite origin directives so User-agent and Sitemap remain intact.

import type { MetadataRoute } from "next";
import { BASE_URL, DISALLOWED_CRAWL_PATHS } from "../lib/constants.ts";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [...DISALLOWED_CRAWL_PATHS],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  };
}

export function renderRobotsTxt(baseUrl: string = BASE_URL): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return [
    "User-agent: *",
    "Allow: /",
    ...DISALLOWED_CRAWL_PATHS.map((p) => `Disallow: ${p}`),
    "",
    `Sitemap: ${cleanBase}/sitemap.xml`,
    "",
  ].join("\n");
}
