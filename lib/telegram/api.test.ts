import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramApi, escapeHtml } from "./api";
import { TelegramError } from "./errors";

const TOKEN = "123456:AAA-super-secret-token";

afterEach(() => {
  vi.useRealTimers();
});

describe("escapeHtml", () => {
  it("escapes &, < and >", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });
});

describe("createTelegramApi", () => {
  it("posts to the method URL with the token in the path and unwraps result", async () => {
    let url = "";
    let init: RequestInit = {};
    const fetchFn = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return new Response(JSON.stringify({ ok: true, result: { id: 42, is_bot: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    const me = await api.getMe();
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(init.method).toBe("POST");
    expect(me).toEqual({ id: 42, is_bot: true });
  });

  it("sendMessage sends chat_id, text, HTML parse mode and reply_markup", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, i: RequestInit) => {
      body = JSON.parse(i.body as string);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    const markup = { inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]] };
    const out = await api.sendMessage({ chatId: 555, text: "hi <b>there</b>", replyMarkup: markup });
    expect(body).toMatchObject({ chat_id: 555, text: "hi <b>there</b>", parse_mode: "HTML", reply_markup: markup });
    expect(out).toEqual({ message_id: 7 });
  });

  it("editMessageText sends chat_id, message_id, text and reply_markup", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, i: RequestInit) => {
      body = JSON.parse(i.body as string);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    await api.editMessageText({ chatId: 555, messageId: 7, text: "edited" });
    expect(body).toMatchObject({ chat_id: 555, message_id: 7, text: "edited", parse_mode: "HTML" });
  });

  it("answerCallbackQuery sends callback_query_id", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, i: RequestInit) => {
      body = JSON.parse(i.body as string);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    await api.answerCallbackQuery({ callbackQueryId: "cb1", text: "done" });
    expect(body).toMatchObject({ callback_query_id: "cb1", text: "done" });
  });

  it("setMyCommands sends the commands array", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, i: RequestInit) => {
      body = JSON.parse(i.body as string);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    const commands = [{ command: "start", description: "Start" }];
    await api.setMyCommands({ commands });
    expect(body).toEqual({ commands });
  });

  it("getFile posts file_id and returns the result", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, i: RequestInit) => {
      body = JSON.parse(i.body as string);
      return new Response(JSON.stringify({ ok: true, result: { file_id: "f1", file_path: "documents/f1.pdf" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    const file = await api.getFile({ fileId: "f1" });
    expect(body).toEqual({ file_id: "f1" });
    expect(file).toEqual({ file_id: "f1", file_path: "documents/f1.pdf" });
  });

  it("getUpdates posts offset and timeout, using timeout + 10s as the HTTP timeout", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetchFn = ((_u: string, i: RequestInit) => {
      capturedSignal = i.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    const promise = api.getUpdates({ offset: 10, timeout: 25 }).catch(() => {});

    await vi.advanceTimersByTimeAsync(34_000);
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(capturedSignal?.aborted).toBe(true);

    await promise;
  });

  it("a hardcoded short default timeout never wins over poll timeout + 10s", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetchFn = ((_u: string, i: RequestInit) => {
      capturedSignal = i.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    // A tiny default timeoutMs must not shorten the poll's required HTTP timeout.
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn, timeoutMs: 1_000 });
    const promise = api.getUpdates({ timeout: 25 }).catch(() => {});

    await vi.advanceTimersByTimeAsync(30_000);
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(capturedSignal?.aborted).toBe(true);
    await promise;
  });

  it("maps a non-2xx response to a TelegramError with code/description", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }), { status: 400 })) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    await expect(api.sendMessage({ chatId: 1, text: "x" })).rejects.toMatchObject({
      code: 400,
      description: "Bad Request: chat not found"
    });
  });

  it("maps a 429 response to a TelegramError with retryAfter from parameters.retry_after", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({
      ok: false, error_code: 429, description: "Too Many Requests: retry later", parameters: { retry_after: 5 }
    }), { status: 429 })) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    await expect(api.sendMessage({ chatId: 1, text: "x" })).rejects.toMatchObject({
      code: 429,
      retryAfter: 5
    });
  });

  it("combines the caller's AbortSignal with the timeout", async () => {
    const controller = new AbortController();
    const fetchFn = ((_u: string, i: RequestInit) => new Promise((_resolve, reject) => {
      (i.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    const promise = api.sendMessage({ chatId: 1, text: "x", signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it("does not leak the bot token into a thrown error's message or stack", async () => {
    const fetchFn = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    let caught: unknown;
    try {
      await api.sendMessage({ chatId: 1, text: "x" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramError);
    const err = caught as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(err.stack ?? "").not.toContain(TOKEN);
  });

  it("downloadFile returns bytes from the file URL", async () => {
    let url = "";
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchFn = (async (u: string) => {
      url = u;
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength) } });
    }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    const out = await api.downloadFile({ filePath: "documents/f1.pdf", maxBytes: 10 });
    expect(url).toBe(`https://api.telegram.org/file/bot${TOKEN}/documents/f1.pdf`);
    expect(out).toEqual(bytes);
  });

  it("downloadFile rejects a file over the max byte size using content-length", async () => {
    const fetchFn = (async () => new Response(new Uint8Array(20), { status: 200, headers: { "content-length": "20" } })) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    await expect(api.downloadFile({ filePath: "documents/f1.pdf", maxBytes: 10 })).rejects.toThrow(/max/i);
  });

  it("downloadFile rejects a file over the max byte size when content-length is absent", async () => {
    const fetchFn = (async () => new Response(new Uint8Array(20), { status: 200 })) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetch: fetchFn });
    await expect(api.downloadFile({ filePath: "documents/f1.pdf", maxBytes: 10 })).rejects.toThrow(/max/i);
  });
});
