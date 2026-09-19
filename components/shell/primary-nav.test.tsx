// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { PrimaryNav } from "./primary-nav";

afterEach(cleanup);

describe("PrimaryNav", () => {
  it("falls back to the zh NAV_ITEMS labels when no labels prop is given", () => {
    render(<PrimaryNav />);
    expect(screen.getByRole("link", { name: "投递" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "能力库" })).toBeTruthy();
  });

  it("renders provided labels (e.g. the en dict) and the given aria-label", () => {
    render(<PrimaryNav navAria="Primary navigation" labels={{ "/": "Capture", "/review": "Review", "/library": "Library" }} />);
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Capture" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Library" })).toBeTruthy();
  });
});
