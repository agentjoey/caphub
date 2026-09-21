// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CapabilityRow } from "../../lib/library/queries";
import { NO_OVERLAP } from "../../lib/analysis/card";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>
}));

const listLibrary = vi.fn();
const libraryStats = vi.fn();
const allTags = vi.fn();
const scenarioStats = vi.fn();
vi.mock("../../lib/library/queries", () => ({
  listLibrary: (...args: unknown[]) => listLibrary(...args),
  libraryStats: (...args: unknown[]) => libraryStats(...args),
  allTags: (...args: unknown[]) => allTags(...args),
  scenarioStats: (...args: unknown[]) => scenarioStats(...args)
}));

vi.mock("../../lib/library/query-embedding", () => ({ embedSearchQuery: async () => null }));
vi.mock("../../lib/analysis/scenarios", () => ({ loadScenarios: async () => [] }));
vi.mock("../../lib/runtime", () => ({ getRuntime: () => ({ pool: {}, config: { providers: { geminiApiKey: undefined } } }) }));
vi.mock("../../lib/i18n/locale", () => ({ getLocale: async () => "zh" }));

const STATS = { byType: { skill: 1, experience: 0, plugin: 0, prompt: 0, tool: 0, model: 0, other: 0 }, total: 1, tagCount: 1, pending: 0, toBuild: 0 };

const baseRow: CapabilityRow = {
  id: "cab_1", captureId: "cap_1", title: "网页抓取技能", type: "skill", summary: "摘要",
  summaryPoints: [], signals: [],
  suggestedVerdict: "keep", suggestedReason: "", confidence: 0.9,
  verdict: "keep", verdictBy: "human",
  usage: "integrate", playbook: { kind: "integrate", install: [], repo: null, prompt_text: null },
  tags: ["python", "scraping", "http", "cli"], sourceUrl: null,
  serial: 12, scenarios: [],
  score: 4, scoreReason: "solid", sourceFacts: {},
  progress: "todo", progressLink: null, progressAt: null,
  reviewNote: null, reviewRequestedAt: null, reviewError: null,
  status: "active", supersededBy: null, statusAt: null, statusNote: null, overlap: NO_OVERLAP,
  hasDeepAnalysis: false,
  syncedAt: null, deletedAt: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
  capture: { kind: "text", objectKey: null, thumbKey: null, text: "hi", url: null }
};

beforeEach(() => {
  listLibrary.mockReset();
  libraryStats.mockReset();
  allTags.mockReset();
  scenarioStats.mockReset();
  libraryStats.mockResolvedValue(STATS);
  allTags.mockResolvedValue([]);
  scenarioStats.mockResolvedValue([]);
});
afterEach(cleanup);

describe("mini library list page", () => {
  it("lists cards with serial, score and at most three tags", async () => {
    listLibrary.mockResolvedValueOnce({ items: [baseRow], total: 1 });
    const { default: Page } = await import("./page");
    render(await Page({ searchParams: Promise.resolve({}) }));

    const row = screen.getByRole("link", { name: /网页抓取技能/ });
    expect(row.getAttribute("href")).toBe("/mini/library/cab_1");
    expect(row.textContent).toContain("SKL-0012");
    expect(row.textContent).toContain("★ 4/5");
    // 4 tags on the card: only the first 3 plus a "+1" remainder should render.
    expect(row.textContent).toContain("python");
    expect(row.textContent).toContain("scraping");
    expect(row.textContent).toContain("http");
    expect(row.textContent).not.toContain("cli");
    expect(row.textContent).toContain("+1");
  });

  it("keeps the current filters in the row links so Back returns to the same view", async () => {
    listLibrary.mockResolvedValueOnce({ items: [baseRow], total: 1 });
    const { default: Page } = await import("./page");
    render(await Page({ searchParams: Promise.resolve({ q: "scrape", type: "skill" }) }));

    const row = screen.getByRole("link", { name: /网页抓取技能/ });
    expect(row.getAttribute("href")).toBe("/mini/library/cab_1?q=scrape&type=skill");
  });

  it("shows an empty state instead of a blank screen when nothing matches", async () => {
    listLibrary.mockResolvedValueOnce({ items: [], total: 0 });
    const { default: Page } = await import("./page");
    render(await Page({ searchParams: Promise.resolve({ q: "nothing-matches-this" }) }));

    expect(screen.getByText(/没有符合条件的能力/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /网页抓取技能/ })).toBeNull();
  });

  it("renders a next-page footer, carrying the current filters and the next page, when total exceeds the rendered rows", async () => {
    listLibrary.mockResolvedValueOnce({ items: [baseRow], total: 25 });
    const { default: Page } = await import("./page");
    render(await Page({ searchParams: Promise.resolve({ q: "scrape", type: "skill" }) }));

    const footer = screen.getByRole("link", { name: /还有 24 张/ });
    expect(footer.getAttribute("href")).toBe("/mini?q=scrape&type=skill&page=2");
  });

  it("pins the boundary between remaining=0 (no footer) and remaining=1 (footer)", async () => {
    listLibrary.mockResolvedValueOnce({ items: [baseRow], total: 1 });
    const { default: Page } = await import("./page");
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText(/还有 .* 张/)).toBeNull();
    cleanup();

    listLibrary.mockResolvedValueOnce({ items: [baseRow], total: 2 });
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/还有 1 张/)).toBeTruthy();
  });

  it("never puts a page param on a row href, even when the list itself is on page 2", async () => {
    listLibrary.mockResolvedValueOnce({ items: [baseRow], total: 25 });
    const { default: Page } = await import("./page");
    render(await Page({ searchParams: Promise.resolve({ page: "2" }) }));

    const row = screen.getByRole("link", { name: /网页抓取技能/ });
    expect(row.getAttribute("href")).toBe("/mini/library/cab_1");
  });
});
