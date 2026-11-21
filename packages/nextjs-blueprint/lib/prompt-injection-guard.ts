/**
 * Indirect Prompt Injection & Delimiter Sanitization Guard for GEO / AI Feeds
 * (`app/llms.txt/route.ts` and `app/ai/jobs.ndjson/route.ts`).
 *
 * STRIDE-T-03 defense:
 * Partner-submitted vacancy descriptions, titles, and upstream batch metadata are
 * untrusted external text consumed by LLM crawlers (GPTBot, ClaudeBot, PerplexityBot).
 * This module enforces linear-time O(N) sanitization:
 * 1. Strips ASCII C0/C1 control chars, zero-width chars, Unicode bidi overrides/isolates,
 *    and JS/NDJSON line separators (U+2028, U+2029).
 * 2. Collapses newlines/CR/tabs to single spaces (prevents Markdown heading/fence breakout
 *    and NDJSON line-splitting attacks).
 * 3. Neutralizes chat-template / system-prompt tokens (`<|...|>` / `[INST]` / `<<SYS>>` / `<system>`)
 *    and indirect prompt-injection override directives.
 * 4. Enforces strict deterministic per-field character length caps.
 */

import type { BatchSchedule } from "./constants.ts";

// Linear-time character class patterns (zero nested quantifiers, ReDoS-safe)
const CONTROL_AND_INVISIBLE_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]+/g;
const LINE_BREAK_RE = /[\r\n\t\u2028\u2029]+/g;
const CHAT_TEMPLATE_TOKEN_RE =
  /<\|[^|]{0,48}\|>|<<\/?SYS>>|\[\/?INST\]|<\s*\/?\s*(?:system|assistant|user|developer|tool_call|instructions?)\s*>/gi;
const MARKDOWN_DELIMITER_RE = /```+|~~~+|(?<=^|\s)#{1,6}(?=\s)|(?<=^|\s)---+(?=\s|$)/g;
const PROMPT_OVERRIDE_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directives?)\b/gi,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directives?)\b/gi,
  /\bforget\s+(?:everything|all\s+(?:previous|prior|above))\b/gi,
  /\b(?:override|bypass)\s+(?:the\s+)?(?:system|safety|security)\s+(?:prompt|instructions?|rules?)\b/gi,
  /\b(?:system\s+prompt|new\s+system\s+instructions?|developer\s+override)\s*:/gi,
  /\byou\s+are\s+now\s+(?:a|an|in)\s+(?:unrestricted|admin|system|jailbreak|dan)\b/gi,
];
const PROMPT_OVERRIDE_COMBINED_RE = new RegExp(
  PROMPT_OVERRIDE_PATTERNS.map((r) => `(?:${r.source})`).join("|"),
  "gi",
);

export interface SanitizeLlmTextOptions {
  maxLength?: number;
  stripMarkdownDelimiters?: boolean;
}

export function sanitizeLlmText(
  raw: unknown,
  options: SanitizeLlmTextOptions = {},
): string {
  if (typeof raw !== "string" || !raw) return "";
  const maxLength = Math.max(1, Math.floor(options.maxLength ?? 280));
  const stripMarkdown = options.stripMarkdownDelimiters ?? true;

  // Cap raw slice before regex passes to guarantee O(1) bounded work on multi-MB payloads
  let text = raw.length > 65_536 ? raw.slice(0, 65_536) : raw;

  text = text
    .replace(CONTROL_AND_INVISIBLE_RE, "")
    .replace(LINE_BREAK_RE, " ");

  // Bound working window after invisible-char stripping (16x maxLength with 4 KB floor)
  // so 50 KB repeated-directive payloads stay well below 2 ms while preserving full output safety
  const workCap = Math.max(4_096, maxLength * 16);
  if (text.length > workCap) {
    text = text.slice(0, workCap);
  }

  text = text.replace(CHAT_TEMPLATE_TOKEN_RE, " ");

  if (stripMarkdown) {
    text = text.replace(MARKDOWN_DELIMITER_RE, " ");
    // Prevent blockquote/link syntax smuggling at line start
    text = text.replace(/^\s*>\s*/, "");
  }

  text = text
    .replace(PROMPT_OVERRIDE_COMBINED_RE, "[redacted-directive]")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

export function sanitizeBatchSchedule(
  schedule: BatchSchedule,
  fallback: BatchSchedule,
): BatchSchedule {
  const safeField = (val: unknown, fb: string, maxLen: number): string => {
    const cleaned = sanitizeLlmText(val, {
      maxLength: maxLen,
      stripMarkdownDelimiters: true,
    });
    return cleaned || fb;
  };

  const year =
    typeof schedule?.year === "number" &&
    Number.isInteger(schedule.year) &&
    schedule.year >= 2024 &&
    schedule.year <= 2100
      ? schedule.year
      : fallback.year;

  const durationMonths =
    typeof schedule?.durationMonths === "number" &&
    Number.isInteger(schedule.durationMonths) &&
    schedule.durationMonths >= 1 &&
    schedule.durationMonths <= 24
      ? schedule.durationMonths
      : fallback.durationMonths;

  return {
    batchLabel: safeField(schedule?.batchLabel, fallback.batchLabel, 48),
    year,
    quotaNational: safeField(schedule?.quotaNational, fallback.quotaNational, 80),
    quotaBatch: safeField(schedule?.quotaBatch, fallback.quotaBatch, 64),
    durationMonths,
    companyRegistration: safeField(schedule?.companyRegistration, fallback.companyRegistration, 48),
    participantRegistration: safeField(
      schedule?.participantRegistration,
      fallback.participantRegistration,
      48,
    ),
    companySelection: safeField(schedule?.companySelection, fallback.companySelection, 48),
    kemnakerAnnouncement: safeField(
      schedule?.kemnakerAnnouncement,
      fallback.kemnakerAnnouncement,
      48,
    ),
    internshipStart: safeField(schedule?.internshipStart, fallback.internshipStart, 48),
    updatedAt: safeField(schedule?.updatedAt, fallback.updatedAt, 32),
  };
}
