import { describe, expect, it } from "vitest";
import {
  CALLBACK_DATA_MAX_BYTES,
  CAPTURE_TEXT_MAX_LEN,
  SEARCH_QUERY_MAX_LEN,
  classifyUpdate,
  decodeDecision,
  encodeDecision,
  type RouterUpdate
} from "./router";

const OWNER = 1000;
const OTHER = 2000;

function textUpdate(text: string, extra: Partial<RouterUpdate["message"]> = {}, chatId = OWNER): RouterUpdate {
  return {
    update_id: 1,
    message: { message_id: 1, chat: { id: chatId }, text, ...extra }
  };
}

describe("classifyUpdate — ownership", () => {
  it("ignores updates from a non-owner chat", () => {
    const result = classifyUpdate(textUpdate("hello", {}, OTHER), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "ignored", reason: "not-owner" });
  });

  it("ignores updates with no message or callback_query", () => {
    const result = classifyUpdate({ update_id: 1 }, { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "ignored", reason: "unsupported" });
  });
});

describe("classifyUpdate — image capture", () => {
  it("takes the largest photo size and carries the caption", () => {
    const update: RouterUpdate = {
      update_id: 1,
      message: {
        message_id: 5,
        chat: { id: OWNER },
        caption: "a cool tool",
        photo: [
          { file_id: "small", width: 100, height: 100 },
          { file_id: "big", width: 800, height: 800 },
          { file_id: "medium", width: 400, height: 400 }
        ]
      }
    };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({
      kind: "image",
      fileId: "big",
      messageId: 5,
      chatId: OWNER,
      caption: "a cool tool"
    });
  });

  it("treats an image/* document as an image capture", () => {
    const update: RouterUpdate = {
      update_id: 1,
      message: { message_id: 6, chat: { id: OWNER }, document: { file_id: "doc1", mime_type: "image/png" } }
    };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({
      kind: "image",
      fileId: "doc1",
      messageId: 6,
      chatId: OWNER
    });
  });

  it("does not treat a caption starting with / as a command", () => {
    const update: RouterUpdate = {
      update_id: 1,
      message: { message_id: 7, chat: { id: OWNER }, caption: "/add ignore me", photo: [{ file_id: "p1", width: 10, height: 10 }] }
    };
    const result = classifyUpdate(update, { ownerChatId: OWNER });
    expect(result.kind).toBe("image");
  });

  it("ignores a non-image document", () => {
    const update: RouterUpdate = {
      update_id: 1,
      message: { message_id: 8, chat: { id: OWNER }, document: { file_id: "doc2", mime_type: "application/pdf" } }
    };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "unsupported" });
  });
});

describe("classifyUpdate — unsupported message kinds", () => {
  it.each([
    ["sticker", { sticker: {} }],
    ["voice", { voice: {} }],
    ["video", { video: {} }],
    ["location", { location: {} }]
  ])("ignores %s messages", (_label, extra) => {
    const update: RouterUpdate = { update_id: 1, message: { message_id: 1, chat: { id: OWNER }, ...extra } };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "unsupported" });
  });

  it("ignores empty text", () => {
    expect(classifyUpdate(textUpdate("   "), { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "unsupported" });
  });

  it("ignores a message with no recognizable content", () => {
    const update: RouterUpdate = { update_id: 1, message: { message_id: 1, chat: { id: OWNER } } };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "unsupported" });
  });
});

describe("classifyUpdate — url capture", () => {
  it("classifies plain http(s) URLs as url capture", () => {
    const result = classifyUpdate(textUpdate("https://example.com/page"), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "url", url: "https://example.com/page", messageId: 1, chatId: OWNER });
  });

  it("does not treat text containing a URL plus other words as a url capture", () => {
    const result = classifyUpdate(textUpdate("check out https://example.com please"), { ownerChatId: OWNER });
    expect(result.kind).toBe("search");
  });
});

