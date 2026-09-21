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
  // SameSite=Lax is deliberate, not an oversight: the Mini App is scoped to the iOS/Android
  // Telegram clients, which render it same-site (a Lax cookie is sent there). Telegram Web and
  // Desktop render it in a cross-site iframe, where Lax is never sent, so those clients 401 —
  // accepted, because /library is one click away on desktop and this feature exists to remove
  // "leave Telegram and log in again" friction on the phone. SameSite=None would make this
  // cookie ride along on cross-site requests to a surface that can decide, retire and delete
  // capability cards — do not "fix" this without weighing that CSRF exposure. (Controller
  // ruling, task-1 review round 1.)
  response.headers.set(
    "Set-Cookie",
    `${MINI_COOKIE}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`
  );
  return response;
}
