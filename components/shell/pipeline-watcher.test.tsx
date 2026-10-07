// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { PipelineWatcher } from "./pipeline-watcher";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
  setHidden(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PipelineWatcher", () => {
  it("refreshes on an interval while active", () => {
    render(<PipelineWatcher active />);
    vi.advanceTimersByTime(3999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing when nothing is in flight", () => {
    render(<PipelineWatcher active={false} />);
    vi.advanceTimersByTime(20000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a background tab, and catches up once when it comes back", () => {
    render(<PipelineWatcher active />);
    setHidden(true);
    vi.advanceTimersByTime(12000);
    expect(refresh).not.toHaveBeenCalled();
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops after unmount and after going inactive", () => {
    const { rerender, unmount } = render(<PipelineWatcher active />);
    rerender(<PipelineWatcher active={false} />);
    vi.advanceTimersByTime(8000);
    expect(refresh).not.toHaveBeenCalled();
    rerender(<PipelineWatcher active />);
    unmount();
    vi.advanceTimersByTime(8000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("holds off while the user is editing, so a refresh never re-seeds a lock token under an open form", () => {
    render(<><PipelineWatcher active /><input aria-label="field" /></>);
    (document.querySelector("input") as HTMLInputElement).focus();
    vi.advanceTimersByTime(8000);
    expect(refresh).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    const editor = document.createElement("div");
    editor.setAttribute("data-editing", "");
    document.body.appendChild(editor);
    vi.advanceTimersByTime(8000);
    expect(refresh).not.toHaveBeenCalled();
    editor.remove();
    vi.advanceTimersByTime(4000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("gives up after its time limit, so a stuck queue does not poll forever", () => {
    render(<PipelineWatcher active maxMs={10000} />);
    vi.advanceTimersByTime(60000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
