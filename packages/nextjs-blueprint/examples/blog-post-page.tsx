// examples/blog-post-page.tsx
// Next.js App Router blog detail page demonstrating React.cache() deduplication
// and symmetric draft guard between generateMetadata() and BlogPostPage().

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  generateBlogPostMetadata,
  getPublishedBlogPost,
} from "../lib/blog-loader.ts";
import { sanitizeJobDescriptionHtml } from "../lib/job-schema.ts";

export const revalidate = 3600;

const ALLOW_DRAFTS = process.env.ALLOW_BLOG_DRAFTS === "true";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return generateBlogPostMetadata(slug, { allowDrafts: ALLOW_DRAFTS });
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPublishedBlogPost(slug, { allowDrafts: ALLOW_DRAFTS });
  if (!post) {
    notFound();
  }

  return (
    <article className="mx-auto max-w-3xl px-4 py-10">
      <header className="border-b pb-4">
        <h1 className="text-3xl font-bold">{post.frontmatter.title}</h1>
        <p className="mt-2 text-sm text-neutral-600">
          {post.frontmatter.author} | Dipublikasikan{" "}
          {post.frontmatter.publishedDate.toISOString().slice(0, 10)}
        </p>
      </header>
      <div
        className="prose mt-6 max-w-none"
        dangerouslySetInnerHTML={{
          __html: sanitizeJobDescriptionHtml(post.bodyHtml),
        }}
      />
    </article>
  );
}
