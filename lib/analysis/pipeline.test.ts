import { describe, expect, it, vi } from "vitest";
import { ProviderError, type ProviderErrorCode } from "../providers/errors";
import { createPipelineDeps, runPipeline, type PipelineDeps } from "./pipeline";

const card = {
  title: "t", type: "skill", summary: "s",
  summary_points: [{ label: "l1", text: "t1" }, { label: "l2", text: "t2" }, { label: "l3", text: "t3" }],
  signals: ["a", "b"], suggested_verdict: "keep", suggested_reason: "r",
  confidence: 0.9, usage: "integrate", playbook: { kind: "integrate", install: [], repo: null }, tags: ["x"], source_url: null,
  scenarios: ["coding"], score: 4, score_reason: "r", source_facts: {}, overlap: { relation: "none", target: null, reason: "" }
};
const pendingCard = { ...card, confidence: 0.5 };
const experienceCard = { ...card, type: "experience", playbook: { kind: "experience", content: "做法本身", when_to_use: "何时用" } };
const extraction = { what: "w", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [] };

type Kind = "image" | "text" | "url" | "video";

const YOUTUBE_URL = "https://youtu.be/tYvu6IpSfiM";

function deps(kind: Kind, opts: {
  reasonValue?: unknown; failTagBump?: boolean; pinnedType?: string;
  existingCapability?: { id: string; hasEmbedding: boolean } | null;
  textSimilar?: Array<Record<string, unknown>>; embeddingSimilar?: Array<Record<string, unknown>>;
  materialEmbeddingSimilar?: Array<Record<string, unknown>>;
  /** Result `deps.embedQuery` resolves to; defaults to null (no key / provider unavailable). */
  embedQueryResult?: number[] | null;
  /** Throws instead of resolving, to exercise the belt-and-braces try/catch around it. */
  embedQueryThrows?: boolean;
  /** `enriched_at` the fake upsert RETURNs; null (never enriched) unless overridden. */
  enrichedAt?: string | null;
  /** `deleted` the fake upsert RETURNs; false unless overridden. */
  deleted?: boolean;
  /** Throws from the enqueue's INSERT; code defaults to 23505 (a concurrent duplicate) unless overridden. */
  enrichEnqueueThrows?: boolean;
  enrichEnqueueThrowsCode?: string;
  /** The text capture's own `text` column; defaults to "hello" as before. */
  sourceText?: string;
  /** What the vision fake resolves to; defaults to the shared `extraction` fixture. */
  extractionValue?: unknown;
  /** What the video fake resolves to; defaults to the shared `extraction` fixture. */
  videoValue?: unknown;
  /** Makes the video fake throw a ProviderError of this code instead of resolving. */
  videoThrows?: ProviderErrorCode;
  /** No `deps.video` at all (as if no Gemini key were configured). */
  noVideo?: boolean;
  /** Overrides for the YouTube Data API fake's `snippet` fields; `null` makes the fetch 404. */
  meta?: Record<string, unknown> | null;
  /** ISO 8601 duration the YouTube Data API fake reports; defaults to a short video. */
  durationIso?: string;
} = {}) {
  const calls: string[] = [];
  const sql: Array<{ text: string; values: unknown[]; client?: boolean }> = [];
  let reasonPromptSeen = "";
  let videoInputSeen: unknown;
  let released = 0;
  const query = async (text: string, values: unknown[] = []) => {
    sql.push({ text, values });
    if (opts.failTagBump && text.includes("INSERT INTO caphub_v2.tags")) throw Object.assign(new Error("duplicate"), { code: "21000" });
    if (text.startsWith("SELECT type FROM caphub_v2.capabilities WHERE capture_id")) {
      return { rows: opts.pinnedType ? [{ type: opts.pinnedType }] : [] };
    }
    if (text.startsWith("SELECT id, embedding IS NOT NULL AS has_embedding")) {
      return { rows: opts.existingCapability === undefined ? [] : opts.existingCapability === null ? [] : [{ id: opts.existingCapability.id, has_embedding: opts.existingCapability.hasEmbedding }] };
    }
    if (text.startsWith("SELECT kind, object_key")) {
      return {
        rows: [{
          kind: kind === "video" ? "url" : kind,
          object_key: kind === "image" ? "sha256/aa/" + "a".repeat(64) : null,
          mime_type: "image/png",
          text: kind === "text" ? (opts.sourceText ?? "hello") : null,
          url: kind === "url" ? "https://example.com/a" : kind === "video" ? YOUTUBE_URL : null
        }]
      };
    }
    if (text.startsWith("SELECT name FROM caphub_v2.tags")) return { rows: [{ name: "x" }] };
    if (text.startsWith("SELECT slug, label_zh, label_en, keywords FROM caphub_v2.scenarios")) {
      return { rows: [{ slug: "coding", label_zh: "编程", label_en: "Coding", keywords: ["code"] }] };
    }
    // The two SimilarCandidate lookups share the same SELECT column list, and only diverge
    // further into the WHERE clause: findSimilar's text search matches on `to_tsquery`, while
    // similarByEmbedding's directly-supplied-embedding form matches on `<=> $1::vector` instead.
    if (text.startsWith("SELECT id, title, type, summary, summary_points, tags, serial FROM caphub_v2.capabilities")) {
      if (text.includes("to_tsquery")) return { rows: opts.textSimilar ?? [] };
      if (text.includes("<=> $1::vector")) return { rows: opts.materialEmbeddingSimilar ?? [] };
    }
    if (text.startsWith("SELECT c.id, c.title, c.type, c.summary, c.summary_points, c.tags, c.serial")) return { rows: opts.embeddingSimilar ?? [] };
    if (text.includes("INSERT INTO caphub_v2.capabilities")) {
      // values: [id, captureId, runId, title, type, summary, signals, suggested_verdict,
      //          suggested_reason, confidence, verdict, verdictBy, usage, playbook, tags, source_url]
      const verdict = values[10] as string;
      return { rows: [{ id: "cab_1", verdict, previous_verdict: null, deleted: opts.deleted ?? false, enriched_at: opts.enrichedAt ?? null }] };
    }
    if (text.includes("INSERT INTO caphub_v2.analysis_runs")) {
      if (opts.enrichEnqueueThrows) throw Object.assign(new Error("duplicate"), { code: opts.enrichEnqueueThrowsCode ?? "23505" });
      return { rows: [] };
    }
    return { rows: [] };
  };
  const pool = {
    query: (text: string, values: unknown[] = []) => query(text, values),
    connect: async () => ({
      query: (text: string, values: unknown[] = []) => { const r = query(text, values); sql[sql.length - 1].client = true; return r; },
      release: () => { released += 1; }
    })
  };
  const d: PipelineDeps = {
    pool: pool as never,
    objects: { get: async () => new Uint8Array([1]) } as never,
    vision: { provider: "minimax", model: "m", invoke: async () => { calls.push("vision"); return { value: opts.extractionValue ?? extraction, usage: { inputTokens: 1, outputTokens: 1 } }; } },
    search: { provider: "tavily", model: "s", search: async () => { calls.push("search"); return { value: { sources: [] }, usage: { inputTokens: 0, outputTokens: 0 } }; } },
    reason: {
      provider: "deepseek", model: "d",
      invoke: async (input: { prompt: string }) => { calls.push("reason"); reasonPromptSeen = input.prompt; return { value: opts.reasonValue ?? card, usage: { inputTokens: 1, outputTokens: 1 } }; }
    },
    material: {
      ocr: async () => "",
      fetch: kind === "url"
        ? (async () => new Response("hello world", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch
        : kind === "video"
          ? (async () => {
              if (opts.meta === null) return new Response("not found", { status: 404 });
              const snippet = { title: "Jev 实测", channelTitle: "01Coder", publishedAt: "2026-09-20T00:00:00Z", description: "简介文本", ...(opts.meta ?? {}) };
              return new Response(JSON.stringify({ items: [{ snippet, contentDetails: { duration: opts.durationIso ?? "PT16M55S" } }] }), { status: 200, headers: { "content-type": "application/json" } });
            }) as typeof fetch
          : undefined,
      youtubeApiKey: "yt-fake-key"
    },
    threshold: 0.8,
    embedQuery: async () => {
      calls.push("embed");
      if (opts.embedQueryThrows) throw new Error("embed provider exploded");
      return opts.embedQueryResult ?? null;
    },
    video: opts.noVideo ? undefined : {
      provider: "gemini", model: "gemini-video",
      invoke: async (input: { video?: unknown }) => {
        calls.push("video");
        videoInputSeen = input.video;
        if (opts.videoThrows) throw new ProviderError(opts.videoThrows);
        return { value: opts.videoValue ?? extraction, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    }
  };
  return { d, calls, sql, released: () => released, reasonPrompt: () => reasonPromptSeen, videoInput: () => videoInputSeen };
}

describe("runPipeline", () => {
  it("runs vision → search → reason for images and stores an auto-kept capability", async () => {
    const { d, calls, sql } = deps("image");
    // sharp 需要真实 PNG：用 1x1 PNG 替换 objects.get
    const sharp = (await import("sharp")).default;
    const png = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer());
    d.objects = { get: async () => png } as never;
    const out = await runPipeline(d, { runId: "run_1", captureId: "cap_1", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["vision", "search", "embed", "reason"]);
    expect(out).toEqual({ capabilityId: "cab_1", verdict: "keep" });
    const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
    expect(insert.values).toContain("auto");
    const tagBump = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.tags"));
    expect(tagBump).toBeDefined();
  });

  it("saves the capability and its tag bump in one transaction on a pool client", async () => {
    const { d, sql, released } = deps("text");
    await runPipeline(d, { runId: "run_tx", captureId: "cap_tx", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    const tx = sql.filter((q) => q.client).map((q) => q.text.includes("INSERT INTO caphub_v2.capabilities") ? "upsert"
      : q.text.includes("UPDATE caphub_v2.capabilities SET serial") ? "assign-serial"
      : q.text.includes("INSERT INTO caphub_v2.tags") ? "bump" : q.text);
    expect(tx).toEqual(["BEGIN", "upsert", "assign-serial", "bump", "COMMIT"]);
    expect(released()).toBe(1);
  });

  it("rolls back the capability when the tag bump fails", async () => {
    const { d, sql, released } = deps("text", { failTagBump: true });
    await expect(runPipeline(d, { runId: "run_rb", captureId: "cap_rb", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal)).rejects.toThrow("duplicate");
    const clientSql = sql.filter((q) => q.client).map((q) => q.text);
    expect(clientSql).toContain("ROLLBACK");
    expect(clientSql).not.toContain("COMMIT");
    expect(released()).toBe(1);
  });

  it("enqueues an M3.7 enrich run, outside the capability transaction, when the card enters keep with enriched_at still null", async () => {
    const { d, sql } = deps("text");
    await runPipeline(d, { runId: "run_enrich", captureId: "cap_enrich", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    const enqueue = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.analysis_runs"));
    expect(enqueue).toBeDefined();
    // Issued via deps.pool directly, not the capability upsert's transactional client -- see
    // pipeline.ts's comment on why this must happen after COMMIT, not inside the transaction.
    expect(enqueue!.client).toBeUndefined();
    expect(enqueue!.text).toContain("'enrich'");
    expect(enqueue!.values).toEqual([expect.any(String), "cap_enrich", "mixed"]);
  });

  it("re-enqueues an enrich run on a rerun even when the card already has enriched_at set (owner ruling: a rerun must re-enrich)", async () => {
    // upsertCapability's ON CONFLICT branch overwrites summary/signals/playbook/open_questions
    // on every rerun regardless of enriched_at, so gating the enqueue on enriched_at === null
    // would permanently strand a rerun card on the pre-enrichment summary. The partial unique
    // index (analysis_runs_one_active_enrich) is what stops a duplicate, not this gate.
    const { d, sql } = deps("text", { enrichedAt: "2026-09-19T00:00:00.000Z" });
    await runPipeline(d, { runId: "run_rerun_enrich", captureId: "cap_rerun_enrich", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    expect(sql.some((q) => q.text.includes("INSERT INTO caphub_v2.analysis_runs"))).toBe(true);
  });

  it("does not enqueue an enrich run when the card does not enter keep", async () => {
    const { d, sql } = deps("text", { reasonValue: pendingCard });
    await runPipeline(d, { runId: "run_pending", captureId: "cap_pending", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    expect(sql.some((q) => q.text.includes("INSERT INTO caphub_v2.analysis_runs"))).toBe(false);
  });

  it("does not enqueue an enrich run for a soft-deleted card, even if the recomputed verdict is keep", async () => {
    const { d, sql } = deps("text", { deleted: true });
    await runPipeline(d, { runId: "run_deleted", captureId: "cap_deleted", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    expect(sql.some((q) => q.text.includes("INSERT INTO caphub_v2.analysis_runs"))).toBe(false);
  });

  it("does not fail the pipeline run when a concurrent enqueue already queued an enrich run (23505)", async () => {
    const { d } = deps("text", { enrichEnqueueThrows: true });
    const out = await runPipeline(d, { runId: "run_dup_enrich", captureId: "cap_dup_enrich", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    expect(out).toEqual({ capabilityId: "cab_1", verdict: "keep" });
  });

  it("does not fail the pipeline run when the enrich enqueue fails for a reason other than a duplicate", async () => {
    // A non-23505 failure (pool exhaustion, connection drop) must never be treated as this
    // analysis run's own failure -- it runs after COMMIT, so falling into the outer catch would
    // ROLLBACK an already-committed connection and report a false "分析失败" for a card that was
    // in fact stored.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { d } = deps("text", { enrichEnqueueThrows: true, enrichEnqueueThrowsCode: "ECONNRESET" });
      const out = await runPipeline(d, { runId: "run_enrich_enqueue_fails", captureId: "cap_enrich_enqueue_fails", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(out).toEqual({ capabilityId: "cab_1", verdict: "keep" });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("excludes its own capture from the similar-capability lookup", async () => {
    const { d, sql } = deps("text");
    await runPipeline(d, { runId: "run_sim", captureId: "cap_sim", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    const similar = sql.find((q) => q.text.startsWith("SELECT id, title, type, summary, summary_points, tags, serial FROM caphub_v2.capabilities"))!;
    expect(similar.values[2]).toBe("cap_sim");
  });

  it("falls back to the text-based similar search when this capture has no capability row yet (its first run)", async () => {
    const { d, sql } = deps("text", { existingCapability: null });
    await runPipeline(d, { runId: "run_first", captureId: "cap_first", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(sql.some((q) => q.text.startsWith("SELECT id, title, type, summary, summary_points, tags, serial FROM caphub_v2.capabilities"))).toBe(true);
    expect(sql.some((q) => q.text.startsWith("SELECT c.id, c.title, c.type, c.summary, c.summary_points, c.tags, c.serial"))).toBe(false);
  });

  it("falls back to the text-based similar search on a rerun whose capability row has no embedding yet", async () => {
    const { d, sql } = deps("text", { existingCapability: { id: "cab_existing", hasEmbedding: false } });
    await runPipeline(d, { runId: "run_no_embed", captureId: "cap_no_embed", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(sql.some((q) => q.text.startsWith("SELECT id, title, type, summary, summary_points, tags, serial FROM caphub_v2.capabilities"))).toBe(true);
    expect(sql.some((q) => q.text.startsWith("SELECT c.id, c.title, c.type, c.summary, c.summary_points, c.tags, c.serial"))).toBe(false);
  });

  it("uses the vector similar search (not the text one) on a rerun whose capability row already has an embedding", async () => {
    const { d, sql, calls } = deps("text", { existingCapability: { id: "cab_existing", hasEmbedding: true } });
    await runPipeline(d, { runId: "run_embed", captureId: "cap_embed", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    const vectorCall = sql.find((q) => q.text.startsWith("SELECT c.id, c.title, c.type, c.summary, c.summary_points, c.tags, c.serial"));
    expect(vectorCall).toBeDefined();
    expect(vectorCall!.values).toEqual(["cab_existing", 5]);
    expect(sql.some((q) => q.text.startsWith("SELECT id, title, type, summary, summary_points, tags, serial FROM caphub_v2.capabilities"))).toBe(false);
    // Already has its own stored embedding -- no need to also compute a material query embedding.
    expect(calls).not.toContain("embed");
  });

  // Controller ruling (fix round 1): "库里是不是已经有了" must be answerable on a capture's very
  // first analysis run, not only from its second run onward -- a brand-new capture has no
  // capability row (hence no stored embedding) yet, so compute a throwaway *query* embedding of
  // the material itself and use that for candidate lookup instead of falling straight to text
  // search.
  describe("material query embedding for first-run overlap candidates", () => {
    it("uses a freshly computed material embedding for candidates on a capture's first run when the embed provider succeeds", async () => {
      const { d, sql, calls } = deps("text", {
        existingCapability: null,
        embedQueryResult: [1, 0, 0],
        materialEmbeddingSimilar: [{ id: "cab_2", title: "Existing Tool", type: "tool", summary: "一个已有工具", tags: [], serial: 9 }]
      });
      await runPipeline(d, { runId: "run_material_embed", captureId: "cap_material_embed", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
      expect(calls).toContain("embed");
      const vectorCall = sql.find((q) => q.text.includes("<=> $1::vector"));
      expect(vectorCall).toBeDefined();
      expect(vectorCall!.values).toEqual(["[1,0,0]", 5, "cap_material_embed"]);
      // The text-similarity fallback must not also run once the material embedding succeeded.
      expect(sql.some((q) => q.text.includes("to_tsquery"))).toBe(false);
    });

    it("falls back to the text-based similar search when no embed provider/key is configured (the default)", async () => {
      const { d, sql, calls } = deps("text", { existingCapability: null });
      await runPipeline(d, { runId: "run_no_gemini", captureId: "cap_no_gemini", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
      expect(calls).toContain("embed"); // still attempted...
      expect(sql.some((q) => q.text.includes("to_tsquery"))).toBe(true); // ...but falls back
      expect(sql.some((q) => q.text.includes("<=> $1::vector"))).toBe(false);
    });

    it("falls back to the text-based similar search, and the run still completes, when the embed provider throws", async () => {
      const { d, sql, calls } = deps("text", { existingCapability: null, embedQueryThrows: true });
      const out = await runPipeline(d, { runId: "run_embed_throws", captureId: "cap_embed_throws", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
      expect(calls).toContain("embed");
      expect(calls).toContain("reason");
      expect(out.verdict).toBe("keep");
      expect(sql.some((q) => q.text.includes("to_tsquery"))).toBe(true);
    });

    it("logs the embed attempt to stdout instead of recording an analysis_steps row (the CHECK doesn't allow 'embed')", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { d, sql } = deps("text", { existingCapability: null, embedQueryResult: [1, 0, 0] });
      await runPipeline(d, { runId: "run_embed_log", captureId: "cap_embed_log", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ runId: "run_embed_log", step: "embed", ok: true }));
      const stepRows = sql.filter((q) => q.text.includes("INSERT INTO caphub_v2.analysis_steps"));
      expect(stepRows.every((q) => q.values[1] !== "embed")).toBe(true);
      logSpy.mockRestore();
    });

    it("does not count the material embedding call against the analysis run's budget: an image run still fits vision+search+reason in the 4-call cap", async () => {
      // RunBudget's default cap is 4 calls / 200k tokens (see budget.ts). An image analysis
      // already uses 3 budgeted calls (vision, search, reason); if the material embedding call
      // were wrongly routed through `runStructured`/`runSearch` (the only two call sites that
      // touch `budget`), a 4th accounted call would appear here. It must not: the embedding
      // call is invoked directly in `loadSimilar`, never through either of those, so it can
      // never call budget.assertCanCall()/budget.charge() at all.
      const { d, calls } = deps("image", { existingCapability: null, embedQueryResult: [1, 0, 0] });
      const sharp = (await import("sharp")).default;
      const png = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer());
      d.objects = { get: async () => png } as never;
      const out = await runPipeline(d, { runId: "run_embed_budget", captureId: "cap_embed_budget", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(calls).toEqual(["vision", "search", "embed", "reason"]);
      expect(out.verdict).toBe("keep");
    });
  });

  it("passes only the candidates' serial codes into the reason prompt's overlap section, and only those into the schema's valid targets", async () => {
    const { d, reasonPrompt } = deps("text", {
      textSimilar: [{ id: "cab_2", title: "Existing Tool", type: "tool", summary: "一个已有工具", tags: [], serial: 9 }]
    });
    const withOverlap = { ...card, overlap: { relation: "duplicate", target: "TOL-0009", reason: "功能重复" } };
    const { d: d2 } = deps("text", {
      reasonValue: withOverlap,
      textSimilar: [{ id: "cab_2", title: "Existing Tool", type: "tool", summary: "一个已有工具", tags: [], serial: 9 }]
    });
    await runPipeline(d, { runId: "run_overlap_prompt", captureId: "cap_overlap_prompt", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(reasonPrompt()).toContain("TOL-0009");
    const out = await runPipeline(d2, { runId: "run_overlap_ok", captureId: "cap_overlap_ok", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(out.verdict).toBe("keep");
  });

  it("fails the run (invalid output, retried) when the model cites an overlap target outside the candidate list", async () => {
    const badOverlap = { ...card, overlap: { relation: "duplicate", target: "TOL-9999", reason: "功能重复" } };
    const { d, calls } = deps("text", {
      reasonValue: badOverlap,
      textSimilar: [{ id: "cab_2", title: "Existing Tool", type: "tool", summary: "一个已有工具", tags: [], serial: 9 }]
    });
    await expect(
      runPipeline(d, { runId: "run_overlap_bad", captureId: "cap_overlap_bad", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(calls.filter((c) => c === "reason")).toHaveLength(2);
  });

  it("throws CAPTURE_NOT_FOUND with a code when the capture row is missing", async () => {
    const { d } = deps("text");
    d.pool = { query: async () => ({ rows: [] }) } as never;
    await expect(runPipeline(d, { runId: "run_nf", captureId: "cap_nf", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal))
      .rejects.toMatchObject({ code: "CAPTURE_NOT_FOUND" });
  });

  it("skips vision for text", async () => {
    const { d, calls } = deps("text");
    await runPipeline(d, { runId: "run_2", captureId: "cap_2", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["search", "embed", "reason"]);
  });

  it("skips vision for a URL capture and still runs search + reason", async () => {
    const { d, calls } = deps("url");
    const out = await runPipeline(d, { runId: "run_url", captureId: "cap_url", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["search", "embed", "reason"]);
    expect(out).toEqual({ capabilityId: "cab_1", verdict: "keep" });
  });

  it("throws OBJECT_UNAVAILABLE when an image's stored object cannot be read", async () => {
    const { d } = deps("image");
    d.objects = { get: async () => { throw new Error("boom"); } } as never;
    await expect(
      runPipeline(d, { runId: "run_3", captureId: "cap_3", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "OBJECT_UNAVAILABLE" });
  });

  it("does not bump tags when the verdict stays pending", async () => {
    const { d, sql } = deps("text", { reasonValue: pendingCard });
    const out = await runPipeline(d, { runId: "run_pending", captureId: "cap_pending", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(out.verdict).toBe("pending");
    const tagBump = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.tags"));
    expect(tagBump).toBeUndefined();
  });

  it("treats a search failure as non-fatal: reason still runs and the failed step is recorded", async () => {
    const { d, calls, sql } = deps("text");
    d.search = { provider: "tavily", model: "s", search: async () => { calls.push("search"); throw new Error("network down"); } };
    const out = await runPipeline(d, { runId: "run_search_fail", captureId: "cap_search_fail", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["search", "embed", "reason"]);
    expect(out.verdict).toBe("keep");
    const failedStep = sql.find((q) => q.text.includes("caphub_v2.analysis_steps") && q.values[1] === "search" && q.values[8] === false);
    expect(failedStep).toBeDefined();
    expect(failedStep!.values[9]).toBe("UNAVAILABLE");
  });

  it("fails the run with a clear error when no scenarios are configured", async () => {
    const { d } = deps("text");
    const inner = d.pool as unknown as { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };
    d.pool = {
      query: (text: string, values: unknown[] = []) =>
        text.startsWith("SELECT slug, label_zh, label_en, keywords FROM caphub_v2.scenarios")
          ? Promise.resolve({ rows: [] })
          : inner.query(text, values),
      connect: (d.pool as unknown as { connect: () => unknown }).connect
    } as never;
    await expect(
      runPipeline(d, { runId: "run_no_scenarios", captureId: "cap_no_scenarios", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal)
    ).rejects.toThrow(/no scenarios/);
  });

  it("rethrows BUDGET when the search response blows the token budget, without invoking reason", async () => {
    const { d, calls } = deps("text");
    d.search = { provider: "tavily", model: "s", search: async () => { calls.push("search"); return { value: { sources: [] }, usage: { inputTokens: 300_000, outputTokens: 0 } }; } };
    await expect(
      runPipeline(d, { runId: "run_budget", captureId: "cap_budget", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "BUDGET" });
    expect(calls).toEqual(["search"]);
  });

  it("passes a human-pinned type into the reason prompt as a hard constraint", async () => {
    const { d, reasonPrompt } = deps("text", { pinnedType: "experience", reasonValue: experienceCard });
    await runPipeline(d, { runId: "run_pinned", captureId: "cap_pinned", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(reasonPrompt()).toMatch(/硬性约束/);
    expect(reasonPrompt()).toContain("experience");
  });

  it("stores the card with the pinned type when the model complies (enforced at the schema layer)", async () => {
    const { d, sql } = deps("text", { pinnedType: "experience", reasonValue: experienceCard });
    await runPipeline(d, { runId: "run_pinned2", captureId: "cap_pinned2", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
    expect(insert.values).toContain("experience");
    expect(insert.values).not.toContain("prompt");
  });

  // Owner ruling (review fix round 1): the pinned type must be enforced by the schema (a
  // z.literal on `type`, checked together with refineCard's type/playbook coherence rule), not
  // by mutating `card.type` after parsing — a post-hoc swap would let a disobedient model's
  // mismatched playbook (e.g. install-shaped playbook under a forced `experience` type) get
  // silently stored instead of caught. This exercises that a mismatch goes through the
  // existing invalid-output retry path and ultimately fails the run, rather than being stored.
  it("retries and then fails the run when the model returns a type/playbook that disagrees with the pinned type", async () => {
    const { d, calls } = deps("text", { pinnedType: "experience", reasonValue: card }); // card.type is "skill", not "experience"
    await expect(
      runPipeline(d, { runId: "run_pinned_bad", captureId: "cap_pinned_bad", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(calls.filter((c) => c === "reason")).toHaveLength(2); // one attempt + one correction retry
  });

  it("rejects a card that claims the pinned type but keeps a mismatched playbook shape (mismatch caught, not silently stored)", async () => {
    const badPlaybookCard = { ...card, type: "experience" }; // type matches, but playbook is still integrate-shaped
    const { d } = deps("text", { pinnedType: "experience", reasonValue: badPlaybookCard });
    await expect(
      runPipeline(d, { runId: "run_pinned_bad2", captureId: "cap_pinned_bad2", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  it("does not add a pinned-type constraint when no capability is human-typed yet", async () => {
    const { d, reasonPrompt } = deps("text");
    await runPipeline(d, { runId: "run_unpinned", captureId: "cap_unpinned", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(reasonPrompt()).not.toMatch(/硬性约束/);
  });

  describe("verbatim prompts", () => {
    const promptCard = { ...card, type: "prompt", usage: "integrate", playbook: { kind: "integrate", install: [], repo: null } };

    it("stores the text capture's own span for each locator", async () => {
      const src = "前言\n你是助手。\n请逐条回答。\n后记";
      const { d, sql } = deps("text", { sourceText: src, reasonValue: { ...promptCard, prompt_locators: [{ start: "你是助手", end: "请逐条回答。" }] } });
      const out = await runPipeline(d, { runId: "r_p1", captureId: "c_p1", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(out.verdict).toBe("keep");
      const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
      expect(insert.values).toContain(JSON.stringify([{ text: "你是助手。\n请逐条回答。" }]));
      expect(insert.values[24]).toBe(0);
    });

    it("sends the card to review when a locator is not in the source", async () => {
      const { d, sql } = deps("text", { sourceText: "别的内容", reasonValue: { ...promptCard, prompt_locators: [{ start: "不存在", end: "也不存在" }] } });
      const out = await runPipeline(d, { runId: "r_p2", captureId: "c_p2", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(out.verdict).toBe("pending");
      const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
      expect(insert.values[24]).toBe(1);
    });

    it("sends a prompt card with no prompt found to review", async () => {
      const { d } = deps("text", { reasonValue: promptCard });
      const out = await runPipeline(d, { runId: "r_p3", captureId: "c_p3", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(out.verdict).toBe("pending");
    });

    it("stores the vision transcription for an image", async () => {
      const { d, sql } = deps("image", { reasonValue: promptCard, extractionValue: { ...extraction, prompts: ["逐字原文 --s 250"] } });
      const sharp = (await import("sharp")).default;
      const png = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer());
      d.objects = { get: async () => png } as never;
      await runPipeline(d, { runId: "r_p4", captureId: "c_p4", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
      expect(insert.values).toContain(JSON.stringify([{ text: "逐字原文 --s 250" }]));
    });
  });

  describe("video materials", () => {
    it("fetches metadata, runs the video call, and keeps normally", async () => {
      const { d, calls, sql, reasonPrompt, videoInput } = deps("video");
      const out = await runPipeline(d, { runId: "run_video", captureId: "cap_video", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(calls).toEqual(["video", "search", "embed", "reason"]);
      const fetchStep = sql.find((q) => q.text.includes("caphub_v2.analysis_steps") && q.values[1] === "fetch");
      expect(fetchStep).toBeDefined();
      expect(fetchStep!.values[2]).toBe("youtube");
      expect(fetchStep!.values[8]).toBe(true);
      expect(videoInput()).toEqual({ url: "https://www.youtube.com/watch?v=tYvu6IpSfiM" });
      expect(reasonPrompt()).toContain("视频内容提取结果");
      expect(reasonPrompt()).toContain("Jev 实测");
      expect(out.verdict).toBe("keep");
    });

    it("uses the video budget (600k tokens), not the default 200k, to fit a large video call plus reason", async () => {
      const { d, calls } = deps("video");
      d.video = {
        provider: "gemini", model: "gemini-video",
        invoke: async () => { calls.push("video"); return { value: extraction, usage: { inputTokens: 450_000, outputTokens: 1000 } }; }
      };
      const out = await runPipeline(d, { runId: "run_video_budget", captureId: "cap_video_budget", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(calls).toContain("reason");
      expect(out.verdict).toBe("keep");
    });

    it("clips a video over 90 minutes and notes it in the reason prompt", async () => {
      const { d, reasonPrompt, videoInput } = deps("video", { durationIso: "PT2H" });
      await runPipeline(d, { runId: "run_video_clip", captureId: "cap_video_clip", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(videoInput()).toEqual({ url: "https://www.youtube.com/watch?v=tYvu6IpSfiM", endOffsetSec: 5400 });
      expect(reasonPrompt()).toContain("只分析了前 90 分钟");
    });

    it("falls back to a metadata-only, forced-pending analysis when the video call fails with INVALID_OUTPUT", async () => {
      const { d, reasonPrompt } = deps("video", { videoThrows: "INVALID_OUTPUT" });
      const out = await runPipeline(d, { runId: "run_video_fail", captureId: "cap_video_fail", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(reasonPrompt()).toContain("视频内容未能读取");
      expect(out.verdict).toBe("pending");
    });

    it("rethrows BUDGET from the video call and fails the run", async () => {
      const { d } = deps("video", { videoThrows: "BUDGET" });
      await expect(
        runPipeline(d, { runId: "run_video_budget_fail", captureId: "cap_video_budget_fail", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal)
      ).rejects.toMatchObject({ code: "BUDGET" });
    });

    it("skips the video call entirely, but still records the fetch step, when no Gemini key is configured", async () => {
      const { d, calls, sql } = deps("video", { noVideo: true });
      const out = await runPipeline(d, { runId: "run_video_none", captureId: "cap_video_none", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(calls).not.toContain("video");
      expect(sql.some((q) => q.text.includes("caphub_v2.analysis_steps") && q.values[1] === "fetch")).toBe(true);
      expect(out.verdict).toBe("pending");
    });

    it("still calls the video model, marked with '无元数据', when the metadata fetch fails", async () => {
      const { d, calls, sql, reasonPrompt } = deps("video", { meta: null });
      await runPipeline(d, { runId: "run_video_no_meta", captureId: "cap_video_no_meta", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      const fetchStep = sql.find((q) => q.text.includes("caphub_v2.analysis_steps") && q.values[1] === "fetch");
      expect(fetchStep!.values[8]).toBe(false);
      expect(calls).toContain("video");
      expect(reasonPrompt()).toContain("无元数据");
    });

    it("stores the video call's dictated prompts the same way an image's are stored", async () => {
      const { d, sql } = deps("video", { videoValue: { ...extraction, prompts: ["口述 prompt"] } });
      await runPipeline(d, { runId: "run_video_prompt", captureId: "cap_video_prompt", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
      // $24 in the SQL text (1-indexed placeholder) is `values[23]` in the JS array (0-indexed).
      expect(insert.values[23]).toBe(JSON.stringify([{ text: "口述 prompt" }]));
    });
  });
});

describe("createPipelineDeps", () => {
  const baseConfig = {
    databaseUrl: "postgres://x", s3: { endpoint: "https://s3", region: "auto", accessKeyId: "a", secretAccessKey: "b", bucket: "bkt" },
    providers: { minimaxApiKey: "mm", deepseekApiKey: "ds" }, telegram: { enabled: false },
    access: { aud: "aud", teamDomain: "team" }, pipeline: "mixed" as const, verdictAutoThreshold: 0.8,
    analysisEnabled: true, retentionEnabled: true
  };

  it("throws a clear error when pipeline is mixed but no Tavily key is configured", () => {
    expect(() => createPipelineDeps(baseConfig as never, {} as never, {} as never, "mixed")).toThrow(/TAVILY_API_KEY/);
  });

  it("throws a clear error when the MiniMax key is missing", () => {
    const config = { ...baseConfig, providers: { deepseekApiKey: "ds" } };
    expect(() => createPipelineDeps(config as never, {} as never, {} as never, "minimax")).toThrow(/MINIMAX_API_KEY/);
  });

  it("throws a clear error when pipeline is mixed but no DeepSeek key is configured", () => {
    const config = { ...baseConfig, providers: { minimaxApiKey: "mm", tavilyApiKey: "tv" } };
    expect(() => createPipelineDeps(config as never, {} as never, {} as never, "mixed")).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("builds mixed deps when a Tavily key is present", () => {
    const config = { ...baseConfig, providers: { ...baseConfig.providers, tavilyApiKey: "tv" } };
    const out = createPipelineDeps(config as never, {} as never, {} as never, "mixed");
    expect(out.search.provider).toBe("tavily");
    expect(out.reason.provider).toBe("deepseek");
  });

  it("throws a clear error when pipeline is minimax_tavily but no Tavily key is configured", () => {
    expect(() => createPipelineDeps(baseConfig as never, {} as never, {} as never, "minimax_tavily")).toThrow(/TAVILY_API_KEY/);
  });

  it("builds minimax_tavily deps with search = tavily and vision/reason = minimax when a Tavily key is present", () => {
    const config = { ...baseConfig, providers: { minimaxApiKey: "mm", tavilyApiKey: "tv" } };
    const out = createPipelineDeps(config as never, {} as never, {} as never, "minimax_tavily");
    expect(out.search.provider).toBe("tavily");
    expect(out.vision.provider).toBe("minimax");
    expect(out.reason.provider).toBe("minimax");
  });

  it("wires embedQuery to resolve null (never reject) when no Gemini key is configured", async () => {
    const config = { ...baseConfig, providers: { ...baseConfig.providers, tavilyApiKey: "tv" } };
    const out = createPipelineDeps(config as never, {} as never, {} as never, "mixed");
    await expect(out.embedQuery("some material text", new AbortController().signal)).resolves.toBeNull();
  });
});
