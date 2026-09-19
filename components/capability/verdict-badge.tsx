import { verdictLabel } from "../../lib/library/labels";
import { getDict, type Locale } from "../../lib/i18n";

export function VerdictBadge({
  verdict,
  verdictBy,
  locale = "zh"
}: {
  verdict: "keep" | "discard" | "pending";
  verdictBy?: "auto" | "human" | null;
  locale?: Locale;
}) {
  const dict = getDict(locale).labels.verdictBy;
  return (
    <>
      <span className={`badge badge--${verdict}`}>{verdictLabel(verdict, locale)}</span>
      {verdictBy === "auto" && <span className="badge badge--auto">{dict.auto}</span>}
      {verdictBy === "human" && <span className="badge badge--human">{dict.human}</span>}
    </>
  );
}
