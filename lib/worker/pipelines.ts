import type { Pool } from "pg";
import { createPipelineDeps, type PipelineDeps } from "../analysis/pipeline";
import type { Config, Pipeline } from "../config";
import type { ObjectStore } from "../storage/s3";

export interface WorkerPipelines {
  minimax: PipelineDeps;
  mixed?: PipelineDeps;
}

/**
 * Builds the pipeline dependency sets the worker can run a lease against.
 * `minimax` deps are always available. `mixed` deps require a Tavily API
 * key; `createPipelineDeps` throws without one, so that case is treated as
 * "mixed unavailable" rather than a startup failure.
 */
export function buildWorkerPipelines(config: Config, pool: Pool, objects: ObjectStore): WorkerPipelines {
  const minimax = createPipelineDeps(config, pool, objects, "minimax");
  let mixed: PipelineDeps | undefined;
  if (config.providers.tavilyApiKey) {
    try {
      mixed = createPipelineDeps(config, pool, objects, "mixed");
    } catch {
      mixed = undefined;
    }
  }
  return { minimax, mixed };
}

/** Selects the deps for a lease's pipeline, or undefined if that pipeline has no deps this run. */
export function selectPipelineDeps(pipelines: WorkerPipelines, pipeline: Pipeline): PipelineDeps | undefined {
  return pipeline === "mixed" ? pipelines.mixed : pipelines.minimax;
}
