// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  decide: vi.fn(),
  rerun: vi.fn(),
  edit: vi.fn(),
  setOpenBand: vi.fn(),
  create: vi.fn()
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }) }));
vi.mock("../../app/actions", () => ({
  decideAction: mocks.decide,
  rerunAction: mocks.rerun,
  editSuggestionAction: mocks.edit
}));
vi.mock("./scene", () => ({ createDeskScene: mocks.create }));
import { Desk } from "./desk";
import type { DeskItem } from "./desk-items";
const item: DeskItem = {
  kind: "pending",
  id: "card",
  captureId: "capture",
  title: "A card",
  type: "skill",
  summary: "Summary",
  summaryPoints: [],
  tags: ["test"],
  usage: "integrate",
  score: 4,
  suggestedVerdict: "keep",
  suggestedReason: "Useful",
  confidence: 0.72,
  createdAt: "2026-01-01",
  updatedAt: "version"
};
const props = { items: [item], pile: [], total: 1, libraryCount: 3, locale: "en" as const };
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.create.mockResolvedValue({
    setOpenBand: mocks.setOpenBand,
    sync: vi.fn(),
    open: vi.fn(),
    file: vi.fn(),
    trash: vi.fn(),
    putBack: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn()
  });
});
afterEach(cleanup);
async function open() {
  render(<Desk {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "A card" }));
  return screen.getByRole("toolbar");
}
it.each([
  ["y", "keep"],
  ["x", "discard"]
])(
  "%s calls decide with the lock token and disables all toolbar buttons while busy",
  async (key, verdict) => {
    let resolve!: (v: unknown) => void;
    mocks.decide.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const toolbar = await open();
    fireEvent.keyDown(toolbar, { key });
    expect(mocks.decide).toHaveBeenCalledWith("card", "version", verdict);
    within(toolbar)
      .getAllByRole("button")
      .forEach((b) => expect(b).toHaveProperty("disabled", true));
    resolve({ ok: true, updatedAt: "new" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("A card"));
  }
);
it("a kept card leaves the desk list at once and cannot be reopened before the refresh", async () => {
  mocks.decide.mockResolvedValue({ ok: true, updatedAt: "new" });
  const toolbar = await open();
  fireEvent.keyDown(toolbar, { key: "y" });
  await waitFor(() => expect(screen.queryByRole("button", { name: "A card" })).toBeNull());
  const onPick = mocks.create.mock.calls[0][2] as (key: string) => void;
  onPick("card");
  expect(screen.queryByRole("toolbar")).toBeNull();
  expect(mocks.decide).toHaveBeenCalledTimes(1);
});
it("ignores browser shortcuts such as Cmd+R and Ctrl+X", async () => {
  const toolbar = await open();
  fireEvent.keyDown(toolbar, { key: "r", metaKey: true });
  fireEvent.keyDown(toolbar, { key: "x", ctrlKey: true });
  fireEvent.keyDown(toolbar, { key: "y", altKey: true });
  expect(mocks.decide).not.toHaveBeenCalled();
  expect(mocks.rerun).not.toHaveBeenCalled();
});
it("conflict shows message and refreshes", async () => {
  mocks.decide.mockResolvedValue({ ok: false, reason: "CONFLICT", message: "Changed elsewhere" });
  const toolbar = await open();
  fireEvent.keyDown(toolbar, { key: "y" });
  expect(await screen.findByText("Changed elsewhere", { selector: ".desk-error" })).toBeTruthy();
  expect(mocks.refresh).toHaveBeenCalled();
});
it("Enter opens detail only on toolbar itself; shortcuts ignore inputs; Escape puts back", async () => {
  const toolbar = await open();
  expect(document.activeElement).toBe(toolbar);
  fireEvent.keyDown(within(toolbar).getAllByRole("button")[0], { key: "Enter" });
  expect(mocks.push).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "y" });
  expect(mocks.decide).not.toHaveBeenCalled();
  fireEvent.keyDown(toolbar, { key: "Enter" });
  expect(mocks.push).toHaveBeenCalledWith("/library/card");
  fireEvent.keyDown(toolbar, { key: "Escape" });
  expect(screen.queryByRole("toolbar")).toBeNull();
});
it("rerun uses captureId", async () => {
  mocks.rerun.mockResolvedValue({ ok: true });
  const toolbar = await open();
  fireEvent.keyDown(toolbar, { key: "r" });
  await waitFor(() => expect(mocks.rerun).toHaveBeenCalledWith("capture"));
});
it("edit reuses SuggestionEditor and passes type, usage, tags and lock token", async () => {
  mocks.edit.mockResolvedValue({ ok: true, updatedAt: "new" });
  const toolbar = await open();
  fireEvent.keyDown(toolbar, { key: "e" });
  fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() =>
    expect(mocks.edit).toHaveBeenCalledWith("card", "version", "skill", "integrate", ["test"])
  );
});
it("has a usable HTML list and GET search before scene loads, persists list choice", async () => {
  render(<Desk {...props} />);
  expect(screen.getByRole("searchbox").closest("form")?.getAttribute("action")).toBe("/library");
  expect(screen.getByRole("link", { name: "A card" }).getAttribute("href")).toBe("/library/card");
  fireEvent.click(screen.getByRole("button", { name: "Switch to list" }));
  expect(localStorage.getItem("caphub-desk-list")).toBe("true");
});
it("automatically falls back and hides toggle when scene cannot create WebGL", async () => {
  mocks.create.mockRejectedValue(new Error("WebGL unavailable"));
  render(<Desk {...props} />);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Switch to list" })).toBeNull());
  expect(screen.getByRole("link", { name: "A card" })).toBeTruthy();
});
it("refreshes running work while search is focused, pauses only for capture dialog", async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    }
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    }
  });
  try {
    const { act } = await import("@testing-library/react");
    render(
      <Desk
        {...props}
        items={[
          {
            kind: "running",
            captureId: "run",
            captureKind: "text",
            createdAt: "2026-01-01",
            url: null,
            okSteps: [],
            preview: null
          }
        ]}
      />
    );
    screen.getByRole("searchbox").focus();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Add a paper" }));
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  } finally {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    vi.useRealTimers();
  }
});
it("rerun instantly changes the selected pending sheet to a running paper", async () => {
  mocks.rerun.mockResolvedValue({ ok: true });
  const toolbar = await open();
  fireEvent.keyDown(toolbar, { key: "r" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Capture being analyzed" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: "A card" })).toBeNull();
});

it("measures the free band when the action bar mounts and when the viewport changes", async () => {
  let wallBottom = 180;
  const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    if (this.classList.contains("desk-canvas")) return { top: 60, bottom: 900 } as DOMRect;
    if (this.classList.contains("desk-wall")) return { bottom: wallBottom } as DOMRect;
    if (this.classList.contains("desk-actions")) return { top: 800 } as DOMRect;
    return { top: 0, bottom: 0 } as DOMRect;
  });
  try {
    render(<Desk {...props} />);
    await waitFor(() => expect(mocks.setOpenBand).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "A card" }));
    expect(mocks.setOpenBand).toHaveBeenLastCalledWith({ top: 120, bottom: 740 });
    wallBottom = 220;
    fireEvent(window, new Event("resize"));
    expect(mocks.setOpenBand).toHaveBeenLastCalledWith({ top: 160, bottom: 740 });
  } finally { rects.mockRestore(); }
});
