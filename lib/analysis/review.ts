import type { Pool } from "pg";
import { RunBudget } from "./budget";
import { reviewNoteSchema, type ReviewNote } from "./card";
import { TIMEOUTS } from "./pipeline";
import { runStructured, type StructuredCall } from "./structured";

export async function reviewCapability(deps: { pool: Pool; call: StructuredCall }, capabilityId: string, signal: AbortSignal): Promise<ReviewNote> {
  const row = (await deps.pool.query<{ run_id: string; card: unknown; reason_output: unknown }>(
    `SELECT cb.run_id, to_jsonb(cb) - 'search' AS card,
            (SELECT output FROM caphub_v2.analysis_steps s WHERE s.run_id = cb.run_id AND s.step = 'reason' AND s.ok ORDER BY id DESC LIMIT 1) AS reason_output
     FROM caphub_v2.capabilities cb WHERE cb.id = $1`, [capabilityId])).rows[0];
  if (!row) throw new Error("CAPABILITY_NOT_FOUND");
  const prompt = [
    "你是第二意见评审。下面是一张由另一个模型生成的能力卡片及其完整推理产物。请独立判断：建议的保留/丢弃、类型、integrate/reference、标签是否合理；摘要有没有夸大或遗漏。",
    `卡片：\n${JSON.stringify(row.card)}`,
    `推理产物：\n${JSON.stringify(row.reason_output)}`,
    "输出 agrees（整体是否同意）和 points（不同意或需要修正的具体点，最多 8 条；同意则给 1–2 条确认理由）。"
  ].join("\n\n");
  const note = await runStructured({
    pool: deps.pool, runId: row.run_id, step: "review", call: deps.call, prompt,
    schemaName: "review_note", schema: reviewNoteSchema, budget: new RunBudget({ maxCalls: 2, maxTokens: 100_000 }),
    timeoutMs: TIMEOUTS.review, signal
  });
  await deps.pool.query("UPDATE caphub_v2.capabilities SET review_note = $2, updated_at = now() WHERE id = $1", [capabilityId, JSON.stringify(note)]);
  return note;
}
