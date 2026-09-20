import type { Pool } from "pg";
import type { Pipeline } from "../config";
import { recordTelegramReceipt, submitCapture } from "../captures/captures";
import type { CaptureInput } from "../captures/dedupe";
import type { ImageMime, ObjectStore } from "../storage/s3";
import { escapeHtml, type TelegramApi } from "./api";
import type { ClassifiedUpdate } from "./router";

/** Telegram files above this size are rejected before (or, if size was unknown, during) download. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const RECEIPT_TEXT = "已收到，分析中…";

export type CaptureOutcome =
  | { kind: "submitted"; captureId: string; runId: string }
  | { kind: "duplicate"; captureId: string; capabilityId: string | null; title: string | null }
  | { kind: "rejected"; reason: "oversized" | "download-failed" | "unsupported-mime" | "submit-failed"; detail: string };

export interface CaptureDeps {
  api: Pick<TelegramApi, "getFile" | "downloadFile" | "sendMessage">;
  pool: Pool;
  objects: ObjectStore;
  pipeline: Pipeline;
}

export type CaptureUpdate = Extract<ClassifiedUpdate, { kind: "image" | "url" | "text-capture" }>;

/**
 * The public web origin captures link back to, e.g. for "you already sent this" replies.
 * `env` defaults to `process.env`; pass an explicit object in tests.
 */
export function publicBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = env.PUBLIC_BASE_URL?.trim();
  const base = raw && raw !== "" ? raw : "https://caphub.agentjoey.ai";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function libraryLink(capabilityId: string): string {
  return `${publicBaseUrl()}/library/${capabilityId}`;
}

/** Magic-byte sniff for the three mime types the object store accepts (mirrors lib/api/captures.ts's web-upload check). */
function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function isOversizeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("exceeds max size");
}

async function findDuplicateCard(pool: Pool, captureId: string): Promise<{ id: string; title: string } | null> {
  const { rows } = await pool.query<{ id: string; title: string }>(
    "SELECT id, title FROM caphub_v2.capabilities WHERE capture_id = $1 AND deleted_at IS NULL", [captureId]
  );
  return rows[0] ?? null;
}

/** Sends `text` in reply to the triggering message. Never throws — a failed reply must not crash the poll loop. */
async function reply(deps: CaptureDeps, update: CaptureUpdate, text: string): Promise<void> {
  try {
    await deps.api.sendMessage({ chatId: update.chatId, text, replyToMessageId: update.messageId });
  } catch (error) {
    console.error(JSON.stringify({
      msg: "telegram reply failed", chatId: update.chatId, messageId: update.messageId,
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

async function rejected(
  deps: CaptureDeps, update: CaptureUpdate,
  reason: "oversized" | "download-failed" | "unsupported-mime" | "submit-failed",
  message: string
): Promise<CaptureOutcome> {
  await reply(deps, update, message);
  return { kind: "rejected", reason, detail: message };
}

async function resolveImageInput(deps: CaptureDeps, update: Extract<CaptureUpdate, { kind: "image" }>): Promise<CaptureInput | CaptureOutcome> {
  let filePath: string | undefined;
  try {
    const file = await deps.api.getFile({ fileId: update.fileId });
    if (file.file_size !== undefined && file.file_size > MAX_IMAGE_BYTES) {
      return rejected(deps, update, "oversized", "图片太大了，最大支持 10 MB");
    }
    filePath = file.file_path;
  } catch (error) {
    void error;
    return rejected(deps, update, "download-failed", "图片下载失败，请稍后重试");
  }
  if (!filePath) {
    return rejected(deps, update, "download-failed", "图片下载失败，请稍后重试");
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.api.downloadFile({ filePath, maxBytes: MAX_IMAGE_BYTES });
  } catch (error) {
    if (isOversizeError(error)) return rejected(deps, update, "oversized", "图片太大了，最大支持 10 MB");
    return rejected(deps, update, "download-failed", "图片下载失败，请稍后重试");
  }

  const mimeType = sniffImageMime(bytes);
  if (!mimeType) {
    return rejected(deps, update, "unsupported-mime", "暂不支持这种图片格式，请发送 PNG、JPEG 或 WEBP");
  }
  return { source: "telegram", kind: "image", bytes, mimeType };
}

/**
 * Submits a capture that arrived via Telegram: downloads and validates an image (capped at
 * 10 MB), or passes a URL / free text straight through. Always replies in-chat and never
 * throws — this runs inside the worker's poll loop, so any failure must become a typed
 * outcome plus a one-sentence Chinese reply, not an unhandled rejection.
 */
export async function handleCapture(deps: CaptureDeps, update: CaptureUpdate): Promise<CaptureOutcome> {
  try {
    let input: CaptureInput;
    if (update.kind === "image") {
      const resolved = await resolveImageInput(deps, update);
      if ("kind" in resolved && (resolved.kind === "rejected")) return resolved;
      input = resolved as CaptureInput;
    } else if (update.kind === "url") {
      input = { source: "telegram", kind: "url", url: update.url };
    } else {
      input = { source: "telegram", kind: "text", text: update.text };
    }

    let result;
    try {
      result = await submitCapture({ pool: deps.pool, objects: deps.objects, pipeline: deps.pipeline }, input);
    } catch (error) {
      void error;
      return rejected(deps, update, "submit-failed", "投递失败，请稍后重试");
    }

    if (result.duplicate) {
      const card = await findDuplicateCard(deps.pool, result.captureId);
      const text = card
        ? `这条之前投过：<a href="${escapeHtml(libraryLink(card.id))}">${escapeHtml(card.title)}</a>`
        : "这条之前投过，分析结果还在生成中";
      await reply(deps, update, text);
      return { kind: "duplicate", captureId: result.captureId, capabilityId: card?.id ?? null, title: card?.title ?? null };
    }

    // result.duplicate === false here, so submitCapture always assigned a runId.
    const runId = result.runId as string;
    const sent = await (async () => {
      try {
        return await deps.api.sendMessage({ chatId: update.chatId, text: RECEIPT_TEXT, replyToMessageId: update.messageId });
      } catch (error) {
        console.error(JSON.stringify({
          msg: "telegram receipt reply failed", captureId: result.captureId,
          error: error instanceof Error ? error.message : String(error)
        }));
        return null;
      }
    })();
    if (sent && typeof sent === "object" && typeof sent.message_id === "number") {
      try {
        await recordTelegramReceipt(deps.pool, result.captureId, { chatId: update.chatId, messageId: sent.message_id });
      } catch (error) {
        console.error(JSON.stringify({
          msg: "recording telegram receipt failed", captureId: result.captureId,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    return { kind: "submitted", captureId: result.captureId, runId };
  } catch (error) {
    // Absolute safety net: this handler must never throw into the worker's poll loop.
    console.error(JSON.stringify({
      msg: "handleCapture crashed", chatId: update.chatId, messageId: update.messageId,
      error: error instanceof Error ? error.message : String(error)
    }));
    const detail = "出了点问题，请稍后重试";
    await reply(deps, update, detail);
    return { kind: "rejected", reason: "submit-failed", detail };
  }
}
