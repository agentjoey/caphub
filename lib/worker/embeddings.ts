import type { Pool } from "pg";
import { embeddingText, toVectorLiteral } from "../analysis/embedding";
import { runErrorCode } from "./tick";

const BATCH_SIZE = 20;

export interface EmbedCall {
  embed(texts: string[], kind: "document" | "query", signal?: AbortSignal): Promise<number[][]>;
}

export interface EmbedTickDeps {
  pool: Pool;
  embed: EmbedCall;
  log?: (o: Record<string, unknown>) => void;
}

interface Candidate {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  updated_at: Date;
  label_zh: string[];
  label_en: string[];
}

/**
 * Picks up to `BATCH_SIZE` capabilities never embedded, or embedded before their last edit
 * (`embedding IS NULL OR embedded_at < updated_at`), embeds them in one batch call, and writes
 * the result back guarded by the `updated_at` read here (via `date_trunc('milliseconds', …)`,
 * matching the pattern in `lib/library/actions.ts`, since node-postgres reads timestamptz back
 * at millisecond precision) — a concurrent edit between the read and the write leaves the row
 * stale again for the next tick, rather than overwriting a newer edit's embedding. `updated_at`
 * itself is never touched.
 */
export async function runEmbedTick(deps: EmbedTickDeps, signal: AbortSignal): Promise<"idle" | "embedded" | "error"> {
  const { rows } = await deps.pool.query<Candidate>(
    `SELECT c.id, c.title, c.summary, c.tags, c.updated_at,
       COALESCE(array_agg(s.label_zh) FILTER (WHERE s.slug IS NOT NULL), '{}') AS label_zh,
       COALESCE(array_agg(s.label_en) FILTER (WHERE s.slug IS NOT NULL), '{}') AS label_en
     FROM caphub_v2.capabilities c
     LEFT JOIN caphub_v2.scenarios s ON s.slug = ANY(c.scenarios)
     WHERE c.deleted_at IS NULL AND (c.embedding IS NULL OR c.embedded_at < c.updated_at)
     GROUP BY c.id
     ORDER BY c.updated_at
     LIMIT ${BATCH_SIZE}`
  );
  if (rows.length === 0) return "idle";

  const texts = rows.map((r) => embeddingText({ title: r.title, summary: r.summary, tags: r.tags, scenarioLabels: [...r.label_zh, ...r.label_en] }));
  let vectors: number[][];
  try {
    vectors = await deps.embed.embed(texts, "document", signal);
  } catch (error) {
    deps.log?.({ embed: "failed", code: runErrorCode(error) });
    return "error";
  }

  let written = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      // node-postgres reads timestamptz back as a millisecond-precision JS Date, so comparing
      // it straight against the µs-precision column read here would almost never match and the
      // write would silently no-op forever. date_trunc to milliseconds on both sides instead.
      // embedded_at is set to the row's own (untruncated) updated_at, not the ms-truncated
      // parameter, so embedded_at < updated_at reads false immediately after a successful write.
      const result = await deps.pool.query(
        `UPDATE caphub_v2.capabilities SET embedding = $2::vector, embedded_at = updated_at
         WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $3::timestamptz`,
        [row.id, toVectorLiteral(vectors[i]), row.updated_at]
      );
      if (result.rowCount) written += 1;
      else skipped += 1;
    } catch (error) {
      deps.log?.({ embed: "row-failed", capability: row.id, code: runErrorCode(error) });
      skipped += 1;
    }
  }
  deps.log?.({ embed: "done", written, skipped });
  return written > 0 ? "embedded" : "idle";
}
