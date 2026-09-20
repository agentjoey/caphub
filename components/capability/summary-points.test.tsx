// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SummaryBody, summaryPointLabel } from "./summary-points";

afterEach(cleanup);

const points = [
  { label: "定位", text: "自适应反爬抓取库" },
  { label: "适用场景", text: "站点结构频繁变动的采集任务" },
  { label: "限制", text: "不处理登录态" }
];

describe("summaryPointLabel", () => {
  it("appends the full stop that makes the label read as a lead-in", () => {
    expect(summaryPointLabel("定位")).toBe("定位。");
  });
  it("does not double a full stop the model already wrote", () => {
    expect(summaryPointLabel("定位。")).toBe("定位。");
    expect(summaryPointLabel("Scope.")).toBe("Scope。");
  });
  it("trims surrounding whitespace and trailing colons", () => {
    expect(summaryPointLabel("  限制： ")).toBe("限制。");
  });
});

describe("SummaryBody", () => {
  it("renders the prose lead and one bold-label line per point", () => {
    const { container } = render(<SummaryBody summary="摘要文字" points={points} />);
    expect(screen.getByText("摘要文字")).toBeTruthy();
    const items = container.querySelectorAll(".summary-points li");
    expect(items.length).toBe(3);
    expect(items[0].querySelector("b")?.textContent).toBe("定位。");
    expect(items[0].textContent).toBe("定位。 自适应反爬抓取库");
    expect(items[2].textContent).toBe("限制。 不处理登录态");
  });

  it("falls back to the prose summary alone when a card has no points yet", () => {
    const { container } = render(<SummaryBody summary="摘要文字" points={[]} />);
    expect(screen.getByText("摘要文字")).toBeTruthy();
    expect(container.querySelector(".summary-points")).toBeNull();
  });

  it("treats a missing points field (pre-migration row) as no points", () => {
    const { container } = render(<SummaryBody summary="摘要文字" points={undefined} />);
    expect(screen.getByText("摘要文字")).toBeTruthy();
    expect(container.querySelector(".summary-points")).toBeNull();
  });

  it("renders nothing at all when there is neither a summary nor a point — never an empty block", () => {
    const { container } = render(<SummaryBody summary="   " points={[]} />);
    expect(container.textContent).toBe("");
    expect(container.querySelector("p")).toBeNull();
  });

  it("drops blank points and renders a point that has only text", () => {
    const { container } = render(
      <SummaryBody summary="" points={[{ label: " ", text: "只有说明" }, { label: "空", text: "  " }]} />
    );
    const items = container.querySelectorAll(".summary-points li");
    expect(items.length).toBe(1);
    expect(items[0].textContent).toBe("只有说明");
    expect(items[0].querySelector("b")).toBeNull();
  });

  it("drops malformed points (non-string label/text, or a non-object entry) instead of throwing", () => {
    const malformed = [
      { label: "定位", text: "解决X问题" },
      { label: 42, text: "数字标签" },
      { label: "缺文字" },
      null,
      "not an object",
      { label: "限制", text: null }
    ] as never;
    const { container } = render(<SummaryBody summary="摘要文字" points={malformed} />);
    const items = container.querySelectorAll(".summary-points li");
    // Only the well-formed point (定位) and the one with a valid text but no valid label survive
    // -- everything else drops the malformed field(s) to "" and is filtered out since text === "".
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe("定位。 解决X问题");
    expect(items[1].textContent).toBe("数字标签");
  });

  it("puts the caller's class on the prose lead only, so points keep their own rhythm", () => {
    const { container } = render(<SummaryBody summary="摘要文字" points={points} className="detail-summary" />);
    expect(container.querySelector("p")?.className).toContain("detail-summary");
    expect(container.querySelector(".summary-points")?.className).not.toContain("detail-summary");
  });
});
