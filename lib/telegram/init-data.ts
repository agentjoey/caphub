import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_AGE_SECONDS = 300;

export type InitDataResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "malformed" | "bad_hash" | "stale" | "not_owner" };

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Verifies a Telegram Mini App `initData` payload per the WebApp spec:
 * `secret = HMAC_SHA256(key="WebAppData", msg=botToken)`,
 * `hash = HMAC_SHA256(key=secret, msg=dataCheckString)`, where dataCheckString is every
 * `key=value` pair except `hash`, joined with `\n` in ascending key order. Also enforces a
 * freshness window on `auth_date` and that the signed user is the configured owner.
 */
export function verifyInitData(
  initData: string,
  opts: { botToken: string; ownerId: string; now?: Date; maxAgeSeconds?: number }
): InitDataResult {
  if (!initData || !opts.botToken) return { ok: false, reason: "malformed" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]+$/i.test(hash)) return { ok: false, reason: "malformed" };
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(opts.botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest("hex");
  if (!hexEqual(hash.toLowerCase(), expected)) return { ok: false, reason: "bad_hash" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) return { ok: false, reason: "malformed" };
  const nowSeconds = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);
  // Both directions: a clock-skewed or replayed future timestamp is as suspect as an old one.
  if (Math.abs(nowSeconds - authDate) > (opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS)) {
    return { ok: false, reason: "stale" };
  }

  let userId: string;
  try {
    const user = JSON.parse(params.get("user") ?? "");
    userId = String(user?.id ?? "");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!userId) return { ok: false, reason: "malformed" };
  if (userId !== String(opts.ownerId)) return { ok: false, reason: "not_owner" };
  return { ok: true, userId };
}
