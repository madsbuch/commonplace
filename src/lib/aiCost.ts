/**
 * The cost page's vocabulary and arithmetic: what each AI feature is called,
 * and how the `ai_usage` ledger rolls up into a total, a breakdown by feature
 * and by model, and spend over time.
 *
 * Every OpenRouter response that reports its cost is logged under the
 * feature that asked for it (lib/openrouter.ts). Pure, so the roll-ups can be
 * tested without a database. Adapted from Tally.
 */

export const AI_FEATURES = ["assistant", "library_details", "connection_test"] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

const FEATURE_INFO: Record<AiFeature, { label: string; detail: string }> = {
  assistant: { label: "Writing assistant", detail: "Questions, critique and quizzes about a page" },
  library_details: { label: "Library details", detail: "Reading a new paper's or book's title, authors and year" },
  connection_test: { label: "Connection tests", detail: "Testing the API key in Settings" },
};

/** Display name and one-line description; unknown features show as logged. */
export function featureInfo(feature: string): { label: string; detail: string } {
  const known = Object.entries(FEATURE_INFO).find(([key]) => key === feature);
  return known?.[1] ?? { label: feature, detail: "" };
}

/** The ledger summed per local day, feature and model. */
export interface UsageRow {
  day: string;
  feature: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
}

function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
}

function add(into: UsageTotals, r: UsageTotals): void {
  into.requests += r.requests;
  into.promptTokens += r.promptTokens;
  into.completionTokens += r.completionTokens;
  into.costUsd += r.costUsd;
}

// Spec: AI-4
export function totalOf(rows: readonly UsageRow[]): UsageTotals {
  const t = emptyTotals();
  for (const r of rows) add(t, r);
  return t;
}

// Spec: AI-4
/** Sum by `feature` or `model`, most expensive first. */
export function groupBy(rows: readonly UsageRow[], key: "feature" | "model"): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const r of rows) {
    const k = r[key];
    let g = groups.get(k);
    if (!g) {
      g = { key: k, ...emptyTotals() };
      groups.set(k, g);
    }
    add(g, r);
  }
  return [...groups.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
}

/** Shift a "YYYY-MM-DD" day by whole days. */
export function shiftDay(day: string, delta: number): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

/** A local date as "YYYY-MM-DD". */
export function localDay(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface SpendBucket {
  /** First day of the bucket. */
  start: string;
  /** Last day of the bucket. */
  end: string;
  costUsd: number;
}

// Spec: AI-4
/**
 * Spend per bucket of `size` days, from `first` through `last` inclusive,
 * with empty days as zero so the gaps show. Built backwards from `last`, so
 * the newest bucket is always whole; the oldest may be cut short at `first`.
 */
export function spendOver(rows: readonly UsageRow[], first: string, last: string, size: number): SpendBucket[] {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.costUsd);
  const buckets: SpendBucket[] = [];
  for (let end = last; end >= first; end = shiftDay(end, -size)) {
    let start = shiftDay(end, -(size - 1));
    if (start < first) start = first;
    let cost = 0;
    for (let d = start; d <= end; d = shiftDay(d, 1)) cost += byDay.get(d) ?? 0;
    buckets.push({ start, end, costUsd: cost });
  }
  return buckets.reverse();
}

/** "$0.42", or "<$0.01" for the small amounts most requests cost. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

/** "1.2M", "34k", "512": token counts at a glance. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}
