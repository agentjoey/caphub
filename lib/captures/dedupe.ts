import { sha256Hex } from "../storage/object-ref";
import type { ImageMime } from "../storage/s3";

export type CaptureInput = {
  source: "web" | "telegram" | "import";
  telegram?: { chatId: string; messageId: string };
} & (
  | { kind: "image"; bytes: Uint8Array; mimeType: ImageMime }
  | { kind: "text"; text: string }
  | { kind: "url"; url: string }
);

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("url must use https");
  parsed.hash = "";
  const s = parsed.toString();
  return s.endsWith("/") && parsed.pathname !== "/" ? s.slice(0, -1) : s;
}

export function dedupeKeyFor(input: CaptureInput): string {
  switch (input.kind) {
    case "image": return sha256Hex(input.bytes);
    case "text": return sha256Hex(`text\0${normalizeText(input.text)}`);
    case "url": return sha256Hex(`url\0${normalizeUrl(input.url)}`);
  }
}
