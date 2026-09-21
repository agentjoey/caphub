// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TelegramWebApp } from "./telegram-webapp";
import { MainButton } from "./main-button";

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

describe("MainButton", () => {
  it("renders nothing", () => {
    const wa = fakeWebApp();
    const { container } = render(<MainButton text="Save" onClick={vi.fn()} />, {
      wrapper: withFakeTelegram(wa),
    });
    expect(container.innerHTML).toBe("");
  });

  it("sets text, binds onClick and shows on mount", () => {
    const wa = fakeWebApp();
    const onClick = vi.fn();
    render(<MainButton text="Save" onClick={onClick} />, { wrapper: withFakeTelegram(wa) });
    expect(wa.MainButton.setText).toHaveBeenCalledWith("Save");
    expect(wa.MainButton.onClick).toHaveBeenCalledWith(onClick);
    expect(wa.MainButton.show).toHaveBeenCalled();
    expect(wa.MainButton.enable).toHaveBeenCalled();
  });

  it("disables the button when disabled is true", () => {
    const wa = fakeWebApp();
    render(<MainButton text="Save" onClick={vi.fn()} disabled />, { wrapper: withFakeTelegram(wa) });
    expect(wa.MainButton.disable).toHaveBeenCalled();
    expect(wa.MainButton.enable).not.toHaveBeenCalled();
  });

  it("unbinds on unmount so the next page does not inherit it", () => {
    const wa = fakeWebApp();
    const onClick = vi.fn();
    const { unmount } = render(<MainButton text="Save" onClick={onClick} />, {
      wrapper: withFakeTelegram(wa),
    });
    unmount();
    expect(wa.MainButton.offClick).toHaveBeenCalledWith(onClick);
    expect(wa.MainButton.hide).toHaveBeenCalled();
  });

  it("does nothing outside Telegram", () => {
    expect(() => render(<MainButton text="Save" onClick={vi.fn()} />)).not.toThrow();
  });
});
