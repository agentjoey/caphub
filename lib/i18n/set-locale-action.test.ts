import { describe, expect, it, vi, beforeEach } from "vitest";

const { set, cookies } = vi.hoisted(() => {
  const set = vi.fn();
  const cookies = vi.fn(async () => ({ set, get: vi.fn() }));
  return { set, cookies };
});

vi.mock("next/headers", () => ({ cookies }));

import { setLocaleAction } from "./set-locale-action";

beforeEach(() => {
  set.mockClear();
  cookies.mockClear();
});

describe("setLocaleAction", () => {
  it("persists 'en' verbatim", async () => {
    await setLocaleAction("en");
    expect(set).toHaveBeenCalledWith("lang", "en", expect.objectContaining({ path: "/", sameSite: "lax" }));
  });

  it("persists 'zh' verbatim", async () => {
    await setLocaleAction("zh");
    expect(set).toHaveBeenCalledWith("lang", "zh", expect.objectContaining({ path: "/", sameSite: "lax" }));
  });

  it("normalizes any other value to 'zh' — Server Actions are public POST endpoints, so the TS parameter type is not a runtime guarantee", async () => {
    // A forged/invalid request body could bypass the `Locale` type at the network boundary.
    await setLocaleAction("fr" as never);
    expect(set).toHaveBeenCalledWith("lang", "zh", expect.objectContaining({ path: "/", sameSite: "lax" }));

    set.mockClear();
    await setLocaleAction("<script>alert(1)</script>" as never);
    expect(set).toHaveBeenCalledWith("lang", "zh", expect.objectContaining({ path: "/", sameSite: "lax" }));

    set.mockClear();
    await setLocaleAction(undefined as never);
    expect(set).toHaveBeenCalledWith("lang", "zh", expect.objectContaining({ path: "/", sameSite: "lax" }));
  });

  it("sets a one-year maxAge", async () => {
    await setLocaleAction("en");
    const options = set.mock.calls[0][2] as { maxAge: number };
    expect(options.maxAge).toBe(60 * 60 * 24 * 365);
  });
});
