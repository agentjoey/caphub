// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BuildNotes } from "./build-notes";

describe("BuildNotes", () => {
  afterEach(cleanup);

  it("renders nothing when there are no notes", () => {
    const { container } = render(<BuildNotes notes={[]} locale="zh" />);
    expect(container.childElementCount).toBe(0);
  });

  it("lists notes newest first with author and time", () => {
    render(<BuildNotes locale="zh" notes={[
      { at: "2026-09-20T10:00:00.000Z", by: "claude", text: "先装了官方 skills" },
      { at: "2026-09-21T10:00:00.000Z", by: "codex", text: "补了 ScrollTrigger 的清理" }
    ]} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("补了 ScrollTrigger 的清理");
    expect(items[0].textContent).toContain("codex");
  });

  it("escapes an untrusted author name instead of rendering it as markup", () => {
    render(<BuildNotes locale="zh" notes={[
      { at: "2026-09-21T10:00:00.000Z", by: "<img src=x onerror=alert(1)>", text: "hi" }
    ]} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });
});
