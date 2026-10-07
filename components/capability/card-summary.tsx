import type { CapabilityRow } from "../../lib/library/queries";
import { typeLabel, usageLabel, verdictLabel } from "../../lib/library/labels";
import { format, getDict, type Locale } from "../../lib/i18n";
import { captureTextExcerpt } from "../../lib/text/excerpt";
import { CapturePreview } from "./capture-preview";
import { PromptNotice } from "./prompt-notice";
import { SummaryBody } from "./summary-points";
import { TagList } from "./tag-list";
import { VerdictBadge } from "./verdict-badge";

/**
 * A pending card as Review shows it (desktop and Mini App). Summary first (owner ruling
 * 2026-10-08: reviews mostly go on the summary and trust the assessment): title, badges, the
 * suggested verdict, any prompt warning and the summary lead stay open; the structured points,
 * value signals, the original text/link and tags fold into "完整摘要".
 */
export function CardSummary({ row, locale = "zh" }: { row: CapabilityRow; locale?: Locale }) {
  const dict = getDict(locale).cardSummary;
  const points = row.summaryPoints ?? [];
  const captureText = row.capture.kind === "text" && row.capture.text ? row.capture.text : null;
  const captureUrl = row.capture.kind === "url" && row.capture.url ? row.capture.url : null;
  const hasMore = points.length > 0 || row.signals.length > 0 || row.tags.length > 0 || captureText !== null || captureUrl !== null;
  return (
    <article className="panel review-card">
      <CapturePreview capture={row.capture} size="thumb" locale={locale} />
      <div>
        <h2 className="card-title">{row.title}</h2>
        <p className="card-badges">
          <span className="badge badge--type">{typeLabel(row.type, locale)}</span>
          <span className="badge badge--usage">{usageLabel(row.usage, locale)}</span>
          <VerdictBadge verdict={row.verdict} verdictBy={row.verdictBy} locale={locale} />
        </p>
        <p className="card-suggestion" data-verdict={row.suggestedVerdict}>
          {format(dict.suggestion, { verdict: verdictLabel(row.suggestedVerdict, locale), confidence: row.confidence, reason: row.suggestedReason })}
        </p>
        <PromptNotice type={row.type} promptCount={row.promptCount} promptUnresolved={row.promptUnresolved} locale={locale} />
        <SummaryBody summary={row.summary} points={[]} className="card-summary" />
        {hasMore && (
          <details className="card-more">
            <summary>{points.length > 0 ? format(dict.morePoints, { count: points.length }) : dict.more}</summary>
            <SummaryBody summary="" points={points} />
            {row.signals.length > 0 && (
              <ul className="card-signals">
                {row.signals.map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            )}
            {captureText && <p className="capture-text">{captureTextExcerpt(captureText)}</p>}
            {captureUrl && <p className="card-more__source"><a className="capture-url" href={captureUrl} target="_blank" rel="noreferrer">{captureUrl}</a></p>}
            <TagList tags={row.tags} />
          </details>
        )}
      </div>
    </article>
  );
}
