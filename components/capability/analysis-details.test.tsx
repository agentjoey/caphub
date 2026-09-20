// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AnalysisDetails } from "./analysis-details";

afterEach(cleanup);

const base = {
  steps: [], runPipeline: "mixed", runState: "done", runId: "run_1",
  captureId: "cap_1", id: "cab_1"
} as const;

describe("AnalysisDetails sources", () => {
  it("renders an http(s) source as a real link", () => {
    render(<AnalysisDetails detail={{ ...base, sources: [{ title: "Some page", url: "https://example.com/a" }] } as never} />);
    const link = screen.getByRole("link", { name: /Some page/ });
    expect(link.getAttribute("href")).toBe("https://example.com/a");
  });

  // Regression: search-step sources are stored, unvalidated JSON — the same class of risk as
  // source_facts.repo_url/homepage. A javascript:/data: URL must render as plain text.
  it("renders a javascript:/data: source as plain text, not an anchor", () => {
    render(
      <AnalysisDetails
        detail={{ ...base, sources: [{ title: "Evil", url: "javascript:alert(1)" }] } as never}
      />
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Evil")).toBeTruthy();
  });
});
