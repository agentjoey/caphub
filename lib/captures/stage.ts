import { parseYouTubeUrl } from "../analysis/material/youtube";

/**
 * The stages a running analysis is shown passing through (lib/analysis/pipeline.ts): reading the
 * screenshot (`read`) or watching the video (`watch`) — both the `vision` step — then `search`,
 * `reason`, and finally storing the card and its verdict (`verdict`, which records no step of its
 * own). Text and plain links skip the first stage entirely.
 */
export type Stage = "read" | "watch" | "search" | "reason" | "verdict";

export interface StageView { stages: Stage[]; current: Stage }

const STEP_FOR: Record<Exclude<Stage, "verdict">, string> = { read: "vision", watch: "vision", search: "search", reason: "reason" };

/**
 * `okSteps` are the step names the current run has recorded as succeeded (failed attempts are
 * excluded by the caller), so a retrying step stays current until it actually succeeds.
 */
export function pipelineStages(kind: "image" | "text" | "url", url: string | null, okSteps: readonly string[]): StageView {
  const first: Stage[] = kind === "image" ? ["read"] : kind === "url" && url && parseYouTubeUrl(url) ? ["watch"] : [];
  const stages: Stage[] = [...first, "search", "reason", "verdict"];
  const done = new Set(okSteps);
  const current = stages.find((stage) => stage === "verdict" || !done.has(STEP_FOR[stage])) ?? "verdict";
  return { stages, current };
}
