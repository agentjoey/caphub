import Link from "next/link";
import type { CapabilityRow } from "../../lib/library/queries";
import { progressLabel, typeLabel, usageLabel } from "../../lib/library/labels";
import { displaySerial } from "../../lib/library/serial";
import { getDict, type Locale } from "../../lib/i18n";
import { ScoreBadge } from "../capability/score-badge";
import { TagList } from "../capability/tag-list";
import { SharedTitle } from "./shared-title";

/** Tags shown on a card before the `+N` remainder (M3.8 decision 4, carried over from the list row). */
const CARD_TAGS = 3;

/**
 * One capability in the library grid (owner rulings 2026-10-08: one card per capability, and no
 * screenshot on it — the capture is provenance, the card is about the capability). Typography
 * only: a mono kicker (type · serial, score on the right), the title, the summary lead, the
 * remaining badges, three quiet tags, and the age — plus, on a search, which parts of the card
 * the query hit. The whole card is one link.
 */
export function CapabilityCard({ row, locale, relativeTime }: { row: CapabilityRow; locale: Locale; relativeTime: string }) {
  const dict = getDict(locale);
  const serial = displaySerial(row.verdict, row.type, row.serial);
  const muted = row.status !== "active";
  const reasons = row.matchedBy ?? [];
  return (
    <Link className="cap-card" href={`/library/${row.id}`} data-muted={muted ? "" : undefined}>
      <div className="cap-card__body">
        <div className="cap-card__kicker">
          <span>{typeLabel(row.type, locale)}{serial && <span className="cap-card__serial"> · {serial}</span>}</span>
          <ScoreBadge score={row.score} reason={row.scoreReason} locale={locale} />
        </div>
        <SharedTitle id={row.id}>
          <h2 className="cap-card__title">{row.title}</h2>
        </SharedTitle>
        {row.summary.trim() !== "" && <p className="cap-card__summary">{row.summary}</p>}
        <div className="cap-card__badges">
          {row.usage === "reference" ? (
            <span className={`badge badge--progress${row.progress === "done" ? " badge--progress-done" : ""}`}>
              {progressLabel(row.progress, locale)}
            </span>
          ) : (
            <span className="badge badge--usage">{usageLabel(row.usage, locale)}</span>
          )}
          {row.status === "deprecated" && <span className="badge badge--status-deprecated">{dict.statusBadge.deprecated}</span>}
          {row.status === "superseded" && <span className="badge badge--status-superseded">{dict.statusBadge.supersededGeneric}</span>}
          {row.hasDeepAnalysis && <span className="badge badge--deep" title={dict.deepAnalysis.badgeAria}>{dict.deepAnalysis.badge}</span>}
        </div>
        <TagList tags={row.tags} max={CARD_TAGS} quiet />
        <div className="cap-card__foot">
          <span>{relativeTime}</span>
          {reasons.length > 0 && (
            <p className="cap-card__match">
              <span className="cap-card__match-label">{dict.library.matchedLabel}</span>
              {reasons.map((reason) => (
                <span key={reason} className="cap-card__reason">{dict.library.matchReason[reason]}</span>
              ))}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}
