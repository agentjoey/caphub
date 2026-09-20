import type { TelegramUpdate } from "./api";

/** Search queries longer than this are truncated (Telegram messages cap out around 4096 chars). */
export const SEARCH_QUERY_MAX_LEN = 200;
/** Captured text (from `/add`) longer than this is truncated. */
export const CAPTURE_TEXT_MAX_LEN = 4000;
/** Telegram's hard limit on `callback_data` byte length. */
export const CALLBACK_DATA_MAX_BYTES = 64;

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface ChatRef {
  id: number;
}

interface PhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface DocumentLike {
  file_id: string;
  mime_type?: string;
}

interface MessageLike {
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

interface CallbackQueryLike {
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

function truncate(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false };
  return { text: text.slice(0, maxLen), truncated: true };
}

function largestPhoto(photos: PhotoSize[]): PhotoSize | undefined {
  return photos.reduce<PhotoSize | undefined>((best, current) => {
    if (!best) return current;
    return current.width * current.height > best.width * best.height ? current : best;
  }, undefined);
}

function classifyText(message: MessageLike, text: string): ClassifiedUpdate {
  const messageId = message.message_id;
  const chatId = message.chat.id;
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
      const sourceText = arg !== "" ? arg : (message.reply_to_message?.text ?? message.reply_to_message?.caption ?? "").trim();
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

function classifyMessage(message: MessageLike): ClassifiedUpdate {
  const messageId = message.message_id;
  const chatId = message.chat.id;

  if (message.photo && message.photo.length > 0) {
    const photo = largestPhoto(message.photo);
    if (photo) {
      return { kind: "image", fileId: photo.file_id, messageId, chatId, ...(message.caption !== undefined ? { caption: message.caption } : {}) };
    }
  }

  if (message.document) {
    if (message.document.mime_type && IMAGE_MIME_TYPES.has(message.document.mime_type)) {
      return { kind: "image", fileId: message.document.file_id, messageId, chatId, ...(message.caption !== undefined ? { caption: message.caption } : {}) };
    }
    return { kind: "ignored", reason: "unsupported" };
  }

  if (message.sticker || message.voice || message.video || message.location) {
    return { kind: "ignored", reason: "unsupported" };
  }

  if (typeof message.text === "string") {
    return classifyText(message, message.text);
  }

  return { kind: "ignored", reason: "unsupported" };
}

function classifyCallbackQuery(callbackQuery: CallbackQueryLike): ClassifiedUpdate {
  const message = callbackQuery.message;
  if (!message || typeof callbackQuery.data !== "string") {
    return { kind: "ignored", reason: "bad-callback" };
  }
  const decoded = decodeDecision(callbackQuery.data);
  if (!decoded) {
    return { kind: "ignored", reason: "bad-callback" };
  }
  return {
    kind: "callback",
    action: decoded.action,
    capabilityId: decoded.capabilityId,
    updatedAt: decoded.updatedAt,
    callbackId: callbackQuery.id,
    chatId: message.chat.id,
    messageId: message.message_id
  };
}

/**
 * Classifies an incoming Telegram update into exactly one actionable kind (or "ignored"
 * with a reason). Pure function: no network, no DB. `ownerChatId` gates every update —
 * anything from another chat is ignored regardless of shape.
 */
export function classifyUpdate(update: RouterUpdate, opts: { ownerChatId: number }): ClassifiedUpdate {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (chatId === undefined) {
    return { kind: "ignored", reason: "unsupported" };
  }
  if (chatId !== opts.ownerChatId) {
    return { kind: "ignored", reason: "not-owner" };
  }

  if (update.callback_query) {
    return classifyCallbackQuery(update.callback_query);
  }
  if (update.message) {
    return classifyMessage(update.message);
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
