import { describe, expect, it } from "vitest";
import { bumpTags, topTags } from "./tags";
import { isValidTag } from "./card";

describe("isValidTag", () => {
  it("accepts lowercase alphanumeric tags", () => {
    expect(isValidTag("rag")).toBe(true);
    expect(isValidTag("webdev")).toBe(true);
  });

  it("accepts hyphenated lowercase tags", () => {
    expect(isValidTag("web-scraping")).toBe(true);
    expect(isValidTag("ai-agents")).toBe(true);
  });

  it("rejects Chinese terms", () => {
    expect(isValidTag("金融预测")).toBe(false);
  });

  it("rejects tags with spaces", () => {
    expect(isValidTag("Web Scraping")).toBe(false);
  });

  it("rejects reserved type words", () => {
    expect(isValidTag("skill")).toBe(false);
    expect(isValidTag("experience")).toBe(false);
    expect(isValidTag("plugin")).toBe(false);
    expect(isValidTag("prompt")).toBe(false);
    expect(isValidTag("other")).toBe(false);
  });

  it("rejects reserved playbook words", () => {
    expect(isValidTag("integrate")).toBe(false);
    expect(isValidTag("reference")).toBe(false);
  });

  it("rejects tags with uppercase", () => {
    expect(isValidTag("RAG")).toBe(false);
    expect(isValidTag("Web-Scraping")).toBe(false);
  });

  it("rejects tags with leading/trailing hyphens", () => {
    expect(isValidTag("-rag")).toBe(false);
    expect(isValidTag("rag-")).toBe(false);
  });
});

describe("topTags", () => {
  it("filters out invalid legacy tags and keeps valid ones", async () => {
    const db = {
      query: async () => ({
        rows: [
          { name: "web-scraping" },
          { name: "金融预测" },
          { name: "Web Scraping" },
          { name: "skill" },
          { name: "rag" },
          { name: "ai-agents" }
        ]
      })
    };
    const result = await topTags(db as never);
    expect(result).toEqual(["web-scraping", "rag", "ai-agents"]);
  });

  it("respects the limit after filtering", async () => {
    const db = {
      query: async () => ({
        rows: [
          { name: "tag1" },
          { name: "金融预测" },
          { name: "tag2" },
          { name: "Web Scraping" },
          { name: "tag3" }
        ]
      })
    };
    const result = await topTags(db as never, 2);
    expect(result).toEqual(["tag1", "tag2"]);
  });

  it("drops legacy tags and keeps only valid ones", async () => {
    const db = {
      query: async () => ({
        rows: [
          { name: "金融预测" },
          { name: "web-scraping" },
          { name: "Web Scraping" },
          { name: "skill" }
        ]
      })
    };
    const result = await topTags(db as never, 100);
    expect(result).toEqual(["web-scraping"]);
  });

  it("fetches more rows to account for filtered results", async () => {
    const db = {
      query: async (text: string, values: unknown[]) => {
        expect(values[0]).toBe(200); // Should fetch limit * 2
        return { rows: [{ name: "valid-tag" }] };
      }
    };
    await topTags(db as never, 100);
  });
});

describe("bumpTags", () => {
  it("inserts DISTINCT tag names so ON CONFLICT never touches a row twice", async () => {
    const sql: Array<{ text: string; values: unknown[] }> = [];
    const db = { query: async (text: string, values: unknown[]) => { sql.push({ text, values }); return { rows: [] }; } };
    await bumpTags(db as never, ["rag", "rag"]);
    expect(sql[0].text).toContain("SELECT DISTINCT t, 1 FROM unnest($1::text[]) AS t");
    expect(sql[0].values).toEqual([["rag", "rag"]]);
  });

  it("does nothing for an empty tag list", async () => {
    let called = false;
    await bumpTags({ query: async () => { called = true; return { rows: [] }; } } as never, []);
    expect(called).toBe(false);
  });
});
