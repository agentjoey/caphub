import type { TelegramUpdate } from "./api";

/** Search queries longer than this are truncated (Telegram messages cap out around 4096 chars). */
export const SEARCH_QUERY_MAX_LEN = 200;
/** Captured text (from `/add`) longer than this is truncated. */
export const CAPTURE_TEXT_MAX_LEN = 4000;
/** Telegram's hard limit on `callback_data` byte length. */
export const CALLBACK_DATA_MAX_BYTES = 64;

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface ChatRef {
  id: number;
}

export interface PhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface DocumentLike {
  file_id: string;
  mime_type?: string;
}

export interface MessageLike {
  message_id: number;
  chat: ChatRef;
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: DocumentLike;
  sticker?: unknown;
  voice?: unknown;
  video?: unknown;
  location?: unknown;
  reply_to_message?: MessageLike;
}

export interface CallbackQueryLike {
  id: string;
  data?: string;
  message?: MessageLike;
}

export interface RouterUpdate extends TelegramUpdate {
  message?: MessageLike;
  callback_query?: CallbackQueryLike;
}

export type DecisionAction = "keep" | "discard" | "rerun";

export type ClassifiedUpdate =
  | { kind: "ignored"; reason: string }
  | { kind: "image"; fileId: string; messageId: number; chatId: number; caption?: string }
  | { kind: "url"; url: string; messageId: number; chatId: number }
  | { kind: "text-capture"; text: string; truncated: boolean; messageId: number; chatId: number }
  | { kind: "search"; query: string; truncated: boolean; messageId: number; chatId: number }
  | { kind: "command"; name: string; arg: string; messageId: number; chatId: number }
  | {
      kind: "callback";
      action: DecisionAction;
      capabilityId: string;
      updatedAt: string;
      callbackId: string;
      chatId: number;
      messageId: number;
    };

const URL_PATTERN = /^https?:\/\/\S+$/i;
const COMMAND_PATTERN = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:[ \t]+([\s\S]*))?$/;

// --- Runtime safety helpers -------------------------------------------------
// classifyUpdate runs on raw, untrusted JSON straight off the wire (the worker's poll
// loop). The exported types above describe the *shape we expect*, but nothing enforces
// it at runtime, so every access below is guarded defensively — this function must
// never throw, no matter how malformed the input is.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readChatId(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const chat = value.chat;
  if (!isRecord(chat)) return undefined;
  return typeof chat.id === "number" ? chat.id : undefined;
}

function readMessageId(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.message_id === "number" ? value.message_id : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === "string" ? v : undefined;
}

/** Splits on codepoints (not UTF-16 code units) so a cut never lands mid-surrogate-pair. */
function truncate(text: string, maxLen: number): { text: string; truncated: boolean } {
  const codepoints = Array.from(text);
  if (codepoints.length <= maxLen) return { text, truncated: false };
  return { text: codepoints.slice(0, maxLen).join(""), truncated: true };
}

function largestPhoto(photos: unknown): PhotoSize | undefined {
  if (!Array.isArray(photos)) return undefined;
  let best: PhotoSize | undefined;
  for (const candidate of photos) {
    if (!isRecord(candidate)) continue;
    const fileId = typeof candidate.file_id === "string" ? candidate.file_id : undefined;
    if (!fileId) continue;
    const width = typeof candidate.width === "number" ? candidate.width : 0;
    const height = typeof candidate.height === "number" ? candidate.height : 0;
    if (!best || width * height > best.width * best.height) {
      best = { file_id: fileId, width, height };
    }
  }
  return best;
}

function classifyText(message: Record<string, unknown>, text: string, messageId: number, chatId: number): ClassifiedUpdate {
  const trimmed = text.trim();

  if (trimmed === "") {
    return { kind: "ignored", reason: "unsupported" };
  }

  if (trimmed.startsWith("/")) {
    const match = COMMAND_PATTERN.exec(trimmed);
    if (!match) {
      return { kind: "ignored", reason: "unsupported" };
    }
    const name = match[1].toLowerCase();
    const arg = (match[2] ?? "").trim();

    if (name === "add") {
      const replyTo = message.reply_to_message;
      const replyText = (readString(replyTo, "text") ?? readString(replyTo, "caption") ?? "").trim();
      const sourceText = arg !== "" ? arg : replyText;
      if (sourceText !== "") {
        const { text: capped, truncated } = truncate(sourceText, CAPTURE_TEXT_MAX_LEN);
        return { kind: "text-capture", text: capped, truncated, messageId, chatId };
      }
      return { kind: "command", name, arg, messageId, chatId };
    }

    if (name === "find" && arg !== "") {
      const { text: capped, truncated } = truncate(arg, SEARCH_QUERY_MAX_LEN);
      return { kind: "search", query: capped, truncated, messageId, chatId };
    }

    return { kind: "command", name, arg, messageId, chatId };
  }

  if (URL_PATTERN.test(trimmed)) {
    return { kind: "url", url: trimmed, messageId, chatId };
  }

  const { text: capped, truncated } = truncate(trimmed, SEARCH_QUERY_MAX_LEN);
  return { kind: "search", query: capped, truncated, messageId, chatId };
}

