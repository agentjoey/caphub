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
 * the result back guarded by the `updated_at` read here — a concurrent edit between the read
 * and the write leaves the row stale again for the next tick, rather than overwriting a newer
 * edit's embedding. `updated_at` itself is never touched.
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

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    await deps.pool.query(
      "UPDATE caphub_v2.capabilities SET embedding = $2::vector, embedded_at = $3 WHERE id = $1 AND updated_at = $4",
      [row.id, toVectorLiteral(vectors[i]), row.updated_at, row.updated_at]
    );
  }
  deps.log?.({ embed: "done", count: rows.length });
  return "embedded";
}
