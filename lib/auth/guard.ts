import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessJwt } from "./access";
import { MINI_COOKIE, verifyMiniSession } from "../telegram/mini-session";

export interface GuardDeps {
  verify?: typeof verifyAccessJwt;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

// Deliberately minimal: a reason code and the path, nothing that could leak a credential (no
// token, no JWT claims, no common_name, no cookie value). This exists only so a rejected request
// leaves a trace instead of vanishing with no way to tell which check failed.
function logAuthRefusal(
  reason:
    | "no_token"
    | "verify_failed"
    | "allowlist_unset"
    | "cn_mismatch"
    | "mini_no_email"
    | "mini_secrets_unset"
    | "mini_session_invalid",
  path: string
): void {
  console.log(JSON.stringify({ event: "auth_refused", reason, path }));
}

export async function guardRequest(
  request: NextRequest,
  env: Record<string, string | undefined>,
  deps: GuardDeps = {}
): Promise<NextResponse> {
  if (env.NODE_ENV === "development" && env.ACCESS_BYPASS === "1") {
    return NextResponse.next();
  }

  const aud = env.CF_ACCESS_AUD;
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  if (!aud || !aud.trim() || !teamDomain || !teamDomain.trim()) {
    return unauthorized();
  }

  const path = request.nextUrl.pathname;
  const isMcp = path === "/api/mcp";

  const token = request.headers.get("cf-access-jwt-assertion") ?? request.cookies.get("CF_Authorization")?.value;
  if (!token) {
    if (isMcp) logAuthRefusal("no_token", path);
    return unauthorized();
  }

  const verify = deps.verify ?? verifyAccessJwt;
  try {
    const identity = await verify(token, { aud, teamDomain });
    if (isMcp) {
      const expected = env.CF_ACCESS_SERVICE_TOKEN_CN?.trim();
      // Fail closed: with no allowlisted common name configured, nobody gets in —
      // verifying the signature alone would let any service token in the same
      // Access team through this route.
      if (!expected) {
        logAuthRefusal("allowlist_unset", path);
        return unauthorized();
      }
      if (identity.commonName !== expected) {
        logAuthRefusal("cn_mismatch", path);
        return unauthorized();
      }
    } else if (path === "/api/mini/session" || path === "/mini" || path.startsWith("/mini/")) {
      // The Mini App's Access session is always a human email session — a service token
      // (common_name, no email) must not reach here even if it also holds a valid mini cookie.
      // Human and machine identities must not cross, so this is checked before anything else.
      if (!identity.email) {
        logAuthRefusal("mini_no_email", path);
        return unauthorized();
      }
      if (path === "/api/mini/session") {
        // /api/mini/session is how a client GETS the mini session cookie — it must still pass
        // Access (the check above), but it cannot require the very cookie it is about to issue.
        return NextResponse.next();
      }
      // /mini is the Telegram Mini App surface. Next server actions POST back to the current
      // page path, so gating this prefix covers page loads and writes alike, with no per-action
      // checks needed.
      const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
      const ownerId = env.TELEGRAM_OWNER_CHAT_ID?.trim();
      // Fail closed, exactly like /api/mcp: without the secrets we cannot verify anything, and
      // the bot token is not yet configured for the web service in production.
      if (!botToken || !ownerId) {
        logAuthRefusal("mini_secrets_unset", path);
        return unauthorized();
      }
      if (!verifyMiniSession(request.cookies.get(MINI_COOKIE)?.value, { botToken, ownerId })) {
        logAuthRefusal("mini_session_invalid", path);
        return unauthorized();
      }
    } else if (!identity.email) {
      return unauthorized();
    }
    return NextResponse.next();
  } catch {
    if (isMcp) logAuthRefusal("verify_failed", path);
    return unauthorized();
  }
}
