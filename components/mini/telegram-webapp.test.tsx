// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TelegramWebApp } from "./telegram-webapp";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

// Imported after the mock above so TelegramProvider picks up the mocked useRouter.
const { TelegramProvider, useTelegram } = await import("./telegram-webapp");

function fakeWebApp(): TelegramWebApp & { _fire: (event: string) => void } {
  const handlers: Record<string, () => void> = {};
  return {
    initData: "stub",
    colorScheme: "light",
    themeParams: { bg_color: "#ffffff", text_color: "#000000" },
    ready: vi.fn(),
    expand: vi.fn(),
    onEvent: vi.fn((e: string, h: () => void) => {
      handlers[e] = h;
    }),
    offEvent: vi.fn(),
    BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
    MainButton: {
      setText: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      onClick: vi.fn(),
      offClick: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
    },
    HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn() },
    _fire: (e: string) => handlers[e]?.(),
  };
}

function withFakeTelegram(wa: TelegramWebApp) {
  window.Telegram = { WebApp: wa };
  return function Wrapper({ children }: { children: ReactNode }) {
    return <TelegramProvider>{children}</TelegramProvider>;
  };
}

afterEach(() => {
  cleanup();
  delete window.Telegram;
  vi.restoreAllMocks();
  refresh.mockClear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--paper");
  document.documentElement.style.removeProperty("--ink");
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true })
  );
});

describe("TelegramProvider", () => {
  it("renders children before Telegram is available and does not crash", () => {
    render(
      <TelegramProvider>
        <p>hello</p>
      </TelegramProvider>
    );
    expect(screen.getByText("hello")).not.toBeNull();
  });

  it("calls ready() and expand() on mount when Telegram is available", () => {
    const wa = fakeWebApp();
    render(<p>hi</p>, { wrapper: withFakeTelegram(wa) });
    expect(wa.ready).toHaveBeenCalled();
    expect(wa.expand).toHaveBeenCalled();
  });

  it("posts initData to /api/mini/session once and refreshes on success", async () => {
    const wa = fakeWebApp();
    render(<p>hi</p>, { wrapper: withFakeTelegram(wa) });

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/mini/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ initData: "stub" }),
      })
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("follows a colorScheme change", () => {
    const wa = fakeWebApp();
    render(<p>hi</p>, { wrapper: withFakeTelegram(wa) });
    expect(document.documentElement.dataset.theme).toBe("light");

    wa.colorScheme = "dark";
    wa.themeParams = { bg_color: "#000000", text_color: "#ffffff" };
    act(() => {
      wa._fire("themeChanged");
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("never paints Telegram's own colours over Caphub's palette", () => {
    // Telegram hands us a white background; the Mini App is meant to look like the mobile web,
    // whose paper cream lives in globals.css. Writing themeParams onto --paper is what made the
    // Mini App near-white, so the inline override must stay absent in both schemes.
    const wa = fakeWebApp();
    wa.themeParams = { bg_color: "#ffffff", text_color: "#000000" };
    render(<p>hi</p>, { wrapper: withFakeTelegram(wa) });
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--ink")).toBe("");

    wa.colorScheme = "dark";
    wa.themeParams = { bg_color: "#000000", text_color: "#ffffff" };
    act(() => {
      wa._fire("themeChanged");
    });
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--ink")).toBe("");
  });

  it("unsubscribes themeChanged on unmount", () => {
    const wa = fakeWebApp();
    const { unmount } = render(<p>hi</p>, { wrapper: withFakeTelegram(wa) });
    unmount();
    expect(wa.offEvent).toHaveBeenCalledWith("themeChanged", expect.any(Function));
  });

  // `beforeInteractive` puts the SDK's <script> in the server HTML ahead of every Next module
  // but explicitly does not block hydration on its execution, so "no bridge at hydration, bridge
  // a moment later" is a real ordering, not a hypothetical. Before the fix `ready` was snapshot
  // through a no-op subscribe and stayed false forever, which meant no ready(), no expand() and
  // no session exchange — the Mini App simply never worked.
  it("flips ready when the SDK script arrives after hydration", async () => {
    function Probe() {
      const { ready } = useTelegram();
      return <p>ready:{String(ready)}</p>;
    }
    render(
      <TelegramProvider>
        <Probe />
      </TelegramProvider>
    );
    expect(screen.getByText("ready:false")).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    const wa = fakeWebApp();
    await act(async () => {
      window.Telegram = { WebApp: wa };
      window.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    expect(screen.getByText("ready:true")).not.toBeNull();
    expect(wa.ready).toHaveBeenCalledTimes(1);
    expect(wa.expand).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a visible error when the session exchange fails instead of failing silently", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const wa = fakeWebApp();
    render(<p>hi</p>, { wrapper: withFakeTelegram(wa) });

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("alert").textContent).toContain("Telegram");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("exposes ready/colorScheme/haptic via useTelegram", () => {
    const wa = fakeWebApp();
    function Probe() {
      const { ready, colorScheme } = useTelegram();
      return (
        <p>
          {String(ready)}-{colorScheme}
        </p>
      );
    }
    render(<Probe />, { wrapper: withFakeTelegram(wa) });
    expect(screen.getByText("true-light")).not.toBeNull();
  });
});
