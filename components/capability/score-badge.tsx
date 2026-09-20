import { format, getDict, type Locale } from "../../lib/i18n";

/**
 * AI value score as a `★ 4/5` badge. Renders nothing when the card has no score (cards
 * filed before M3.5's backfill) — an unscored card must never read as a 0.
 *
 * `score_reason` is pinned at scoring time while `source_facts` refresh on every re-analysis,
 * so the reason lives in the badge's tooltip rather than inline next to any live number.
 */
export function ScoreBadge({
  score,
  reason,
  locale = "zh"
}: {
  score: number | null | undefined;
  reason?: string | null;
  locale?: Locale;
}) {
  if (typeof score !== "number" || score < 1) return null;
  const dict = getDict(locale).scoreBadge;
  return (
    <span className="badge badge--score" title={reason ?? undefined} aria-label={format(dict.aria, { score })}>
      {format(dict.label, { score })}
    </span>
  );
}
