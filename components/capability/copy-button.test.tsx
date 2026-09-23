// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./copy-button";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("CopyButton status announcements (WCAG 4.1.3)", () => {
  it("has a polite live region present before any click, so the result is announced", () => {
    render(<CopyButton text="x" />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("announces a successful copy", async () => {
    stubClipboard(() => Promise.resolve());
    render(<CopyButton text="hello" />);
    await act(async () => { fireEvent.click(screen.getByRole("button")); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已复制"));
  });

  it("announces a failed copy", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    render(<CopyButton text="hello" />);
    await act(async () => { fireEvent.click(screen.getByRole("button")); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("复制失败"));
  });
});
