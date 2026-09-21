// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TelegramWebApp } from "./telegram-webapp";
import { BackButton } from "./back-button";

function fakeWebApp(): TelegramWebApp {
  return {
    initData: "stub",
    colorScheme: "light",
    themeParams: {},
    ready: vi.fn(),
    expand: vi.fn(),
    onEvent: vi.fn(),
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
  };
}

function withFakeTelegram(wa: TelegramWebApp) {
  window.Telegram = { WebApp: wa };
  return function Wrapper({ children }: { children: ReactNode }) {
    return <>{children}</>;
  };
}

afterEach(() => {
  cleanup();
  delete window.Telegram;
});

describe("BackButton", () => {
  it("renders nothing", () => {
    const wa = fakeWebApp();
    const { container } = render(<BackButton onClick={vi.fn()} />, { wrapper: withFakeTelegram(wa) });
    expect(container.innerHTML).toBe("");
  });

  it("shows and binds onClick on mount", () => {
    const wa = fakeWebApp();
    const onClick = vi.fn();
    render(<BackButton onClick={onClick} />, { wrapper: withFakeTelegram(wa) });
    expect(wa.BackButton.show).toHaveBeenCalled();
    expect(wa.BackButton.onClick).toHaveBeenCalledWith(onClick);
  });

  it("unbinds the back button on unmount so the next page does not inherit it", () => {
    const wa = fakeWebApp();
    const onClick = vi.fn();
    const { unmount } = render(<BackButton onClick={onClick} />, { wrapper: withFakeTelegram(wa) });
    expect(wa.BackButton.show).toHaveBeenCalled();
    unmount();
    expect(wa.BackButton.offClick).toHaveBeenCalledWith(onClick);
    expect(wa.BackButton.hide).toHaveBeenCalled();
  });

  it("does nothing outside Telegram", () => {
    expect(() => render(<BackButton onClick={vi.fn()} />)).not.toThrow();
  });
});
