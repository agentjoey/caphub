import { beforeEach, describe, expect, it, vi } from "vitest";

const wakeWorker = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/worker/wake", () => ({ wakeWorker: (...args: unknown[]) => wakeWorker(...args) }));
vi.mock("../lib/runtime", () => ({ getRuntime: () => ({ pool: {}, config: { pipeline: "mixed" } }) }));
vi.mock("../lib/i18n/locale", () => ({ getLocale: async () => "zh" }));
vi.mock("../lib/library/actions", () => {
  const ok = async () => ({ ok: true, updatedAt: "2026-10-12T00:00:00.000Z" });
  return {
    decide: ok, editSuggestion: ok, ignoreOverlap: ok, requestDeepAnalysis: ok, requestRerun: ok, requestReview: ok,
    setProgress: ok, setStatus: ok, softDelete: ok, supersedeOverlapTarget: ok
  };
});

const actions = await import("./actions");

beforeEach(() => wakeWorker.mockClear());

describe("server actions wake the idle worker", () => {
  it.each([
    ["decideAction", () => actions.decideAction("cab_1", "t", "keep")],
    ["rerunAction", () => actions.rerunAction("cap_1")],
    ["deepAnalysisAction", () => actions.deepAnalysisAction("cap_1")],
    ["reviewAction", () => actions.reviewAction("cab_1")],
    ["editSuggestionAction", () => actions.editSuggestionAction("cab_1", "t", "skill", "integrate", ["a"])]
  ])("%s", async (_name, call) => {
    await call();
    expect(wakeWorker).toHaveBeenCalledTimes(1);
  });
});
