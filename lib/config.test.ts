import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const db = { DATABASE_URL: "postgres://u:p@h/db" };
const s3 = { S3_ENDPOINT: "https://s3.example.com", S3_REGION: "ap-southeast-1", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", S3_BUCKET: "caphub-objects" };
const providers = { MINIMAX_API_KEY: "m", DEEPSEEK_API_KEY: "d" };
const access = { CF_ACCESS_AUD: "aud", CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" };
const web = { ...db, ...s3, ...access };
const worker = { ...db, ...s3, ...providers };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(worker, "worker");
    expect(c.pipeline).toBe("minimax");
    expect(c.verdictAutoThreshold).toBe(0.8);
    expect(c.analysisEnabled).toBe(true);
    expect(c.telegram.enabled).toBe(false);
  });
  it("rejects non-https s3 endpoint", () => {
    expect(() => loadConfig({ ...worker, S3_ENDPOINT: "http://x" }, "worker")).toThrow();
  });
});

describe("loadConfig web", () => {
  it("needs DATABASE_URL, S3_* and CF_ACCESS_*, but no provider keys or Telegram", () => {
    const c = loadConfig({ ...web, PIPELINE: "mixed", TELEGRAM_ENABLED: "true" }, "web");
    expect(c.access).toEqual({ aud: "aud", teamDomain: "team.cloudflareaccess.com" });
    expect(c.s3.bucket).toBe("caphub-objects");
    expect(c.providers).toEqual({ minimaxApiKey: undefined, deepseekApiKey: undefined, tavilyApiKey: undefined, geminiApiKey: undefined });
  });
  it("is not required for web or worker, but is passed through when set", () => {
    expect(loadConfig(web, "web").providers.geminiApiKey).toBeUndefined();
    expect(loadConfig(worker, "worker").providers.geminiApiKey).toBeUndefined();
    expect(loadConfig({ ...worker, GEMINI_API_KEY: "g" }, "worker").providers.geminiApiKey).toBe("g");
  });
  it("names every missing web variable", () => {
    expect(() => loadConfig({ ...db, ...s3 }, "web")).toThrow(/CF_ACCESS_AUD, CF_ACCESS_TEAM_DOMAIN required for web/);
    expect(() => loadConfig({ ...db, ...access }, "web")).toThrow(/S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY required for web/);
  });
  it("treats empty values as unset", () => {
    expect(() => loadConfig({ ...web, CF_ACCESS_AUD: "" }, "web")).toThrow(/CF_ACCESS_AUD required for web/);
  });
});

describe("loadConfig worker", () => {
  it("does not need CF_ACCESS_*", () => {
    expect(loadConfig(worker, "worker").access).toBeUndefined();
  });
  it("requires provider keys and S3", () => {
    expect(() => loadConfig({ ...db, ...s3 }, "worker")).toThrow(/MINIMAX_API_KEY, DEEPSEEK_API_KEY required for worker/);
    expect(() => loadConfig({ ...db, ...providers }, "worker")).toThrow(/S3_ENDPOINT/);
  });
  it("requires tavily key when pipeline is mixed", () => {
    expect(() => loadConfig({ ...worker, PIPELINE: "mixed" }, "worker")).toThrow(/TAVILY_API_KEY/);
    expect(loadConfig({ ...worker, PIPELINE: "mixed", TAVILY_API_KEY: "t" }, "worker").providers.tavilyApiKey).toBe("t");
  });
  it("requires tavily key when pipeline is minimax_tavily", () => {
    expect(() => loadConfig({ ...worker, PIPELINE: "minimax_tavily" }, "worker")).toThrow(/TAVILY_API_KEY/);
    expect(loadConfig({ ...worker, PIPELINE: "minimax_tavily", TAVILY_API_KEY: "t" }, "worker").pipeline).toBe("minimax_tavily");
  });
  it("requires telegram fields when enabled", () => {
    expect(() => loadConfig({ ...worker, TELEGRAM_ENABLED: "true" }, "worker")).toThrow(/TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID/);
  });
  it("fails fast on a non-numeric TELEGRAM_OWNER_CHAT_ID when enabled, instead of letting it become NaN downstream", () => {
    expect(() =>
      loadConfig({ ...worker, TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_CHAT_ID: "not-a-number" }, "worker")
    ).toThrow(/TELEGRAM_OWNER_CHAT_ID must be a valid integer/);
  });
  it("accepts a numeric TELEGRAM_OWNER_CHAT_ID when enabled", () => {
    const c = loadConfig({ ...worker, TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_CHAT_ID: "123456" }, "worker");
    expect(c.telegram.ownerChatId).toBe("123456");
  });
  it("does not validate TELEGRAM_OWNER_CHAT_ID's format when telegram is disabled", () => {
    expect(() => loadConfig({ ...worker, TELEGRAM_OWNER_CHAT_ID: "not-a-number" }, "worker")).not.toThrow();
  });
});

describe("loadConfig script", () => {
  it("needs only DATABASE_URL; S3 is optional and typed so", () => {
    const c = loadConfig(db, "script");
    expect(c.databaseUrl).toBe("postgres://u:p@h/db");
    expect(c.s3).toBeUndefined();
    expect(loadConfig({ ...db, ...s3 }, "script").s3?.endpoint).toBe("https://s3.example.com");
  });
  it("fails without DATABASE_URL", () => {
    expect(() => loadConfig({}, "script")).toThrow(/DATABASE_URL required for script/);
  });
});
