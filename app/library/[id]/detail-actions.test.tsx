// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
