import "server-only";
import { cookies } from "next/headers";
import type { Locale } from "./index";

/** Server-only: reads the `lang` cookie (Server Components / Server Functions only — never
 * import this from a Client Component, `next/headers` is not available there). Defaults to
 * "zh"; any value other than "en" is treated as "zh". */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  return store.get("lang")?.value === "en" ? "en" : "zh";
}
