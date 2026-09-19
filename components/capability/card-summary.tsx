import type { CapabilityRow } from "../../lib/library/queries";
import { TYPE_LABEL, USAGE_LABEL, VERDICT_LABEL } from "../../lib/library/labels";
import { CapturePreview } from "./capture-preview";
import { TagList } from "./tag-list";
import { VerdictBadge } from "./verdict-badge";

export function CardSummary({ row }: { row: CapabilityRow }) {
  return (
    <article className="panel review-card">
      <CapturePreview capture={row.capture} size="thumb" />
      <div>
        <h2 className="card-title">{row.title}</h2>
        <p className="card-badges">
          <span className="badge badge--type">{TYPE_LABEL[row.type]}</span>
          <span className="badge badge--usage">{USAGE_LABEL[row.usage]}</span>
          <VerdictBadge verdict={row.verdict} verdictBy={row.verdictBy} />
        </p>
        <p className="card-suggestion">
          建议{VERDICT_LABEL[row.suggestedVerdict]} · 置信度 {row.confidence} — {row.suggestedReason}
        </p>
        <p className="card-summary">{row.summary}</p>
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
