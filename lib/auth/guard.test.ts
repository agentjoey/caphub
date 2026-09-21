import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { guardRequest } from "./guard";
import { MINI_COOKIE, issueMiniSession } from "../telegram/mini-session";

const ENV = { NODE_ENV: "production", CF_ACCESS_AUD: "aud1", CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" };

function request(init: { headers?: Record<string, string>; cookie?: string; path?: string; method?: string } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`http://localhost${init.path ?? "/api/captures"}`, { headers, method: init.method });
}

const mcp = (headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/mcp", { method: "POST", headers });
const MCP_ENV = { ...ENV, CF_ACCESS_SERVICE_TOKEN_CN: "caphub-agent" };

const BOT_TOKEN = "123456:test-token";
const OWNER_ID = "99";
const MINI_ENV = { ...ENV, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID: OWNER_ID };
const validMiniCookie = () => issueMiniSession(OWNER_ID, { botToken: BOT_TOKEN });

describe("guardRequest", () => {
  it("401s on /api/mcp when no service-token common name is configured", async () => {
    const verify = vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" });
    const res = await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), ENV, { verify });
    expect(res.status).toBe(401);
  });

  it("401s on /api/mcp when the common name does not match the allowlist", async () => {
    const verify = vi.fn().mockResolvedValue({ email: "", commonName: "someone-elses-token" });
    const res = await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), MCP_ENV, { verify });
    expect(res.status).toBe(401);
  });

  it("lets the configured service token through on /api/mcp", async () => {
    const verify = vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" });
    const res = await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), MCP_ENV, { verify });
    expect(res.status).not.toBe(401);
  });

  it("401s on /api/mcp for a human email JWT", async () => {
    const verify = vi.fn().mockResolvedValue({ email: "theagentjoey@gmail.com", commonName: "" });
    const res = await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), MCP_ENV, { verify });
    expect(res.status).toBe(401);
  });

  it("401s on a normal page for a service-token JWT", async () => {
    const verify = vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" });
    const res = await guardRequest(new NextRequest("http://localhost/library"), MCP_ENV, { verify });
    expect(res.status).toBe(401);
  });

  it("returns 401 when no token is present", async () => {
    const verify = vi.fn();
    const res = await guardRequest(request(), ENV, { verify });
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it("prefers the header token over the cookie when both are present", async () => {
    const verify = vi.fn().mockResolvedValue({ email: "a@b.c" });
    const res = await guardRequest(
      request({ headers: { "cf-access-jwt-assertion": "header-token" }, cookie: "CF_Authorization=cookie-token" }),
      ENV,
      { verify }
    );
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledWith("header-token", expect.objectContaining({ aud: "aud1", teamDomain: "team.cloudflareaccess.com" }));
  });

  it("falls back to the CF_Authorization cookie when there is no header", async () => {
    const verify = vi.fn().mockResolvedValue({ email: "a@b.c" });
    const res = await guardRequest(request({ cookie: "CF_Authorization=cookie-token" }), ENV, { verify });
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledWith("cookie-token", expect.anything());
  });

  it("returns 401 when verification fails", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("bad token"));
    const res = await guardRequest(request({ headers: { "cf-access-jwt-assertion": "bad" } }), ENV, { verify });
    expect(res.status).toBe(401);
  });

  it("bypasses verification only when NODE_ENV=development AND ACCESS_BYPASS=1", async () => {
    const verify = vi.fn();
    const res = await guardRequest(request(), { ...ENV, NODE_ENV: "development", ACCESS_BYPASS: "1" }, { verify });
    expect(res.status).toBe(200);
    expect(verify).not.toHaveBeenCalled();
  });

  it("still requires a token in production even when ACCESS_BYPASS=1", async () => {
    const verify = vi.fn();
    const res = await guardRequest(request(), { ...ENV, NODE_ENV: "production", ACCESS_BYPASS: "1" }, { verify });
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not bypass when ACCESS_BYPASS is unset in development", async () => {
    const verify = vi.fn();
    const res = await guardRequest(request(), { ...ENV, NODE_ENV: "development" }, { verify });
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it("returns 401 without calling the verifier when CF_ACCESS_AUD is missing", async () => {
    const verify = vi.fn();
    const res = await guardRequest(request({ headers: { "cf-access-jwt-assertion": "t" } }), { ...ENV, CF_ACCESS_AUD: "" }, { verify });
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it("returns 401 without calling the verifier when CF_ACCESS_AUD is whitespace", async () => {
    const verify = vi.fn();
    const res = await guardRequest(request({ headers: { "cf-access-jwt-assertion": "t" } }), { ...ENV, CF_ACCESS_AUD: "   " }, { verify });
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it("returns 401 without calling the verifier when CF_ACCESS_TEAM_DOMAIN is missing", async () => {
    const verify = vi.fn();
    const res = await guardRequest(request({ headers: { "cf-access-jwt-assertion": "t" } }), { ...ENV, CF_ACCESS_TEAM_DOMAIN: undefined }, { verify });
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  describe("refusal logging on /api/mcp", () => {
    it("logs no_token when no token is present", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const verify = vi.fn();
      await guardRequest(mcp(), MCP_ENV, { verify });
      expect(log.mock.calls.map((c) => c[0]).join("\n")).toContain('"reason":"no_token"');
      log.mockRestore();
    });

    it("logs verify_failed when verification throws", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const verify = vi.fn().mockRejectedValue(new Error("bad token"));
      await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), MCP_ENV, { verify });
      expect(log.mock.calls.map((c) => c[0]).join("\n")).toContain('"reason":"verify_failed"');
      log.mockRestore();
    });

    it("logs allowlist_unset when the allowlist env var is unset", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const verify = vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" });
      await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), ENV, { verify });
      expect(log.mock.calls.map((c) => c[0]).join("\n")).toContain('"reason":"allowlist_unset"');
      log.mockRestore();
    });

    it("logs cn_mismatch when the common name does not match the allowlist", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const verify = vi.fn().mockResolvedValue({ email: "", commonName: "someone-elses-token" });
      await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), MCP_ENV, { verify });
      expect(log.mock.calls.map((c) => c[0]).join("\n")).toContain('"reason":"cn_mismatch"');
      log.mockRestore();
    });

    it("never logs the token or the common name, even on refusal", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const secretToken = "super-secret-jwt-value-should-never-appear";
      const secretCn = "someone-elses-super-secret-common-name";
      const verify = vi.fn().mockResolvedValue({ email: "", commonName: secretCn });
      await guardRequest(mcp({ "cf-access-jwt-assertion": secretToken }), MCP_ENV, { verify });
      const allLogged = log.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allLogged).not.toContain(secretToken);
      expect(allLogged).not.toContain(secretCn);
      expect(allLogged).not.toContain(MCP_ENV.CF_ACCESS_SERVICE_TOKEN_CN);
      log.mockRestore();
    });
  });

  describe("/mini", () => {
    const verify = () => vi.fn().mockResolvedValue({ email: "theagentjoey@gmail.com", commonName: "" });

    it("401s a /mini page request with no mini session cookie", async () => {
      const res = await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/mini" }),
        MINI_ENV,
        { verify: verify() }
      );
      expect(res.status).toBe(401);
    });

    it("401s a /mini/library/x POST with no mini session cookie (simulated server action)", async () => {
      const res = await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/mini/library/x", method: "POST" }),
        MINI_ENV,
        { verify: verify() }
      );
      expect(res.status).toBe(401);
    });

    it("lets /api/mini/session through with no mini session cookie", async () => {
      const res = await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/api/mini/session", method: "POST" }),
        MINI_ENV,
        { verify: verify() }
      );
      expect(res.status).not.toBe(401);
    });

    it("401s /mini whenever the bot token / owner id are not configured", async () => {
      const res = await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/mini", cookie: `${MINI_COOKIE}=${validMiniCookie()}` }),
        ENV,
        { verify: verify() }
      );
      expect(res.status).toBe(401);
    });

    it("lets /mini through with a valid mini session cookie", async () => {
      const res = await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/mini", cookie: `${MINI_COOKIE}=${validMiniCookie()}` }),
        MINI_ENV,
        { verify: verify() }
      );
      expect(res.status).not.toBe(401);
    });

    it("still 401s /api/mcp when the request carries a valid mini session cookie (no identity crossover)", async () => {
      const res = await guardRequest(
        mcp({ "cf-access-jwt-assertion": "t", cookie: `${MINI_COOKIE}=${validMiniCookie()}` }),
        { ...MINI_ENV, ...MCP_ENV },
        { verify: vi.fn().mockResolvedValue({ email: "", commonName: "someone-elses-token" }) }
      );
      expect(res.status).toBe(401);
    });

    it("401s a service-token identity (no email) holding a valid mini cookie on /mini", async () => {
      const verify = vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" });
      const res = await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/mini", cookie: `${MINI_COOKIE}=${validMiniCookie()}` }),
        MINI_ENV,
        { verify }
      );
      expect(res.status).toBe(401);
    });

    it("401s a service-token identity (no email) POSTing /api/mini/session", async () => {
      const verify = vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" });
      const res = await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/api/mini/session", method: "POST" }),
        MINI_ENV,
        { verify }
      );
      expect(res.status).toBe(401);
    });

    it("logs mini-specific reason codes instead of the MCP ones", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/mini", cookie: `${MINI_COOKIE}=${validMiniCookie()}` }),
        MINI_ENV,
        { verify: vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" }) }
      );
      await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/mini" }),
        ENV,
        { verify: vi.fn().mockResolvedValue({ email: "theagentjoey@gmail.com", commonName: "" }) }
      );
      await guardRequest(
        request({ headers: { "cf-access-jwt-assertion": "t" }, path: "/mini" }),
        MINI_ENV,
        { verify: vi.fn().mockResolvedValue({ email: "theagentjoey@gmail.com", commonName: "" }) }
      );

      const logged = log.mock.calls.map((c) => c[0]).join("\n");
      expect(logged).toContain('"reason":"mini_no_email"');
      expect(logged).toContain('"reason":"mini_secrets_unset"');
      expect(logged).toContain('"reason":"mini_session_invalid"');
      log.mockRestore();
    });
  });
});
