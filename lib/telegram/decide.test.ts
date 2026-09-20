import { describe, expect, it } from "vitest";
import { handleCallback, type CallbackDecoded, type HandleCallbackDeps } from "./decide";

const SCENARIO_ROWS = [{ slug: "coding", label_zh: "编程", label_en: "Coding", keywords: [] }];
const T = "2026-09-20T00:00:00.000Z";
const T2 = "2026-09-20T00:05:00.000Z";

type QueryHandler = (text: string, values: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined;

function candidateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cab_1", captureId: "cap_1", title: "示例标题", type: "skill", usage: "integrate",
    suggestedVerdict: "keep", suggestedReason: "很实用", summary: "摘要",
    tags: ["rag"], scenarios: ["coding"], serial: null, verdict: "pending",
    updatedAt: new Date(T),
    telegramChatId: "1000", telegramMessageId: "500",
    runState: "done", errorCode: null,
    ...overrides
  };
}

function fakePool(handler: QueryHandler) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const q = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const r = handler(text, values);
    if (r === undefined) throw new Error(`unhandled query: ${text}`);
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
  };
  return {
    calls,
    pool: { query: q, connect: async () => ({ query: q, release: () => {} }) } as never
  };
}

/** Routes the queries `handleCallback` (and the shared `decide`/`requestRerun`/`loadScenarios` it
 * calls) actually issue. `candidate` is what a fresh `loadCandidateById` returns after any
 * mutation the test wants reflected (defaults to the pre-decision row). */
function routedPool(opts: {
  candidate?: Record<string, unknown> | null;
  /** Returned by `loadCandidateById` from the *second* call onward — simulates a reload after a mutation committed. Defaults to `candidate`. */
  candidateAfterMutation?: Record<string, unknown> | null;
  decideRow?: { updated_at: Date; tags: string[]; previous: string } | null;
  decideConflictExists?: boolean;
  rerunCapture?: { kind: string; purged: boolean; active: boolean } | null;
}) {
  const candidate = opts.candidate === undefined ? candidateRow() : opts.candidate;
  const candidateAfter = opts.candidateAfterMutation === undefined ? candidate : opts.candidateAfterMutation;
  let candidateQueryCalls = 0;
  return fakePool((text) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    if (text.includes(`cb.capture_id AS "captureId"`)) {
      candidateQueryCalls += 1;
      const row = candidateQueryCalls === 1 ? candidate : candidateAfter;
      return { rows: row ? [row] : [] };
    }
    if (text.includes("FROM caphub_v2.scenarios")) return { rows: SCENARIO_ROWS };
    if (text.startsWith("SELECT 1 FROM caphub_v2.capabilities")) return { rows: opts.decideConflictExists ? [{ "?column?": 1 }] : [] };
    if (text.startsWith("UPDATE caphub_v2.capabilities cb SET verdict")) {
      return opts.decideRow === undefined ? { rows: [] } : { rows: opts.decideRow ? [opts.decideRow] : [] };
    }
    if (text.includes("INSERT INTO caphub_v2.tags")) return { rows: [] };
    if (text.startsWith("UPDATE caphub_v2.capabilities SET notified_at = NULL")) return { rows: [], rowCount: 1 };
    if (text.startsWith("SELECT c.kind,")) return { rows: opts.rerunCapture ? [opts.rerunCapture] : [] };
    if (text.startsWith("INSERT INTO caphub_v2.analysis_runs")) return { rows: [] };
    return undefined;
  });
}

function fakeApi() {
  const answered: unknown[] = [];
  const edited: unknown[] = [];
  return {
    api: {
      answerCallbackQuery: async (params: never) => { answered.push(params); return true as const; },
      editMessageText: async (params: never) => { edited.push(params); return true as const; }
    },
    answered,
    edited
  };
}

function cb(overrides: Partial<CallbackDecoded> = {}): CallbackDecoded {
  return {
    kind: "callback", action: "keep", capabilityId: "cab_1", updatedAt: T,
    callbackId: "cbq_1", chatId: 1000, messageId: 500,
    ...overrides
  };
}

