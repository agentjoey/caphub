// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SourceFacts } from "./source-facts";

afterEach(cleanup);

describe("SourceFacts", () => {
  it("renders http(s) repo_url/homepage as real links", () => {
    render(
      <SourceFacts
        facts={{ repo_url: "https://github.com/joey/thing", homepage: "http://example.com" }}
      />
    );
    const repoLink = screen.getByRole("link", { name: "https://github.com/joey/thing" });
    expect(repoLink.getAttribute("href")).toBe("https://github.com/joey/thing");
    const homeLink = screen.getByRole("link", { name: "http://example.com" });
    expect(homeLink.getAttribute("href")).toBe("http://example.com");
  });

  // Regression: source_facts.repo_url/homepage are model-supplied and the zod schema accepts any
  // z.string().url() value, including javascript:/data: — a poisoned analysis result must render
  // as plain text, never a clickable anchor.
  it("renders javascript:/data: repo_url/homepage as plain text, not an anchor", () => {
    render(
      <SourceFacts
        facts={{
          repo_url: "javascript:alert(1)",
          homepage: "data:text/html,<script>alert(1)</script>"
        }}
      />
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("javascript:alert(1)")).toBeTruthy();
    expect(screen.getByText("data:text/html,<script>alert(1)</script>")).toBeTruthy();
  });
});
