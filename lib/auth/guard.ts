import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessJwt } from "./access";

export interface GuardDeps {
  verify?: typeof verifyAccessJwt;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

// Deliberately minimal: a reason code and the path, nothing that could leak a credential (no
// token, no JWT claims, no common_name). This exists only so a rejected /api/mcp request leaves
// a trace instead of vanishing with no way to tell which check failed.
function logMcpRefusal(reason: "no_token" | "verify_failed" | "allowlist_unset" | "cn_mismatch", path: string): void {
  console.log(JSON.stringify({ event: "mcp_auth_refused", reason, path }));
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

  const isMcp = request.nextUrl.pathname === "/api/mcp";

  const token = request.headers.get("cf-access-jwt-assertion") ?? request.cookies.get("CF_Authorization")?.value;
  if (!token) {
    if (isMcp) logMcpRefusal("no_token", request.nextUrl.pathname);
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
        logMcpRefusal("allowlist_unset", request.nextUrl.pathname);
        return unauthorized();
      }
      if (identity.commonName !== expected) {
        logMcpRefusal("cn_mismatch", request.nextUrl.pathname);
        return unauthorized();
      }
    } else if (!identity.email) {
      return unauthorized();
    }
    return NextResponse.next();
  } catch {
    if (isMcp) logMcpRefusal("verify_failed", request.nextUrl.pathname);
    return unauthorized();
  }
}
