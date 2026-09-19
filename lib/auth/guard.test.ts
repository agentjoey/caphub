import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { guardRequest } from "./guard";

const ENV = { NODE_ENV: "production", CF_ACCESS_AUD: "aud1", CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" };

function request(init: { headers?: Record<string, string>; cookie?: string } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest("http://localhost/api/captures", { headers });
}

describe("guardRequest", () => {
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
});
