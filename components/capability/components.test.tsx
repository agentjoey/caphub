// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CardSummary } from "./card-summary";
import { PlaybookView, playbookHasContent } from "./playbook-view";
import { CopyButton } from "./copy-button";

afterEach(cleanup);

const row = {
  id: "cab_1", captureId: "cap_1", title: "Scrapling 自适应爬虫框架", type: "skill", summary: "摘要文字", signals: ["a", "b"],
  suggestedVerdict: "keep", suggestedReason: "成熟开源", confidence: 0.86, verdict: "pending", verdictBy: null,
  usage: "integrate", playbook: { kind: "integrate", install: ["pip install scrapling"], repo: "D4Vinci/Scrapling" },
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

  it("leads with the verdict and the summary, folding points, signals and tags away", () => {
    const withPoints = { ...row, summaryPoints: [{ label: "定位", text: "一句话定位" }] };
    const { container } = render(<CardSummary row={withPoints as never} />);
    const more = container.querySelector("details.card-more")!;
    expect(more.hasAttribute("open")).toBe(false);
    expect(more.querySelector("summary")?.textContent).toBe("完整摘要 · 1 条要点");
    expect(more.textContent).toContain("一句话定位");
    expect(more.textContent).toContain("web-scraping");
    expect(more.querySelector(".card-signals")).toBeTruthy();
    // The lead and the verdict stay outside the fold.
    expect(more.textContent).not.toContain("摘要文字");
    expect(more.textContent).not.toContain("成熟开源");
  });

  it("renders no fold when there is nothing beyond the lead", () => {
    const bare = { ...row, summaryPoints: [], signals: [], tags: [] };
    const { container } = render(<CardSummary row={bare as never} />);
    expect(container.querySelector("details.card-more")).toBeNull();
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

  it("renders usage_prompt with its AI-generated label and a copy button for a non-prompt integrate card", () => {
    render(<PlaybookView type="skill" playbook={{ kind: "integrate", install: [], repo: null, usage_prompt: "使用 xyz skill，把我提供的内容做成…" }} />);
    expect(screen.getByText("用法示例（AI 生成）")).toBeTruthy();
    expect(screen.getByText("使用 xyz skill，把我提供的内容做成…")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /复制/ }).length).toBeGreaterThan(0);
  });

  it("does not render usage_prompt for a prompt-type card even when the field is set", () => {
    render(<PlaybookView type="prompt" playbook={{ kind: "integrate", install: [], repo: null, usage_prompt: "不该出现的示例" }} />);
    expect(screen.queryByText("用法示例（AI 生成）")).toBeNull();
    expect(screen.queryByText("不该出现的示例")).toBeNull();
  });

  it("does not render the usage_prompt block when usage_prompt is null", () => {
    render(<PlaybookView type="skill" playbook={{ kind: "integrate", install: [], repo: null, usage_prompt: null }} />);
    expect(screen.queryByText("用法示例（AI 生成）")).toBeNull();
  });
});

describe("playbookHasContent", () => {
  it("playbookHasContent is false for an empty integrate playbook", () => {
    expect(playbookHasContent({ kind: "integrate", install: [], repo: null, usage_prompt: null }, "skill")).toBe(false);
    expect(playbookHasContent({ kind: "integrate", install: ["npm i x"], repo: null, usage_prompt: null }, "skill")).toBe(true);
    expect(playbookHasContent({ kind: "reference", points: ["p"] }, "skill")).toBe(true);
  });

  it("counts a non-empty usage_prompt as content for a non-prompt type", () => {
    expect(playbookHasContent({ kind: "integrate", install: [], repo: null, usage_prompt: "示例" }, "skill")).toBe(true);
  });

  it("does not count usage_prompt as content for a prompt-type card", () => {
    expect(playbookHasContent({ kind: "integrate", install: [], repo: null, usage_prompt: "示例" }, "prompt")).toBe(false);
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
    await waitFor(() => expect(screen.getByRole("button", { name: "复制失败" })).toBeTruthy());
  });

  it("shows the English label and status text under the en locale", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<CopyButton text="hello" locale="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy failed" })).toBeTruthy());
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
