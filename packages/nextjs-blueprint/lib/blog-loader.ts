/**
 * Request-memoized Blog / Panduan loader with symmetric draft guard.
 *
 * Guarantees that generateMetadata() and BlogPostPage() ALWAYS share:
 * 1. The exact same React.cache() lookup (1 read per request).
 * 2. The exact same visibility predicate `isBlogPostPubliclyVisible()`, preventing
 *    metadata leaks of `draft: true` posts in `<head>` when the body returns 404.
 * 3. Self-referencing canonical URLs and strictly bounded OG/Twitter metadata lengths.
 */

import { cache } from "react";
import type { Metadata } from "next";
import { BASE_URL, METADATA_LIMITS } from "./constants.ts";
import { parseBlogFrontmatter, type BlogFrontmatter } from "./blog-schema.ts";

export interface BlogPostRecord {
  frontmatter: BlogFrontmatter;
  bodyHtml: string;
}

export interface BlogVisibilityOptions {
  allowDrafts?: boolean;
}

export type BlogPostRepository = (slug: string) => Promise<BlogPostRecord | null>;

/**
 * Single source of truth for draft visibility.
 * Both generateMetadata() and BlogPostPage() MUST evaluate this exact predicate.
 */
export function isBlogPostPubliclyVisible(
  post: BlogPostRecord | null | undefined,
  options: BlogVisibilityOptions = {},
): post is BlogPostRecord {
  if (!post) return false;
  if (post.frontmatter.draft && options.allowDrafts !== true) {
    return false;
  }
  return true;
}

let activeRepository: BlogPostRepository = async () => null;

/**
 * Registers the storage adapter (filesystem MDX, CMS, or test mock).
 */
export function setBlogPostRepository(repo: BlogPostRepository): void {
  activeRepository = repo;
}

/**
 * Request-memoized raw loader via React.cache().
 * Validates frontmatter through blogFrontmatterSchema before returning.
 */
export const loadBlogPostBySlug = cache(
  async (slug: string): Promise<BlogPostRecord | null> => {
    const raw = await activeRepository(slug);
    if (!raw) return null;
    const validatedFrontmatter = parseBlogFrontmatter(raw.frontmatter);
    return {
      frontmatter: validatedFrontmatter,
      bodyHtml: raw.bodyHtml,
    };
  },
);

/**
 * Symmetric public loader used by BOTH generateBlogPostMetadata() and BlogPostPage().
 * Returns null for missing posts AND for `draft: true` posts when allowDrafts is false.
 */
export async function getPublishedBlogPost(
  slug: string,
  options: BlogVisibilityOptions = {},
): Promise<BlogPostRecord | null> {
  const post = await loadBlogPostBySlug(slug);
  if (!isBlogPostPubliclyVisible(post, options)) {
    return null;
  }
  return post;
}

/**
 * Generates strict, self-canonical Next.js Metadata for a blog post.
 * Mirrors BlogPostPage() draft visibility symmetrically: hidden drafts return
 * a generic 404 metadata stub with noindex, nofollow and zero draft title leakage.
 */
export async function generateBlogPostMetadata(
  slug: string,
  options: BlogVisibilityOptions & { routePrefix?: string; baseUrl?: string } = {},
): Promise<Metadata> {
  const post = await getPublishedBlogPost(slug, options);
  if (!post) {
    return {
      title: "Artikel Tidak Ditemukan | MagangHub Kemnaker RI",
      robots: { index: false, follow: false },
    };
  }

  const fm = post.frontmatter;
  const routePrefix = (options.routePrefix ?? "/panduan").replace(/\/+$/, "");
  const canonicalPath = fm.canonicalPath ?? `${routePrefix}/${encodeURIComponent(fm.slug)}`;
  const baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/+$/, "");
  const canonicalUrl = `${baseUrl}${canonicalPath}`;

  const seoTitle = (fm.seoTitle ?? fm.title).slice(0, METADATA_LIMITS.maxTitleChars);
  const ogTitle = (fm.openGraph?.title ?? seoTitle).slice(0, METADATA_LIMITS.maxSocialTitleChars);
  const ogDescription = (fm.openGraph?.description ?? fm.description).slice(
    0,
    METADATA_LIMITS.maxSocialDescriptionChars,
  );
  const twitterTitle = (fm.twitter?.title ?? seoTitle).slice(
    0,
    METADATA_LIMITS.maxSocialTitleChars,
  );
  const twitterDescription = (fm.twitter?.description ?? fm.description).slice(
    0,
    METADATA_LIMITS.maxSocialDescriptionChars,
  );

  return {
    title: seoTitle,
    description: fm.description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      type: "article",
      locale: "id_ID",
      siteName: "MagangHub Kemnaker RI",
      title: ogTitle,
      description: ogDescription,
      url: canonicalUrl,
      publishedTime: fm.publishedDate.toISOString(),
      ...(fm.updatedDate ? { modifiedTime: fm.updatedDate.toISOString() } : {}),
      authors: [fm.author],
      tags: fm.tags,
    },
    twitter: {
      card: "summary_large_image",
      title: twitterTitle,
      description: twitterDescription,
    },
    robots: fm.draft
      ? { index: false, follow: false }
      : { index: true, follow: true },
  };
}