function deps(pool: unknown, api: HandleCallbackDeps["api"], overrides: Partial<HandleCallbackDeps> = {}): HandleCallbackDeps {
  return { pool: pool as HandleCallbackDeps["pool"], api, ownerChatId: 1000, pipeline: "mixed", ...overrides };
}

describe("handleCallback", () => {
  it("keeps: answers with a keep toast and re-renders the message without buttons", async () => {
    const { pool, calls } = routedPool({
      candidate: candidateRow(),
      candidateAfterMutation: candidateRow({ verdict: "keep", serial: 7, updatedAt: new Date(T2) }),
      decideRow: { updated_at: new Date(T2), tags: ["rag"], previous: "pending" }
    });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "keep" }));

    expect(result).toEqual({ outcome: "decided", action: "keep", capabilityId: "cab_1" });
    expect(answered[0]).toMatchObject({ callbackQueryId: "cbq_1", text: "已保留" });
    expect(edited[0]).toMatchObject({ chatId: 1000, messageId: 500 });
    expect((edited[0] as { replyMarkup?: unknown }).replyMarkup).toEqual({ inline_keyboard: [] });
    expect((edited[0] as { text: string }).text).toContain("已保留");
    expect(calls.some((c) => c.text.startsWith("UPDATE caphub_v2.capabilities cb SET verdict"))).toBe(true);
  });

  it("discards: answers with a discard toast and re-renders", async () => {
    const { pool } = routedPool({
      candidate: candidateRow(),
      candidateAfterMutation: candidateRow({ verdict: "discard", updatedAt: new Date(T2) }),
      decideRow: { updated_at: new Date(T2), tags: ["rag"], previous: "pending" }
    });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "discard" }));

    expect(result).toEqual({ outcome: "decided", action: "discard", capabilityId: "cab_1" });
    expect(answered[0]).toMatchObject({ text: "已丢弃" });
    expect((edited[0] as { text: string }).text).toContain("已丢弃");
    expect((edited[0] as { replyMarkup?: unknown }).replyMarkup).toEqual({ inline_keyboard: [] });
  });

  it("reruns: answers with a requeue toast, edits to the requeue text, and clears notified_at", async () => {
    const { pool, calls } = routedPool({
      candidate: candidateRow(),
      rerunCapture: { kind: "image", purged: false, active: false }
    });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun" }));

    expect(result).toEqual({ outcome: "decided", action: "rerun", capabilityId: "cab_1" });
    expect(answered[0]).toMatchObject({ text: "已重新排队" });
    expect(edited[0]).toMatchObject({ chatId: 1000, messageId: 500, text: "已重新排队，分析中…" });
    expect((edited[0] as { replyMarkup?: unknown }).replyMarkup).toEqual({ inline_keyboard: [] });
    const notifiedUpdate = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET notified_at = NULL"));
    expect(notifiedUpdate?.values).toEqual(["cab_1"]);
  });

  it("reruns: clear-notified-at succeeds on the first retry after an initial failure", async () => {
    let clearAttempts = 0;
    const { pool, calls } = fakePool((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes(`cb.capture_id AS "captureId"`)) return { rows: [candidateRow()] };
      if (text.includes("FROM caphub_v2.scenarios")) return { rows: SCENARIO_ROWS };
      if (text.startsWith("UPDATE caphub_v2.capabilities SET notified_at = NULL")) {
        clearAttempts += 1;
        if (clearAttempts === 1) throw Object.assign(new Error("connection terminated"), { code: "57P01" });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("SELECT c.kind,")) return { rows: [{ kind: "image", purged: false, active: false }] };
      if (text.startsWith("INSERT INTO caphub_v2.analysis_runs")) return { rows: [] };
      return undefined;
    });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun" }));

    expect(result).toEqual({ outcome: "decided", action: "rerun", capabilityId: "cab_1" });
    expect(answered[0]).toMatchObject({ text: "已重新排队" });
    expect(edited[0]).toMatchObject({ text: "已重新排队，分析中…" });
    const clears = calls.filter((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET notified_at = NULL"));
    expect(clears).toHaveLength(2);
  });

  it("reruns: clear-notified-at fails twice — the requeue still happened, but the outcome is 'failed' and the toast tells the user to check the web", async () => {
    const { pool, calls } = fakePool((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes(`cb.capture_id AS "captureId"`)) return { rows: [candidateRow()] };
      if (text.includes("FROM caphub_v2.scenarios")) return { rows: SCENARIO_ROWS };
      if (text.startsWith("UPDATE caphub_v2.capabilities SET notified_at = NULL")) {
        throw Object.assign(new Error("connection terminated"), { code: "57P01" });
      }
      if (text.startsWith("SELECT c.kind,")) return { rows: [{ kind: "image", purged: false, active: false }] };
      if (text.startsWith("INSERT INTO caphub_v2.analysis_runs")) return { rows: [] };
      return undefined;
    });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun" }));

    expect(result).toEqual({ outcome: "failed", reason: "clear-notified-at-failed", capabilityId: "cab_1" });
    // The requeue (analysis_runs insert) and the message edit to the requeue text still happen —
    // only the toast and the reported outcome change, since the eventual result may now never
    // auto-push.
    expect(edited[0]).toMatchObject({ text: "已重新排队，分析中…" });
    expect(answered[0]).toMatchObject({ text: "已重新排队，但结果可能不会自动推送，请去 web 查看" });
    const clears = calls.filter((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET notified_at = NULL"));
    expect(clears).toHaveLength(2); // one attempt plus one retry, both failed
  });

  it("conflict: a stale callback (someone decided elsewhere) gets a toast and the current-state card, no buttons", async () => {
    const { pool } = routedPool({ candidate: candidateRow({ verdict: "keep", updatedAt: new Date(T2) }) });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "keep", updatedAt: T }));

    expect(result).toEqual({ outcome: "conflict", capabilityId: "cab_1" });
    expect(answered[0]).toMatchObject({ text: "已在别处处理" });
    expect((edited[0] as { replyMarkup?: unknown }).replyMarkup).toEqual({ inline_keyboard: [] });
    expect((edited[0] as { text: string }).text).toContain("已保留");
  });

  it("conflict from a DB-level race: decide() itself reports CONFLICT even though the precheck passed", async () => {
    const { pool } = routedPool({ candidate: candidateRow(), decideConflictExists: true, decideRow: null });
    const { api, answered } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "keep" }));

    expect(result).toEqual({ outcome: "conflict", capabilityId: "cab_1" });
    expect(answered[0]).toMatchObject({ text: "已在别处处理" });
  });

  it("object gone: rerun on a purged image gets its own toast and is rejected", async () => {
    const { pool } = routedPool({ candidate: candidateRow(), rerunCapture: { kind: "image", purged: true, active: false } });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun" }));

    expect(result).toEqual({ outcome: "rejected", reason: "object-gone", capabilityId: "cab_1" });
    expect(answered[0]).toMatchObject({ text: "原图已过期，无法重跑" });
    expect(edited).toHaveLength(0);
  });

  it("already queued: a second rerun press is rejected with its own toast", async () => {
    const { pool } = routedPool({ candidate: candidateRow(), rerunCapture: { kind: "image", purged: false, active: true } });
    const { api, answered } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun" }));

    expect(result).toEqual({ outcome: "rejected", reason: "already-queued", capabilityId: "cab_1" });
    expect(answered[0]).toMatchObject({ text: "已在排队或分析中" });
  });

  it("forged callback_data: a capability id that doesn't exist (or was deleted) is rejected without touching the message", async () => {
    const { pool } = routedPool({ candidate: null });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ capabilityId: "cab_ghost" }));

    expect(result).toEqual({ outcome: "rejected", reason: "not-found", capabilityId: "cab_ghost" });
    expect(answered[0]).toMatchObject({ text: "卡片不存在或已删除" });
    expect(edited).toHaveLength(0);
  });

  it("unknown decoded action: rejected with its own toast, never throws", async () => {
    const { pool } = routedPool({ candidate: candidateRow() });
    const { api, answered } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "bogus" as never }));

    expect(result).toEqual({ outcome: "rejected", reason: "unknown-action", capabilityId: "cab_1" });
    expect(answered).toHaveLength(1);
  });

  it("non-owner chat: answered with a neutral toast and nothing else happens (defense in depth)", async () => {
    const { pool, calls } = routedPool({ candidate: candidateRow() });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ chatId: 9999 }));

    expect(result).toEqual({ outcome: "rejected", reason: "not-owner" });
    expect(answered).toHaveLength(1);
    expect(edited).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("never throws: an unexpected DB failure is reported as a failed outcome", async () => {
    const pool = { query: async () => { throw new Error("connection terminated"); } } as never;
    const { api, answered } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb());

    expect(result).toMatchObject({ outcome: "failed", capabilityId: "cab_1" });
    expect(answered).toHaveLength(1);
  });
});

