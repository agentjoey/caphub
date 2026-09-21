// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>
}));

import type { CapabilityType } from "../../lib/analysis/card";
import { MiniFilters } from "./mini-filters";

const BY_TYPE: Record<CapabilityType, number> = { skill: 3, experience: 0, plugin: 1, prompt: 0, tool: 0, model: 0, other: 0 };

afterEach(cleanup);

describe("MiniFilters", () => {
  it("links type chips to /mini with the current filter plus the toggled type", () => {
    render(
      <MiniFilters
        filter={{ page: 1, q: "scrape" }}
        byType={BY_TYPE}
        scenarios={[]}
        scenarioCountBySlug={new Map()}
        tags={[]}
      />
    );
    const chip = screen.getByRole("link", { name: "技能 3" });
    expect(chip.getAttribute("href")).toBe("/mini?q=scrape&type=skill");
    expect(chip.getAttribute("aria-current")).toBeNull();
  });

  it("turns a type chip off (aria-current true, href drops the type) once it's active", () => {
    render(
      <MiniFilters
        filter={{ page: 1, types: ["skill"] }}
        byType={BY_TYPE}
        scenarios={[]}
        scenarioCountBySlug={new Map()}
        tags={[]}
      />
    );
    const chip = screen.getByRole("link", { name: "技能 3" });
    expect(chip.getAttribute("aria-current")).toBe("true");
    expect(chip.getAttribute("href")).toBe("/mini");
  });

  it("hides a type with zero count unless it's the active filter", () => {
    render(
      <MiniFilters
        filter={{ page: 1 }}
        byType={BY_TYPE}
        scenarios={[]}
        scenarioCountBySlug={new Map()}
        tags={[]}
      />
    );
    expect(screen.queryByRole("link", { name: /提示词/ })).toBeNull();
  });

  it("links scenario and tag chips to /mini carrying the current filter", () => {
    render(
      <MiniFilters
        filter={{ page: 1 }}
        byType={BY_TYPE}
        scenarios={[{ slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: [] }]}
        scenarioCountBySlug={new Map([["coding", 5]])}
        tags={[{ name: "python", count: 2 }]}
      />
    );
    expect(screen.getByRole("link", { name: "编程 5" }).getAttribute("href")).toBe("/mini?scenario=coding");
    expect(screen.getByRole("link", { name: "python 2" }).getAttribute("href")).toBe("/mini?tag=python");
  });
});
