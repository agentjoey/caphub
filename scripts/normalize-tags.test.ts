import { describe, expect, it } from "vitest";
import { applyTagNormalization, normalizeTags, runNormalize, TAG_SYNONYMS } from "./normalize-tags";

function fakeRowsPool(rows: Array<Record<string, unknown>>) {
  const updates: unknown[][] = [];
  return {
    pool: {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("SELECT id, title, tags")) return { rows };
        if (text.startsWith("UPDATE caphub_v2.capabilities SET tags")) {
          updates.push(values ?? []);
          return { rows: [] };
        }
        throw new Error(`unhandled query: ${text}`);
      }
    },
    updates
  };
}

const row = { id: "cab_1", title: "t", tags: ["agent-skills", "rag"], type: "skill" as const, serial: 12 };

describe("normalizeTags", () => {
  it("rewrites every known synonym to its canonical form", () => {
    expect(normalizeTags(["agent-skills"])).toEqual(["agent-skill"]);
    expect(normalizeTags(["mcp-server"])).toEqual(["mcp"]);
    expect(normalizeTags(["cli-tool"])).toEqual(["cli"]);
    expect(normalizeTags(["python-library"])).toEqual(["library"]);
    expect(normalizeTags(["libraries"])).toEqual(["library"]);
  });

  it("leaves an already-canonical or unrelated tag untouched", () => {
    expect(normalizeTags(["mcp", "rag", "web-scraping"])).toEqual(["mcp", "rag", "web-scraping"]);
  });

  it("preserves order otherwise, only renaming matched entries in place", () => {
    expect(normalizeTags(["rag", "mcp-server", "web-scraping"])).toEqual(["rag", "mcp", "web-scraping"]);
  });

  it("dedupes when a synonym collides with an already-present canonical tag", () => {
    expect(normalizeTags(["mcp", "mcp-server"])).toEqual(["mcp"]);
  });

  it("only maps the exact set of known synonyms, guessing nothing else", () => {
    expect(Object.keys(TAG_SYNONYMS).sort()).toEqual(
      ["agent-skills", "cli-tool", "libraries", "mcp-server", "python-library"].sort()
    );
  });
});

describe("applyTagNormalization", () => {
  it("updates only tags, leaving updated_at and everything else alone", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: async (text: string, values: unknown[]) => { sql = text; params = values; return { rows: [] }; }
    };
    await applyTagNormalization(pool as never, "cab_1", ["mcp"]);
    expect(sql).toContain("SET tags = $2");
    expect(sql).not.toContain("updated_at");
    expect(params).toEqual(["cab_1", ["mcp"]]);
  });
});

describe("runNormalize", () => {
  const log = () => {};

  it("writes a before/after log line and updates a card whose tags would change, when apply=true", async () => {
    const { pool, updates } = fakeRowsPool([row]);
    const logs: Record<string, unknown>[] = [];
    const result = await runNormalize(pool as never, true, (o) => logs.push(o));
    expect(result).toEqual({
      candidates: 1, changed: 1, unchanged: 0, failed: 0,
      changes: [{ label: "SKL-0012", before: ["agent-skills", "rag"], after: ["agent-skill", "rag"] }]
    });
    expect(updates).toEqual([["cab_1", ["agent-skill", "rag"]]]);
    const changeLog = logs.find((l) => l.capabilityId === "cab_1");
    expect(changeLog).toMatchObject({ before: ["agent-skills", "rag"], after: ["agent-skill", "rag"], applied: true });
  });

  it("does not write when apply=false, even when tags would change", async () => {
    const { pool, updates } = fakeRowsPool([row]);
    const result = await runNormalize(pool as never, false, log);
    expect(result).toEqual({
      candidates: 1, changed: 1, unchanged: 0, failed: 0,
      changes: [{ label: "SKL-0012", before: ["agent-skills", "rag"], after: ["agent-skill", "rag"] }]
    });
    expect(updates).toHaveLength(0);
  });

  it("counts a card as unchanged (not changed, no write) when its tags already are canonical", async () => {
    const { pool, updates } = fakeRowsPool([{ ...row, tags: ["mcp", "rag"] }]);
    const result = await runNormalize(pool as never, true, log);
    expect(result).toEqual({ candidates: 1, changed: 0, unchanged: 1, failed: 0, changes: [] });
    expect(updates).toHaveLength(0);
  });

  it("uses the title as the label when the card has no serial yet", async () => {
    const { pool } = fakeRowsPool([{ ...row, serial: null }]);
    const result = await runNormalize(pool as never, false, log);
    expect(result.changes).toEqual([{ label: "t", before: ["agent-skills", "rag"], after: ["agent-skill", "rag"] }]);
  });

  it("reports the changed/unchanged/failed counts, isolating a per-row failure from the rest", async () => {
    const rows = [row, { ...row, id: "cab_2", tags: ["mcp", "rag"] }];
    const { pool } = fakeRowsPool(rows);
    const originalQuery = pool.query.bind(pool);
    pool.query = async (text: string, values?: unknown[]) => {
      if (text.startsWith("UPDATE caphub_v2.capabilities SET tags") && values?.[0] === "cab_1") {
        throw new Error("db down");
      }
      return originalQuery(text, values);
    };
    const result = await runNormalize(pool as never, true, log);
    expect(result).toEqual({
      candidates: 2, changed: 0, unchanged: 1, failed: 1,
      changes: []
    });
  });
});
