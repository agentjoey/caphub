import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MINI_COOKIE, verifyMiniSession } from "../../../../lib/telegram/mini-session";

const BOT_TOKEN = "123456:test-token";
const OWNER_ID = "99";

vi.mock("../../../../lib/runtime", () => ({
  getRuntime: () => ({ config: { telegram: { enabled: true, botToken: BOT_TOKEN, ownerChatId: OWNER_ID } } })
}));

const { POST } = await import("./route");

function signedInitData(): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAE",
    user: JSON.stringify({ id: Number(OWNER_ID), first_name: "J" })
  };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function post(body: unknown): Promise<Response> {
  return POST(new Request("https://caphub.example/api/mini/session", { method: "POST", body: JSON.stringify(body) }));
}

describe("POST /api/mini/session", () => {
  it("issues a verifiable mini session cookie for a valid initData payload", async () => {
    const res = await post({ initData: signedInitData() });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("Set-Cookie") ?? "";
    const value = setCookie.slice(`${MINI_COOKIE}=`.length).split(";")[0];
    expect(verifyMiniSession(value, { botToken: BOT_TOKEN, ownerId: OWNER_ID })).toBe(true);
  });

  it("sends the cookie cross-site-capable but locked down", async () => {
    const setCookie = (await post({ initData: signedInitData() })).headers.get("Set-Cookie") ?? "";
    // SameSite=None is load-bearing: Telegram Desktop/Web render the Mini App in a cross-site
    // iframe, and a Lax cookie is never sent from there. Secure is mandatory alongside it, and
    // HttpOnly keeps the value out of any script in that iframe. See the route for what stops
    // CSRF once the cookie does travel cross-site.
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
  });

  it("marks the response no-store — it mints a credential", async () => {
    const res = await post({ initData: signedInitData() });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sets no cookie and says nothing about why when initData does not verify", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({ initData: "hash=deadbeef&auth_date=1" });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
