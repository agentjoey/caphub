// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionResult } from "../../lib/library/actions";

const setStatusAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
vi.mock("../../app/actions", () => ({ setStatusAction: (...args: unknown[]) => setStatusAction(...(args as [])) }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

import { StatusControl } from "./status-control";

const T = "2026-09-19T00:00:00.000Z";
const base = { id: "cab_1", updatedAt: T, status: "active", statusNote: null } as const;

describe("StatusControl", () => {
  afterEach(cleanup);
  beforeEach(() => {
    setStatusAction.mockReset();
    refresh.mockReset();
  });

  it("shows 置为失效 when active, and 恢复有效 only once deprecated/superseded", () => {
    render(<StatusControl {...base} />);
    expect(screen.getByRole("button", { name: "置为失效" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "恢复有效" })).toBeNull();

    cleanup();
    render(<StatusControl {...base} status="deprecated" />);
    expect(screen.getByRole("button", { name: "恢复有效" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "置为失效" })).toBeNull();
  });

  it("marks deprecated with no supersededBy", async () => {
    setStatusAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-19T00:00:05.000Z" });
    render(<StatusControl {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "置为失效" }));
    await waitFor(() => expect(setStatusAction).toHaveBeenCalledOnce());
    expect(setStatusAction).toHaveBeenCalledWith("cab_1", T, "deprecated", null, null);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("marks superseded with the entered serial and note, disabled until a serial is typed", async () => {
    setStatusAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-19T00:00:05.000Z" });
    render(<StatusControl {...base} />);
    const submit = screen.getByRole("button", { name: "标记被替代" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("替代它的卡片编号，如 TOL-0009"), { target: { value: "TOL-0009" } });
    fireEvent.change(screen.getByPlaceholderText("可选"), { target: { value: "同类工具" } });
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(setStatusAction).toHaveBeenCalledOnce());
    expect(setStatusAction).toHaveBeenCalledWith("cab_1", T, "superseded", "TOL-0009", "同类工具");
  });

  it("shows a conflict message and freezes the control", async () => {
    setStatusAction.mockResolvedValue({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
    render(<StatusControl {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "置为失效" }));
    await waitFor(() => expect(screen.getByText("已在别处处理")).toBeTruthy());
    expect(screen.getByRole("button", { name: "置为失效" }).hasAttribute("disabled")).toBe(true);
  });

  it("reports a thrown action as a generic error", async () => {
    setStatusAction.mockRejectedValue(new Error("network"));
    render(<StatusControl {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "置为失效" }));
    await waitFor(() => expect(screen.getByText("操作失败，请重试")).toBeTruthy());
  });

  it("uses the English dictionary when locale is en", () => {
    render(<StatusControl {...base} locale="en" />);
    expect(screen.getByRole("button", { name: "Mark deprecated" })).toBeTruthy();
  });
});
