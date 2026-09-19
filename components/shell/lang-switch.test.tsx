// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
const setLocaleAction = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("../../lib/i18n/set-locale-action", () => ({
  setLocaleAction: (...args: unknown[]) => setLocaleAction(...(args as []))
}));

import { LangSwitch } from "./lang-switch";

beforeEach(() => {
  refresh.mockClear();
  setLocaleAction.mockClear();
});
afterEach(cleanup);

describe("LangSwitch", () => {
  it("marks the active locale via aria-pressed", () => {
    render(<LangSwitch locale="zh" ariaLabel="切换界面语言" />);
    expect(screen.getByRole("button", { name: "中文" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "EN" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("sets the cookie via the server action and refreshes when switching to en", async () => {
    render(<LangSwitch locale="zh" ariaLabel="切换界面语言" />);
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    await waitFor(() => expect(setLocaleAction).toHaveBeenCalledWith("en"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("does nothing when clicking the already-active locale", () => {
    render(<LangSwitch locale="zh" ariaLabel="切换界面语言" />);
    fireEvent.click(screen.getByRole("button", { name: "中文" }));
    expect(setLocaleAction).not.toHaveBeenCalled();
  });
});
