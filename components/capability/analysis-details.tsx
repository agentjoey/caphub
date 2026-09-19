import type { CapabilityDetail } from "../../lib/library/queries";
import { RUN_STATE_LABEL, errorLabel } from "../../lib/library/labels";

const STEP_LABEL: Record<string, string> = { vision: "看图", search: "搜索", reason: "分析", review: "复核" };

function stepLabel(step: string): string {
  return STEP_LABEL[step] ?? step;
}

function runStateLabel(state: string): string {
  return (RUN_STATE_LABEL as Record<string, string>)[state] ?? state;
}

function seconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(1);
}

function tokens(inputTokens: number | null, outputTokens: number | null): string {
  if (inputTokens === null && outputTokens === null) return "—";
  return `${inputTokens ?? 0} + ${outputTokens ?? 0}`;
}

export function AnalysisDetails({ detail }: { detail: CapabilityDetail }) {
  return (
    <details>
      <summary>详情</summary>
      {detail.steps.length > 0 && (
        <table>
          <thead>
            <tr><th>步骤</th><th>服务</th><th>耗时 s</th><th>token</th><th>结果</th></tr>
          </thead>
          <tbody>
            {detail.steps.map((step, index) => (
              <tr key={index}>
                <td>{stepLabel(step.step)}</td>
                <td>{step.provider} / {step.model}</td>
                <td>{seconds(step.durationMs)}</td>
                <td>{tokens(step.inputTokens, step.outputTokens)}</td>
                <td>{step.ok ? "成功" : (errorLabel(step.error) || "失败")}</td>
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
        <dt>投递</dt><dd>{detail.captureId}</dd>
        <dt>能力卡</dt><dd>{detail.id}</dd>
        <dt>分析运行</dt><dd>{detail.runId} · {detail.runPipeline} · {runStateLabel(detail.runState)}</dd>
      </dl>
    </details>
  );
}
