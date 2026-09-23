import type { CapabilityRow } from "../../lib/library/queries";
import { typeLabel, usageLabel, verdictLabel } from "../../lib/library/labels";
import { format, getDict, type Locale } from "../../lib/i18n";
import { captureTextExcerpt } from "../../lib/text/excerpt";
import { CapturePreview } from "./capture-preview";
import { PromptNotice } from "./prompt-notice";
import { SummaryBody } from "./summary-points";
import { TagList } from "./tag-list";
import { VerdictBadge } from "./verdict-badge";

export function CardSummary({ row, locale = "zh" }: { row: CapabilityRow; locale?: Locale }) {
  const dict = getDict(locale).cardSummary;
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
        <p className="card-suggestion">
          {format(dict.suggestion, { verdict: verdictLabel(row.suggestedVerdict, locale), confidence: row.confidence, reason: row.suggestedReason })}
        </p>
        <PromptNotice type={row.type} promptCount={row.promptCount} promptUnresolved={row.promptUnresolved} locale={locale} />
        {row.capture.kind === "text" && row.capture.text && (
          <p className="capture-text">{captureTextExcerpt(row.capture.text)}</p>
        )}
        {row.capture.kind === "url" && row.capture.url && (
          <p><a className="capture-url" href={row.capture.url} target="_blank" rel="noreferrer">{row.capture.url}</a></p>
        )}
        <SummaryBody summary={row.summary} points={row.summaryPoints} className="card-summary" />
        {row.signals.length > 0 && (
          <ul className="card-signals">
            {row.signals.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        )}
        <TagList tags={row.tags} />
      </div>
    </article>
  );
}
