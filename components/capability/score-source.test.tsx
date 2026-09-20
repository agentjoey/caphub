// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScoreBadge } from "./score-badge";
import { SourceFacts } from "./source-facts";

afterEach(cleanup);

describe("ScoreBadge", () => {
  it("renders ★ n/5 with the reason as its tooltip", () => {
    const { container } = render(<ScoreBadge score={4} reason="成熟开源且可直接安装" />);
    const badge = container.querySelector(".badge--score")!;
    expect(badge.textContent).toBe("★ 4/5");
    expect(badge.getAttribute("title")).toBe("成熟开源且可直接安装");
  });

  it("renders nothing when the card has no score — never a 0", () => {
    const { container } = render(<ScoreBadge score={null} reason={null} />);
    expect(container.textContent).toBe("");
    expect(container.textContent).not.toContain("0");
  });

  it("omits the tooltip when there is no reason", () => {
    const { container } = render(<ScoreBadge score={2} reason={null} />);
    expect(container.querySelector(".badge--score")!.hasAttribute("title")).toBe(false);
  });
});

describe("SourceFacts", () => {
  it("renders every present field, links the repo and homepage, and shows as_of", () => {
    render(
      <SourceFacts
        facts={{
          repo_url: "https://github.com/D4Vinci/Scrapling",
          stars: 12345,
          last_update: "2026-09-01",
          license: "BSD-3-Clause",
          homepage: "https://scrapling.dev",
          as_of: "2026-09-20"
        }}
      />
    );
    expect(screen.getByText("仓库地址")).toBeTruthy();
    const repo = screen.getByRole("link", { name: "https://github.com/D4Vinci/Scrapling" });
    expect(repo.getAttribute("href")).toBe("https://github.com/D4Vinci/Scrapling");
    expect(repo.getAttribute("rel")).toBe("noreferrer");
    expect(screen.getByText("star 数")).toBeTruthy();
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.getByText("最近更新")).toBeTruthy();
    expect(screen.getByText("2026-09-01")).toBeTruthy();
    expect(screen.getByText("许可证")).toBeTruthy();
    expect(screen.getByText("BSD-3-Clause")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://scrapling.dev" })).toBeTruthy();
    expect(screen.getByText(/2026-09-20/)).toBeTruthy();
  });

  it("skips null/missing fields", () => {
    render(<SourceFacts facts={{ stars: 7, repo_url: null, license: null }} />);
    expect(screen.getByText("star 数")).toBeTruthy();
    expect(screen.queryByText("仓库地址")).toBeNull();
    expect(screen.queryByText("许可证")).toBeNull();
    expect(screen.queryByText("主页")).toBeNull();
  });

  it("renders nothing when every fact is empty, or when only as_of survives", () => {
    for (const facts of [undefined, null, {}, { repo_url: null, stars: null }, { as_of: "2026-09-20" }]) {
      const { container, unmount } = render(<SourceFacts facts={facts as never} />);
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("uses the English dictionary when locale is en", () => {
    render(<SourceFacts facts={{ stars: 3 }} locale="en" />);
    expect(screen.getByText("Stars")).toBeTruthy();
    expect(screen.getByText("Source facts")).toBeTruthy();
  });
});