// Ruling 1 (Task 7): "rerun-capture" carries a capture id (not a capability id) — a failed
// FIRST analysis run has no capability row to load or optimistic-lock against.
describe("handleCallback — rerun-capture", () => {
  it("requeues by capture id directly, without loading a candidate", async () => {
    const { pool, calls } = routedPool({ candidate: candidateRow(), rerunCapture: { kind: "image", purged: false, active: false } });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun-capture", capabilityId: "cap_1" }));

    expect(result).toEqual({ outcome: "decided", action: "rerun-capture", capabilityId: "cap_1" });
    expect(answered[0]).toMatchObject({ text: "已重新排队" });
    expect(edited[0]).toMatchObject({ chatId: 1000, messageId: 500, text: "已重新排队，分析中…" });
    expect((edited[0] as { replyMarkup?: unknown }).replyMarkup).toEqual({ inline_keyboard: [] });
    // No candidate lookup (the "cb.capture_id AS captureId" query) and no notified_at clear
    // (there is no capability row to clear it on) — just the rerun insert.
    expect(calls.some((c) => c.text.includes(`cb.capture_id AS "captureId"`))).toBe(false);
    expect(calls.some((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET notified_at = NULL"))).toBe(false);
    expect(calls.some((c) => c.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))).toBe(true);
  });

  it("object gone: a purged capture is rejected with its own toast", async () => {
    const { pool } = routedPool({ rerunCapture: { kind: "image", purged: true, active: false } });
    const { api, answered, edited } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun-capture", capabilityId: "cap_1" }));

    expect(result).toEqual({ outcome: "rejected", reason: "object-gone", capabilityId: "cap_1" });
    expect(answered[0]).toMatchObject({ text: "原图已过期，无法重跑" });
    expect(edited).toHaveLength(0);
  });

  it("already queued: rejected with its own toast", async () => {
    const { pool } = routedPool({ rerunCapture: { kind: "image", purged: false, active: true } });
    const { api, answered } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun-capture", capabilityId: "cap_1" }));

    expect(result).toEqual({ outcome: "rejected", reason: "already-queued", capabilityId: "cap_1" });
    expect(answered[0]).toMatchObject({ text: "已在排队或分析中" });
  });

  it("capture not found: rejected with its own toast", async () => {
    const { pool } = routedPool({ rerunCapture: null });
    const { api, answered } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun-capture", capabilityId: "cap_ghost" }));

    expect(result).toEqual({ outcome: "rejected", reason: "not-found", capabilityId: "cap_ghost" });
    expect(answered).toHaveLength(1);
  });

  it("non-owner chat is still rejected before the rerun-capture branch runs", async () => {
    const { pool, calls } = routedPool({});
    const { api, answered } = fakeApi();
    const result = await handleCallback(deps(pool, api), cb({ action: "rerun-capture", capabilityId: "cap_1", chatId: 9999 }));

    expect(result).toEqual({ outcome: "rejected", reason: "not-owner" });
    expect(answered).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});
