import { z } from "zod";

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const boolTrue = z.enum(["true", "false"]).default("true").transform((v) => v === "true");
// An empty value (e.g. `KEY=` copied from .env.example) counts as unset.
const unsetIfEmpty = (v: unknown) => (v === "" ? undefined : v);
const optional = z.preprocess(unsetIfEmpty, z.string().optional());

const envSchema = z.object({
  DATABASE_URL: optional,
  DATABASE_URL_READONLY: optional,
  S3_ENDPOINT: z.preprocess(unsetIfEmpty, z.string().url().refine((u) => u.startsWith("https://"), "S3_ENDPOINT must be https").optional()),
  S3_REGION: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  S3_BUCKET: z.preprocess(unsetIfEmpty, z.string().default("caphub-objects")),
  MINIMAX_API_KEY: optional,
  DEEPSEEK_API_KEY: optional,
  TAVILY_API_KEY: optional,
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_OWNER_CHAT_ID: optional,
  CF_ACCESS_AUD: optional,
  CF_ACCESS_TEAM_DOMAIN: optional,
  PIPELINE: z.enum(["minimax", "mixed"]).default("minimax"),
  VERDICT_AUTO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  ANALYSIS_ENABLED: boolTrue,
  RETENTION_ENABLED: boolTrue,
  TELEGRAM_ENABLED: bool
});
type Env = z.infer<typeof envSchema>;

export type Pipeline = "minimax" | "mixed";
/** Which process is loading config: each Railway service / local script only requires what it uses. */
export type ConfigRole = "web" | "worker" | "script";

export interface S3Config { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string }

export interface Config {
  databaseUrl: string;
  /** Local-only (vault-sync); never set on Railway. */
  databaseUrlReadonly?: string;
  s3?: S3Config;
  providers: { minimaxApiKey?: string; deepseekApiKey?: string; tavilyApiKey?: string };
  telegram: { enabled: boolean; botToken?: string; ownerChatId?: string };
  access?: { aud: string; teamDomain: string };
  pipeline: Pipeline;
  verdictAutoThreshold: number;
  analysisEnabled: boolean;
  retentionEnabled: boolean;
}
export type WebConfig = Config & { s3: S3Config; access: { aud: string; teamDomain: string } };
export type WorkerConfig = Config & { s3: S3Config; providers: { minimaxApiKey: string; deepseekApiKey: string; tavilyApiKey?: string } };

const S3_VARS = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

function requiredFor(role: ConfigRole, e: Env): Array<keyof Env> {
  switch (role) {
    case "web": return ["DATABASE_URL", ...S3_VARS, "CF_ACCESS_AUD", "CF_ACCESS_TEAM_DOMAIN"];
    case "worker": return [
      "DATABASE_URL", ...S3_VARS, "MINIMAX_API_KEY", "DEEPSEEK_API_KEY",
      ...(e.PIPELINE === "mixed" ? ["TAVILY_API_KEY" as const] : []),
      ...(e.TELEGRAM_ENABLED ? ["TELEGRAM_BOT_TOKEN" as const, "TELEGRAM_OWNER_CHAT_ID" as const] : [])
    ];
    case "script": return ["DATABASE_URL"];
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>, role: "web"): WebConfig;
export function loadConfig(env: Readonly<Record<string, string | undefined>>, role: "worker"): WorkerConfig;
export function loadConfig(env: Readonly<Record<string, string | undefined>>, role: "script"): Config;
export function loadConfig(env: Readonly<Record<string, string | undefined>>, role: ConfigRole): Config {
  const e = envSchema.parse(env);
  const missing = requiredFor(role, e).filter((k) => e[k] === undefined);
  if (missing.length) throw new Error(`${missing.join(", ")} required for ${role} (PIPELINE=${e.PIPELINE}, TELEGRAM_ENABLED=${e.TELEGRAM_ENABLED})`);
  const s3 = S3_VARS.every((k) => e[k] !== undefined)
    ? { endpoint: e.S3_ENDPOINT!, region: e.S3_REGION!, accessKeyId: e.S3_ACCESS_KEY_ID!, secretAccessKey: e.S3_SECRET_ACCESS_KEY!, bucket: e.S3_BUCKET }
    : undefined;
  return {
    databaseUrl: e.DATABASE_URL!,
    databaseUrlReadonly: e.DATABASE_URL_READONLY,
    s3,
    providers: { minimaxApiKey: e.MINIMAX_API_KEY, deepseekApiKey: e.DEEPSEEK_API_KEY, tavilyApiKey: e.TAVILY_API_KEY },
    telegram: { enabled: e.TELEGRAM_ENABLED, botToken: e.TELEGRAM_BOT_TOKEN, ownerChatId: e.TELEGRAM_OWNER_CHAT_ID },
    access: e.CF_ACCESS_AUD && e.CF_ACCESS_TEAM_DOMAIN ? { aud: e.CF_ACCESS_AUD, teamDomain: e.CF_ACCESS_TEAM_DOMAIN } : undefined,
    pipeline: e.PIPELINE,
    verdictAutoThreshold: e.VERDICT_AUTO_THRESHOLD,
    analysisEnabled: e.ANALYSIS_ENABLED,
    retentionEnabled: e.RETENTION_ENABLED
  };
}
