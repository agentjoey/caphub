// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>
}));

import { ActiveFilters } from "./active-filters";

afterEach(cleanup);

const scenarios = [{ slug: "coding", labelZh: "编程", labelEn: "Coding" }];

describe("ActiveFilters", () => {
  it("lists each applied filter as a removable chip that keeps the others", () => {
    render(<ActiveFilters filter={{ tags: ["mcp"], usage: "reference", page: 1 }} scenarios={scenarios as never} locale="zh" />);
    const tag = screen.getByRole("link", { name: "移除筛选：mcp" });
    expect(tag.getAttribute("href")).toBe("/library?usage=reference");
    const usage = screen.getByRole("link", { name: "移除筛选：参考自研" });
    expect(usage.getAttribute("href")).toBe("/library?tag=mcp");
    expect(screen.getByRole("link", { name: "清除全部" }).getAttribute("href")).toBe("/library");
  });

  it("keeps the search text and type selection when a chip is removed", () => {
    render(<ActiveFilters filter={{ q: "agent", types: ["skill"], scenarios: ["coding"], page: 2 }} scenarios={scenarios as never} locale="zh" />);
    expect(screen.getByRole("link", { name: "移除筛选：编程" }).getAttribute("href")).toBe("/library?q=agent&type=skill");
    // A single chip needs no separate "clear all".
    expect(screen.queryByRole("link", { name: "清除全部" })).toBeNull();
  });

  it("names the switches it shows (discarded, retired, deep, progress)", () => {
    render(<ActiveFilters filter={{ discarded: true, includeRetired: true, deepAnalyzed: true, progress: ["todo"], page: 1 }} scenarios={[]} locale="zh" />);
    for (const name of ["已丢弃", "显示失效/被替代", "已深度分析"]) {
      expect(screen.getByRole("link", { name: `移除筛选：${name}` })).toBeTruthy();
    }
    expect(screen.getAllByRole("link").length).toBe(5);
  });

  it("renders nothing when only the search box or type bar is in use", () => {
    const { container } = render(<ActiveFilters filter={{ q: "agent", types: ["tool"], page: 1 }} scenarios={scenarios as never} locale="zh" />);
    expect(container.innerHTML).toBe("");
  });
});
