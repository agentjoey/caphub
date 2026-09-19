import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessJwt } from "./lib/auth/access";

export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === "development" && process.env.ACCESS_BYPASS === "1") {
    return NextResponse.next();
  }

  const token = request.headers.get("cf-access-jwt-assertion") ?? request.cookies.get("CF_Authorization")?.value;
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    await verifyAccessJwt(token, {
      aud: process.env.CF_ACCESS_AUD ?? "",
      teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN ?? ""
    });
    return NextResponse.next();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
