// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CardSummary } from "./card-summary";
import { PlaybookView } from "./playbook-view";
import { CopyButton } from "./copy-button";

afterEach(cleanup);

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

  it("renders reference points as a list", () => {
    render(<PlaybookView type="skill" playbook={{ kind: "reference", points: ["要点一", "要点二"] }} />);
    expect(screen.getByText("要点一")).toBeTruthy();
    expect(screen.getByText("要点二")).toBeTruthy();
  });
});

describe("CopyButton", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows 复制失败 when the clipboard write rejects", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<CopyButton text="hello" />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(screen.getByText("复制失败")).toBeTruthy());
  });

  it("shows the English label and status text under the en locale", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<CopyButton text="hello" locale="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByText("Copy failed")).toBeTruthy());
  });
});

describe("locale=en", () => {
  it("translates chrome (type/usage/verdict labels) but leaves AI-generated card content untouched", () => {
    render(<CardSummary row={row as never} locale="en" />);
    // Chrome text is translated.
    expect(screen.getByText("Skill")).toBeTruthy();
    expect(screen.getByText("Integrate directly")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText(/Suggests Keep/)).toBeTruthy();
    // AI-generated content (title, summary, reason, tags) is verbatim regardless of locale.
    expect(screen.getByText("Scrapling 自适应爬虫框架")).toBeTruthy();
    expect(screen.getByText("摘要文字")).toBeTruthy();
    expect(screen.getByText("成熟开源", { exact: false })).toBeTruthy();
    expect(screen.getByText("web-scraping")).toBeTruthy();
    expect(screen.queryByText("技能")).toBeNull();
  });

  it("translates the playbook copy-all label but not experience/reference AI content", () => {
    render(<PlaybookView type="experience" playbook={{ kind: "experience", content: "核心步骤", when_to_use: "生成图片时" }} locale="en" />);
    expect(screen.getByText("核心步骤")).toBeTruthy();
    expect(screen.getByText(/When to use:/)).toBeTruthy();
    expect(screen.getByText(/生成图片时/)).toBeTruthy();
  });
});
