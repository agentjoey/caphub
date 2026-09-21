// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Fonts are irrelevant here and `next/font` only resolves inside a Next build.
vi.mock("../fonts", () => ({ fontVariables: "font-vars" }));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "font-vars" }) }));
vi.mock("next/font/google", () => ({ IBM_Plex_Mono: () => ({ variable: "font-vars" }) }));
vi.mock("next/script", () => ({
  default: ({ src, strategy }: { src: string; strategy?: string }) => <script src={src} data-strategy={strategy} async />
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), back: vi.fn(), push: vi.fn() }),
  usePathname: () => "/mini"
}));
vi.mock("../../lib/i18n/locale", () => ({ getLocale: async () => "zh" }));

const { default: MiniLayout } = await import("./layout");
const { default: ChromeLayout } = await import("../(chrome)/layout");

/**
 * `/mini` renders through its own root layout, not the desktop one. The Mini App lives inside
 * Telegram's WebView: tapping the brand link or a primary-nav entry would navigate that WebView
 * onto `/`, `/review` or `/library` — surfaces with no mobile styling, and unreachable with only
 * a mini session. The ChromeLayout assertions below are the control: they prove this test would
 * actually notice if AppShell came back.
 */
describe("/mini layout composition", () => {
  it("renders a mini page with no brand link and no primary nav", async () => {
    const html = renderToStaticMarkup(await MiniLayout({ children: <p>mini page body</p> }));

    expect(html).toContain("mini page body");
    expect(html).not.toContain("primary-nav");
    expect(html).not.toContain('href="/library"');
    expect(html).not.toContain('href="/review"');
    expect(html).not.toContain("brand__text");
    expect(html).not.toContain("<nav");
  });

  it("loads the Telegram SDK ahead of hydration, and only here", async () => {
    const miniHtml = renderToStaticMarkup(await MiniLayout({ children: <p>mini</p> }));
    expect(miniHtml).toContain("https://telegram.org/js/telegram-web-app.js");
    expect(miniHtml).toContain('data-strategy="beforeInteractive"');

    const chromeHtml = renderToStaticMarkup(await ChromeLayout({ children: <p>desktop</p> }));
    expect(chromeHtml).not.toContain("telegram-web-app.js");
  });

  it("control: the desktop layout does still render the primary nav", async () => {
    const html = renderToStaticMarkup(await ChromeLayout({ children: <p>desktop</p> }));
    expect(html).toContain("primary-nav");
    expect(html).toContain('href="/library"');
  });
});
