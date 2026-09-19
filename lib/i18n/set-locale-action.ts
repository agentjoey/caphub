"use server";
import { cookies } from "next/headers";
import type { Locale } from "./index";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Server Action used by `components/shell/lang-switch.tsx` to persist the chosen locale. */
export async function setLocaleAction(locale: Locale): Promise<void> {
  const store = await cookies();
  store.set("lang", locale, { path: "/", maxAge: ONE_YEAR_SECONDS, sameSite: "lax" });
}
