import { describe, expect, it, vi } from "vitest";
import { COMMANDS, handleCommand, PENDING_SHOW_LIMIT, syncCommands, type CommandDeps } from "./commands";

const SCENARIO_ROWS = [{ slug: "coding", label_zh: "写代码", label_en: "Coding", keywords: ["code"] }];

function pendingCard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cab_1",
    captureId: "cap_1",
    title: "grep 用法",
    type: "skill",
    summary: "how to grep",
    signals: [],
    suggestedVerdict: "keep",
    suggestedReason: "useful",
    confidence: 0.9,
    verdict: "pending",
    verdictBy: null,
    usage: "reference",
    playbook: { steps: [] },
    tags: ["cli"],
    sourceUrl: null,
    serial: null,
    scenarios: ["coding"],
    score: null,
    scoreReason: null,
    sourceFacts: {},
    progress: "todo",
    progressLink: null,
    progressAt: null,
    reviewNote: null,
    reviewRequestedAt: null,
    reviewError: null,
    syncedAt: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capture: { kind: "text", objectKey: null, thumbKey: null, text: "grep -r", url: null },
    ...overrides
  };
}

function fakePool(opts: {
  pending?: unknown[];
  pendingTotal?: number;
  typeCounts?: Record<string, number>;
  throwOn?: string;
} = {}) {
  const queries: string[] = [];
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    async query(text: string, values: unknown[] = []) {
      queries.push(text);
      calls.push({ text, values });
      if (opts.throwOn && text.includes(opts.throwOn)) throw new Error("boom");
      if (text.includes("FROM caphub_v2.scenarios")) return { rows: SCENARIO_ROWS };
      if (text.includes("cb.verdict = 'pending'") && text.includes("count(*)")) return { rows: [{ total: String(opts.pendingTotal ?? (opts.pending?.length ?? 0)) }] };
      if (text.includes("cb.verdict = 'pending'")) return { rows: opts.pending ?? [] };
      if (text.startsWith("SELECT type, count(*)::text AS n")) {
        const counts = opts.typeCounts ?? { skill: 3 };
        return { rows: Object.entries(counts).map(([type, n]) => ({ type, n: String(n) })) };
      }
      if (text.includes("count(DISTINCT t)")) return { rows: [{ n: "4" }] };
      if (text.startsWith("SELECT count(*)::text AS n FROM caphub_v2.capabilities WHERE verdict = 'pending'")) {
        return { rows: [{ n: String(opts.pendingTotal ?? (opts.pending?.length ?? 0)) }] };
      }
      if (text.startsWith("UPDATE caphub_v2.captures SET telegram_chat_id")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    }
  };
  return { pool: pool as never, queries, calls };
}

function fakeApi() {
  const sent: Array<{ chatId: number | string; text: string; replyMarkup?: unknown; replyToMessageId?: number }> = [];
  return {
    api: {
      sendMessage: async (p: never) => { sent.push(p); return { message_id: sent.length }; },
      setMyCommands: async () => true as const
    },
    sent
  };
}

const config: CommandDeps["config"] = { providers: {} };
const base = { chatId: 1000, messageId: 5 };

