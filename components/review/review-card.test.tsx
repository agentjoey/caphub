// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionResult } from "../../lib/library/actions";

const decideAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>(
  async () => ({ ok: false, reason: "CONFLICT", message: "已在别处处理" })
);
const editSuggestionAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();

vi.mock("../../app/actions", () => ({
  decideAction: (...args: unknown[]) => decideAction(...(args as [])),
  editSuggestionAction: (...args: unknown[]) => editSuggestionAction(...(args as []))
}));

import { ReviewCard } from "./review-card";

const row = {
  id: "cab_1", captureId: "cap_1", title: "Scrapling 自适应爬虫框架", type: "skill", summary: "摘要文字", signals: ["a", "b"],
  suggestedVerdict: "keep", suggestedReason: "成熟开源", confidence: 0.86, verdict: "pending", verdictBy: null,
  usage: "integrate", playbook: { kind: "integrate", install: ["pip install scrapling"], repo: "D4Vinci/Scrapling", prompt_text: null },
  tags: ["web-scraping", "python"], sourceUrl: null, reviewNote: null, reviewRequestedAt: null, reviewError: null,
  syncedAt: null, deletedAt: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
  capture: { kind: "image", objectKey: "sha256/ab/" + "a".repeat(64), text: null, url: null }
} as const;
const detail = { ...row, steps: [], sources: [], runPipeline: "mixed", runState: "done" } as const;

beforeEach(() => {
  decideAction.mockClear();
  editSuggestionAction.mockReset();
});

afterEach(cleanup);

describe("ReviewCard", () => {
  it("greys out with the conflict message when the decision conflicts", async () => {
    const { container } = render(<ReviewCard row={row as never} detail={detail as never} />);
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await waitFor(() => expect(screen.getByText("已在别处处理")).toBeTruthy());
    expect(container.querySelector("[data-state='stale']")).toBeTruthy();
  });

  it("shows a done state and fades the card when keep succeeds", async () => {
    decideAction.mockResolvedValueOnce({ ok: true, updatedAt: "2026-09-19T00:01:00.000Z" });
    const { container } = render(<ReviewCard row={row as never} detail={detail as never} />);
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await waitFor(() => expect(screen.getByText("已保留")).toBeTruthy());
    expect(container.querySelector("[data-state='done']")).toBeTruthy();
  });

  it("shows a done state with 已丢弃 when discard succeeds", async () => {
    decideAction.mockResolvedValueOnce({ ok: true, updatedAt: "2026-09-19T00:01:00.000Z" });
    render(<ReviewCard row={row as never} detail={detail as never} />);
    fireEvent.click(screen.getByRole("button", { name: "丢弃" }));
    await waitFor(() => expect(screen.getByText("已丢弃")).toBeTruthy());
    expect(decideAction).toHaveBeenCalledWith("cab_1", "2026-09-19T00:00:00.000Z", "discard");
  });

  it("shows an inline error for a non-conflict failure without disabling the card", async () => {
    decideAction.mockResolvedValueOnce({ ok: false, reason: "NOT_FOUND", message: "卡片不存在或已删除" });
    const { container } = render(<ReviewCard row={row as never} detail={detail as never} />);
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await waitFor(() => expect(screen.getByText("卡片不存在或已删除")).toBeTruthy());
    expect(container.querySelector(".inline-error")).toBeTruthy();
    expect(container.querySelector("[data-state='idle']")).toBeTruthy();
  });

  it("expands the suggestion editor and saves an edit, showing INVALID messages inline", async () => {
    editSuggestionAction.mockResolvedValueOnce({ ok: false, reason: "INVALID", message: "标签需 1–6 个" });
    render(<ReviewCard row={row as never} detail={detail as never} />);
    fireEvent.click(screen.getByRole("button", { name: "改建议" }));
    const tagsInput = screen.getByLabelText("标签");
    fireEvent.change(tagsInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并保留" }));
    await waitFor(() => expect(screen.getByText("标签需 1–6 个")).toBeTruthy());

    editSuggestionAction.mockResolvedValueOnce({ ok: true, updatedAt: "2026-09-19T00:02:00.000Z" });
    fireEvent.change(tagsInput, { target: { value: "rag, python" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并保留" }));
    await waitFor(() => expect(screen.getByText("已保留")).toBeTruthy());
    expect(editSuggestionAction).toHaveBeenLastCalledWith("cab_1", "2026-09-19T00:00:00.000Z", "skill", "integrate", ["rag", "python"]);
  });

  it("does not send a decide() while an edit save is pending", async () => {
    let resolveEdit!: (r: ActionResult) => void;
    editSuggestionAction.mockImplementationOnce(() => new Promise((resolve) => { resolveEdit = resolve; }));
    render(<ReviewCard row={row as never} detail={detail as never} />);
    fireEvent.click(screen.getByRole("button", { name: "改建议" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并保留" }));

    // The save is in flight: 保留/丢弃/改建议 must already be disabled, so this click is a no-op.
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(decideAction).not.toHaveBeenCalled();

    resolveEdit({ ok: true, updatedAt: "2026-09-19T00:03:00.000Z" });
    await waitFor(() => expect(screen.getByText("已保留")).toBeTruthy());
  });

  it("greys out and disables the open editor (not only the action row) when its own save conflicts", async () => {
    let resolveEdit!: (r: ActionResult) => void;
    editSuggestionAction.mockImplementationOnce(() => new Promise((resolve) => { resolveEdit = resolve; }));
    const { container } = render(<ReviewCard row={row as never} detail={detail as never} />);
    fireEvent.click(screen.getByRole("button", { name: "改建议" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并保留" }));

    resolveEdit({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
    await waitFor(() => expect(screen.getByText("已在别处处理")).toBeTruthy());

    expect(container.querySelector("[data-state='stale']")).toBeTruthy();
    const select = screen.getByLabelText("类型") as HTMLSelectElement;
    const tagsInput = screen.getByLabelText("标签") as HTMLInputElement;
    const saveButton = screen.getByRole("button", { name: "保存并保留" });
    expect(select.disabled).toBe(true);
    expect(tagsInput.disabled).toBe(true);
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("wires the tag hint to the tags input via aria-describedby", () => {
    render(<ReviewCard row={row as never} detail={detail as never} />);
    fireEvent.click(screen.getByRole("button", { name: "改建议" }));
    const tagsInput = screen.getByLabelText("标签");
    const describedBy = tagsInput.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("英文小写，可用连字符，1–6 个");
  });
});