describe("classifyUpdate — /add text capture", () => {
  it("captures the argument text", () => {
    const result = classifyUpdate(textUpdate("/add remember this trick"), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "text-capture", text: "remember this trick", truncated: false, messageId: 1, chatId: OWNER });
  });

  it("captures the replied-to message's text when /add has no argument", () => {
    const update: RouterUpdate = {
      update_id: 1,
      message: {
        message_id: 2,
        chat: { id: OWNER },
        text: "/add",
        reply_to_message: { message_id: 1, chat: { id: OWNER }, text: "this is the original tip" }
      }
    };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({
      kind: "text-capture",
      text: "this is the original tip",
      truncated: false,
      messageId: 2,
      chatId: OWNER
    });
  });

  it("falls back to the replied-to message's caption when it has no text", () => {
    const update: RouterUpdate = {
      update_id: 1,
      message: {
        message_id: 2,
        chat: { id: OWNER },
        text: "/add",
        reply_to_message: { message_id: 1, chat: { id: OWNER }, caption: "captioned tip" }
      }
    };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({
      kind: "text-capture",
      text: "captioned tip",
      truncated: false,
      messageId: 2,
      chatId: OWNER
    });
  });

  it("treats bare /add with no argument and no reply as a plain command", () => {
    const result = classifyUpdate(textUpdate("/add"), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "command", name: "add", arg: "", messageId: 1, chatId: OWNER });
  });

  it("supports /add@BotName addressing", () => {
    const result = classifyUpdate(textUpdate("/add@MyCapHubBot hello there"), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "text-capture", text: "hello there", truncated: false, messageId: 1, chatId: OWNER });
  });

  it("truncates long capture text and flags it", () => {
    const long = "x".repeat(CAPTURE_TEXT_MAX_LEN + 500);
    const result = classifyUpdate(textUpdate(`/add ${long}`), { ownerChatId: OWNER });
    expect(result.kind).toBe("text-capture");
    if (result.kind === "text-capture") {
      expect(result.text).toHaveLength(CAPTURE_TEXT_MAX_LEN);
      expect(result.truncated).toBe(true);
    }
  });
});

describe("classifyUpdate — /find search and generic commands", () => {
  it("classifies /find with an argument as search", () => {
    const result = classifyUpdate(textUpdate("/find deploy scripts"), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "search", query: "deploy scripts", truncated: false, messageId: 1, chatId: OWNER });
  });

  it("treats bare /find with no argument as a plain command", () => {
    const result = classifyUpdate(textUpdate("/find"), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "command", name: "find", arg: "", messageId: 1, chatId: OWNER });
  });

  it("classifies other /commands generically", () => {
    const result = classifyUpdate(textUpdate("/help me please"), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "command", name: "help", arg: "me please", messageId: 1, chatId: OWNER });
  });
});

