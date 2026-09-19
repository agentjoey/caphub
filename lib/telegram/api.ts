import { withTimeout } from "../analysis/structured";
import { TelegramError } from "./errors";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Long polls add this margin on top of the poll duration so the HTTP request never times out before Telegram responds. */
const POLL_TIMEOUT_MARGIN_MS = 10_000;

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramUpdate {
  update_id: number;
  [key: string]: unknown;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  [key: string]: unknown;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  [key: string]: unknown;
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface TelegramApi {
  getMe(signal?: AbortSignal): Promise<TelegramUser>;
  getUpdates(params: { offset?: number; timeout: number; signal?: AbortSignal }): Promise<TelegramUpdate[]>;
  sendMessage(params: { chatId: number | string; text: string; replyMarkup?: InlineKeyboardMarkup; signal?: AbortSignal }): Promise<TelegramMessage>;
  editMessageText(params: { chatId: number | string; messageId: number; text: string; replyMarkup?: InlineKeyboardMarkup; signal?: AbortSignal }): Promise<TelegramMessage | true>;
  answerCallbackQuery(params: { callbackQueryId: string; text?: string; showAlert?: boolean; signal?: AbortSignal }): Promise<true>;
  getFile(params: { fileId: string; signal?: AbortSignal }): Promise<TelegramFile>;
  downloadFile(params: { filePath: string; maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array>;
  setMyCommands(params: { commands: BotCommand[]; signal?: AbortSignal }): Promise<true>;
}

/** Escapes the characters Telegram's `parse_mode: "HTML"` requires escaped outside of tags. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function describeTransportFailure(timedOut: boolean, aborted: boolean): string {
  if (timedOut) return "request timed out";
  if (aborted) return "request aborted";
  return "network error";
}

export function createTelegramApi(opts: { token: string; fetch?: typeof fetch; timeoutMs?: number }): TelegramApi {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function methodUrl(method: string): string {
    return `${TELEGRAM_API_BASE}/bot${opts.token}/${method}`;
  }

  function fileUrl(filePath: string): string {
    return `${TELEGRAM_API_BASE}/file/bot${opts.token}/${filePath}`;
  }

  async function callApi<T>(method: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const outerSignal = signal ?? new AbortController().signal;
    const t = withTimeout(outerSignal, timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(methodUrl(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: t.signal
      });
    } catch (error) {
      // Never surface the raw error (which some fetch implementations decorate with the
      // request URL, and therefore the bot token) — only our own, token-free description.
      void error;
      throw new TelegramError(0, describeTransportFailure(t.timedOut(), outerSignal.aborted));
    } finally {
      t.clear();
    }
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    const payload = (data && typeof data === "object" ? data : {}) as {
      ok?: boolean;
      result?: unknown;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!response.ok || payload.ok !== true) {
      const code = typeof payload.error_code === "number" ? payload.error_code : response.status;
      const description = typeof payload.description === "string" ? payload.description : `HTTP ${response.status}`;
      const retryAfter = code === 429 ? payload.parameters?.retry_after : undefined;
      throw new TelegramError(code, description, retryAfter);
    }
    return payload.result as T;
  }

  return {
    getMe(signal) {
      return callApi<TelegramUser>("getMe", {}, defaultTimeoutMs, signal);
    },

    getUpdates({ offset, timeout, signal }) {
      const httpTimeoutMs = timeout * 1000 + POLL_TIMEOUT_MARGIN_MS;
      return callApi<TelegramUpdate[]>("getUpdates", { offset, timeout }, httpTimeoutMs, signal);
    },

    sendMessage({ chatId, text, replyMarkup, signal }) {
      return callApi<TelegramMessage>("sendMessage", {
        chat_id: chatId, text, parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      }, defaultTimeoutMs, signal);
    },

    editMessageText({ chatId, messageId, text, replyMarkup, signal }) {
      return callApi<TelegramMessage | true>("editMessageText", {
        chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      }, defaultTimeoutMs, signal);
    },

    answerCallbackQuery({ callbackQueryId, text, showAlert, signal }) {
      return callApi<true>("answerCallbackQuery", {
        callback_query_id: callbackQueryId, ...(text !== undefined ? { text } : {}), ...(showAlert !== undefined ? { show_alert: showAlert } : {})
      }, defaultTimeoutMs, signal);
    },

    getFile({ fileId, signal }) {
      return callApi<TelegramFile>("getFile", { file_id: fileId }, defaultTimeoutMs, signal);
    },

    async downloadFile({ filePath, maxBytes, signal }) {
      const outerSignal = signal ?? new AbortController().signal;
      const t = withTimeout(outerSignal, defaultTimeoutMs);
      let response: Response;
      try {
        response = await fetchFn(fileUrl(filePath), { signal: t.signal });
      } catch (error) {
        void error;
        throw new TelegramError(0, describeTransportFailure(t.timedOut(), outerSignal.aborted));
      } finally {
        t.clear();
      }
      if (!response.ok) throw new TelegramError(response.status, `HTTP ${response.status}`);
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxBytes) {
        throw new Error(`telegram file exceeds max size of ${maxBytes} bytes (content-length ${contentLength})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        throw new Error(`telegram file exceeds max size of ${maxBytes} bytes (got ${bytes.byteLength})`);
      }
      return bytes;
    },

    setMyCommands({ commands, signal }) {
      return callApi<true>("setMyCommands", { commands }, defaultTimeoutMs, signal);
    }
  };
}
