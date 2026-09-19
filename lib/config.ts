import { z } from "zod";

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const boolTrue = z.enum(["true", "false"]).default("true").transform((v) => v === "true");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_READONLY: z.string().optional(),
  S3_ENDPOINT: z.string().url().refine((u) => u.startsWith("https://"), "S3_ENDPOINT must be https"),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().default("caphub-objects"),
  MINIMAX_API_KEY: z.string().min(1),
  DEEPSEEK_API_KEY: z.string().min(1),
  TAVILY_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_OWNER_CHAT_ID: z.string().optional(),
  CF_ACCESS_AUD: z.string().min(1),
  CF_ACCESS_TEAM_DOMAIN: z.string().min(1),
  PIPELINE: z.enum(["minimax", "mixed"]).default("minimax"),
  VERDICT_AUTO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  ANALYSIS_ENABLED: boolTrue,
  RETENTION_ENABLED: boolTrue,
  TELEGRAM_ENABLED: bool
});

export type Pipeline = "minimax" | "mixed";

export interface Config {
  databaseUrl: string;
  databaseUrlReadonly?: string;
  s3: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  providers: { minimaxApiKey: string; deepseekApiKey: string; tavilyApiKey?: string };
  telegram: { enabled: boolean; botToken?: string; ownerChatId?: string };
  access: { aud: string; teamDomain: string };
  pipeline: Pipeline;
  verdictAutoThreshold: number;
  analysisEnabled: boolean;
  retentionEnabled: boolean;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): Config {
  const e = envSchema.parse(env);
  if (e.PIPELINE === "mixed" && !e.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is required when PIPELINE=mixed");
  if (e.TELEGRAM_ENABLED && (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_OWNER_CHAT_ID)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID are required when TELEGRAM_ENABLED=true");
  }
  return {
    databaseUrl: e.DATABASE_URL,
    databaseUrlReadonly: e.DATABASE_URL_READONLY,
    s3: { endpoint: e.S3_ENDPOINT, region: e.S3_REGION, accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY, bucket: e.S3_BUCKET },
    providers: { minimaxApiKey: e.MINIMAX_API_KEY, deepseekApiKey: e.DEEPSEEK_API_KEY, tavilyApiKey: e.TAVILY_API_KEY },
    telegram: { enabled: e.TELEGRAM_ENABLED, botToken: e.TELEGRAM_BOT_TOKEN, ownerChatId: e.TELEGRAM_OWNER_CHAT_ID },
    access: { aud: e.CF_ACCESS_AUD, teamDomain: e.CF_ACCESS_TEAM_DOMAIN },
    pipeline: e.PIPELINE,
    verdictAutoThreshold: e.VERDICT_AUTO_THRESHOLD,
    analysisEnabled: e.ANALYSIS_ENABLED,
    retentionEnabled: e.RETENTION_ENABLED
  };
}
