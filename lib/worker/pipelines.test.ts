import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { Config } from "../config";
import type { Lease } from "../queue/runs";
import type { ObjectStore } from "../storage/s3";
import { buildWorkerPipelines, selectPipelineDeps } from "./pipelines";
import { runTick } from "./tick";

function config(tavilyApiKey?: string): Config {
  return {
    databaseUrl: "postgres://x",
    s3: { endpoint: "https://x", region: "auto", accessKeyId: "a", secretAccessKey: "b", bucket: "bucket" },
    providers: { minimaxApiKey: "m", deepseekApiKey: "d", tavilyApiKey },
    telegram: { enabled: false },
    access: { aud: "aud", teamDomain: "team" },
    pipeline: "minimax",
    verdictAutoThreshold: 0.8,
    analysisEnabled: true,
    retentionEnabled: true,
    geminiVideoModel: "gemini-3.8-flash"
  };
}

const pool = {} as Pool;
const objects = {} as ObjectStore;

describe("buildWorkerPipelines", () => {
  it("always builds minimax deps and leaves mixed/minimax_tavily unavailable without a Tavily key", () => {
    const pipelines = buildWorkerPipelines(config(undefined), pool, objects);
    expect(pipelines.minimax).toBeDefined();
    expect(pipelines.mixed).toBeUndefined();
    expect(pipelines.minimax_tavily).toBeUndefined();
  });

  it("builds mixed and minimax_tavily deps when a Tavily key is configured", () => {
    const pipelines = buildWorkerPipelines(config("tavily-key"), pool, objects);
    expect(pipelines.mixed).toBeDefined();
    expect(pipelines.minimax_tavily).toBeDefined();
  });
});

describe("selectPipelineDeps", () => {
  it("selects deps by lease pipeline, or undefined when that pipeline is unavailable", () => {
    const pipelines = buildWorkerPipelines(config(undefined), pool, objects);
    expect(selectPipelineDeps(pipelines, "minimax")).toBe(pipelines.minimax);
    expect(selectPipelineDeps(pipelines, "mixed")).toBeUndefined();
    expect(selectPipelineDeps(pipelines, "minimax_tavily")).toBeUndefined();
  });

  it("selects minimax_tavily deps when available", () => {
    const pipelines = buildWorkerPipelines(config("tavily-key"), pool, objects);
    expect(selectPipelineDeps(pipelines, "minimax_tavily")).toBe(pipelines.minimax_tavily);
  });
});

describe("a lease whose pipeline has no deps", () => {
  it("finishes failed with PIPELINE_UNAVAILABLE through runTick", async () => {
    const pipelines = buildWorkerPipelines(config(undefined), pool, objects);
    const lease: Lease = { runId: "run_1", captureId: "cap_1", pipeline: "mixed", ownerToken: "t" };
    const finished: unknown[] = [];
    const queue = {
      claim: async () => lease,
      heartbeat: async () => true,
      finish: async (_l: unknown, o: unknown) => { finished.push(o); return true; }
    };
    const run = (l: Lease) => {
      const deps = selectPipelineDeps(pipelines, l.pipeline);
      if (!deps) throw Object.assign(new Error(`no pipeline deps available for '${l.pipeline}'`), { code: "PIPELINE_UNAVAILABLE" });
      return Promise.resolve(deps);
    };
    await runTick({ queue, run, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal);
    expect(finished).toEqual([{ state: "failed", errorCode: "PIPELINE_UNAVAILABLE", errorMessage: "no pipeline deps available for 'mixed'" }]);
  });
});
