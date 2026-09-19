import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const base = {
  DATABASE_URL: "postgres://u:p@h/db",
  S3_ENDPOINT: "https://s3.example.com", S3_REGION: "ap-southeast-1",
  S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", S3_BUCKET: "caphub-objects",
  MINIMAX_API_KEY: "m", DEEPSEEK_API_KEY: "d",
  CF_ACCESS_AUD: "aud", CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com"
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.pipeline).toBe("minimax");
    expect(c.verdictAutoThreshold).toBe(0.8);
    expect(c.analysisEnabled).toBe(true);
    expect(c.telegram.enabled).toBe(false);
  });
  it("requires tavily key when pipeline is mixed", () => {
    expect(() => loadConfig({ ...base, PIPELINE: "mixed" })).toThrow(/TAVILY_API_KEY/);
  });
  it("requires telegram fields when enabled", () => {
    expect(() => loadConfig({ ...base, TELEGRAM_ENABLED: "true" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
  it("rejects non-https s3 endpoint", () => {
    expect(() => loadConfig({ ...base, S3_ENDPOINT: "http://x" })).toThrow();
  });
});
