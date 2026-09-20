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

/** Self-build progress states, mirroring migration 007's CHECK constraint. Only meaningful for `usage = 'reference'` cards. */
export const PROGRESS_VALUES = ["todo", "planned", "building", "done", "dropped"] as const;
export type Progress = (typeof PROGRESS_VALUES)[number];

export function isProgress(value: unknown): value is Progress {
  return typeof value === "string" && (PROGRESS_VALUES as readonly string[]).includes(value);
}

export function progressLabel(progress: Progress, locale: Locale = "zh"): string {
  return getDict(locale).labels.progress[progress];
}

export function runStateLabel(state: string, locale: Locale = "zh"): string {
  return (getDict(locale).labels.runState as Record<string, string>)[state] ?? state;
}

export function errorLabel(code: string | null, locale: Locale = "zh"): string {
  if (!code) return "";
  const errors = getDict(locale).labels.errors as Record<string, string>;
  return errors[code] ?? format(errors.fallback, { code });
}
