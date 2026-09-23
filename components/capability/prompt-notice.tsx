import type { CapabilityType } from "../../lib/analysis/card";
import { format, getDict, type Locale } from "../../lib/i18n";

/** Review hint for the two cases decideVerdict routes to Review for missing verbatim prompts. */
export function PromptNotice({ type, promptCount, promptUnresolved, locale = "zh" }: {
  type: CapabilityType; promptCount: number; promptUnresolved: number; locale?: Locale;
}) {
  const dict = getDict(locale).cardSummary;
  if (promptUnresolved > 0) return <p className="prompt-notice">{format(dict.promptUnresolved, { count: promptUnresolved })}</p>;
  if (type === "prompt" && promptCount === 0) return <p className="prompt-notice">{dict.promptMissing}</p>;
  return null;
}
