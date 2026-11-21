// Ambient type shims for Next.js 15/16 App Router, React 19, JSX, and Astro Content Layer.
// Enables strict `tsc --noEmit` verification inside this standalone blueprint repository
// without installing full Next.js, React, or Astro frameworks.
// When copying files into a real Next.js or Astro app, delete this shim file.

interface RequestInit {
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
}

declare namespace JSX {
  type Element = unknown;
  interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>;
  }
}

declare module "react" {
  export function cache<T extends (...args: never[]) => unknown>(fn: T): T;
  export type ReactNode = unknown;
}

declare module "react/jsx-runtime" {
  export function jsx(type: unknown, props: Record<string, unknown>, key?: string): unknown;
  export function jsxs(type: unknown, props: Record<string, unknown>, key?: string): unknown;
  export const Fragment: symbol;
}

declare module "next" {
  export interface RobotsInfo {
    index?: boolean;
    follow?: boolean;
    nocache?: boolean;
    noarchive?: boolean;
    nosnippet?: boolean;
    googleBot?: {
      index?: boolean;
      follow?: boolean;
      noimageindex?: boolean;
    };
  }

  export interface Metadata {
    metadataBase?: URL;
    title?: string | { default: string; template: string; absolute?: string } | { absolute: string };
    description?: string;
    alternates?: {
      canonical?: string | URL;
    };
    openGraph?: {
      type?: string;
      locale?: string;
      siteName?: string;
      title?: string;
      description?: string;
      url?: string | URL;
      publishedTime?: string;
      modifiedTime?: string;
      authors?: string[];
      tags?: string[];
    };
    twitter?: {
      card?: "summary" | "summary_large_image" | "app" | "player";
      title?: string;
      description?: string;
      site?: string;
      creator?: string;
    };
    robots?: string | RobotsInfo;
  }

  export namespace MetadataRoute {
    export type Sitemap = Array<{
      url: string;
      lastModified?: string | Date;
      changeFrequency?:
        | "always"
        | "hourly"
        | "daily"
        | "weekly"
        | "monthly"
        | "yearly"
        | "never";
      priority?: number;
    }>;

    export type Robots = {
      rules:
        | {
            userAgent?: string | string[];
            allow?: string | string[];
            disallow?: string | string[];
            crawlDelay?: number;
          }
        | Array<{
            userAgent: string | string[];
            allow?: string | string[];
            disallow?: string | string[];
            crawlDelay?: number;
          }>;
      sitemap?: string | string[];
      host?: string;
    };
  }
}

declare module "next/server" {
  export interface NextURL {
    pathname: string;
    search: string;
    origin: string;
    href: string;
  }

  export class NextRequest extends Request {
    nextUrl: NextURL;
  }

  export class NextResponse extends Response {
    static next(init?: ResponseInit): NextResponse;
    static redirect(url: string | URL, status?: number): NextResponse;
    static json(data: unknown, init?: ResponseInit): NextResponse;
  }
}

declare module "next/link" {
  export interface LinkProps {
    href: string;
    className?: string;
    children?: unknown;
  }
  export default function Link(props: LinkProps): unknown;
}

declare module "next/navigation" {
  export function notFound(): never;
}

declare module "astro:content" {
  export interface CollectionConfig<TSchema = unknown> {
    loader?: unknown;
    type?: "content" | "data";
    schema: TSchema;
  }
  export function defineCollection<TSchema>(
    config: CollectionConfig<TSchema>,
  ): CollectionConfig<TSchema>;
}

declare module "astro/loaders" {
  export function glob(options: { pattern: string; base: string }): unknown;
}
