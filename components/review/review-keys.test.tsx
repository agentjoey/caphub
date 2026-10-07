// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { REVIEW_DONE_EVENT, ReviewKeys } from "./review-keys";

const clicks: string[] = [];

function Card({ id, state = "idle", disabled = false }: { id: string; state?: string; disabled?: boolean }) {
  return (
    <div data-review-item="" data-state={state} tabIndex={-1} id={id}>
      {(["keep", "discard", "edit", "rerun"] as const).map((action) => (
        <button key={action} type="button" data-action={action} disabled={disabled} onClick={() => clicks.push(`${id}:${action}`)}>
          {action}
        </button>
      ))}
      <input aria-label={`tags-${id}`} />
    </div>
  );
}

function renderQueue(cards = [<Card key="a" id="a" />, <Card key="b" id="b" />]) {
  return render(
    <>
      <ReviewKeys total={cards.length} labels={{ remaining: "剩余 {count} 张", hint: "J/K 切换" }} />
      {cards}
    </>
  );
}

const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init });

beforeEach(() => {
  clicks.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("ReviewKeys", () => {
  it("j and k move focus between pending cards", () => {
    renderQueue();
    key("j");
    expect(document.activeElement?.id).toBe("a");
    key("j");
    expect(document.activeElement?.id).toBe("b");
    key("k");
    expect(document.activeElement?.id).toBe("a");
  });

  it("y / x / e / r press the focused card's keep / discard / edit / rerun", () => {
    renderQueue();
    key("j");
    key("y");
    key("x");
    key("e");
    key("r");
    expect(clicks).toEqual(["a:keep", "a:discard", "a:edit", "a:rerun"]);
  });

  it("acts on the first pending card when nothing is focused yet", () => {
    renderQueue([<Card key="a" id="a" state="done" />, <Card key="b" id="b" />]);
    key("y");
    expect(clicks).toEqual(["b:keep"]);
  });

  it("ignores keys typed into a field, so editing tags never keeps or discards a card", () => {
    renderQueue();
    const input = screen.getByLabelText("tags-a");
    input.focus();
    fireEvent.keyDown(input, { key: "y" });
    fireEvent.keyDown(input, { key: "x" });
    expect(clicks).toEqual([]);
  });

  it("leaves modified keys (⌘R reload, Ctrl+Y) to the browser", () => {
    renderQueue();
    key("j");
    const reload = new KeyboardEvent("keydown", { key: "r", metaKey: true, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(reload);
    key("y", { ctrlKey: true });
    expect(clicks).toEqual([]);
    expect(reload.defaultPrevented).toBe(false);
  });

  it("does not press a disabled button (a save already in flight)", () => {
    renderQueue([<Card key="a" id="a" disabled />, <Card key="b" id="b" />]);
    key("j");
    key("y");
    expect(clicks).toEqual([]);
  });

  it("counts down and moves on to the next pending card when one is decided", () => {
    renderQueue();
    expect(screen.getByText("剩余 2 张")).toBeTruthy();
    key("j");
    act(() => {
      document.getElementById("a")!.setAttribute("data-state", "done");
      window.dispatchEvent(new CustomEvent(REVIEW_DONE_EVENT, { detail: { id: "a" } }));
    });
    expect(screen.getByText("剩余 1 张")).toBeTruthy();
    expect(document.activeElement?.id).toBe("b");
  });
});
