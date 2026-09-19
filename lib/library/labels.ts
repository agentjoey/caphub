import type { CapabilityType } from "../analysis/card";
import { format, getDict, type Locale } from "../i18n";

/** zh-default exports kept for backward compatibility with call sites/tests that index by key
 * directly without a locale. Prefer the `*Label()` functions below for locale-aware UI text. */
export const TYPE_LABEL: Record<CapabilityType, string> = getDict("zh").labels.type;
export const USAGE_LABEL = getDict("zh").labels.usage;
export const VERDICT_LABEL = getDict("zh").labels.verdict;
export const RUN_STATE_LABEL = getDict("zh").labels.runState;

export function typeLabel(type: CapabilityType, locale: Locale = "zh"): string {
  return getDict(locale).labels.type[type];
}

export function usageLabel(usage: keyof typeof USAGE_LABEL, locale: Locale = "zh"): string {
  return getDict(locale).labels.usage[usage];
}

export function verdictLabel(verdict: keyof typeof VERDICT_LABEL, locale: Locale = "zh"): string {
  return getDict(locale).labels.verdict[verdict];
}

export function runStateLabel(state: string, locale: Locale = "zh"): string {
  return (getDict(locale).labels.runState as Record<string, string>)[state] ?? state;
}

export function errorLabel(code: string | null, locale: Locale = "zh"): string {
  if (!code) return "";
  const errors = getDict(locale).labels.errors as Record<string, string>;
  return errors[code] ?? format(errors.fallback, { code });
}
