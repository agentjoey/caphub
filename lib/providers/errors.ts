export type ProviderErrorCode = "TIMEOUT" | "AUTHENTICATION" | "BILLING" | "UNAVAILABLE" | "INVALID_OUTPUT" | "ABORTED" | "BUDGET";

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, options?: ErrorOptions) {
    super(`provider call failed: ${code}`, options);
    this.name = "ProviderError";
  }
}

export function failureForHttpStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "AUTHENTICATION";
  if (status === 402 || status === 429) return "BILLING";
  if (status === 400 || status === 422) return "INVALID_OUTPUT";
  return "UNAVAILABLE";
}
