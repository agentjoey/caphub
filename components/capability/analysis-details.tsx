import type { CapabilityDetail } from "../../lib/library/queries";
import { runStateLabel, errorLabel } from "../../lib/library/labels";
import { safeHttpUrl } from "../../lib/library/safe-url";
import { getDict, type Locale } from "../../lib/i18n";

function seconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(1);
}

function tokens(inputTokens: number | null, outputTokens: number | null): string {
  if (inputTokens === null && outputTokens === null) return "—";
  return `${inputTokens ?? 0} + ${outputTokens ?? 0}`;
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function AnalysisDetails({ detail, locale = "zh" }: { detail: CapabilityDetail; locale?: Locale }) {
  const dict = getDict(locale).analysisDetails;
  const stepLabels: Record<string, string> = { vision: dict.stepVision, search: dict.stepSearch, reason: dict.stepReason, review: dict.stepReview };
  const stepLabel = (step: string) => stepLabels[step] ?? step;

  return (
    <details className="analysis-details">
      <summary>{dict.summary}</summary>
      {detail.steps.length > 0 && (
        <div className="analysis-steps__scroll">
          <table className="analysis-steps">
            <thead>
              <tr><th>{dict.stepHeader}</th><th>{dict.serviceHeader}</th><th className="num">{dict.durationHeader}</th><th className="num">{dict.tokenHeader}</th><th>{dict.resultHeader}</th></tr>
            </thead>
            <tbody>
              {detail.steps.map((step, index) => (
                <tr key={index}>
                  <td>{stepLabel(step.step)}</td>
                  <td>{step.provider} / {step.model}</td>
                  <td className="num">{seconds(step.durationMs)}</td>
                  <td className="num">{tokens(step.inputTokens, step.outputTokens)}</td>
                  <td>{step.ok ? dict.success : (errorLabel(step.error, locale) || dict.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail.sources.length > 0 && (
        <ul className="analysis-sources">
          {detail.sources.map((source, index) => {
            // source.url comes straight from a stored search-step result (unvalidated JSON) —
            // same class of risk as source_facts.repo_url/homepage: only render an anchor when
            // it parses as http/https, otherwise fall back to plain text (see safeHttpUrl).
            const safe = safeHttpUrl(source.url);
            const body = (
              <>
                <span className="analysis-sources__title">{source.title}</span>
                <span className="analysis-sources__domain"> · {domain(source.url)}</span>
              </>
            );
            return (
              <li key={`${index}-${source.url}`}>
                {safe ? (
                  <a href={safe} target="_blank" rel="noreferrer" title={`${source.title} · ${source.url}`}>
                    {body}
                  </a>
                ) : (
                  <span title={`${source.title} · ${source.url}`}>{body}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <dl className="analysis-ids">
        <dt>{dict.captureLabel}</dt><dd>{detail.captureId}</dd>
        <dt>{dict.capabilityLabel}</dt><dd>{detail.id}</dd>
        <dt>{dict.runLabel}</dt><dd>{detail.runId} · {detail.runPipeline} · {runStateLabel(detail.runState, locale)}</dd>
      </dl>
    </details>
  );
}
