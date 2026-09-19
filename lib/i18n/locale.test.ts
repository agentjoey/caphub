import { describe, expect, it } from "vitest";
import { vi } from "vitest";

function mockCookieValue(value: string | undefined) {
  vi.doMock("next/headers", () => ({
    cookies: async () => ({ get: (name: string) => (name === "lang" && value !== undefined ? { name, value } : undefined) })
  }));
}

describe("getLocale", () => {
  it("returns 'en' when the lang cookie is exactly 'en'", async () => {
    vi.resetModules();
    mockCookieValue("en");
    const { getLocale } = await import("./locale");
    expect(await getLocale()).toBe("en");
  });

  it("defaults to 'zh' when the cookie is missing", async () => {
    vi.resetModules();
    mockCookieValue(undefined);
    const { getLocale } = await import("./locale");
    expect(await getLocale()).toBe("zh");
  });

  it("treats any invalid/forged value as 'zh', never passing it through", async () => {
    vi.resetModules();
    mockCookieValue("fr");
    const { getLocale } = await import("./locale");
    expect(await getLocale()).toBe("zh");

    vi.resetModules();
    mockCookieValue("<script>alert(1)</script>");
    const { getLocale: getLocale2 } = await import("./locale");
    expect(await getLocale2()).toBe("zh");

    vi.resetModules();
    mockCookieValue("");
    const { getLocale: getLocale3 } = await import("./locale");
    expect(await getLocale3()).toBe("zh");
  });
});
