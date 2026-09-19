// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const rerunAction = vi.fn();

vi.mock("./actions", () => ({
  rerunAction: (...args: unknown[]) => rerunAction(...(args as []))
}));

import { RecentRow } from "./recent-row";
import type { RecentCapture } from "../lib/captures/captures";

const base: RecentCapture = {
  id: "cap_1", kind: "image", createdAt: "2026-09-19T00:00:00.000Z", runState: "failed",
  capabilityId: null, errorCode: "TIMEOUT", objectKey: "sha256/ab/" + "a".repeat(64), text: null, url: null,
  title: null, verdict: null, deleted: false
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

  it("shows a 已删除 badge instead of the verdict badge when soft-deleted", () => {
    const item: RecentCapture = { ...base, runState: "done", errorCode: null, capabilityId: "cab_1", verdict: "keep", deleted: true };
    render(<RecentRow item={item} relativeTime="1 分钟前" />);
    expect(screen.getByText("已删除")).toBeTruthy();
    expect(screen.queryByText("保留")).toBeNull();
  });
});
