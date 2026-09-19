import type { Pool } from "pg";
import { jsonStringifyStripNul } from "../text/sanitize";
import { RunBudget } from "./budget";
import { reviewNoteSchema, type ReviewNote } from "./card";
import { TIMEOUTS } from "./pipeline";
import { runStructured, type StructuredCall } from "./structured";

export async function reviewCapability(deps: { pool: Pool; call: StructuredCall }, capabilityId: string, signal: AbortSignal): Promise<ReviewNote> {
  const row = (await deps.pool.query<{ run_id: string; card: unknown; reason_output: unknown }>(
    `SELECT cb.run_id,
            jsonb_build_object(
              'title', cb.title, 'type', cb.type, 'summary', cb.summary, 'signals', cb.signals,
              'suggested_verdict', cb.suggested_verdict, 'suggested_reason', cb.suggested_reason,
              'confidence', cb.confidence, 'usage', cb.usage, 'playbook', cb.playbook,
              'tags', cb.tags, 'source_url', cb.source_url
            ) AS card,
            (SELECT output FROM caphub_v2.analysis_steps s WHERE s.run_id = cb.run_id AND s.step = 'reason' AND s.ok ORDER BY id DESC LIMIT 1) AS reason_output
     FROM caphub_v2.capabilities cb WHERE cb.id = $1`, [capabilityId])).rows[0];
  if (!row) throw Object.assign(new Error("CAPABILITY_NOT_FOUND"), { code: "CAPABILITY_NOT_FOUND" });
  if (row.reason_output == null) throw Object.assign(new Error("REASON_STEP_NOT_FOUND"), { code: "REASON_STEP_NOT_FOUND" });
  const prompt = [
    "你是第二意见评审。下面是一张由另一个模型生成的能力卡片及其完整推理产物。请独立判断：建议的保留/丢弃、类型、integrate/reference、标签是否合理；摘要有没有夸大或遗漏。",
    `卡片：\n${JSON.stringify(row.card)}`,
    `推理产物：\n${JSON.stringify(row.reason_output)}`,
    "输出 agrees（整体是否同意）和 points（不同意或需要修正的具体点，最多 8 条；同意则给 1–2 条确认理由）。"
  ].join("\n\n");
  const note = await runStructured({
    pool: deps.pool, runId: row.run_id, step: "review", call: deps.call, prompt,
    schemaName: "review_note", schema: reviewNoteSchema,
    // One call plus one correction retry; a manual review is a separate action from the
    // analysis run's own budget, so it gets its own small allowance rather than sharing it.
    budget: new RunBudget({ maxCalls: 2, maxTokens: 100_000 }),
    timeoutMs: TIMEOUTS.review, signal
  });
  // updated_at is the optimistic-lock token for verdict decisions; a review note must not invalidate it.
  await deps.pool.query("UPDATE caphub_v2.capabilities SET review_note = $2 WHERE id = $1", [capabilityId, jsonStringifyStripNul(note)]);
  return note;
}
