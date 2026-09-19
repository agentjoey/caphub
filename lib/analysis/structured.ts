import type { Pool } from "pg";
import type { z } from "zod";
import { ProviderError } from "../providers/errors";
import type { RunBudget } from "./budget";
import { recordStep, type StepName } from "./steps";

export interface StructuredInput {
  prompt: string;
  images?: Array<{ data: Uint8Array; mediaType: string }>;
  schemaName: string;
  schema: z.ZodType;
  correction?: { issues: string[] };
}

export interface StructuredCall {
  provider: string;
  model: string;
  invoke(input: StructuredInput, signal: AbortSignal): Promise<{ value: unknown; usage: { inputTokens: number; outputTokens: number } }>;
}

export interface RunStructuredRequest<T> {
  pool: Pick<Pool, "query">; runId: string; step: StepName; call: StructuredCall;
  prompt: string; images?: StructuredInput["images"]; schemaName: string; schema: z.ZodType<T>;
  budget: RunBudget; timeoutMs: number; signal: AbortSignal;
}

function withTimeout(signal: AbortSignal, ms: number): { signal: AbortSignal; clear(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort();
  return { signal: controller.signal, clear: () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }, timedOut: () => timedOut };
}

export async function runStructured<T>(req: RunStructuredRequest<T>): Promise<T> {
  let issues: string[] | undefined;
  for (const attempt of [1, 2] as const) {
    req.budget.assertCanCall();
    req.budget.calls += 1;
    const t = withTimeout(req.signal, req.timeoutMs);
    const started = Date.now();
    const base = { runId: req.runId, step: req.step, provider: req.call.provider, model: req.call.model, attempt };
    let raw: Awaited<ReturnType<StructuredCall["invoke"]>>;
    try {
      raw = await req.call.invoke({ prompt: req.prompt, images: req.images, schemaName: req.schemaName, schema: req.schema, ...(issues ? { correction: { issues } } : {}) }, t.signal);
    } catch (error) {
      const code = t.timedOut() ? "TIMEOUT" : error instanceof ProviderError ? error.code : "UNAVAILABLE";
      await recordStep(req.pool, { ...base, durationMs: Date.now() - started, ok: false, error: code });
      throw new ProviderError(code, { cause: error });
    } finally {
      t.clear();
    }
    const durationMs = Date.now() - started;
    req.budget.charge(raw.usage.inputTokens + raw.usage.outputTokens);
    const parsed = req.schema.safeParse(raw.value);
    if (parsed.success) {
      await recordStep(req.pool, { ...base, inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens, durationMs, ok: true, output: parsed.data });
      return parsed.data;
    }
    issues = parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`);
    await recordStep(req.pool, { ...base, inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens, durationMs, ok: false, error: "INVALID_OUTPUT", output: raw.value });
  }
  throw new ProviderError("INVALID_OUTPUT");
}