function classifyMessage(message: unknown): ClassifiedUpdate {
  if (!isRecord(message)) return { kind: "ignored", reason: "unsupported" };

  const chatId = readChatId(message);
  const messageId = readMessageId(message);
  if (chatId === undefined || messageId === undefined) {
    return { kind: "ignored", reason: "unsupported" };
  }

  const caption = readString(message, "caption");

  const photo = largestPhoto(message.photo);
  if (photo) {
    return { kind: "image", fileId: photo.file_id, messageId, chatId, ...(caption !== undefined ? { caption } : {}) };
  }

  const document = message.document;
  if (document !== undefined && document !== null) {
    const mimeType = readString(document, "mime_type");
    const fileId = readString(document, "file_id");
    if (mimeType && fileId && IMAGE_MIME_TYPES.has(mimeType)) {
      return { kind: "image", fileId, messageId, chatId, ...(caption !== undefined ? { caption } : {}) };
    }
    return { kind: "ignored", reason: "unsupported" };
  }

  if (message.sticker || message.voice || message.video || message.location) {
    return { kind: "ignored", reason: "unsupported" };
  }

  const text = message.text;
  if (typeof text === "string") {
    return classifyText(message, text, messageId, chatId);
  }

  return { kind: "ignored", reason: "unsupported" };
}

function classifyCallbackQuery(callbackQuery: unknown): ClassifiedUpdate {
  if (!isRecord(callbackQuery)) return { kind: "ignored", reason: "unsupported" };

  const message = callbackQuery.message;
  const chatId = readChatId(message);
  const messageId = readMessageId(message);
  if (chatId === undefined || messageId === undefined) {
    return { kind: "ignored", reason: "unsupported" };
  }

  const data = callbackQuery.data;
  const callbackId = callbackQuery.id;
  if (typeof data !== "string" || typeof callbackId !== "string") {
    return { kind: "ignored", reason: "bad-callback" };
  }

  const decoded = decodeDecision(data);
  if (!decoded) {
    return { kind: "ignored", reason: "bad-callback" };
  }

  return {
    kind: "callback",
    action: decoded.action,
    capabilityId: decoded.capabilityId,
    updatedAt: decoded.updatedAt,
    callbackId,
    chatId,
    messageId
  };
}

/**
 * Classifies an incoming Telegram update into exactly one actionable kind (or "ignored"
 * with a reason). Pure function: no network, no DB. `ownerChatId` gates every update —
 * anything from another chat is ignored regardless of shape.
 *
 * `update` is typed as `unknown` deliberately: this runs directly on raw JSON parsed from
 * the Telegram API response, which is untrusted and may be arbitrarily malformed. This
 * function is total — it never throws, for any input.
 */
export function classifyUpdate(update: unknown, opts: { ownerChatId: number }): ClassifiedUpdate {
  if (!isRecord(update)) {
    return { kind: "ignored", reason: "unsupported" };
  }

  const message = update.message;
  const callbackQuery = update.callback_query;
  const callbackMessage = isRecord(callbackQuery) ? callbackQuery.message : undefined;
  const chatId = readChatId(message) ?? readChatId(callbackMessage);

  if (chatId === undefined) {
    return { kind: "ignored", reason: "unsupported" };
  }
  if (chatId !== opts.ownerChatId) {
    return { kind: "ignored", reason: "not-owner" };
  }

  if (callbackQuery !== undefined && callbackQuery !== null) {
    return classifyCallbackQuery(callbackQuery);
  }
  if (message !== undefined && message !== null) {
    return classifyMessage(message);
  }
  return { kind: "ignored", reason: "unsupported" };
}

const ACTION_TO_CODE: Record<DecisionAction, string> = { keep: "k", discard: "d", rerun: "r" };
const CODE_TO_ACTION: Record<string, DecisionAction> = { k: "keep", d: "discard", r: "rerun" };

/** Encodes a moderation decision as Telegram `callback_data`: `k|<capabilityId>|<epochMs>`. */
export function encodeDecision(action: DecisionAction, capabilityId: string, updatedAtIso: string): string {
  const epochMs = Date.parse(updatedAtIso);
  return `${ACTION_TO_CODE[action]}|${capabilityId}|${epochMs}`;
}

/**
 * Decodes `callback_data` produced by {@link encodeDecision}. Never throws: returns `null`
 * for anything malformed, an unknown action code, a non-numeric epoch, or data over
 * {@link CALLBACK_DATA_MAX_BYTES} bytes.
 */
export function decodeDecision(data: string): { action: DecisionAction; capabilityId: string; updatedAt: string } | null {
  if (typeof data !== "string" || data === "") return null;
  if (new TextEncoder().encode(data).length > CALLBACK_DATA_MAX_BYTES) return null;

  const parts = data.split("|");
  if (parts.length !== 3) return null;
  const [code, capabilityId, epochStr] = parts;

  const action = CODE_TO_ACTION[code];
  if (!action) return null;
  if (!capabilityId) return null;
  if (!/^\d+$/.test(epochStr)) return null;

  const epochMs = Number(epochStr);
  if (!Number.isSafeInteger(epochMs)) return null;

  const iso = new Date(epochMs).toISOString();
  return { action, capabilityId, updatedAt: iso };
}
