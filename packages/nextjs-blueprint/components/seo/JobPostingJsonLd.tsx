// components/seo/JobPostingJsonLd.tsx
// Server Component emitting Google for Jobs compliant JobPosting JSON-LD
// plus reusable JsonLdScript for GovernmentOrganization and FAQPage.
// Defense-in-depth: returns null if evaluateJobLifecycle(vacancy).state !== "ACTIVE",
// allowlist-sanitizes HTML description, and escapes <, >, &, U+2028, U+2029.

import {
  buildJobPostingSchema,
  serializeSafeJsonLd,
} from "../../lib/job-schema.ts";
import type { MagangVacancy } from "../../lib/get-lowongan.ts";

export interface JsonLdScriptProps {
  data: unknown;
}

export function JsonLdScript({ data }: JsonLdScriptProps) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: serializeSafeJsonLd(data),
      }}
    />
  );
}

export interface JobPostingJsonLdProps {
  vacancy: MagangVacancy;
  nowMs?: number;
  baseUrl?: string;
  jobRoutePrefix?: string;
}

export function JobPostingJsonLd({
  vacancy,
  nowMs,
  baseUrl,
  jobRoutePrefix,
}: JobPostingJsonLdProps) {
  const schema = buildJobPostingSchema(vacancy, {
    nowMs,
    baseUrl,
    jobRoutePrefix,
  });
  if (!schema) return null;

  return <JsonLdScript data={schema} />;
}
