import type { Pool } from "pg";
import { reviewCapability } from "../analysis/review";
import type { ReviewNote } from "../analysis/card";
import type { StructuredCall } from "../analysis/structured";
import { runErrorCode } from "./tick";

export interface ReviewTickDeps {
  pool: Pool;
  call: StructuredCall;
  review?: (deps: { pool: Pool; call: StructuredCall }, id: string, signal: AbortSignal) => Promise<ReviewNote>;
  log?: (o: Record<string, unknown>) => void;
}

// FOR UPDATE SKIP LOCKED only holds the row lock for the duration of this single statement
// under autocommit (no surrounding transaction), so it cannot serialize concurrent claimants
// across the review + clear-request sequence below. The worker runs a single instance with a
// single sequential loop, so reviews are never actually claimed concurrently; this is sufficient
// for that deployment shape and would need an explicit transaction if the worker were ever scaled out.
export async function runReviewTick(deps: ReviewTickDeps, signal: AbortSignal): Promise<"idle" | "processed"> {
  const claimed = (await deps.pool.query<{ id: string }>(
    `SELECT id FROM caphub_v2.capabilities WHERE review_requested_at IS NOT NULL AND deleted_at IS NULL
     ORDER BY review_requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
  if (!claimed) return "idle";
  const review = deps.review ?? reviewCapability;
  try {
    await review({ pool: deps.pool, call: deps.call }, claimed.id, signal);
    await deps.pool.query("UPDATE caphub_v2.capabilities SET review_requested_at = NULL, review_error = NULL WHERE id = $1", [claimed.id]);
    deps.log?.({ review: "done", capability: claimed.id });
  } catch (error) {
    const code = runErrorCode(error);
    await deps.pool.query("UPDATE caphub_v2.capabilities SET review_requested_at = NULL, review_error = $2 WHERE id = $1", [claimed.id, code]);
    deps.log?.({ review: "failed", capability: claimed.id, code });
  }
  return "processed";
}
