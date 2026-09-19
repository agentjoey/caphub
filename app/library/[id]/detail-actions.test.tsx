// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionResult } from "../../../lib/library/actions";

const softDeleteAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>(
  async () => ({ ok: true, updatedAt: "2026-09-19T00:00:01.000Z" })
);
const reviewAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>(
  async () => ({ ok: false, reason: "CONFLICT", message: "复核已在进行中" })
);
const rerunAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
const decideAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
const editSuggestionAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();

vi.mock("../../actions", () => ({
  softDeleteAction: (...args: unknown[]) => softDeleteAction(...(args as [])),
  reviewAction: (...args: unknown[]) => reviewAction(...(args as [])),
  rerunAction: (...args: unknown[]) => rerunAction(...(args as [])),
  decideAction: (...args: unknown[]) => decideAction(...(args as [])),
  editSuggestionAction: (...args: unknown[]) => editSuggestionAction(...(args as []))
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { DetailActions } from "./detail-actions";

describe("DetailActions", () => {
  afterEach(cleanup);
  beforeEach(() => {
    softDeleteAction.mockClear();
    reviewAction.mockClear();
    rerunAction.mockClear();
    decideAction.mockClear();
    editSuggestionAction.mockClear();
  });

  it("asks once before deleting", async () => {
    render(
      <DetailActions
        id="cab_1"
        captureId="cap_1"
        updatedAt="2026-09-19T00:00:00.000Z"
        verdict="keep"
        type="skill"
        usage="integrate"
        tags={["python"]}
        reviewPending={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(softDeleteAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(softDeleteAction).toHaveBeenCalledOnce());
  });

  it("shows the conflict message for review", async () => {
    render(
      <DetailActions
        id="cab_1"
        captureId="cap_1"
        updatedAt="t"
        verdict="keep"
        type="skill"
        usage="integrate"
        tags={[]}
        reviewPending={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "复核" }));
    await waitFor(() => expect(screen.getByText("复核已在进行中")).toBeTruthy());
  });

  it("keeps the original lock token after a successful review, for a later delete", async () => {
    // requestReview() never touches capabilities.updated_at, so its ActionResult.updatedAt
    // (just the server's current time) must NOT replace the optimistic-lock token — otherwise
    // the next action (here: delete) would send a stale/wrong token and always CONFLICT.
    const originalUpdatedAt = "2026-09-19T00:00:00.000Z";
    reviewAction.mockResolvedValueOnce({ ok: true, updatedAt: "2026-09-19T12:00:00.000Z" });
    render(
      <DetailActions
        id="cab_1"
        captureId="cap_1"
        updatedAt={originalUpdatedAt}
        verdict="keep"
        type="skill"
        usage="integrate"
        tags={["python"]}
        reviewPending={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "复核" }));
    await waitFor(() => expect(reviewAction).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "复核中" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(softDeleteAction).toHaveBeenCalledWith("cab_1", originalUpdatedAt));
  });

  it("does not go stale on a rerun CONFLICT (already queued), so delete still works", async () => {
    // A CONFLICT from rerunAction() means "已在排队或分析中" — not a lock conflict on this
    // capability row — so the rest of the card's actions (delete, in particular) must stay
    // enabled and functional afterwards.
    rerunAction.mockResolvedValueOnce({ ok: false, reason: "CONFLICT", message: "已在排队或分析中" });
    render(
      <DetailActions
        id="cab_1"
        captureId="cap_1"
        updatedAt="2026-09-19T00:00:00.000Z"
        verdict="keep"
        type="skill"
        usage="integrate"
        tags={["python"]}
        reviewPending={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "重跑分析" }));
    await waitFor(() => expect(screen.getByText("已在排队或分析中")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(softDeleteAction).toHaveBeenCalledOnce());
  });
});
