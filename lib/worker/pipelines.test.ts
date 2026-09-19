import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { Config } from "../config";
import type { ObjectStore } from "../storage/s3";
import { buildWorkerPipelines, selectPipelineDeps } from "./pipelines";

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
    retentionEnabled: true
  };
}

const pool = {} as Pool;
const objects = {} as ObjectStore;

describe("buildWorkerPipelines", () => {
  it("always builds minimax deps and leaves mixed unavailable without a Tavily key", () => {
    const pipelines = buildWorkerPipelines(config(undefined), pool, objects);
    expect(pipelines.minimax).toBeDefined();
    expect(pipelines.mixed).toBeUndefined();
  });

  it("builds mixed deps when a Tavily key is configured", () => {
    const pipelines = buildWorkerPipelines(config("tavily-key"), pool, objects);
    expect(pipelines.mixed).toBeDefined();
  });
});

describe("selectPipelineDeps", () => {
  it("selects deps by lease pipeline, or undefined when that pipeline is unavailable", () => {
    const pipelines = buildWorkerPipelines(config(undefined), pool, objects);
    expect(selectPipelineDeps(pipelines, "minimax")).toBe(pipelines.minimax);
    expect(selectPipelineDeps(pipelines, "mixed")).toBeUndefined();
  });
});
