import { describe, expect, it } from "vitest";
import { createPipelineDeps, runPipeline, type PipelineDeps } from "./pipeline";

const card = {
  title: "t", type: "prompt", summary: "s", signals: ["a", "b"], suggested_verdict: "keep", suggested_reason: "r",
  confidence: 0.9, usage: "integrate", playbook: { kind: "integrate", install: [], repo: null, prompt_text: "p" }, tags: ["x"], source_url: null
};
const pendingCard = { ...card, confidence: 0.5 };
const extraction = { what: "w", visible_text: "", commands: [], prompt_text: null, source_hints: [], questions: [] };

type Kind = "image" | "text" | "url";

function deps(kind: Kind, opts: { reasonValue?: unknown } = {}) {
  const calls: string[] = [];
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      sql.push({ text, values });
      if (text.startsWith("SELECT kind, object_key")) {
        return {
          rows: [{
            kind,
            object_key: kind === "image" ? "sha256/aa/" + "a".repeat(64) : null,
            mime_type: "image/png",
            text: kind === "text" ? "hello" : null,
            url: kind === "url" ? "https://example.com/a" : null
          }]
        };
      }
      if (text.startsWith("SELECT name FROM caphub_v2.tags")) return { rows: [{ name: "x" }] };
      if (text.startsWith("SELECT id, title, tags FROM caphub_v2.capabilities")) return { rows: [] };
      if (text.includes("INSERT INTO caphub_v2.capabilities")) {
        // values: [id, captureId, runId, title, type, summary, signals, suggested_verdict,
        //          suggested_reason, confidence, verdict, verdictBy, usage, playbook, tags, source_url]
        const verdict = values[10] as string;
        return { rows: [{ id: "cab_1", verdict, previous_verdict: null, deleted: false }] };
      }
      return { rows: [] };
    }
  };
  const d: PipelineDeps = {
    pool: pool as never,
    objects: { get: async () => new Uint8Array([1]) } as never,
    vision: { provider: "minimax", model: "m", invoke: async () => { calls.push("vision"); return { value: extraction, usage: { inputTokens: 1, outputTokens: 1 } }; } },
    search: { provider: "tavily", model: "s", search: async () => { calls.push("search"); return { value: { sources: [] }, usage: { inputTokens: 0, outputTokens: 0 } }; } },
    reason: { provider: "deepseek", model: "d", invoke: async () => { calls.push("reason"); return { value: opts.reasonValue ?? card, usage: { inputTokens: 1, outputTokens: 1 } }; } },
    material: { ocr: async () => "", fetch: kind === "url" ? (async () => new Response("hello world", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch : undefined },
    threshold: 0.8
  };
  return { d, calls, sql };
}

describe("runPipeline", () => {
  it("runs vision → search → reason for images and stores an auto-kept capability", async () => {
    const { d, calls, sql } = deps("image");
    // sharp 需要真实 PNG：用 1x1 PNG 替换 objects.get
    const sharp = (await import("sharp")).default;
    const png = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer());
    d.objects = { get: async () => png } as never;
    const out = await runPipeline(d, { runId: "run_1", captureId: "cap_1", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["vision", "search", "reason"]);
    expect(out).toEqual({ capabilityId: "cab_1", verdict: "keep" });
    const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
    expect(insert.values).toContain("auto");
    const tagBump = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.tags"));
    expect(tagBump).toBeDefined();
  });

  it("skips vision for text", async () => {
    const { d, calls } = deps("text");
    await runPipeline(d, { runId: "run_2", captureId: "cap_2", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["search", "reason"]);
  });

  it("skips vision for a URL capture and still runs search + reason", async () => {
    const { d, calls } = deps("url");
    const out = await runPipeline(d, { runId: "run_url", captureId: "cap_url", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["search", "reason"]);
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
    expect(calls).toEqual(["search", "reason"]);
    expect(out.verdict).toBe("keep");
    const failedStep = sql.find((q) => q.text.includes("caphub_v2.analysis_steps") && q.values[1] === "search" && q.values[8] === false);
    expect(failedStep).toBeDefined();
    expect(failedStep!.values[9]).toBe("UNAVAILABLE");
  });

  it("rethrows BUDGET when the search response blows the token budget, without invoking reason", async () => {
    const { d, calls } = deps("text");
    d.search = { provider: "tavily", model: "s", search: async () => { calls.push("search"); return { value: { sources: [] }, usage: { inputTokens: 300_000, outputTokens: 0 } }; } };
    await expect(
      runPipeline(d, { runId: "run_budget", captureId: "cap_budget", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "BUDGET" });
    expect(calls).toEqual(["search"]);
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

  it("builds mixed deps when a Tavily key is present", () => {
    const config = { ...baseConfig, providers: { ...baseConfig.providers, tavilyApiKey: "tv" } };
    const out = createPipelineDeps(config as never, {} as never, {} as never, "mixed");
    expect(out.search.provider).toBe("tavily");
    expect(out.reason.provider).toBe("deepseek");
  });
});
