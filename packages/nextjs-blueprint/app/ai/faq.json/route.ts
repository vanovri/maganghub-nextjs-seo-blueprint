// app/ai/faq.json/route.ts
// Structured AI FAQ JSON feed paired with live Batch 3B 2026 schedule and FAQPage JSON-LD.

import {
  BASE_URL,
  BNSP_CERTIFICATION_URL,
  LIVE_BATCH_3B_2026,
  LIVE_FAQ_ITEMS,
  ORGANIZER_PORTAL_URL,
  type BatchSchedule,
  type FaqItem,
} from "../../../lib/constants.ts";
import { buildFaqPageSchema, type FaqPageSchema } from "../../../lib/job-schema.ts";

export const revalidate = 3600; // 1-hour ISR cache

export interface AiFaqFeedPayload {
  schemaVersion: "1.0";
  portal: string;
  canonicalOrigin: string;
  generatedAt: string;
  batchSchedule: BatchSchedule;
  ecosystem: {
    organizerPortal: string;
    bnspCertification: string;
  };
  items: readonly FaqItem[];
  jsonLd: FaqPageSchema;
}

export function buildAiFaqFeedPayload(
  options: {
    now?: Date;
    baseUrl?: string;
    schedule?: BatchSchedule;
    items?: readonly FaqItem[];
  } = {},
): AiFaqFeedPayload {
  const now = options.now ?? new Date();
  const baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/+$/, "");
  const schedule = options.schedule ?? LIVE_BATCH_3B_2026;
  const items = options.items ?? LIVE_FAQ_ITEMS;

  return {
    schemaVersion: "1.0",
    portal: "MagangHub Kemnaker RI",
    canonicalOrigin: baseUrl,
    generatedAt: now.toISOString(),
    batchSchedule: schedule,
    ecosystem: {
      organizerPortal: ORGANIZER_PORTAL_URL,
      bnspCertification: BNSP_CERTIFICATION_URL,
    },
    items,
    jsonLd: buildFaqPageSchema(items),
  };
}

export async function GET(): Promise<Response> {
  const payload = buildAiFaqFeedPayload();
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
