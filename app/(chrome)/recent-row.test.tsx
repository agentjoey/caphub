// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const rerunAction = vi.fn();

vi.mock("../actions", () => ({
  rerunAction: (...args: unknown[]) => rerunAction(...(args as []))
}));

import { RecentRow } from "./recent-row";
import type { RecentCapture } from "../../lib/captures/captures";

const base: RecentCapture = {
  id: "cap_1", kind: "image", createdAt: "2026-09-19T00:00:00.000Z", runState: "failed",
  capabilityId: null, errorCode: "TIMEOUT", objectKey: "sha256/ab/" + "a".repeat(64), thumbKey: null, text: null, url: null,
  title: null, verdict: null, deleted: false, okSteps: []
};

beforeEach(() => rerunAction.mockReset());
afterEach(cleanup);

describe("RecentRow", () => {
  it("shows a fallback error message when rerunAction throws", async () => {
    rerunAction.mockRejectedValueOnce(new Error("network down"));
    render(<RecentRow item={base} relativeTime="1 分钟前" />);
    fireEvent.click(screen.getByRole("button", { name: "重跑" }));
    await waitFor(() => expect(screen.getByText("重跑失败，请稍后再试。")).toBeTruthy());
  });

  it("does not link to the library when the capability is soft-deleted", () => {
    const item: RecentCapture = { ...base, runState: "done", errorCode: null, capabilityId: "cab_1", deleted: true };
    render(<RecentRow item={item} relativeTime="1 分钟前" />);
    expect(screen.queryByRole("link", { name: "查看" })).toBeNull();
  });

  it("links to the library when a capability exists and is not deleted", () => {
    const item: RecentCapture = { ...base, runState: "done", errorCode: null, capabilityId: "cab_1", deleted: false };
    render(<RecentRow item={item} relativeTime="1 分钟前" />);
    expect(screen.getByRole("link", { name: "查看" }).getAttribute("href")).toBe("/library/cab_1");
  });

  it("links to the review anchor instead of the library detail page when the card is pending", () => {
    const item: RecentCapture = { ...base, runState: "done", errorCode: null, capabilityId: "cab_1", verdict: "pending", deleted: false };
    render(<RecentRow item={item} relativeTime="1 分钟前" />);
    expect(screen.getByRole("link", { name: "查看" }).getAttribute("href")).toBe("/review#cab_1");
  });

  it("shows a 已删除 badge instead of the verdict badge when soft-deleted", () => {
    const item: RecentCapture = { ...base, runState: "done", errorCode: null, capabilityId: "cab_1", verdict: "keep", deleted: true };
    render(<RecentRow item={item} relativeTime="1 分钟前" />);
    expect(screen.getByText("已删除")).toBeTruthy();
    expect(screen.queryByText("保留")).toBeNull();
  });

  it("shows where a running analysis is: finished stages, the current one, and the rest", () => {
    const item: RecentCapture = { ...base, runState: "running", errorCode: null, okSteps: ["vision"] };
    const { container } = render(<RecentRow item={item} relativeTime="刚刚" />);
    const list = screen.getByRole("list", { name: "分析中：第 2 步，共 4 步，搜索" });
    const states = Array.from(list.querySelectorAll("li")).map((li) => `${li.textContent}:${li.getAttribute("data-state")}`);
    expect(states).toEqual(["看图:done", "搜索:current", "分析:todo", "裁决:todo"]);
    expect(container.querySelector(".live-dot")).toBeTruthy();
  });

  it("marks a queued capture as live but shows no stages yet", () => {
    const item: RecentCapture = { ...base, runState: "queued", errorCode: null };
    const { container } = render(<RecentRow item={item} relativeTime="刚刚" />);
    expect(container.querySelector(".stages")).toBeNull();
    expect(container.querySelector(".live-dot")).toBeTruthy();
  });

  it("flags a row that just finished so it can flash once, then clears the flag", () => {
    vi.useFakeTimers();
    try {
      const running: RecentCapture = { ...base, runState: "running", errorCode: null, okSteps: ["vision", "search"] };
      const { container, rerender } = render(<RecentRow item={running} relativeTime="刚刚" />);
      const row = () => container.querySelector(".list-row")!;
      expect(row().hasAttribute("data-arrived")).toBe(false);
      rerender(<RecentRow item={{ ...running, runState: "done", okSteps: [], capabilityId: "cab_1", verdict: "keep" }} relativeTime="刚刚" />);
      expect(row().hasAttribute("data-arrived")).toBe(true);
      act(() => { vi.advanceTimersByTime(1700); });
      expect(row().hasAttribute("data-arrived")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flash a row that was already done when the page first rendered", () => {
    const item: RecentCapture = { ...base, runState: "done", errorCode: null, capabilityId: "cab_1", verdict: "keep" };
    const { container } = render(<RecentRow item={item} relativeTime="刚刚" />);
    expect(container.querySelector(".list-row")!.hasAttribute("data-arrived")).toBe(false);
  });
});
