// examples/astro-content-config.ts
// Drop-in Astro 5 Content Layer configuration reusing the exact hardened Zod schema
// from lib/blog-schema.ts (emptyToUndefined anti-1970-01-01 date guard + strict metadata bounds).

import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { blogFrontmatterSchema } from "../lib/blog-schema.ts";

const panduan = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/panduan" }),
  schema: blogFrontmatterSchema,
});

export const collections = {
  panduan,
};
