import { describe, expect, it } from "vitest";
import { createPipelineDeps, runPipeline, type PipelineDeps } from "./pipeline";

const card = {
  title: "t", type: "prompt", summary: "s", signals: ["a", "b"], suggested_verdict: "keep", suggested_reason: "r",
  confidence: 0.9, usage: "integrate", playbook: { kind: "integrate", install: [], repo: null, prompt_text: "p" }, tags: ["x"], source_url: null
};
const extraction = { what: "w", visible_text: "", commands: [], prompt_text: null, source_hints: [], questions: [] };

function deps(kind: "image" | "text") {
  const calls: string[] = [];
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      sql.push({ text, values });
      if (text.startsWith("SELECT kind, object_key")) return { rows: [{ kind, object_key: kind === "image" ? "sha256/aa/" + "a".repeat(64) : null, mime_type: "image/png", text: kind === "text" ? "hello" : null, url: null }] };
      if (text.startsWith("SELECT name FROM caphub_v2.tags")) return { rows: [{ name: "x" }] };
      if (text.startsWith("SELECT id, title, tags FROM caphub_v2.capabilities")) return { rows: [] };
      if (text.startsWith("INSERT INTO caphub_v2.capabilities")) return { rows: [{ id: "cab_1", verdict: "keep" }] };
      return { rows: [] };
    }
  };
  const d: PipelineDeps = {
    pool: pool as never,
    objects: { get: async () => new Uint8Array([1]) } as never,
    vision: { provider: "minimax", model: "m", invoke: async () => { calls.push("vision"); return { value: extraction, usage: { inputTokens: 1, outputTokens: 1 } }; } },
    search: { provider: "tavily", model: "s", search: async () => { calls.push("search"); return { value: { sources: [] }, usage: { inputTokens: 0, outputTokens: 0 } }; } },
    reason: { provider: "deepseek", model: "d", invoke: async () => { calls.push("reason"); return { value: card, usage: { inputTokens: 1, outputTokens: 1 } }; } },
    material: { ocr: async () => "" },
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
    const insert = sql.find((q) => q.text.startsWith("INSERT INTO caphub_v2.capabilities"))!;
    expect(insert.values).toContain("auto");
  });
  it("skips vision for text", async () => {
    const { d, calls } = deps("text");
    await runPipeline(d, { runId: "run_2", captureId: "cap_2", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["search", "reason"]);
  });
  it("throws OBJECT_UNAVAILABLE when an image's stored object cannot be read", async () => {
    const { d } = deps("image");
    d.objects = { get: async () => { throw new Error("boom"); } } as never;
    await expect(
      runPipeline(d, { runId: "run_3", captureId: "cap_3", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal)
    ).rejects.toMatchObject({ code: "OBJECT_UNAVAILABLE" });
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
