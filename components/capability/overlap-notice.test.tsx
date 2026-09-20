// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionResult } from "../../lib/library/actions";

const ignoreOverlapAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
const supersedeOverlapTargetAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
const setStatusAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
vi.mock("../../app/actions", () => ({
  ignoreOverlapAction: (...args: unknown[]) => ignoreOverlapAction(...(args as [])),
  supersedeOverlapTargetAction: (...args: unknown[]) => supersedeOverlapTargetAction(...(args as [])),
  setStatusAction: (...args: unknown[]) => setStatusAction(...(args as []))
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
    setStatusAction.mockReset();
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

  it("marks the other card superseded without touching this card's own lock token, and dismisses the notice immediately", async () => {
    supersedeOverlapTargetAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-19T00:00:05.000Z" });
    render(<OverlapNotice id="cab_1" updatedAt={T} overlap={overlap} />);
    fireEvent.click(screen.getByRole("button", { name: "把 TOL-0009 标为被本卡替代" }));
    await waitFor(() => expect(supersedeOverlapTargetAction).toHaveBeenCalledOnce());
    expect(supersedeOverlapTargetAction).toHaveBeenCalledWith("cab_1");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // The action resolves this card's own overlap in the same DB transaction as marking the
    // other card superseded, so the notice must not keep nagging once it succeeds.
    await waitFor(() => expect(screen.queryByText("疑似与 TOL-0009 重复 · 同类工具")).toBeNull());
  });

  it("keeps the notice visible when the other card's status write fails (conflict)", async () => {
    supersedeOverlapTargetAction.mockResolvedValue({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
    render(<OverlapNotice id="cab_1" updatedAt={T} overlap={overlap} />);
    fireEvent.click(screen.getByRole("button", { name: "把 TOL-0009 标为被本卡替代" }));
    await waitFor(() => expect(screen.getByText("已在别处处理")).toBeTruthy());
    expect(screen.getByText("疑似与 TOL-0009 重复 · 同类工具")).toBeTruthy();
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

  // Per-relation copy and available actions (M3.6 final-review fix): the analysis can emit four
  // distinct non-"none" relations, each with its own meaning about which card (if either) is the
  // one worth retiring, so the copy and the offered actions must not be a single one-size-fits-all
  // "duplicate" treatment.
  describe("per-relation copy and actions", () => {
    it("upgrade: 本卡可能比 X 更强, offers markOtherSuperseded + ignore", () => {
      render(<OverlapNotice id="cab_1" updatedAt={T} overlap={{ relation: "upgrade", target: "TOL-0009", reason: "功能更全" }} />);
      expect(screen.getByText("本卡可能比 TOL-0009 更强 · 功能更全")).toBeTruthy();
      expect(screen.getByRole("button", { name: "把 TOL-0009 标为被本卡替代" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "忽略" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "把本卡标为被 TOL-0009 替代" })).toBeNull();
    });

    it("superseded: X 可能已取代本卡, offers markSelfSuperseded (not markOtherSuperseded) + ignore", () => {
      render(<OverlapNotice id="cab_1" updatedAt={T} overlap={{ relation: "superseded", target: "TOL-0009", reason: "对方更新" }} />);
      expect(screen.getByText("TOL-0009 可能已取代本卡 · 对方更新")).toBeTruthy();
      expect(screen.getByRole("button", { name: "把本卡标为被 TOL-0009 替代" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "忽略" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "把 TOL-0009 标为被本卡替代" })).toBeNull();
    });

    it("complement: 与 X 相近但互补, offers only ignore -- no supersede action either direction", () => {
      render(<OverlapNotice id="cab_1" updatedAt={T} overlap={{ relation: "complement", target: "TOL-0009", reason: "场景不同" }} />);
      expect(screen.getByText("与 TOL-0009 相近但互补 · 场景不同")).toBeTruthy();
      expect(screen.getByRole("button", { name: "忽略" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "把 TOL-0009 标为被本卡替代" })).toBeNull();
      expect(screen.queryByRole("button", { name: "把本卡标为被 TOL-0009 替代" })).toBeNull();
    });

    it("superseded: markSelfSuperseded writes THIS card via setStatus, using this card's own lock token", async () => {
      setStatusAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-19T00:00:05.000Z" });
      render(<OverlapNotice id="cab_1" updatedAt={T} overlap={{ relation: "superseded", target: "TOL-0009", reason: "对方更新" }} />);
      fireEvent.click(screen.getByRole("button", { name: "把本卡标为被 TOL-0009 替代" }));
      await waitFor(() => expect(setStatusAction).toHaveBeenCalledWith("cab_1", T, "superseded", "TOL-0009", "对方更新"));
      expect(supersedeOverlapTargetAction).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByText("TOL-0009 可能已取代本卡 · 对方更新")).toBeNull());
    });

    it("superseded: a conflict from setStatus keeps the notice visible and freezes the control", async () => {
      setStatusAction.mockResolvedValue({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
      render(<OverlapNotice id="cab_1" updatedAt={T} overlap={{ relation: "superseded", target: "TOL-0009", reason: "对方更新" }} />);
      fireEvent.click(screen.getByRole("button", { name: "把本卡标为被 TOL-0009 替代" }));
      await waitFor(() => expect(screen.getByText("已在别处处理")).toBeTruthy());
      expect(screen.getByText("TOL-0009 可能已取代本卡 · 对方更新")).toBeTruthy();
    });
  });
});
