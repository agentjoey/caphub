import { describe, expect, it } from "vitest";
import { findSimilar, similarTokens } from "./similar";

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
    const out = await findSimilar(pool as never, "   ");
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
        return { rows: [{ id: "cab_1", title: "t", tags: ["x"] }] };
      }
    };
    const out = await findSimilar(pool as never, "claude code");
    expect(sql).toContain("to_tsquery('simple', $1)");
    expect(values[0]).toBe("'claude' | 'code'");
    expect(out).toEqual([{ id: "cab_1", title: "t", tags: ["x"] }]);
  });
});
