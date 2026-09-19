import { ProviderError } from "../providers/errors";

export class RunBudget {
  calls = 0;
  tokens = 0;
  constructor(readonly limits: { maxCalls: number; maxTokens: number } = { maxCalls: 4, maxTokens: 200_000 }) {}
  assertCanCall(): void {
    if (this.calls >= this.limits.maxCalls) throw new ProviderError("BUDGET");
  }
  charge(tokens: number): void {
    this.tokens += tokens;
    if (this.tokens > this.limits.maxTokens) throw new ProviderError("BUDGET");
  }
}
