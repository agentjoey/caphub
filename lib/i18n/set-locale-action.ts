"use server";
import { cookies } from "next/headers";
import type { Locale } from "./index";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Server Action used by `components/shell/lang-switch.tsx` to persist the chosen locale.
 *
 * A Server Action is a public POST endpoint: its parameter type is only a compile-time
 * contract, not a runtime guarantee — any client can call it with an arbitrary string in the
 * request body. Normalize here so only "zh" or "en" is ever persisted, regardless of what the
 * (possibly forged) argument actually is. */
export async function setLocaleAction(locale: Locale): Promise<void> {
  const value: Locale = locale === "en" ? "en" : "zh";
  const store = await cookies();
  store.set("lang", value, { path: "/", maxAge: ONE_YEAR_SECONDS, sameSite: "lax" });
}
