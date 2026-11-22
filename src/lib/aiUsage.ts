/**
 * The usage ledger: one `ai_usage` row per model response that reported its
 * cost, under the feature that asked for it. Written by lib/openrouter.ts,
 * read by the Costs screen. The rows sync like the rest of the book, so
 * every device sees what every device spent.
 */
import { aiUsage } from "../db/schema";
import { db, nowIso, select } from "./db";
import type { AiFeature, UsageRow } from "./aiCost";
import { parseUsageRows } from "./schemas";

export interface UsageEntry {
  feature: AiFeature;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

// Spec: AI-3
/** Records one response's reported cost. */
export async function recordAiUsage(entry: UsageEntry): Promise<void> {
  await db.insert(aiUsage).values({
    feature: entry.feature,
    model: entry.model,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    cost: entry.costUsd,
    createdAt: nowIso(),
  });
}

// Spec: AI-4
/** The whole ledger, summed per local day, feature and model, oldest first. */
export async function loadUsageRows(): Promise<UsageRow[]> {
  const rows = await select(
    `SELECT date(created_at, 'localtime') AS day, feature, model,
       count(*) AS requests,
       coalesce(sum(prompt_tokens), 0) AS promptTokens,
       coalesce(sum(completion_tokens), 0) AS completionTokens,
       coalesce(sum(cost), 0) AS costUsd
     FROM ai_usage
     GROUP BY day, feature, model
     ORDER BY day`,
  );
  return parseUsageRows(rows);
}
