import type { Pool } from "pg";
import { createPipelineDeps, type PipelineDeps } from "../analysis/pipeline";
import type { Config, Pipeline } from "../config";
import type { ObjectStore } from "../storage/s3";

export interface WorkerPipelines {
  minimax: PipelineDeps;
  mixed?: PipelineDeps;
  minimax_tavily?: PipelineDeps;
}

/**
 * Builds the pipeline dependency sets the worker can run a lease against.
 * `minimax` deps are always available. `mixed` and `minimax_tavily` deps are built only
 * when a Tavily API key is configured, since `createPipelineDeps` requires one for both;
 * without a key, they are simply left unavailable.
 */
export function buildWorkerPipelines(config: Config, pool: Pool, objects: ObjectStore): WorkerPipelines {
  const minimax = createPipelineDeps(config, pool, objects, "minimax");
  const mixed = config.providers.tavilyApiKey ? createPipelineDeps(config, pool, objects, "mixed") : undefined;
  const minimax_tavily = config.providers.tavilyApiKey ? createPipelineDeps(config, pool, objects, "minimax_tavily") : undefined;
  return { minimax, mixed, minimax_tavily };
}

/** Selects the deps for a lease's pipeline, or undefined if that pipeline has no deps this run. */
export function selectPipelineDeps(pipelines: WorkerPipelines, pipeline: Pipeline): PipelineDeps | undefined {
  if (pipeline === "mixed") return pipelines.mixed;
  if (pipeline === "minimax_tavily") return pipelines.minimax_tavily;
  return pipelines.minimax;
}