describe("handleCommand", () => {
  it("/help replies with a single-screen usage summary covering every input mode", async () => {
    const { pool } = fakePool();
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "help", arg: "" });
    expect(outcome).toEqual({ kind: "help" });
    expect(sent[0]!.text).toContain("发图");
    expect(sent[0]!.text).toContain("发链接");
    expect(sent[0]!.text).toContain("/add");
    expect(sent[0]!.text).toContain("直接打字");
    expect(sent[0]!.text).toContain("按钮");
  });

  it("/find with no argument replies with usage instead of searching", async () => {
    const { pool } = fakePool();
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "find", arg: "" });
    expect(outcome).toEqual({ kind: "find-usage" });
    expect(sent[0]!.text).toContain("/find");
  });

  it("/find with an argument delegates to handleSearch", async () => {
    const { pool } = fakePool();
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "find", arg: "grep" });
    expect(outcome.kind).toBe("search");
    expect(sent[0]!.text).toContain("没找到");
  });

  it("/add with no argument tells the user the /add usage (capture path handles the real submit)", async () => {
    const { pool } = fakePool();
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "add", arg: "" });
    expect(outcome).toEqual({ kind: "add-usage" });
    expect(sent[0]!.text).toContain("/add");
  });

  it("/pending renders each pending card as its own message reusing formatResult's pending buttons", async () => {
    const { pool } = fakePool({ pending: [pendingCard()] });
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "pending", arg: "" });
    expect(outcome).toEqual({ kind: "pending", shown: 1, total: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("grep 用法");
    expect(sent[0]!.replyMarkup).toMatchObject({
      inline_keyboard: [
        [{ text: "✅ 保留" }, { text: "🗑 丢弃" }],
        [{ text: "♻️ 重跑分析" }, { text: "🔗 去 web" }]
      ]
    });
  });

  it("/pending with none pending replies with a plain message", async () => {
    const { pool } = fakePool({ pending: [] });
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "pending", arg: "" });
    expect(outcome).toEqual({ kind: "pending", shown: 0, total: 0 });
    expect(sent[0]!.text).toContain("没有待处理");
  });

  it("/pending with more than the show limit adds a final web-link message", async () => {
    const items = Array.from({ length: PENDING_SHOW_LIMIT }, (_, i) => pendingCard({ id: `cab_${i}` }));
    const { pool } = fakePool({ pending: items, pendingTotal: PENDING_SHOW_LIMIT + 2 });
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "pending", arg: "" });
    expect(outcome).toEqual({ kind: "pending", shown: PENDING_SHOW_LIMIT, total: PENDING_SHOW_LIMIT + 2 });
    expect(sent).toHaveLength(PENDING_SHOW_LIMIT + 1);
    expect(sent.at(-1)!.text).toContain("还有更多待处理卡片");
    expect(sent.at(-1)!.text).toContain("https://caphub.agentjoey.ai/review");
  });

  it("/pending records a Telegram receipt (chat/message id) against each card's capture, regardless of the capture's source", async () => {
    const items = [pendingCard({ id: "cab_a", captureId: "cap_a" }), pendingCard({ id: "cab_b", captureId: "cap_b" })];
    const { pool, calls } = fakePool({ pending: items });
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "pending", arg: "" });
    expect(outcome).toEqual({ kind: "pending", shown: 2, total: 2 });
    expect(sent).toHaveLength(2);
    const receipts = calls.filter((c) => c.text.startsWith("UPDATE caphub_v2.captures SET telegram_chat_id"));
    expect(receipts).toHaveLength(2);
    expect(receipts[0]!.values).toEqual(["cap_a", "1000", "1"]);
    expect(receipts[1]!.values).toEqual(["cap_b", "1000", "2"]);
  });

  it("/pending still sends every card's message even if recording one card's receipt fails", async () => {
    const items = [pendingCard({ id: "cab_a", captureId: "cap_a" }), pendingCard({ id: "cab_b", captureId: "cap_b" })];
    const { pool } = fakePool({ pending: items, throwOn: "UPDATE caphub_v2.captures SET telegram_chat_id" });
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "pending", arg: "" });
    expect(outcome).toEqual({ kind: "pending", shown: 2, total: 2 });
    expect(sent).toHaveLength(2);
  });

  it("/stats reports per-type counts, tag count and pending count", async () => {
    const { pool } = fakePool({ typeCounts: { skill: 3, plugin: 1 }, pendingTotal: 2 });
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "stats", arg: "" });
    expect(outcome).toEqual({ kind: "stats" });
    expect(sent[0]!.text).toContain("技能：3");
    expect(sent[0]!.text).toContain("插件：1");
    expect(sent[0]!.text).toContain("标签数：4");
    expect(sent[0]!.text).toContain("待 Review：2");
  });

  it("an unknown command replies with a hint pointing at /help", async () => {
    const { pool } = fakePool();
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "wat", arg: "" });
    expect(outcome).toEqual({ kind: "unknown", name: "wat" });
    expect(sent[0]!.text).toContain("/help");
  });

  it("never throws: a DB failure in /stats is caught and replied to", async () => {
    const { pool } = fakePool({ throwOn: "SELECT type, count" });
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "stats", arg: "" });
    expect(outcome.kind).toBe("failed");
    expect(sent[0]!.text).toBe("出了点问题，请稍后重试");
  });

  it("never throws: a DB failure in /pending is caught and replied to", async () => {
    const { pool } = fakePool({ pending: [pendingCard()], throwOn: "FROM caphub_v2.scenarios" });
    const { api, sent } = fakeApi();
    const outcome = await handleCommand({ pool, api, config }, { ...base, name: "pending", arg: "" });
    expect(outcome.kind).toBe("failed");
    expect(sent[0]!.text).toBe("出了点问题，请稍后重试");
  });
});

describe("syncCommands", () => {
  it("calls setMyCommands with the five commands", async () => {
    const setMyCommands = vi.fn(async () => true as const);
    await syncCommands({ setMyCommands });
    expect(setMyCommands).toHaveBeenCalledWith({ commands: COMMANDS });
    expect(COMMANDS.map((c) => c.command)).toEqual(["help", "find", "add", "pending", "stats"]);
  });

  it("logs and does not throw when setMyCommands fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const setMyCommands = vi.fn(async () => { throw new Error("down"); });
    await expect(syncCommands({ setMyCommands })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
