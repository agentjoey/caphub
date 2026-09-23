// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PromptNotice } from "./prompt-notice";

afterEach(cleanup);

describe("PromptNotice", () => {
  it("warns about unresolved prompts on any type", () => {
    render(<PromptNotice type="skill" promptCount={1} promptUnresolved={2} />);
    expect(screen.getByText(/有 2 条 prompt 原文未能/)).toBeTruthy();
  });
  it("warns when a prompt card has no prompt", () => {
    render(<PromptNotice type="prompt" promptCount={0} promptUnresolved={0} />);
    expect(screen.getByText(/未摘到 prompt 原文/)).toBeTruthy();
  });
  it("renders nothing for a healthy card", () => {
    const { container } = render(<PromptNotice type="prompt" promptCount={1} promptUnresolved={0} />);
    expect(container.innerHTML).toBe("");
  });
});
