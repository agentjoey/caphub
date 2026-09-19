// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardSummary } from "./card-summary";
import { PlaybookView } from "./playbook-view";

const row = {
  id: "cab_1", captureId: "cap_1", title: "Scrapling 自适应爬虫框架", type: "skill", summary: "摘要文字", signals: ["a", "b"],
  suggestedVerdict: "keep", suggestedReason: "成熟开源", confidence: 0.86, verdict: "pending", verdictBy: null,
  usage: "integrate", playbook: { kind: "integrate", install: ["pip install scrapling"], repo: "D4Vinci/Scrapling", prompt_text: null },
  tags: ["web-scraping", "python"], sourceUrl: null, reviewNote: null, reviewRequestedAt: null, reviewError: null,
  syncedAt: null, deletedAt: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
  capture: { kind: "image", objectKey: "sha256/ab/" + "a".repeat(64), text: null, url: null }
} as const;

describe("CardSummary", () => {
  it("shows the six review fields and no internal ids", () => {
    const { container } = render(<CardSummary row={row as never} />);
    expect(screen.getByText("Scrapling 自适应爬虫框架")).toBeTruthy();
    expect(screen.getByText("技能")).toBeTruthy();
    expect(screen.getByText(/建议保留/)).toBeTruthy();
    expect(screen.getByText("成熟开源", { exact: false })).toBeTruthy();
    expect(screen.getByText("摘要文字")).toBeTruthy();
    expect(screen.getByText("web-scraping")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`/api/objects/sha256/ab/${"a".repeat(64)}`);
    expect(container.textContent).not.toMatch(/cab_|cap_|run_/);
  });
});

describe("PlaybookView", () => {
  it("renders integrate commands with copy buttons", () => {
    render(<PlaybookView type="skill" playbook={row.playbook as never} />);
    expect(screen.getByText("pip install scrapling")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /复制/ }).length).toBeGreaterThan(0);
  });
  it("renders experience content", () => {
    render(<PlaybookView type="experience" playbook={{ kind: "experience", content: "核心步骤", when_to_use: "生成图片时" }} />);
    expect(screen.getByText("核心步骤")).toBeTruthy();
    expect(screen.getByText(/生成图片时/)).toBeTruthy();
  });
});
