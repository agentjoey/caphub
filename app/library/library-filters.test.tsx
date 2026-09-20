// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>
}));

import { LibraryFilters } from "./library-filters";

afterEach(cleanup);

describe("LibraryFilters", () => {
  it("offers the 已深度分析 toggle beside 含失效, linking to deep=1 and back off again", () => {
    render(<LibraryFilters filter={{ page: 1 }} />);
    const chip = screen.getByRole("link", { name: "已深度分析" });
    expect(chip.getAttribute("href")).toBe("/library?deep=1");
    expect(chip.getAttribute("aria-current")).toBeNull();
    // Same row as the 显示失效/被替代 toggle, not a row of its own.
    expect(chip.parentElement).toBe(screen.getByRole("link", { name: "显示失效/被替代" }).parentElement);

    cleanup();
    render(<LibraryFilters filter={{ page: 1, deepAnalyzed: true }} />);
    const active = screen.getByRole("link", { name: "已深度分析" });
    expect(active.getAttribute("aria-current")).toBe("true");
    expect(active.getAttribute("href")).toBe("/library");
  });
});
