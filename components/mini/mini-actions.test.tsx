// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ActionResult } from "../../lib/library/actions";
import type { TelegramWebApp } from "./telegram-webapp";

const decideAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
const editSuggestionAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
const setProgressAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
const rerunAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();
const softDeleteAction = vi.fn<(...args: unknown[]) => Promise<ActionResult>>();

vi.mock("../../app/actions", () => ({
  decideAction: (...args: unknown[]) => decideAction(...(args as [])),
  editSuggestionAction: (...args: unknown[]) => editSuggestionAction(...(args as [])),
  setProgressAction: (...args: unknown[]) => setProgressAction(...(args as [])),
  rerunAction: (...args: unknown[]) => rerunAction(...(args as [])),
  softDeleteAction: (...args: unknown[]) => softDeleteAction(...(args as []))
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const haptic = vi.fn();
vi.mock("./telegram-webapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram-webapp")>();
  return { ...actual, useTelegram: () => ({ ready: true, colorScheme: "light" as const, haptic }) };
});

import { MiniActions } from "./mini-actions";

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
      disable: vi.fn()
    },
    HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn() }
  };
}

function withFakeTelegram(wa: TelegramWebApp) {
  window.Telegram = { WebApp: wa };
  return function Wrapper({ children }: { children: ReactNode }) {
    return <>{children}</>;
  };
}

describe("MiniActions", () => {
  afterEach(() => {
    cleanup();
    delete window.Telegram;
  });
  beforeEach(() => {
    decideAction.mockReset();
    editSuggestionAction.mockReset();
    setProgressAction.mockReset();
    rerunAction.mockReset();
    softDeleteAction.mockReset();
    haptic.mockReset();
  });

  it("fires a success haptic when a decision succeeds and a warning haptic when it conflicts", async () => {
    decideAction.mockResolvedValueOnce({ ok: true, updatedAt: "2026-09-21T00:00:01.000Z" });
    render(
      <MiniActions
        id="cab_1"
        captureId="cap_1"
        updatedAt="2026-09-21T00:00:00.000Z"
        verdict="pending"
        type="skill"
        usage="integrate"
        tags={[]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await waitFor(() => expect(decideAction).toHaveBeenCalledOnce());
    await waitFor(() => expect(haptic).toHaveBeenCalledWith("success"));
    expect(haptic).not.toHaveBeenCalledWith("warning");

    haptic.mockReset();
    decideAction.mockResolvedValueOnce({ ok: false, reason: "CONFLICT", message: "已被修改，请刷新" });
    cleanup();
    render(
      <MiniActions
        id="cab_2"
        captureId="cap_2"
        updatedAt="2026-09-21T00:00:00.000Z"
        verdict="pending"
        type="skill"
        usage="integrate"
        tags={[]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "丢弃" }));
    await waitFor(() => expect(decideAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(haptic).toHaveBeenCalledWith("warning"));
    expect(haptic).not.toHaveBeenCalledWith("success");
  });

  it("freezes the control on CONFLICT instead of retrying with a stale lock token", async () => {
    decideAction.mockResolvedValueOnce({ ok: false, reason: "CONFLICT", message: "已被修改，请刷新" });
    render(
      <MiniActions
        id="cab_1"
        captureId="cap_1"
        updatedAt="2026-09-21T00:00:00.000Z"
        verdict="pending"
        type="skill"
        usage="integrate"
        tags={[]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await waitFor(() => expect(decideAction).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText("已被修改，请刷新")).toBeTruthy());

    // The control is now frozen: a second click on any lock-carrying action must NOT fire another
    // request with the same (now stale) token — it must wait for a reload instead.
    fireEvent.click(screen.getByRole("button", { name: "丢弃" }));
    expect(decideAction).toHaveBeenCalledOnce();
  });

  it("never binds MainButton for a pending card — that state is only ever rendered on /mini/review, which always passes enableMainButton={false}", () => {
    const wa = fakeWebApp();
    render(
      <MiniActions
        id="cab_1"
        captureId="cap_1"
        updatedAt="t"
        verdict="pending"
        type="skill"
        usage="integrate"
        tags={[]}
      />,
      { wrapper: withFakeTelegram(wa) }
    );
    expect(wa.MainButton.setText).not.toHaveBeenCalled();
    expect(wa.MainButton.show).not.toHaveBeenCalled();
  });

  it("binds MainButton to the primary action for the card's current state", () => {
    // 已保留、参考自研、未开始自研：MainButton 绑定「开始自研」
    const wa2 = fakeWebApp();
    const { unmount: unmount2 } = render(
      <MiniActions
        id="cab_2"
        captureId="cap_2"
        updatedAt="t"
        verdict="keep"
        type="skill"
        usage="reference"
        tags={[]}
        progress="todo"
        progressLink={null}
      />,
      { wrapper: withFakeTelegram(wa2) }
    );
    expect(wa2.MainButton.setText).toHaveBeenCalledWith("开始自研");
    unmount2();

    // 已在自研中：不再绑定同一个「开始自研」主按钮
    const wa3 = fakeWebApp();
    render(
      <MiniActions
        id="cab_3"
        captureId="cap_3"
        updatedAt="t"
        verdict="keep"
        type="skill"
        usage="reference"
        tags={[]}
        progress="building"
        progressLink={null}
      />,
      { wrapper: withFakeTelegram(wa3) }
    );
    expect(wa3.MainButton.setText).not.toHaveBeenCalledWith("开始自研");
  });
});
