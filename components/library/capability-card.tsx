import Link from "next/link";
import type { CapabilityRow } from "../../lib/library/queries";
import { progressLabel, typeLabel, usageLabel } from "../../lib/library/labels";
import { displaySerial } from "../../lib/library/serial";
import { getDict, type Locale } from "../../lib/i18n";
import { CapturePreview } from "../capability/capture-preview";
import { ScoreBadge } from "../capability/score-badge";
import { TagList } from "../capability/tag-list";
import { SharedTitle } from "./shared-title";

/** Tags shown on a card before the `+N` remainder (M3.8 decision 4, carried over from the list row). */
const CARD_TAGS = 3;

/**
 * One capability in the library grid (owner ruling 2026-10-08: one card per capability). The whole
 * card is a single link: media strip on top (screenshot, video frame or a typed placeholder), then
 * title + serial, the summary lead, the badges, three quiet tags, and the age — plus, on a search,
 * which parts of the card the query hit.
 */
export function CapabilityCard({ row, locale, relativeTime }: { row: CapabilityRow; locale: Locale; relativeTime: string }) {
  const dict = getDict(locale);
  const serial = displaySerial(row.verdict, row.type, row.serial);
  const muted = row.status !== "active";
  const reasons = row.matchedBy ?? [];
  return (
    <Link className="cap-card" href={`/library/${row.id}`} data-muted={muted ? "" : undefined}>
      <CapturePreview capture={row.capture} size="card" placeholder={typeLabel(row.type, locale)} locale={locale} />
      <div className="cap-card__body">
        <SharedTitle id={row.id}>
          <h2 className="cap-card__title">
            {row.title}
            {serial && <span className="serial"> {serial}</span>}
          </h2>
        </SharedTitle>
        {row.summary.trim() !== "" && <p className="cap-card__summary">{row.summary}</p>}
        <div className="cap-card__badges">
          <span className="badge badge--type">{typeLabel(row.type, locale)}</span>
          <ScoreBadge score={row.score} reason={row.scoreReason} locale={locale} />
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
