// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionResult } from "../../lib/library/actions";

const ignoreOverlapAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
const supersedeOverlapTargetAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
vi.mock("../../app/actions", () => ({
  ignoreOverlapAction: (...args: unknown[]) => ignoreOverlapAction(...(args as [])),
  supersedeOverlapTargetAction: (...args: unknown[]) => supersedeOverlapTargetAction(...(args as []))
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

import { OverlapNotice } from "./overlap-notice";

const T = "2026-09-19T00:00:00.000Z";
const overlap = { relation: "duplicate" as const, target: "TOL-0009", reason: "同类工具" };

describe("OverlapNotice", () => {
  afterEach(cleanup);
  beforeEach(() => {
    ignoreOverlapAction.mockReset();
    supersedeOverlapTargetAction.mockReset();
    refresh.mockReset();
  });

  it("renders nothing when relation is none", () => {
    const { container } = render(<OverlapNotice id="cab_1" updatedAt={T} overlap={{ relation: "none", target: null, reason: "" }} />);
    expect(container.textContent).toBe("");
  });

  it("shows the notice text with the target serial and reason", () => {
    render(<OverlapNotice id="cab_1" updatedAt={T} overlap={overlap} />);
    expect(screen.getByText("疑似与 TOL-0009 重复 · 同类工具")).toBeTruthy();
    expect(screen.getByRole("button", { name: "把 TOL-0009 标为被本卡替代" })).toBeTruthy();
  });

  it("marks the other card superseded without touching this card's own lock token", async () => {
    supersedeOverlapTargetAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-19T00:00:05.000Z" });
    render(<OverlapNotice id="cab_1" updatedAt={T} overlap={overlap} />);
    fireEvent.click(screen.getByRole("button", { name: "把 TOL-0009 标为被本卡替代" }));
    await waitFor(() => expect(supersedeOverlapTargetAction).toHaveBeenCalledOnce());
    expect(supersedeOverlapTargetAction).toHaveBeenCalledWith("cab_1");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("ignoring dismisses the notice and adopts the new lock token", async () => {
    ignoreOverlapAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-19T00:00:05.000Z" });
    render(<OverlapNotice id="cab_1" updatedAt={T} overlap={overlap} />);
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    await waitFor(() => expect(ignoreOverlapAction).toHaveBeenCalledWith("cab_1", T));
    await waitFor(() => expect(screen.queryByText("疑似与 TOL-0009 重复 · 同类工具")).toBeNull());
  });

  it("shows a conflict message from ignore without dismissing the notice", async () => {
    ignoreOverlapAction.mockResolvedValue({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
    render(<OverlapNotice id="cab_1" updatedAt={T} overlap={overlap} />);
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    await waitFor(() => expect(screen.getByText("已在别处处理")).toBeTruthy());
    expect(screen.getByText("疑似与 TOL-0009 重复 · 同类工具")).toBeTruthy();
  });

  it("uses the English dictionary when locale is en", () => {
    render(<OverlapNotice id="cab_1" updatedAt={T} overlap={overlap} locale="en" />);
    expect(screen.getByRole("button", { name: "Ignore" })).toBeTruthy();
  });
});
