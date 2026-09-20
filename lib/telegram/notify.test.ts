import { describe, expect, it } from "vitest";
import { TelegramError } from "./errors";
import { runNotifyTick, type NotifyTickDeps } from "./notify";

const SCENARIO_ROWS = [
  { slug: "coding", label_zh: "编程", label_en: "Coding", keywords: [] },
  { slug: "automation", label_zh: "自动化", label_en: "Automation", keywords: [] }
];

function candidateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cab_1", title: "示例标题", type: "skill", usage: "integrate",
    suggestedVerdict: "keep", suggestedReason: "很实用", summary: "摘要",
    tags: ["rag"], scenarios: ["coding"], serial: 7, verdict: "keep",
    updatedAt: new Date("2026-09-20T00:00:00.000Z"),
    telegramChatId: "1000", telegramMessageId: "500",
    runState: "done", errorCode: null,
    ...overrides
  };
}

function fakePool(candidateRows: Array<Record<string, unknown>>, opts: { throwOn?: (text: string) => boolean } = {}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (opts.throwOn?.(text)) {
      throw Object.assign(new Error("connection terminated"), { code: "57P01" });
    }
    if (text.includes("FROM caphub_v2.capabilities cb")) return { rows: candidateRows };
    if (text.includes("FROM caphub_v2.scenarios")) return { rows: SCENARIO_ROWS };
    if (text.includes("UPDATE caphub_v2.capabilities SET notified_at")) return { rows: [], rowCount: 1 };
    if (text.includes("UPDATE caphub_v2.captures SET telegram_message_id")) return { rows: [], rowCount: 1 };
    return { rows: [] };
  };
  return { calls, pool: { query } as never };
}

function fakeApi(overrides: Partial<NotifyTickDeps["api"]> = {}): NotifyTickDeps["api"] & { edited: unknown[]; sent: unknown[] } {
  const edited: unknown[] = [];
  const sent: unknown[] = [];
  return {
    editMessageText: async (params: never) => { edited.push(params); return true; },
    sendMessage: async (params: never) => { sent.push(params); return { message_id: 777 }; },
    ...overrides,
    edited,
    sent
  } as unknown as NotifyTickDeps["api"] & { edited: unknown[]; sent: unknown[] };
}

