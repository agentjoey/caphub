import { describe, expect, it } from "vitest";
import { handleSearch, SEARCH_RESULT_LIMIT, type SearchDeps } from "./search";

const SCENARIO_ROWS = [{ slug: "coding", label_zh: "写代码", label_en: "Coding", keywords: ["code"] }];

function card(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cab_1",
    title: "grep 用法",
    type: "skill",
    verdict: "keep",
    serial: 7,
    scenarios: ["coding"],
    ...overrides
  };
}

/**
 * Dispatches by SQL prefix: scenarios select → SCENARIO_ROWS; the `listLibrary` items query →
 * `items`; its count query → `{ total }`. `listLibrary` always issues exactly one items query
 * then one count query (see lib/library/queries.ts `paged`), so matching on statement shape is
 * enough — no need to track call order.
 */
function fakePool(items: unknown[], total: number, opts: { throwOn?: string } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (opts.throwOn && text.includes(opts.throwOn)) throw new Error("boom");
      if (text.includes("FROM caphub_v2.scenarios")) return { rows: SCENARIO_ROWS };
      if (text.includes("count(*)::text AS total FROM caphub_v2.capabilities")) return { rows: [{ total: String(total) }] };
      return { rows: items };
    }
  };
  return { pool: pool as never, queries };
}

function fakeApi() {
  const sent: Array<{ chatId: number | string; text: string; replyToMessageId?: number }> = [];
  return {
    api: { sendMessage: async (p: { chatId: number | string; text: string; replyToMessageId?: number }) => { sent.push(p); return { message_id: 1 }; } },
    sent
  };
}

const config: SearchDeps["config"] = { providers: {} };
const params = { chatId: 1000, messageId: 5, query: "grep" };

describe("handleSearch", () => {
  it("a serial-shaped query resolves to that one card", async () => {
    const { pool } = fakePool([card()], 1);
    const { api, sent } = fakeApi();
    const outcome = await handleSearch({ pool, api, config }, { ...params, query: "SKL-0007" });
    expect(outcome).toEqual({ kind: "results", total: 1, shown: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(1000);
    expect(sent[0]!.replyToMessageId).toBe(5);
    expect(sent[0]!.text).toBe('SKL-0007 · <a href="https://caphub.agentjoey.ai/library/cab_1">grep 用法</a> · 技能 · 写代码');
  });

  it("a free-text query lists up to 5 hybrid-search hits with 编号 · 标题(链接) · 类型 · 场景, the title linked instead of a raw URL", async () => {
    const { pool } = fakePool([card()], 1);
    const { api, sent } = fakeApi();
    const outcome = await handleSearch({ pool, api, config }, params);
    expect(outcome).toEqual({ kind: "results", total: 1, shown: 1 });
    expect(sent[0]!.text).toContain('SKL-0007 · <a href="https://caphub.agentjoey.ai/library/cab_1">grep 用法</a> · 技能 · 写代码');
  });

  it("caps at SEARCH_RESULT_LIMIT and adds a web link when more results exist", async () => {
    const items = Array.from({ length: SEARCH_RESULT_LIMIT }, (_, i) => card({ id: `cab_${i}`, serial: i }));
    const { pool } = fakePool(items, SEARCH_RESULT_LIMIT + 3);
    const { api, sent } = fakeApi();
    const outcome = await handleSearch({ pool, api, config }, params);
    expect(outcome).toEqual({ kind: "results", total: SEARCH_RESULT_LIMIT + 3, shown: SEARCH_RESULT_LIMIT });
    const lines = sent[0]!.text.split("\n");
    expect(lines).toHaveLength(SEARCH_RESULT_LIMIT + 1);
    expect(lines.at(-1)).toContain("还有更多结果，去 web 看看");
    expect(lines.at(-1)).toContain("https://caphub.agentjoey.ai/library?q=grep");
  });

  it("no results → the standard 没找到 reply with a web link", async () => {
    const { pool } = fakePool([], 0);
    const { api, sent } = fakeApi();
    const outcome = await handleSearch({ pool, api, config }, params);
    expect(outcome).toEqual({ kind: "empty" });
    expect(sent[0]!.text).toContain("没找到，换个词试试，或者去 web 看看");
    expect(sent[0]!.text).toContain("https://caphub.agentjoey.ai/library");
  });

  it("escapes every card-derived field", async () => {
    const { pool } = fakePool([card({ title: "<b>x</b> & y" })], 1);
    const { api, sent } = fakeApi();
    await handleSearch({ pool, api, config }, params);
    expect(sent[0]!.text).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
    expect(sent[0]!.text).not.toContain("<b>x</b>");
  });

  it("a card with no serial shows a placeholder instead of an internal id", async () => {
    const { pool } = fakePool([card({ verdict: "pending", serial: null })], 1);
    const { api, sent } = fakeApi();
    await handleSearch({ pool, api, config }, params);
    // The internal id only ever appears inside the link's href, never as standalone text.
    expect(sent[0]!.text.startsWith('- · <a href="https://caphub.agentjoey.ai/library/cab_1">grep 用法</a>')).toBe(true);
    const withoutHref = sent[0]!.text.replace(/https:\/\/\S+/g, "");
    expect(withoutHref).not.toContain("cab_1");
  });

  it("degrades to non-semantic search when no embedding key is configured (never throws)", async () => {
    const { pool } = fakePool([card()], 1);
    const { api } = fakeApi();
    const outcome = await handleSearch({ pool, api, config: { providers: {} } }, params);
    expect(outcome.kind).toBe("results");
  });

  it("never throws: a DB failure is caught, replied to, and returned as a typed outcome", async () => {
    const { pool } = fakePool([card()], 1, { throwOn: "FROM caphub_v2.scenarios" });
    const { api, sent } = fakeApi();
    const outcome = await handleSearch({ pool, api, config }, params);
    expect(outcome.kind).toBe("failed");
    expect(sent[0]!.text).toBe("搜索出错了，请稍后重试");
  });
});
