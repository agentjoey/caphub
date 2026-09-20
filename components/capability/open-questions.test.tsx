// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OpenQuestions } from "./open-questions";

afterEach(cleanup);

describe("OpenQuestions", () => {
  it("renders nothing when there are no open questions", () => {
    const { container } = render(<OpenQuestions questions={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a 待核实 list with each question when non-empty", () => {
    render(<OpenQuestions questions={["是否需要登录才能用", "免费额度上限是多少"]} />);
    expect(screen.getByRole("heading", { name: "待核实" })).toBeTruthy();
    expect(screen.getByText("是否需要登录才能用")).toBeTruthy();
    expect(screen.getByText("免费额度上限是多少")).toBeTruthy();
  });

  it("renders the English title in en locale", () => {
    render(<OpenQuestions questions={["needs check"]} locale="en" />);
    expect(screen.queryByRole("heading", { name: "待核实" })).toBeNull();
  });
});