describe("classifyUpdate — plain text search", () => {
  it("classifies arbitrary text as a search", () => {
    const result = classifyUpdate(textUpdate("react hooks cheatsheet"), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "search", query: "react hooks cheatsheet", truncated: false, messageId: 1, chatId: OWNER });
  });

  it("truncates long search queries and flags it", () => {
    const long = "y".repeat(SEARCH_QUERY_MAX_LEN + 50);
    const result = classifyUpdate(textUpdate(long), { ownerChatId: OWNER });
    expect(result.kind).toBe("search");
    if (result.kind === "search") {
      expect(result.query).toHaveLength(SEARCH_QUERY_MAX_LEN);
      expect(result.truncated).toBe(true);
    }
  });

  it("classifies a bare scheme-less domain as search, not url (deliberate: only a full http(s) URL is a url capture)", () => {
    const result = classifyUpdate(textUpdate("x.com"), { ownerChatId: OWNER });
    expect(result).toEqual({ kind: "search", query: "x.com", truncated: false, messageId: 1, chatId: OWNER });
  });

  it("truncates codepoint-aware so a boundary cut never splits a surrogate pair (emoji)", () => {
    const prefix = "a".repeat(SEARCH_QUERY_MAX_LEN - 1);
    const text = prefix + "😀😀"; // 2 codepoints, each a surrogate pair in UTF-16
    const result = classifyUpdate(textUpdate(text), { ownerChatId: OWNER });
    expect(result.kind).toBe("search");
    if (result.kind === "search") {
      expect(result.truncated).toBe(true);
      // The kept text must be exactly SEARCH_QUERY_MAX_LEN codepoints and must not contain
      // a lone (unpaired) surrogate, which is what a naive UTF-16 slice would produce here.
      expect(Array.from(result.query)).toHaveLength(SEARCH_QUERY_MAX_LEN);
      expect(result.query).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("truncates /add capture text codepoint-aware at an emoji boundary", () => {
    const prefix = "b".repeat(CAPTURE_TEXT_MAX_LEN - 1);
    const text = `/add ${prefix}🎉🎉`;
    const result = classifyUpdate(textUpdate(text), { ownerChatId: OWNER });
    expect(result.kind).toBe("text-capture");
    if (result.kind === "text-capture") {
      expect(result.truncated).toBe(true);
      expect(Array.from(result.text)).toHaveLength(CAPTURE_TEXT_MAX_LEN);
      expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });
});

describe("classifyUpdate — total safety against malformed/untrusted input", () => {
  it("ignores a message missing chat entirely (does not throw)", () => {
    expect(() => classifyUpdate({ update_id: 1, message: { message_id: 1 } }, { ownerChatId: OWNER })).not.toThrow();
    expect(classifyUpdate({ update_id: 1, message: { message_id: 1 } }, { ownerChatId: OWNER })).toEqual({
      kind: "ignored",
      reason: "unsupported"
    });
  });

  it("ignores an explicit null message", () => {
    expect(classifyUpdate({ update_id: 1, message: null }, { ownerChatId: OWNER })).toEqual({
      kind: "ignored",
      reason: "unsupported"
    });
  });

  it("ignores a callback_query without a message", () => {
    expect(classifyUpdate({ update_id: 1, callback_query: { id: "cb1", data: "k|cab_1|1" } }, { ownerChatId: OWNER })).toEqual({
      kind: "ignored",
      reason: "unsupported"
    });
  });

  it("ignores a completely empty object", () => {
    expect(classifyUpdate({}, { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "unsupported" });
  });

  it("ignores a null update", () => {
    expect(classifyUpdate(null, { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "unsupported" });
  });

  it("ignores an undefined update", () => {
    expect(classifyUpdate(undefined, { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "unsupported" });
  });

  it.each<[string, unknown]>([
    ["primitive string update", "just a string"],
    ["primitive number update", 42],
    ["primitive boolean update", true],
    ["array update", [1, 2, 3]],
    ["chat is null", { update_id: 1, message: { message_id: 1, chat: null } }],
    ["chat is an empty object", { update_id: 1, message: { message_id: 1, chat: {} } }],
    ["chat.id is a string, not a number", { update_id: 1, message: { message_id: 1, chat: { id: "abc" } } }],
    ["message is a primitive", { update_id: 1, message: "not-an-object" }],
    ["photo is a string instead of an array", { update_id: 1, message: { message_id: 1, chat: { id: OWNER }, photo: "oops" } }],
    ["photo entries are primitives", { update_id: 1, message: { message_id: 1, chat: { id: OWNER }, photo: [1, "x", null] } }],
    ["document is a primitive", { update_id: 1, message: { message_id: 1, chat: { id: OWNER }, document: "oops" } }],
    ["callback_query is a primitive", { update_id: 1, callback_query: "oops" }],
    ["callback_query.message is a primitive", { update_id: 1, callback_query: { id: "cb1", data: "k|cab_1|1", message: "oops" } }],
    ["callback_query.data is not a string", { update_id: 1, callback_query: { id: "cb1", data: 123, message: { message_id: 9, chat: { id: OWNER } } } }],
    ["callback_query.id is not a string", { update_id: 1, callback_query: { id: 5, data: "k|cab_1|1", message: { message_id: 9, chat: { id: OWNER } } } }]
  ])("never throws and returns ignored for: %s", (_label, input) => {
    expect(() => classifyUpdate(input, { ownerChatId: OWNER })).not.toThrow();
    expect(classifyUpdate(input, { ownerChatId: OWNER })).toMatchObject({ kind: "ignored" });
  });

  it("never throws when /add's reply_to_message is a primitive (falls back to a plain command, doesn't crash)", () => {
    const input = { update_id: 1, message: { message_id: 1, chat: { id: OWNER }, text: "/add", reply_to_message: "oops" } };
    expect(() => classifyUpdate(input, { ownerChatId: OWNER })).not.toThrow();
    expect(classifyUpdate(input, { ownerChatId: OWNER })).toEqual({ kind: "command", name: "add", arg: "", messageId: 1, chatId: OWNER });
  });
});

describe("classifyUpdate — callback_query decisions", () => {
  it("decodes a valid decision callback", () => {
    const data = encodeDecision("keep", "cab_0123456789abcdef", "2026-09-20T00:00:00.000Z");
    const update: RouterUpdate = {
      update_id: 1,
      callback_query: { id: "cb1", data, message: { message_id: 9, chat: { id: OWNER } } }
    };
    const result = classifyUpdate(update, { ownerChatId: OWNER });
    expect(result).toEqual({
      kind: "callback",
      action: "keep",
      capabilityId: "cab_0123456789abcdef",
      updatedAt: "2026-09-20T00:00:00.000Z",
      callbackId: "cb1",
      chatId: OWNER,
      messageId: 9
    });
  });

  it("ignores a callback from a non-owner chat", () => {
    const data = encodeDecision("discard", "cab_0123456789abcdef", "2026-09-20T00:00:00.000Z");
    const update: RouterUpdate = {
      update_id: 1,
      callback_query: { id: "cb1", data, message: { message_id: 9, chat: { id: OTHER } } }
    };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "not-owner" });
  });

  it("ignores a callback with forged/malformed data", () => {
    const update: RouterUpdate = {
      update_id: 1,
      callback_query: { id: "cb1", data: "not-a-real-payload", message: { message_id: 9, chat: { id: OWNER } } }
    };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "bad-callback" });
  });

  it("ignores a callback_query with no attached message", () => {
    const update: RouterUpdate = { update_id: 1, callback_query: { id: "cb1", data: "k|cab_x|123" } };
    expect(classifyUpdate(update, { ownerChatId: OWNER })).toEqual({ kind: "ignored", reason: "unsupported" });
  });
});

describe("encodeDecision / decodeDecision", () => {
  it("round-trips keep, discard and rerun", () => {
    for (const action of ["keep", "discard", "rerun"] as const) {
      const iso = "2026-01-15T12:30:00.000Z";
      const data = encodeDecision(action, "cab_deadbeefcafef00d", iso);
      expect(decodeDecision(data)).toEqual({ action, capabilityId: "cab_deadbeefcafef00d", updatedAt: iso });
    }
  });

  it("uses single-letter prefixes k|d|r", () => {
    const iso = "2026-01-15T12:30:00.000Z";
    expect(encodeDecision("keep", "cab_1", iso).startsWith("k|")).toBe(true);
    expect(encodeDecision("discard", "cab_1", iso).startsWith("d|")).toBe(true);
    expect(encodeDecision("rerun", "cab_1", iso).startsWith("r|")).toBe(true);
  });

  it("a real capability id plus a 13-digit epoch fits within the byte limit", () => {
    const capabilityId = "cab_" + "a1b2c3d4e5f60718"; // cab_ + 16 hex chars
    const data = encodeDecision("rerun", capabilityId, "2026-09-20T00:00:00.000Z");
    const epochMs = Date.parse("2026-09-20T00:00:00.000Z");
    expect(String(epochMs)).toHaveLength(13);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    expect(decodeDecision(data)).not.toBeNull();
  });

  it("returns null for an unknown action code", () => {
    expect(decodeDecision("x|cab_1|123")).toBeNull();
  });

  it("returns null for a non-numeric epoch", () => {
    expect(decodeDecision("k|cab_1|not-a-number")).toBeNull();
  });

  it("returns null for a wrong number of segments", () => {
    expect(decodeDecision("k|cab_1")).toBeNull();
    expect(decodeDecision("k|cab_1|123|extra")).toBeNull();
  });

  it("returns null for an empty capability id", () => {
    expect(decodeDecision("k||123")).toBeNull();
  });

  it("returns null for data over the byte limit", () => {
    const overlong = `k|${"a".repeat(80)}|123`;
    expect(decodeDecision(overlong)).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(() => decodeDecision("")).not.toThrow();
    expect(decodeDecision("")).toBeNull();
  });
});
