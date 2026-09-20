import { describe, expect, it } from "vitest";
import { handleCapture, publicBaseUrl, type CaptureDeps } from "./capture";
import type { ClassifiedUpdate } from "./router";

function fakePool(existingCapture: { id: string } | null, existingCard: { id: string; title: string } | null) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string) {
      if (text.startsWith("SELECT id FROM caphub_v2.captures")) {
        return { rows: existingCapture ? [existingCapture] : [], rowCount: existingCapture ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const pool = {
    connect: async () => client,
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.startsWith("SELECT id, title FROM caphub_v2.capabilities")) {
        return { rows: existingCard ? [existingCard] : [], rowCount: existingCard ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  return { pool: pool as never, queries };
}

const objects = {
  putIfAbsent: async () => ({ key: "sha256/ab/" + "a".repeat(64), digest: "a".repeat(64), bytes: 1 }),
  putThumbnail: async () => {}
} as never;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);

function fakeApi(overrides: Partial<CaptureDeps["api"]> = {}): CaptureDeps["api"] {
  const sent: Array<{ chatId: number | string; text: string; replyToMessageId?: number }> = [];
  return {
    getFile: async () => ({ file_id: "f1", file_unique_id: "u1", file_path: "photos/f1.jpg" }),
    downloadFile: async () => PNG_BYTES,
    sendMessage: async ({ chatId, text, replyToMessageId }: never) => {
      sent.push({ chatId, text, replyToMessageId });
      return { message_id: 999 };
    },
    ...overrides,
    // expose for assertions
    __sent: sent
  } as unknown as CaptureDeps["api"];
}

function sentOf(api: CaptureDeps["api"]) {
  return (api as unknown as { __sent: Array<{ chatId: number | string; text: string; replyToMessageId?: number }> }).__sent;
}

const imageUpdate: Extract<ClassifiedUpdate, { kind: "image" }> = {
  kind: "image", fileId: "f1", messageId: 10, chatId: 1000
};
const urlUpdate: Extract<ClassifiedUpdate, { kind: "url" }> = {
  kind: "url", url: "https://example.com/x", messageId: 11, chatId: 1000
};
const textUpdate: Extract<ClassifiedUpdate, { kind: "text-capture" }> = {
  kind: "text-capture", text: "hello there", truncated: false, messageId: 12, chatId: 1000
};

describe("handleCapture — image", () => {
  it("downloads, submits and replies, then records the receipt", async () => {
    const { pool, queries } = fakePool(null, null);
    const api = fakeApi();
    const out = await handleCapture({ api, pool, objects, pipeline: "minimax" }, imageUpdate);
    expect(out.kind).toBe("submitted");
    if (out.kind !== "submitted") throw new Error("unreachable");
    expect(out.captureId).toMatch(/^cap_/);
    expect(out.runId).toMatch(/^run_/);

    const sent = sentOf(api);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("已收到，分析中…");
    expect(sent[0]!.chatId).toBe(1000);
    expect(sent[0]!.replyToMessageId).toBe(10);

    const update = queries.find((q) => q.text.startsWith("UPDATE caphub_v2.captures SET telegram_chat_id"));
    expect(update).toBeTruthy();
    expect(update!.values).toEqual([out.captureId, "1000", "999"]);
  });

  it("rejects an oversized file without downloading", async () => {
    const { pool } = fakePool(null, null);
    let downloaded = false;
    const api = fakeApi({
      getFile: async () => ({ file_id: "f1", file_unique_id: "u1", file_path: "photos/f1.jpg", file_size: 11 * 1024 * 1024 }),
      downloadFile: async () => { downloaded = true; return PNG_BYTES; }
    });
    const out = await handleCapture({ api, pool, objects, pipeline: "minimax" }, imageUpdate);
    expect(out).toEqual({ kind: "rejected", reason: "oversized", detail: expect.any(String) });
    expect(downloaded).toBe(false);
    expect(sentOf(api)[0]!.replyToMessageId).toBe(10);
  });

  it("rejects when the download itself reports the file was too large", async () => {
    const { pool } = fakePool(null, null);
    const api = fakeApi({
      downloadFile: async () => { throw new Error("telegram file exceeds max size of 10485760 bytes (got 12000000)"); }
    });
    const out = await handleCapture({ api, pool, objects, pipeline: "minimax" }, imageUpdate);
    expect(out).toEqual({ kind: "rejected", reason: "oversized", detail: expect.any(String) });
  });

  it("rejects on download failure without throwing", async () => {
    const { pool } = fakePool(null, null);
    const api = fakeApi({
      downloadFile: async () => { throw new Error("network error"); }
    });
    const out = await handleCapture({ api, pool, objects, pipeline: "minimax" }, imageUpdate);
    expect(out).toEqual({ kind: "rejected", reason: "download-failed", detail: expect.any(String) });
  });

  it("rejects an unsupported mime (e.g. HEIC) instead of crashing", async () => {
    const { pool } = fakePool(null, null);
    const heicBytes = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    const api = fakeApi({ downloadFile: async () => heicBytes });
    const out = await handleCapture({ api, pool, objects, pipeline: "minimax" }, imageUpdate);
    expect(out).toEqual({ kind: "rejected", reason: "unsupported-mime", detail: expect.any(String) });
    expect(sentOf(api)).toHaveLength(1);
  });
});

describe("handleCapture — url and text", () => {
  it("submits a url capture without downloading anything", async () => {
    const { pool } = fakePool(null, null);
    const api = fakeApi();
    const out = await handleCapture({ api, pool, objects, pipeline: "minimax" }, urlUpdate);
    expect(out.kind).toBe("submitted");
  });

  it("submits a text capture", async () => {
    const { pool } = fakePool(null, null);
    const api = fakeApi();
    const out = await handleCapture({ api, pool, objects, pipeline: "minimax" }, textUpdate);
    expect(out.kind).toBe("submitted");
  });
});

describe("handleCapture — duplicates", () => {
  it("replies with the existing card's title and web link, and does not enqueue", async () => {
    const { pool, queries } = fakePool({ id: "cap_existing" }, { id: "cab_1", title: "Some capability" });
    const api = fakeApi();
    const out = await handleCapture({ api, pool, objects, pipeline: "minimax" }, textUpdate);
    expect(out).toEqual({ kind: "duplicate", captureId: "cap_existing", capabilityId: "cab_1", title: "Some capability" });
    const sent = sentOf(api);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("这条之前投过");
    expect(sent[0]!.text).toContain("Some capability");
    expect(sent[0]!.text).toContain(`${publicBaseUrl()}/library/cab_1`);
    expect(sent[0]!.text).not.toContain("cap_existing");
    expect(queries.some((q) => q.text.startsWith("UPDATE caphub_v2.captures SET telegram_chat_id"))).toBe(false);
  });

  it("replies gracefully when the card has not been built yet", async () => {
    const { pool } = fakePool({ id: "cap_existing" }, null);
    const api = fakeApi();
    const out = await handleCapture({ api, pool, objects, pipeline: "minimax" }, textUpdate);
    expect(out).toEqual({ kind: "duplicate", captureId: "cap_existing", capabilityId: null, title: null });
    expect(sentOf(api)[0]!.text).toContain("这条之前投过");
  });
});

describe("handleCapture — submit failure", () => {
  it("returns a rejected outcome and replies in Chinese instead of throwing", async () => {
    const failingObjects = {
      putIfAbsent: async () => { throw new Error("s3 down"); },
      putThumbnail: async () => {}
    } as never;
    const { pool } = fakePool(null, null);
    const api = fakeApi();
    const out = await handleCapture({ api, pool, objects: failingObjects, pipeline: "minimax" }, imageUpdate);
    expect(out).toEqual({ kind: "rejected", reason: "submit-failed", detail: expect.any(String) });
    expect(sentOf(api)).toHaveLength(1);
  });
});

describe("publicBaseUrl", () => {
  it("falls back to the production domain when unset", () => {
    expect(publicBaseUrl({})).toBe("https://caphub.agentjoey.ai");
  });

  it("reads PUBLIC_BASE_URL and strips a trailing slash", () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://example.com/" })).toBe("https://example.com");
  });
});
