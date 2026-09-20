// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionResult } from "../../lib/library/actions";

const setProgressAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
vi.mock("../../app/actions", () => ({ setProgressAction: (...args: unknown[]) => setProgressAction(...(args as [])) }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

import { ProgressControl } from "./progress-control";

const T = "2026-09-19T00:00:00.000Z";
const base = { id: "cab_1", updatedAt: T, progress: "todo", progressLink: null } as const;

describe("ProgressControl", () => {
  afterEach(cleanup);
  beforeEach(() => {
    setProgressAction.mockReset();
    refresh.mockReset();
  });

  it("shows the five states with the current one pressed", () => {
    render(<ProgressControl {...base} progress="building" />);
    for (const label of ["未处理", "已排期", "自研中", "已完成", "放弃"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "自研中" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "未处理" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("saves the picked state and link, then adopts the new lock token", async () => {
    setProgressAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-19T00:00:05.000Z" });
    render(<ProgressControl {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "自研中" }));
    fireEvent.change(screen.getByLabelText("关联链接"), { target: { value: "https://github.com/joey/thing" } });
    fireEvent.click(screen.getByRole("button", { name: "保存进度" }));
    await waitFor(() => expect(setProgressAction).toHaveBeenCalledOnce());
    expect(setProgressAction).toHaveBeenCalledWith("cab_1", T, "building", "https://github.com/joey/thing");
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    setProgressAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-19T00:00:09.000Z" });
    fireEvent.click(screen.getByRole("button", { name: "已完成" }));
    fireEvent.click(screen.getByRole("button", { name: "保存进度" }));
    await waitFor(() => expect(setProgressAction).toHaveBeenCalledTimes(2));
    expect(setProgressAction.mock.calls[1][1]).toBe("2026-09-19T00:00:05.000Z");
  });

  it("sends an empty link as an empty string and does not save until asked", () => {
    render(<ProgressControl {...base} progress="planned" />);
    fireEvent.click(screen.getByRole("button", { name: "放弃" }));
    expect(setProgressAction).not.toHaveBeenCalled();
  });

  it("shows a conflict message and freezes the control", async () => {
    setProgressAction.mockResolvedValue({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
    render(<ProgressControl {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "已完成" }));
    fireEvent.click(screen.getByRole("button", { name: "保存进度" }));
    await waitFor(() => expect(screen.getByText("已在别处处理")).toBeTruthy());
    expect(screen.getByRole("button", { name: "保存进度" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "已排期" }).hasAttribute("disabled")).toBe(true);
  });

  it("surfaces an invalid-link message without freezing the control", async () => {
    setProgressAction.mockResolvedValue({ ok: false, reason: "INVALID", message: "链接需以 http:// 或 https:// 开头" });
    render(<ProgressControl {...base} progressLink="ftp://x" />);
    fireEvent.click(screen.getByRole("button", { name: "保存进度" }));
    await waitFor(() => expect(screen.getByText("链接需以 http:// 或 https:// 开头")).toBeTruthy());
    expect(screen.getByRole("button", { name: "保存进度" }).hasAttribute("disabled")).toBe(false);
  });

  it("reports a thrown action as a generic error", async () => {
    setProgressAction.mockRejectedValue(new Error("network"));
    render(<ProgressControl {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "保存进度" }));
    await waitFor(() => expect(screen.getByText("操作失败，请重试")).toBeTruthy());
  });

  it("uses the English dictionary when locale is en", () => {
    render(<ProgressControl {...base} locale="en" />);
    expect(screen.getByRole("button", { name: "Building" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save progress" })).toBeTruthy();
  });
});
