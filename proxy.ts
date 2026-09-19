import type { NextRequest } from "next/server";
import { guardRequest } from "./lib/auth/guard";

export const config = { matcher: ["/((?!_next/static|_next/image|favicon\\.ico$).*)"] };

export async function proxy(request: NextRequest) {
  return guardRequest(request, process.env);
}
