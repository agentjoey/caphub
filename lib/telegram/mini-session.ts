import { createHmac, timingSafeEqual } from "node:crypto";

/** Name of the cookie that carries a verified Telegram Mini App session. */
export const MINI_COOKIE = "caphub_mini";

const TTL_MS = 12 * 60 * 60 * 1000; // 12h, matches the Set-Cookie Max-Age in the session route.

// A distinct key-derivation string from initData's "WebAppData" so the two HMAC keys never
// collide even though both are ultimately derived from the same bot token.
const KEY_INFO = "CaphubMiniSession";

interface SessionPayload {
  u: string; // userId
  e: number; // expiresAtMs
}

function sign(payload: string, botToken: string): string {
  const key = createHmac("sha256", KEY_INFO).update(botToken).digest();
  return createHmac("sha256", key).update(payload).digest("hex");
}

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function issueMiniSession(userId: string, opts: { botToken: string; now?: Date }): string {
  const expiresAtMs = (opts.now?.getTime() ?? Date.now()) + TTL_MS;
  const payload: SessionPayload = { u: userId, e: expiresAtMs };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, opts.botToken)}`;
}

export function verifyMiniSession(
  value: string | undefined,
  opts: { botToken: string; ownerId: string; now?: Date }
): boolean {
  if (!value || !opts.botToken) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^[0-9a-f]+$/i.test(sig)) return false;
  const expected = sign(payload, opts.botToken);
  if (!hexEqual(sig.toLowerCase(), expected)) return false;

  let parsed: SessionPayload;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (typeof parsed?.u !== "string" || typeof parsed?.e !== "number") return false;

  const now = opts.now?.getTime() ?? Date.now();
  if (now > parsed.e) return false;
  return parsed.u === String(opts.ownerId);
}
