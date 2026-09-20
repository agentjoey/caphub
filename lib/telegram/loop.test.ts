import { describe, expect, it } from "vitest";
import type { CaptureDeps, CaptureUpdate } from "./capture";
import type { CommandDeps, CommandParams } from "./commands";
import type { CallbackDecoded, HandleCallbackDeps } from "./decide";
import { runTelegramTick, type TelegramLoopDeps } from "./loop";
import { encodeDecision } from "./router";
import type { SearchDeps, SearchParams } from "./search";
import type { TelegramUpdate } from "./api";
import { TelegramError } from "./errors";

const OWNER = 1000;

function fakePool(initialOffset?: number) {
  let stored = initialOffset;
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes("SELECT value FROM caphub_v2.telegram_state")) {
      return { rows: stored === undefined ? [] : [{ value: String(stored) }] };
    }
    if (text.includes("INSERT INTO caphub_v2.telegram_state")) {
      stored = Number(values[1]);
      return { rows: [] };
    }
    return { rows: [] };
  };
  return { calls, pool: { query } as never, currentOffset: () => stored };
}

function fakeGetUpdates(batches: TelegramUpdate[][]) {
  const calls: Array<{ offset?: number; timeout: number }> = [];
  let i = 0;
  return {
    calls,
    getUpdates: async (params: { offset?: number; timeout: number }) => {
      calls.push({ offset: params.offset, timeout: params.timeout });
      const batch = batches[i] ?? [];
      i += 1;
      return batch;
    }
  };
}

function baseDeps(overrides: Partial<TelegramLoopDeps> = {}): TelegramLoopDeps {
  return {
    pool: fakePool().pool,
    api: fakeGetUpdates([[]]),
    ownerChatId: OWNER,
    capture: {} as CaptureDeps,
    search: {} as SearchDeps,
    callback: {} as HandleCallbackDeps,
    ...overrides
  };
}

