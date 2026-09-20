import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessJwt } from "./access";

export interface GuardDeps {
  verify?: typeof verifyAccessJwt;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  const token = request.headers.get("cf-access-jwt-assertion") ?? request.cookies.get("CF_Authorization")?.value;
  if (!token) {
    return unauthorized();
  }

  const verify = deps.verify ?? verifyAccessJwt;
  try {
    const identity = await verify(token, { aud, teamDomain });
    const isMcp = request.nextUrl.pathname === "/api/mcp";
    if (isMcp) {
      const expected = env.CF_ACCESS_SERVICE_TOKEN_CN?.trim();
      // Fail closed: with no allowlisted common name configured, nobody gets in —
      // verifying the signature alone would let any service token in the same
      // Access team through this route.
      if (!expected || identity.commonName !== expected) return unauthorized();
    } else if (!identity.email) {
      return unauthorized();
    }
    return NextResponse.next();
  } catch {
    return unauthorized();
  }
}
