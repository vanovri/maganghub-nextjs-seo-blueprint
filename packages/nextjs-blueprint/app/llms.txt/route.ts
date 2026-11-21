// app/llms.txt/route.ts
// Dynamic llmstxt.org-compliant Route Handler replacing static public/llms.txt.
// Hydrates live Batch 3B 2026 schedule (17-26 Nov, 23 Nov-1 Des, 2-10 Des, 11 Des, 14 Des 2026),
// actual /magang-nasional/* routes, organizer.maganghub.kemnaker.go.id, and /ai/* feeds with zero placeholders.

import { LIVE_BATCH_3B_2026, type BatchSchedule } from "../../lib/constants.ts";
import { buildLlmsTxt } from "../../lib/llms.ts";

export const revalidate = 3600; // Refresh every hour

export interface ActiveBatchPayload {
  schedule: BatchSchedule;
  activeVacanciesCount?: number;
}

export async function getActiveBatchConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<ActiveBatchPayload> {
  const endpoint = process.env.MAGANGHUB_INTERNAL_BATCH_URL;
  if (!endpoint) {
    return { schedule: LIVE_BATCH_3B_2026 };
  }

  try {
    const res = await fetchImpl(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return { schedule: LIVE_BATCH_3B_2026 };
    return (await res.json()) as ActiveBatchPayload;
  } catch {
    return { schedule: LIVE_BATCH_3B_2026 };
  }
}

export async function GET(): Promise<Response> {
  const { schedule, activeVacanciesCount } = await getActiveBatchConfig();
  const body = buildLlmsTxt(schedule, { activeVacanciesCount });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
