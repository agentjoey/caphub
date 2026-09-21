// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CapabilityRow } from "../../lib/library/queries";
import { NO_OVERLAP } from "../../lib/analysis/card";
import { issueMiniSession, MINI_COOKIE } from "../../lib/telegram/mini-session";

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

const embedSearchQuery = vi.fn(async () => null);
vi.mock("../../lib/library/query-embedding", () => ({ embedSearchQuery: (...args: unknown[]) => embedSearchQuery(...(args as [])) }));
vi.mock("../../lib/analysis/scenarios", () => ({ loadScenarios: async () => [] }));

const BOT_TOKEN = "123:test-bot-token";
const OWNER_ID = "4242";
vi.mock("../../lib/runtime", () => ({
  getRuntime: () => ({
    pool: {},
    config: {
      providers: { geminiApiKey: "test-gemini-key" },
      telegram: { enabled: true, botToken: BOT_TOKEN, ownerChatId: OWNER_ID }
    }
  })
}));
vi.mock("../../lib/i18n/locale", () => ({ getLocale: async () => "zh" }));

// The mini-session cookie is NOT mocked away: these tests exercise the real `verifyMiniSession`
// the guard uses, so a change that made the page accept an unsigned or foreign cookie would fail
// here instead of silently reopening the leak.
let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === MINI_COOKIE && cookieValue ? { name, value: cookieValue } : undefined) })
}));

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
  // A genuine, correctly signed session for the configured owner — every test below except the
  // no-session ones renders as the signed-in owner does.
  cookieValue = issueMiniSession(OWNER_ID, { botToken: BOT_TOKEN });
  embedSearchQuery.mockClear();
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

  // `GET /mini` is cookie-exempt in lib/auth/guard.ts (the shell has to load before it can
  // exchange initData), so the page itself is the only thing keeping an Access session with no
  // Telegram from reading the library.
  describe("without a valid mini session", () => {
    it("renders only the shell: no library data, no query, no embedding call", async () => {
      cookieValue = undefined;
      const { default: Page } = await import("./page");
      render(await Page({ searchParams: Promise.resolve({ q: "scrape", page: "3" }) }));

      expect(listLibrary).not.toHaveBeenCalled();
      expect(libraryStats).not.toHaveBeenCalled();
      expect(scenarioStats).not.toHaveBeenCalled();
      expect(allTags).not.toHaveBeenCalled();
      expect(embedSearchQuery).not.toHaveBeenCalled();
      expect(screen.queryByRole("link", { name: /网页抓取技能/ })).toBeNull();
      expect(document.body.textContent).not.toContain("网页抓取技能");
      expect(document.body.textContent).not.toContain("SKL-0012");
      // No search box either — it would only ever submit back into this same empty shell.
      expect(screen.queryByRole("searchbox")).toBeNull();
    });

    it("refuses a tampered or foreign cookie the same way", async () => {
      for (const bad of [
        "not-a-cookie",
        issueMiniSession(OWNER_ID, { botToken: "a-different-bot-token" }),
        issueMiniSession("9999", { botToken: BOT_TOKEN })
      ]) {
        cookieValue = bad;
        const { default: Page } = await import("./page");
        render(await Page({ searchParams: Promise.resolve({}) }));
        expect(listLibrary).not.toHaveBeenCalled();
        cleanup();
      }
    });
  });

  it("never puts a page param on a row href, even when the list itself is on page 2", async () => {
    listLibrary.mockResolvedValueOnce({ items: [baseRow], total: 25 });
    const { default: Page } = await import("./page");
    render(await Page({ searchParams: Promise.resolve({ page: "2" }) }));

    const row = screen.getByRole("link", { name: /网页抓取技能/ });
    expect(row.getAttribute("href")).toBe("/mini/library/cab_1");
  });
});