describe("runTelegramTick", () => {
  it("is idle when getUpdates returns nothing", async () => {
    const deps = baseDeps({ minIdleIntervalMs: 0 });
    const result = await runTelegramTick(deps, new AbortController().signal);
    expect(result).toEqual({ kind: "idle" });
  });

  it("reads the persisted offset and passes it to getUpdates", async () => {
    const { pool } = fakePool(42);
    const api = fakeGetUpdates([[]]);
    const result = await runTelegramTick(baseDeps({ pool, api, minIdleIntervalMs: 0 }), new AbortController().signal);
    expect(result).toEqual({ kind: "idle" });
    expect(api.calls[0]).toEqual({ offset: 42, timeout: 25 });
  });

  it("logs and falls back to no offset when the stored value isn't a safe integer", async () => {
    const logs: Record<string, unknown>[] = [];
    const query = async (text: string) => {
      if (text.includes("SELECT value FROM caphub_v2.telegram_state")) return { rows: [{ value: "not-a-number" }] };
      return { rows: [] };
    };
    const api = fakeGetUpdates([[]]);
    const deps = baseDeps({ pool: { query } as never, api, log: (o) => logs.push(o), minIdleIntervalMs: 0 });
    const result = await runTelegramTick(deps, new AbortController().signal);
    expect(result).toEqual({ kind: "idle" });
    expect(api.calls[0]).toEqual({ offset: undefined, timeout: 25 });
    expect(logs.some((l) => l.telegram === "invalid-stored-offset" && l.value === "not-a-number")).toBe(true);
  });

  it("adds a floor delay before returning idle when getUpdates comes back immediately (a proxy ignoring the long-poll timeout)", async () => {
    const api = fakeGetUpdates([[]]); // resolves instantly, unlike a real 25s long poll
    const floorMs = 200;
    const startedAt = Date.now();
    const result = await runTelegramTick(baseDeps({ api, minIdleIntervalMs: floorMs }), new AbortController().signal);
    const elapsed = Date.now() - startedAt;
    expect(result).toEqual({ kind: "idle" });
    expect(elapsed).toBeGreaterThanOrEqual(floorMs - 5); // small tolerance for timer scheduling jitter
  });

  it("routes a mixed batch (image, search text, command, callback) to the matching handler and persists offset after each", async () => {
    const { pool, currentOffset } = fakePool();
    const updates: TelegramUpdate[] = [
      { update_id: 1, message: { message_id: 1, chat: { id: OWNER }, photo: [{ file_id: "f1", width: 10, height: 10 }] } },
      { update_id: 2, message: { message_id: 2, chat: { id: OWNER }, text: "some free text query" } },
      { update_id: 3, message: { message_id: 3, chat: { id: OWNER }, text: "/help" } },
      {
        update_id: 4,
        callback_query: {
          id: "cbq_1",
          data: encodeDecision("keep", "cab_1", "2026-09-20T00:00:00.000Z"),
          message: { message_id: 4, chat: { id: OWNER } }
        }
      }
    ];
    const api = fakeGetUpdates([updates, []]);

    const seen: string[] = [];
    const deps = baseDeps({
      pool,
      api,
      handlers: {
        handleCapture: (async (_deps: CaptureDeps, update: CaptureUpdate) => { seen.push(`capture:${update.kind}`); return { kind: "submitted", captureId: "x", runId: "y" }; }) as never,
        handleSearch: (async (_deps: SearchDeps, params: SearchParams) => { seen.push(`search:${params.query}`); return { kind: "results", total: 1, shown: 1 }; }) as never,
        handleCommand: (async (_deps: CommandDeps, params: CommandParams) => { seen.push(`command:${params.name}`); return { kind: "help" }; }) as never,
        handleCallback: (async (_deps: HandleCallbackDeps, cb: CallbackDecoded) => { seen.push(`callback:${cb.action}`); return { outcome: "decided", action: cb.action, capabilityId: cb.capabilityId }; }) as never
      }
    });

    const result = await runTelegramTick(deps, new AbortController().signal);
    expect(result).toEqual({ kind: "processed", count: 4 });
    expect(seen).toEqual(["capture:image", "search:some free text query", "command:help", "callback:keep"]);
    expect(currentOffset()).toBe(5);
  });

  it("ignores an update outside the owner chat, still advances the offset, and calls no handler", async () => {
    const { pool, currentOffset } = fakePool();
    const updates: TelegramUpdate[] = [
      { update_id: 10, message: { message_id: 1, chat: { id: 9999 }, text: "hi" } }
    ];
    const api = fakeGetUpdates([updates, []]);
    let calledAny = false;
    const deps = baseDeps({
      pool,
      api,
      handlers: {
        handleCapture: (async () => { calledAny = true; return {} as never; }) as never,
        handleSearch: (async () => { calledAny = true; return {} as never; }) as never,
        handleCommand: (async () => { calledAny = true; return {} as never; }) as never,
        handleCallback: (async () => { calledAny = true; return {} as never; }) as never
      }
    });
    const result = await runTelegramTick(deps, new AbortController().signal);
    expect(result).toEqual({ kind: "processed", count: 1 });
    expect(calledAny).toBe(false);
    expect(currentOffset()).toBe(11);
  });

  it("counts ignored updates by reason and logs the counts once per tick (not once per update)", async () => {
    const { pool, currentOffset } = fakePool();
    const updates: TelegramUpdate[] = [
      { update_id: 30, message: { message_id: 1, chat: { id: 9999 }, text: "hi" } }, // not-owner
      { update_id: 31, message: { message_id: 2, chat: { id: 9999 }, text: "hi again" } }, // not-owner
      { update_id: 32, message: { message_id: 3, chat: { id: OWNER }, sticker: {} } }, // unsupported
      { update_id: 33, message: { message_id: 4, chat: { id: OWNER }, text: "/help" } } // not ignored
    ];
    const api = fakeGetUpdates([updates, []]);
    const logs: Record<string, unknown>[] = [];
    const deps = baseDeps({
      pool,
      api,
      log: (o) => logs.push(o),
      handlers: { handleCommand: (async () => ({ kind: "help" })) as never }
    });
    const result = await runTelegramTick(deps, new AbortController().signal);
    expect(result).toEqual({ kind: "processed", count: 4 });
    expect(currentOffset()).toBe(34);
    const ignoredLogs = logs.filter((l) => l.telegram === "ignored");
    expect(ignoredLogs).toHaveLength(1);
    expect(ignoredLogs[0]!.counts).toEqual({ "not-owner": 2, unsupported: 1 });
  });

  it("logs nothing about ignored updates when there are none", async () => {
    const { pool } = fakePool();
    const updates: TelegramUpdate[] = [{ update_id: 40, message: { message_id: 1, chat: { id: OWNER }, text: "/help" } }];
    const api = fakeGetUpdates([updates, []]);
    const logs: Record<string, unknown>[] = [];
    const deps = baseDeps({ pool, api, log: (o) => logs.push(o), handlers: { handleCommand: (async () => ({ kind: "help" })) as never } });
    await runTelegramTick(deps, new AbortController().signal);
    expect(logs.some((l) => l.telegram === "ignored")).toBe(false);
  });

  it("a poison update (handler throws) is logged and the offset still advances, other updates in the batch still process", async () => {
    const { pool, currentOffset } = fakePool();
    const updates: TelegramUpdate[] = [
      { update_id: 20, message: { message_id: 1, chat: { id: OWNER }, text: "will explode" } },
      { update_id: 21, message: { message_id: 2, chat: { id: OWNER }, text: "fine query" } }
    ];
    const api = fakeGetUpdates([updates, []]);
    const logs: Record<string, unknown>[] = [];
    let secondCalled = false;
    const deps = baseDeps({
      pool,
      api,
      log: (o) => logs.push(o),
      handlers: {
        handleSearch: (async (_deps: SearchDeps, params: SearchParams) => {
          if (params.query === "will explode") throw new Error("boom");
          secondCalled = true;
          return { kind: "results", total: 1, shown: 1 };
        }) as never
      }
    });
    const result = await runTelegramTick(deps, new AbortController().signal);
    expect(result).toEqual({ kind: "processed", count: 2 });
    expect(secondCalled).toBe(true);
    expect(currentOffset()).toBe(22);
    expect(logs.some((l) => l.telegram === "dispatch-failed" && l.updateId === 20)).toBe(true);
  });

  it("never throws when getUpdates itself fails", async () => {
    const { pool } = fakePool();
    const api = { getUpdates: async () => { throw new Error("network error"); } };
    const result = await runTelegramTick(baseDeps({ pool, api }), new AbortController().signal);
    expect(result).toEqual({ kind: "error", reason: "get-updates-failed" });
  });

  it("surfaces a 429's retry_after (in ms) so the caller can back off by exactly that long", async () => {
    const { pool } = fakePool();
    const api = { getUpdates: async () => { throw new TelegramError(429, "too many requests", 3); } };
    const result = await runTelegramTick(baseDeps({ pool, api }), new AbortController().signal);
    expect(result).toEqual({ kind: "error", reason: "get-updates-failed", retryAfterMs: 3_000 });
  });

  it("returns idle immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const api = fakeGetUpdates([[{ update_id: 1, message: { message_id: 1, chat: { id: OWNER }, text: "x" } }]]);
    const result = await runTelegramTick(baseDeps({ api }), controller.signal);
    expect(result).toEqual({ kind: "idle" });
    expect(api.calls).toHaveLength(0);
  });
});
