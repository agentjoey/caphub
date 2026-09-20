import { describe, expect, it } from "vitest";
import { findSimilar, similarByEmbedding, similarTokens } from "./similar";

describe("similarTokens", () => {
  it("splits ASCII text into lowercase word tokens, capped at 8, deduped", () => {
    expect(similarTokens("Claude Code hooks and Claude skills")).toEqual(["claude", "code", "hooks", "and", "skills"]);
    expect(similarTokens("one two three four five six seven eight nine ten")).toHaveLength(8);
  });

  it("keeps CJK runs as tokens and adds a 4-char prefix for long runs", () => {
    expect(similarTokens("个人 agent 能力库整理工具")).toEqual(["个人", "agent", "能力库整理工具", "能力库整"]);
  });

  it("strips tsquery metacharacters, treating them as word boundaries and dropping resulting single-char tokens", () => {
    expect(similarTokens("a&b|c!d(e):f*g'h")).toEqual([]);
    expect(similarTokens("foo&bar (baz)")).toEqual(["foo", "bar", "baz"]);
  });

  it("returns an empty list for empty or whitespace-only input", () => {
    expect(similarTokens("")).toEqual([]);
    expect(similarTokens("   ")).toEqual([]);
    expect(similarTokens("a")).toEqual([]);
  });
});

describe("findSimilar", () => {
  it("returns [] without querying when no tokens can be extracted", async () => {
    let called = false;
    const pool = { query: async () => { called = true; return { rows: [] }; } };
    const out = await findSimilar(pool as never, "   ", "cap_self");
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("builds an OR'd to_tsquery expression from the extracted tokens", async () => {
    let sql = "";
    let values: unknown[] = [];
    const pool = {
      query: async (text: string, v: unknown[]) => {
        sql = text;
        values = v;
        return { rows: [{ id: "cab_1", title: "t", type: "tool", summary: "一个已有工具", tags: ["x"], serial: 9 }] };
      }
    };
    const out = await findSimilar(pool as never, "claude code", "cap_self");
    expect(sql).toContain("to_tsquery('simple', $1)");
    expect(values[0]).toBe("'claude' | 'code'");
    expect(out).toEqual([{ id: "cab_1", code: "TOL-0009", title: "t", type: "tool", summary: "一个已有工具", tags: ["x"] }]);
  });

  it("excludes the capture being analysed", async () => {
    let sql = "";
    let values: unknown[] = [];
    const pool = { query: async (text: string, v: unknown[]) => { sql = text; values = v; return { rows: [] }; } };
    await findSimilar(pool as never, "claude code", "cap_self");
    expect(sql).toContain("capture_id <> $3");
    expect(values[2]).toBe("cap_self");
  });

  it("only looks at kept, active, non-deleted cards", async () => {
    let sql = "";
    const pool = { query: async (text: string) => { sql = text; return { rows: [] }; } };
    await findSimilar(pool as never, "claude code", "cap_self");
    expect(sql).toContain("verdict = 'keep'");
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).toContain("status = 'active'");
  });

  it("truncates a long summary to a one-line blurb with an ellipsis", async () => {
    const longSummary = "一".repeat(80);
    const pool = { query: async () => ({ rows: [{ id: "cab_1", title: "t", type: "skill", summary: longSummary, tags: [], serial: null }] }) };
    const [out] = await findSimilar(pool as never, "claude code", "cap_self");
    expect(out.summary).toBe(`${"一".repeat(60)}…`);
    expect(out.code).toBeNull();
  });
});

describe("similarByEmbedding", () => {
  it("compares entirely in SQL via a self-referencing join, never pulling the embedding value into JS", async () => {
    let sql = "";
    let values: unknown[] = [];
    const pool = {
      query: async (text: string, v: unknown[]) => {
        sql = text;
        values = v;
        return { rows: [{ id: "cab_2", title: "Existing Tool", type: "tool", summary: "一个已有工具", tags: ["cli"], serial: 9 }] };
      }
    };
    const out = await similarByEmbedding(pool as never, { capabilityId: "cab_self" });
    expect(sql).toContain("self.id = $1");
    expect(sql).toContain("self.embedding IS NOT NULL");
    expect(sql).toContain("c.id <> $1");
    expect(sql).toContain("ORDER BY c.embedding <=> self.embedding");
    expect(values).toEqual(["cab_self", 5]);
    expect(out).toEqual([{ id: "cab_2", code: "TOL-0009", title: "Existing Tool", type: "tool", summary: "一个已有工具", tags: ["cli"] }]);
  });

  it("only looks at kept, active, non-deleted, embedded cards", async () => {
    let sql = "";
    const pool = { query: async (text: string) => { sql = text; return { rows: [] }; } };
    await similarByEmbedding(pool as never, { capabilityId: "cab_self" });
    expect(sql).toContain("c.verdict = 'keep'");
    expect(sql).toContain("c.deleted_at IS NULL");
    expect(sql).toContain("c.status = 'active'");
    expect(sql).toContain("c.embedding IS NOT NULL");
  });

  it("respects a custom limit", async () => {
    let values: unknown[] = [];
    const pool = { query: async (_text: string, v: unknown[]) => { values = v; return { rows: [] }; } };
    await similarByEmbedding(pool as never, { capabilityId: "cab_self", limit: 3 });
    expect(values).toEqual(["cab_self", 3]);
  });
});
