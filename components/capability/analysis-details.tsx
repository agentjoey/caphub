import type { CapabilityDetail } from "../../lib/library/queries";
import { runStateLabel, errorLabel } from "../../lib/library/labels";
import { getDict, type Locale } from "../../lib/i18n";

function seconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(1);
}

function tokens(inputTokens: number | null, outputTokens: number | null): string {
  if (inputTokens === null && outputTokens === null) return "—";
  return `${inputTokens ?? 0} + ${outputTokens ?? 0}`;
}

export function AnalysisDetails({ detail, locale = "zh" }: { detail: CapabilityDetail; locale?: Locale }) {
  const dict = getDict(locale).analysisDetails;
  const stepLabels: Record<string, string> = { vision: dict.stepVision, search: dict.stepSearch, reason: dict.stepReason, review: dict.stepReview };
  const stepLabel = (step: string) => stepLabels[step] ?? step;

  return (
    <details>
      <summary>{dict.summary}</summary>
      {detail.steps.length > 0 && (
        <table>
          <thead>
            <tr><th>{dict.stepHeader}</th><th>{dict.serviceHeader}</th><th>{dict.durationHeader}</th><th>{dict.tokenHeader}</th><th>{dict.resultHeader}</th></tr>
          </thead>
          <tbody>
            {detail.steps.map((step, index) => (
              <tr key={index}>
                <td>{stepLabel(step.step)}</td>
                <td>{step.provider} / {step.model}</td>
                <td>{seconds(step.durationMs)}</td>
                <td>{tokens(step.inputTokens, step.outputTokens)}</td>
                <td>{step.ok ? dict.success : (errorLabel(step.error, locale) || dict.failed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detail.sources.length > 0 && (
        <ul>
          {detail.sources.map((source, index) => (
            <li key={`${index}-${source.url}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>
          ))}
        </ul>
      )}
      <dl>
        <dt>{dict.captureLabel}</dt><dd>{detail.captureId}</dd>
        <dt>{dict.capabilityLabel}</dt><dd>{detail.id}</dd>
        <dt>{dict.runLabel}</dt><dd>{detail.runId} · {detail.runPipeline} · {runStateLabel(detail.runState, locale)}</dd>
      </dl>
    </details>
  );
}
