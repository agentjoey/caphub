import { dictZh } from "./dict-zh";
import { dictEn } from "./dict-en";

export type Locale = "zh" | "en";

/** Same shape as `dictZh`, but every leaf is just `string` — lets `dict-en.ts` be checked at
 * compile time against the zh dictionary's key set without forcing identical string literals. */
type DeepStringDict<T> = { [K in keyof T]: T[K] extends string ? string : DeepStringDict<T[K]> };

export type Dict = DeepStringDict<typeof dictZh>;

/** Pure and safe to import from both Server and Client Components (no `next/headers`). */
export function getDict(locale: Locale): Dict {
  return locale === "en" ? dictEn : dictZh;
}

/** `Intl` locale tag matching our two supported locales. */
export function intlLocale(locale: Locale): string {
  return locale === "en" ? "en-US" : "zh-CN";
}

/** Tiny `{name}` placeholder interpolation — no i18n library. Unknown placeholders are left as-is. */
export function format(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}
