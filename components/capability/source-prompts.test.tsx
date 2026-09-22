// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SourcePrompts } from "./source-prompts";

afterEach(cleanup);

describe("SourcePrompts", () => {
  it("renders nothing without prompts", () => {
    const { container } = render(<SourcePrompts prompts={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders each prompt in full, keeping line breaks, with its own copy button", () => {
    const long = "第一行\n第二行 --s 250\n" + "字".repeat(5000);
    render(<SourcePrompts prompts={[{ text: long }, { text: "second" }]} />);
    expect(screen.getByRole("heading", { name: "Prompt 原文" })).toBeTruthy();
    const pres = document.querySelectorAll("pre");
    expect(pres).toHaveLength(2);
    expect(pres[0].textContent).toBe(long);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("第 1 条")).toBeTruthy();
  });

  it("omits the index label for a single prompt", () => {
    render(<SourcePrompts prompts={[{ text: "only" }]} />);
    expect(screen.queryByText("第 1 条")).toBeNull();
  });
});
