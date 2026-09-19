export type ProviderErrorCode = "TIMEOUT" | "AUTHENTICATION" | "BILLING" | "UNAVAILABLE" | "INVALID_OUTPUT" | "ABORTED" | "BUDGET";

export interface ProviderErrorOptions extends ErrorOptions {
  /** Raw provider text, truncated, kept when the HTTP call succeeded but the text was not parseable JSON. */
  raw?: string;
  /** Token usage reported alongside an otherwise-unparseable response. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Diagnostic detail (e.g. HTTP status + response body excerpt). Never includes headers or API keys. */
  detail?: string;
}

export class ProviderError extends Error {
  readonly raw?: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly detail?: string;

  constructor(readonly code: ProviderErrorCode, options?: ProviderErrorOptions) {
    super(`provider call failed: ${code}`, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.raw = options?.raw;
    this.usage = options?.usage;
    this.detail = options?.detail;
  }
}

export function failureForHttpStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "AUTHENTICATION";
  if (status === 402 || status === 429) return "BILLING";
  if (status === 400 || status === 422) return "INVALID_OUTPUT";
  return "UNAVAILABLE";
}