describe("runNotifyTick", () => {
  it("is idle when there is nothing to notify", async () => {
    const { pool } = fakePool([]);
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("idle");
  });

  it("edits the stored receipt for an auto-keep card and marks it notified", async () => {
    const { pool, calls } = fakePool([candidateRow()]);
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect(api.edited).toHaveLength(1);
    expect(api.sent).toHaveLength(0);
    const [edit] = api.edited as Array<{ chatId: unknown; messageId: unknown; text: string; replyMarkup?: unknown }>;
    expect(edit.chatId).toBe("1000");
    expect(edit.messageId).toBe(500);
    expect(edit.text).toContain("✅ 已保留 · SKL-0007");
    expect(edit.text).toContain("场景：编程");
    // A keep card carries the 🔬 深度分析 / 去 web row (M3.6 Task 4) — and Telegram keeps whatever keyboard the message already had
    // (e.g. the pending card's 保留/丢弃/重跑分析 row) unless reply_markup is explicitly emptied.
    expect((edit.replyMarkup as { inline_keyboard: Array<Array<{ text?: string }>> }).inline_keyboard.flat().map((b) => b.text)).toEqual(["🔬 深度分析", "🔗 去 web"]);
    const notifyUpdate = calls.find((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"));
    expect(notifyUpdate?.values).toEqual(["cab_1"]);
  });

  it("renders a discard, pending and failed card by status", async () => {
    const rows = [
      candidateRow({ id: "cab_discard", verdict: "discard", runState: "done" }),
      candidateRow({ id: "cab_pending", verdict: "pending", serial: null, runState: "done" }),
      candidateRow({ id: "cab_failed", runState: "failed", errorCode: "TIMEOUT" })
    ];
    const { pool } = fakePool(rows);
    const api = fakeApi();
    await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    const edits = api.edited as Array<{ text: string; replyMarkup?: { inline_keyboard: unknown[] } }>;
    const texts = edits.map((e) => e.text);
    expect(texts.some((t) => t.startsWith("🗑 已丢弃"))).toBe(true);
    expect(texts.some((t) => t.includes("建议：保留"))).toBe(true);
    expect(texts.some((t) => t === "❌ 分析失败 · 模型响应超时")).toBe(true);

    const discard = edits.find((e) => e.text.startsWith("🗑 已丢弃"))!;
    expect(discard.replyMarkup).toEqual({ inline_keyboard: [] });
    // Pending and failed cards keep their real (non-empty) keyboards — only the no-buttons
    // (decided) case should get the buttons-removed override.
    const pending = edits.find((e) => e.text.includes("建议：保留"))!;
    expect(pending.replyMarkup?.inline_keyboard.length).toBeGreaterThan(0);
    const failed = edits.find((e) => e.text === "❌ 分析失败 · 模型响应超时")!;
    expect(failed.replyMarkup?.inline_keyboard.length).toBeGreaterThan(0);
  });

  // Regression (M3.5 walkthrough): this push EDITS the card's stored Telegram message, which for
  // a self-build card may be the `/todo` card the owner is looking at. A failed rerun must not
  // replace it with the bare 分析失败 card — the 进度 line and the progress buttons have to stay.
  it("keeps a self-build card (kept, reference, in progress) as a todo card when its latest run failed, with a failure note", async () => {
    const { pool } = fakePool([
      candidateRow({ id: "cab_todo", verdict: "keep", usage: "reference", progress: "building", runState: "failed", errorCode: "TIMEOUT" })
    ]);
    const api = fakeApi();
    await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    const [edit] = api.edited as Array<{ text: string; replyMarkup?: { inline_keyboard: Array<Array<{ text?: string }>> } }>;
    expect(edit.text).not.toContain("❌ 分析失败");
    expect(edit.text).toContain("进度：自研中");
    expect(edit.text).toContain("上次分析失败：模型响应超时");
    expect(edit.replyMarkup?.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ["🔨 开始自研", "✅ 已完成"], ["🚫 放弃", "🔗 去 web"], ["♻️ 重跑分析"], ["🔬 深度分析"]
    ]);
  });

  it("falls back to sendMessage when there is no stored receipt message id, and records the new id", async () => {
    const { pool, calls } = fakePool([candidateRow({ telegramMessageId: null })]);
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect(api.edited).toHaveLength(0);
    expect(api.sent).toHaveLength(1);
    const recorded = calls.find((c) => c.text.includes("UPDATE caphub_v2.captures SET telegram_message_id"));
    expect(recorded?.values).toEqual(["cab_1", "777"]);
  });

  it("falls back to sendMessage when editing the stored receipt fails (message gone)", async () => {
    const { pool } = fakePool([candidateRow()]);
    const api = fakeApi({ editMessageText: async () => { throw new TelegramError(400, "message to edit not found"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect(api.sent).toHaveLength(1);
  });

  it("skips a card on 429 without marking it notified, and reports 'error'", async () => {
    const { pool, calls } = fakePool([candidateRow()]);
    const api = fakeApi({ editMessageText: async () => { throw new TelegramError(429, "too many requests", 3); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("error");
    expect(api.sent).toHaveLength(0);
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"))).toBe(false);
  });

  it("skips a card on a network error without marking it notified, and reports 'error'", async () => {
    const { pool, calls } = fakePool([candidateRow()]);
    const api = fakeApi({ editMessageText: async () => { throw new TelegramError(0, "request timed out"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("error");
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"))).toBe(false);
  });

  it("treats a 5xx as transient (keeps retrying, does not mark notified)", async () => {
    const { pool, calls } = fakePool([candidateRow()]);
    const api = fakeApi({ editMessageText: async () => { throw new TelegramError(500, "internal server error"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("error");
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"))).toBe(false);
  });

  it("treats an edit failing with 'message is not modified' as a success — no fresh send, no duplicate push", async () => {
    const { pool, calls } = fakePool([candidateRow()]);
    const api = fakeApi({ editMessageText: async () => { throw new TelegramError(400, "Bad Request: message is not modified"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect(api.sent).toHaveLength(0);
    const notifyUpdate = calls.find((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"));
    expect(notifyUpdate?.values).toEqual(["cab_1"]);
  });

  it("retires a card on a permanent (non-429) 4xx send failure — marks it notified without retrying, and logs once with the error code", async () => {
    const { pool, calls } = fakePool([candidateRow({ telegramMessageId: null })]);
    const logs: Record<string, unknown>[] = [];
    const api = fakeApi({ sendMessage: async () => { throw new TelegramError(403, "Forbidden: bot was blocked by the user"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000, log: (o) => logs.push(o) }, new AbortController().signal);
    // No successful push happened, so this is not counted as "notified" — but the card must
    // still be retired (marked notified) so it stops starving newer cards in the batch.
    expect(result).toBe("idle");
    const notifyUpdate = calls.find((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"));
    expect(notifyUpdate?.values).toEqual(["cab_1"]);
    expect(logs.some((l) => l.notify === "send-failed-permanent-retired" && l.capability === "cab_1" && l.code === 403)).toBe(true);
  });

  it("retires a stuck card via the failed-run edit-then-fallback path when the chat itself is gone (400 on both edit and send)", async () => {
    const { pool, calls } = fakePool([candidateRow()]);
    const api = fakeApi({
      editMessageText: async () => { throw new TelegramError(400, "Bad Request: chat not found"); },
      sendMessage: async () => { throw new TelegramError(400, "Bad Request: chat not found"); }
    });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("idle");
    const notifyUpdate = calls.find((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"));
    expect(notifyUpdate?.values).toEqual(["cab_1"]);
  });

  it("treats a 400 'can't parse entities' as a formatting bug, not a delivery failure — leaves notified_at NULL so it's retried instead of silently marked delivered", async () => {
    const { pool, calls } = fakePool([candidateRow({ telegramMessageId: null })]);
    const logs: Record<string, unknown>[] = [];
    const api = fakeApi({ sendMessage: async () => { throw new TelegramError(400, "Bad Request: can't parse entities: Unsupported start tag \"a\" at byte offset 12"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(result).toBe("idle");
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"))).toBe(false);
    expect(logs.some((l) => l.notify === "send-failed-parse-error" && l.capability === "cab_1" && l.code === 400)).toBe(true);
  });

  it("treats a 401 (invalid/revoked bot token) as a tick-level error, not a per-card retirement", async () => {
    const { pool, calls } = fakePool([candidateRow({ telegramMessageId: null })]);
    const logs: Record<string, unknown>[] = [];
    const api = fakeApi({ sendMessage: async () => { throw new TelegramError(401, "Unauthorized"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(result).toBe("error");
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"))).toBe(false);
    expect(logs.some((l) => l.notify === "send-failed-auth" && l.code === 401)).toBe(true);
  });

  it("treats a 403 that isn't 'blocked by the user' as a tick-level auth error too, not a retirement", async () => {
    const { pool, calls } = fakePool([candidateRow({ telegramMessageId: null })]);
    const api = fakeApi({ sendMessage: async () => { throw new TelegramError(403, "Forbidden: bot is not a member of the chat"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("error");
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"))).toBe(false);
  });

  it("still retires (does not treat as a global auth failure) a 403 'blocked by the user' — a per-chat, card-local failure", async () => {
    const { pool, calls } = fakePool([candidateRow({ telegramMessageId: null })]);
    const api = fakeApi({ sendMessage: async () => { throw new TelegramError(403, "Forbidden: bot was blocked by the user"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("idle");
    const notifyUpdate = calls.find((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"));
    expect(notifyUpdate?.values).toEqual(["cab_1"]);
  });

  it("keeps processing the rest of the batch when markNotified throws for one candidate, and reports 'error'", async () => {
    const rows = [candidateRow({ id: "cab_bad" }), candidateRow({ id: "cab_good" })];
    let calls = 0;
    const { pool, calls: queries } = fakePool(rows, {
      throwOn: (text) => {
        if (!text.includes("UPDATE caphub_v2.capabilities SET notified_at")) return false;
        calls += 1;
        return calls === 1; // only the first candidate's write fails
      }
    });
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("error");
    // Both cards were still pushed to Telegram even though marking the first as notified failed.
    expect(api.edited).toHaveLength(2);
    const notifyUpdates = queries.filter((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"));
    expect(notifyUpdates.map((c) => c.values)).toEqual([["cab_bad"], ["cab_good"]]);
  });

  it("keeps processing the rest of the batch when recordMessageId throws for one candidate, and reports 'error'", async () => {
    const rows = [candidateRow({ id: "cab_bad", telegramMessageId: null }), candidateRow({ id: "cab_good" })];
    const { pool, calls: queries } = fakePool(rows, {
      throwOn: (text) => text.includes("UPDATE caphub_v2.captures SET telegram_message_id")
    });
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("error");
    // cab_bad: sendMessage succeeded but recording its message id failed, so it must not be marked notified.
    expect(api.sent).toHaveLength(1);
    expect(api.edited).toHaveLength(1); // cab_good, which has a stored receipt, still went through
    const notifyUpdates = queries.filter((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"));
    expect(notifyUpdates.map((c) => c.values)).toEqual([["cab_good"]]);
  });

  it("selects on stored Telegram ids, not capture source — a web-sourced capture with a recorded receipt is eligible", async () => {
    const { pool, calls } = fakePool([candidateRow()]);
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    const select = calls.find((c) => c.text.includes("FROM caphub_v2.capabilities cb"));
    expect(select?.text).not.toContain("c.source = 'telegram'");
    expect(select?.text).toContain("c.telegram_chat_id IS NOT NULL AND c.telegram_message_id IS NOT NULL");
  });

  it("keeps processing the rest of the batch after one card's formatting throws", async () => {
    const rows = [
      candidateRow({ id: "cab_bad", type: "not-a-real-type" }),
      candidateRow({ id: "cab_good" })
    ];
    const { pool, calls } = fakePool(rows);
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect(api.edited).toHaveLength(1);
    const notifyUpdate = calls.find((c) => c.text.includes("UPDATE caphub_v2.capabilities SET notified_at"));
    expect(notifyUpdate?.values).toEqual(["cab_good"]);
  });
});

// Ruling 1 (Task 7): a capture whose FIRST analysis run failed never gets a capabilities row —
// this second selection branch (keyed on analysis_runs, not capabilities) is how that failure
// still reaches Telegram. The capability branch above is untouched by this.
function captureFailureRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    captureId: "cap_1", runId: "run_1", errorCode: "TIMEOUT",
    updatedAt: new Date("2026-09-20T00:00:00.000Z"),
    telegramChatId: "1000", telegramMessageId: "500",
    ...overrides
  };
}

function fakePoolWithCaptureFailures(
  captureFailureRows: Array<Record<string, unknown>>,
  opts: { throwOn?: (text: string) => boolean } = {}
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (opts.throwOn?.(text)) {
      throw Object.assign(new Error("connection terminated"), { code: "57P01" });
    }
    if (text.includes("FROM caphub_v2.capabilities cb")) return { rows: [] };
    if (text.includes("FROM caphub_v2.captures c") && text.includes("caphub_v2.analysis_runs ar")) {
      return { rows: captureFailureRows };
    }
    if (text.includes("FROM caphub_v2.scenarios")) return { rows: SCENARIO_ROWS };
    if (text.includes("UPDATE caphub_v2.analysis_runs SET notified_at")) return { rows: [], rowCount: 1 };
    if (text.includes("UPDATE caphub_v2.captures SET telegram_message_id")) return { rows: [], rowCount: 1 };
    return { rows: [] };
  };
  return { calls, pool: { query } as never };
}

describe("runNotifyTick — failed-run-with-no-capability branch", () => {
  it("pushes a failed-first-run capture with a rerun-capture button, and marks the run notified", async () => {
    const { pool, calls } = fakePoolWithCaptureFailures([captureFailureRow()]);
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect(api.edited).toHaveLength(1);
    const [edit] = api.edited as Array<{ chatId: unknown; messageId: unknown; text: string; replyMarkup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } }>;
    expect(edit.text).toBe("❌ 分析失败 · 模型响应超时");
    expect(edit.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data).toMatch(/^rc\|cap_1\|/);
    const runNotified = calls.find((c) => c.text.includes("UPDATE caphub_v2.analysis_runs SET notified_at"));
    expect(runNotified?.values).toEqual(["run_1"]);
    const select = calls.find((c) => c.text.includes("caphub_v2.analysis_runs ar"));
    expect(select?.text).not.toContain("c.source = 'telegram'");
    expect(select?.text).toContain("c.telegram_chat_id IS NOT NULL AND c.telegram_message_id IS NOT NULL");
  });

  it("falls back to sendMessage and records the message id against the capture (not a capability)", async () => {
    const { pool, calls } = fakePoolWithCaptureFailures([captureFailureRow({ telegramMessageId: null })]);
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect(api.sent).toHaveLength(1);
    const recorded = calls.find((c) => c.text.includes("UPDATE caphub_v2.captures SET telegram_message_id"));
    expect(recorded?.values).toEqual(["cap_1", "777"]);
  });

  it("processes both branches in the same tick", async () => {
    const capabilityRows = [candidateRow()];
    const captureRows = [captureFailureRow({ captureId: "cap_2", runId: "run_2", telegramMessageId: "501" })];
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const query = async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("FROM caphub_v2.capabilities cb")) return { rows: capabilityRows };
      if (text.includes("FROM caphub_v2.captures c") && text.includes("caphub_v2.analysis_runs ar")) return { rows: captureRows };
      if (text.includes("FROM caphub_v2.scenarios")) return { rows: SCENARIO_ROWS };
      return { rows: [], rowCount: 1 };
    };
    const api = fakeApi();
    const result = await runNotifyTick({ pool: { query } as never, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect(api.edited).toHaveLength(2);
  });

  it("retires a failed-capture push on a permanent 4xx — marks the run notified (analysis_runs.notified_at) without retrying", async () => {
    const { pool, calls } = fakePoolWithCaptureFailures([captureFailureRow({ telegramMessageId: null })]);
    const api = fakeApi({ sendMessage: async () => { throw new TelegramError(400, "Bad Request: chat not found"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("idle");
    const runNotified = calls.find((c) => c.text.includes("UPDATE caphub_v2.analysis_runs SET notified_at"));
    expect(runNotified?.values).toEqual(["run_1"]);
  });

  it("does not mark the run notified on a transient delivery error", async () => {
    const { pool, calls } = fakePoolWithCaptureFailures([captureFailureRow()]);
    const api = fakeApi({ editMessageText: async () => { throw new TelegramError(429, "too many requests", 3); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("error");
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.analysis_runs SET notified_at"))).toBe(false);
  });
});

const DEEP_ANALYSIS = {
  headline: "自托管的浏览器自动化框架",
  architecture: { summary: "三层", points: ["a", "b", "c"] },
  implementation: { summary: "Python", points: ["a", "b", "c"] },
  use_cases: [{ title: "批量抓取", detail: "定时抓取" }, { title: "b", detail: "d" }, { title: "c", detail: "e" }],
  cases: [],
  feedback: { positive: [], negative: [] },
  risks: ["依赖上游浏览器版本", "内存吃紧"],
  sources: [{ title: "文档", url: "https://example.com" }]
};

function deepRunRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runId: "run_deep_1", capabilityId: "cab_1", title: "示例标题",
    state: "done", errorCode: null, deepAnalysis: DEEP_ANALYSIS, telegramChatId: "1000",
    ...overrides
  };
}

function fakePoolWithDeepRuns(deepRows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes("ar.kind = 'deep'")) return { rows: deepRows };
    if (text.includes("UPDATE caphub_v2.analysis_runs SET notified_at")) return { rows: [], rowCount: 1 };
    if (text.includes("FROM caphub_v2.scenarios")) return { rows: SCENARIO_ROWS };
    return { rows: [] };
  };
  return { calls, pool: { query } as never };
}

// Regression (M3.6 fix round 2): the candidate lateral used to take the capture's newest run of
// ANY kind. Deep runs were unreachable before Task 4; once they exist, a failed deep run would
// re-render the card as 「分析失败」 (and put a false 上次分析失败 note on a /todo card), and a
// queued one would hold up a genuinely pending card's push.
describe("runNotifyTick — a deep run is not the card's analysis run", () => {
  it("scopes the latest-run lookup to kind = 'analysis'", async () => {
    const { pool, calls } = fakePool([]);
    await runNotifyTick({ pool, api: fakeApi(), ownerChatId: 1000 }, new AbortController().signal);
    const select = calls.find((c) => c.text.includes(`lr.state AS "runState"`))!;
    expect(select.text).toMatch(/WHERE capture_id = cb\.capture_id AND kind = 'analysis'/);
  });

  it("renders a kept card normally even though its newest deep run failed", async () => {
    // The row the scoped lateral yields: the card's own analysis is 'done'; the failed deep run
    // is invisible to this query.
    const { pool } = fakePool([candidateRow({ verdict: "keep", runState: "done", errorCode: null })]);
    const api = fakeApi();
    await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    const [edit] = api.edited as Array<{ text: string }>;
    expect(edit.text).toContain("✅ 已保留");
    expect(edit.text).not.toContain("分析失败");
  });

  it("does not let a queued deep run hold up a pending card's push", async () => {
    // Same scoping, seen from the other side: the pending card's analysis run is finished, so it
    // is selected and pushed even while a deep run sits queued for the same capture.
    const { pool, calls } = fakePool([candidateRow({ verdict: "pending", serial: null, runState: "done" })]);
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect((api.edited as Array<{ text: string }>)[0]!.text).toContain("建议：保留");
    const select = calls.find((c) => c.text.includes("lr.state IN ('done', 'failed')"))!;
    expect(select.text).toMatch(/kind = 'analysis'/);
  });
});

describe("runNotifyTick — finished deep-analysis runs", () => {
  it("sends a short summary as its own message (never editing the card) and marks the run notified", async () => {
    const { pool, calls } = fakePoolWithDeepRuns([deepRunRow()]);
    const api = fakeApi();
    const result = await runNotifyTick({ pool, api, ownerChatId: 9999 }, new AbortController().signal);
    expect(result).toBe("notified");
    expect(api.edited).toHaveLength(0);
    expect(api.sent).toHaveLength(1);
    const [sent] = api.sent as Array<{ chatId: unknown; text: string }>;
    expect(sent.chatId).toBe("1000");
    expect(sent.text).toContain("🔬 深度分析完成");
    expect(sent.text).toContain("最适合场景：批量抓取");
    expect(sent.text).toContain("最大风险：依赖上游浏览器版本");
    expect(sent.text).toContain("/library/cab_1");
    // A one-glance summary, not the six-section analysis.
    expect(sent.text).not.toContain("三层");
    const notified = calls.find((c) => c.text.includes("UPDATE caphub_v2.analysis_runs SET notified_at"));
    expect(notified?.values).toEqual(["run_deep_1"]);
  });

  it("falls back to the owner chat for a capture with no Telegram receipt (a web-triggered deep run)", async () => {
    const { pool } = fakePoolWithDeepRuns([deepRunRow({ telegramChatId: null })]);
    const api = fakeApi();
    await runNotifyTick({ pool, api, ownerChatId: 9999 }, new AbortController().signal);
    expect((api.sent as Array<{ chatId: unknown }>)[0]!.chatId).toBe(9999);
  });

  it("pushes a failed deep run's reason rather than going silent", async () => {
    const { pool } = fakePoolWithDeepRuns([deepRunRow({ state: "failed", errorCode: "TIMEOUT", deepAnalysis: null })]);
    const api = fakeApi();
    await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect((api.sent as Array<{ text: string }>)[0]!.text).toContain("🔬 深度分析失败 · 模型响应超时");
  });

  it("leaves a transiently-failed push unnotified and reports the tick as an error", async () => {
    const { pool, calls } = fakePoolWithDeepRuns([deepRunRow()]);
    const api = fakeApi({ sendMessage: async () => { throw new TelegramError(429, "Too Many Requests"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    expect(result).toBe("error");
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.analysis_runs SET notified_at"))).toBe(false);
  });

  it("retires a permanently-undeliverable push so it cannot block later runs forever", async () => {
    const { pool, calls } = fakePoolWithDeepRuns([deepRunRow()]);
    const api = fakeApi({ sendMessage: async () => { throw new TelegramError(400, "chat not found"); } });
    const result = await runNotifyTick({ pool, api, ownerChatId: 1000 }, new AbortController().signal);
    // Retired, not delivered: the run stops being re-selected, but the tick doesn't claim a push.
    expect(result).toBe("idle");
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.analysis_runs SET notified_at"))).toBe(true);
  });

  it("selects only finished, unnotified deep runs of still-existing cards, one row per run", async () => {
    const { pool, calls } = fakePoolWithDeepRuns([]);
    await runNotifyTick({ pool, api: fakeApi(), ownerChatId: 1000 }, new AbortController().signal);
    const select = calls.find((c) => c.text.includes("ar.kind = 'deep'"))!;
    expect(select.text).toContain("ar.state IN ('done','failed') AND ar.notified_at IS NULL");
    expect(select.text).toContain("cb.deleted_at IS NULL");
    expect(select.text).not.toContain("DISTINCT ON");
  });
});
