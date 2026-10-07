// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>
}));

import { CapabilityCard } from "./capability-card";

afterEach(cleanup);

const row = {
  id: "cab_1", captureId: "cap_1", title: "Scrapling 自适应爬虫框架", type: "skill", summary: "一个会自己适应页面结构变化的 Python 爬虫库。",
  summaryPoints: [], signals: [], suggestedVerdict: "keep", suggestedReason: "", confidence: 0.9, verdict: "keep", verdictBy: "auto",
  usage: "integrate", tags: ["web-scraping", "python", "crawler", "automation"], serial: 12, scenarios: [], score: 4, scoreReason: "成熟",
  progress: "todo", status: "active", hasDeepAnalysis: false, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
  capture: { kind: "image", objectKey: "sha256/ab/" + "a".repeat(64), thumbKey: null, text: null, url: null }
} as const;

describe("CapabilityCard", () => {
  it("is one link to the capability, with its title, serial, summary lead and score", () => {
    render(<CapabilityCard row={row as never} locale="zh" relativeTime="2 天前" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/library/cab_1");
    expect(screen.getByText("Scrapling 自适应爬虫框架")).toBeTruthy();
    expect(screen.getByText("SKL-0012")).toBeTruthy();
    expect(screen.getByText("一个会自己适应页面结构变化的 Python 爬虫库。")).toBeTruthy();
    expect(screen.getByText("★ 4/5")).toBeTruthy();
    // Three quiet tags, then +1.
    expect(screen.getByText("+1")).toBeTruthy();
  });

  it("says why a search result matched", () => {
    render(<CapabilityCard row={{ ...row, matchedBy: ["title", "semantic"] } as never} locale="zh" relativeTime="2 天前" />);
    expect(screen.getByText("命中").parentElement?.textContent).toBe("命中标题语义");
  });

  it("shows no match line outside a search", () => {
    render(<CapabilityCard row={row as never} locale="zh" relativeTime="2 天前" />);
    expect(screen.queryByText("命中")).toBeNull();
  });

  it("mutes a retired card", () => {
    const { container } = render(<CapabilityCard row={{ ...row, status: "deprecated" } as never} locale="zh" relativeTime="2 天前" />);
    expect(container.querySelector(".cap-card")?.hasAttribute("data-muted")).toBe(true);
  });

  it("gives a text capture a typed placeholder instead of an image", () => {
    const text = { ...row, capture: { kind: "text", objectKey: null, thumbKey: null, text: "prompt", url: null } };
    const { container } = render(<CapabilityCard row={text as never} locale="zh" relativeTime="2 天前" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".cap-card__media")?.textContent).toBe("技能");
  });
});
