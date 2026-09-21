import { verifyInitData } from "../../../../lib/telegram/init-data";
import { issueMiniSession, MINI_COOKIE } from "../../../../lib/telegram/mini-session";
import { getRuntime } from "../../../../lib/runtime";

type RefusalReason = "config_missing" | "invalid_body" | "malformed" | "bad_hash" | "stale" | "not_owner";

// Deliberately minimal: a reason code only goes to the server log, never into the response body
// (see unauthorized() below) — an attacker probing this endpoint should not learn which check
// failed. Never logs initData, the cookie value, or the bot token.
function logSessionRefusal(reason: RefusalReason): void {
  console.log(JSON.stringify({ event: "mini_session_refused", reason }));
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function POST(request: Request): Promise<Response> {
  const { config } = getRuntime();
  const botToken = config.telegram.botToken?.trim();
  const ownerId = config.telegram.ownerChatId?.trim();
  // Fail closed: without both secrets configured we cannot verify anything (see task-1-brief.md
  // Step 6/7 — the bot token is not yet set in production for the `web` service).
  if (!botToken || !ownerId) {
    logSessionRefusal("config_missing");
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logSessionRefusal("invalid_body");
    return unauthorized();
  }

  const initData = typeof body === "object" && body !== null && "initData" in body
    ? (body as { initData: unknown }).initData
    : undefined;
  if (typeof initData !== "string") {
    logSessionRefusal("invalid_body");
    return unauthorized();
  }

  const result = verifyInitData(initData, { botToken, ownerId });
  if (!result.ok) {
    logSessionRefusal(result.reason);
    return unauthorized();
  }

  const cookieValue = issueMiniSession(result.userId, { botToken });
  const response = Response.json({ ok: true });
  // This response mints a credential — it must never sit in a shared or browser cache.
  response.headers.set("Cache-Control", "no-store");
  // SameSite=None is required, not a relaxation for convenience: Telegram Desktop and Telegram
  // Web render a Mini App inside a cross-site iframe on web.telegram.org, and a Lax cookie is
  // never sent from there — every request from those clients, including the card buttons in
  // chat (`web_app` buttons in lib/telegram/format.ts), would 401 without it.
  //
  // What stops CSRF once the cookie does ride along cross-site:
  //  1. Every write on /mini is a Next server action, and Next 16 aborts any server action whose
  //     `Origin` header does not match `Host`/`X-Forwarded-Host` (node_modules/next/dist/server/
  //     app-render/action-handler.js — "Invalid Server Actions request."; documented in
  //     next/dist/docs/01-app/02-guides/data-security.md). A cross-site form or fetch from an
  //     attacker page carries that site's Origin, so it is rejected before any action runs.
  //     `serverActions.allowedOrigins` is not configured, so only this host's own Origin passes.
  //  2. Cloudflare Access still fronts every /mini request, so an attacker's browser would also
  //     have to carry a valid CF_Authorization session.
  //  3. This cookie alone proves nothing else: lib/auth/guard.ts additionally requires a human
  //     email Access identity on /mini.
  // `Secure` is mandatory for SameSite=None and is set below; the app is HTTPS-only behind the
  // tunnel, so there is no plaintext path on which it could be dropped.
  response.headers.set(
    "Set-Cookie",
    `${MINI_COOKIE}=${cookieValue}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=43200`
  );
  return response;
}
