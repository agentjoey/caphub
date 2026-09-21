import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyInitData } from "./init-data";

const BOT = "123456:test-token";
const OWNER = "99";

function sign(fields: Record<string, string>, botToken = BOT): string {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const fresh = (over: Record<string, string> = {}) => ({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: "AAE",
  user: JSON.stringify({ id: 99, first_name: "J" }),
  ...over
});

describe("verifyInitData", () => {
  it("accepts a correctly signed, fresh payload from the owner", () => {
    expect(verifyInitData(sign(fresh()), { botToken: BOT, ownerId: OWNER }))
      .toEqual({ ok: true, userId: "99" });
  });

  it("rejects a tampered field even though the hash is well-formed", () => {
    const signed = sign(fresh());
    const tampered = signed.replace("first_name%22%3A%22J", "first_name%22%3A%22X");
    expect(verifyInitData(tampered, { botToken: BOT, ownerId: OWNER }))
      .toEqual({ ok: false, reason: "bad_hash" });
  });

  it("rejects a payload signed with a different bot token", () => {
    expect(verifyInitData(sign(fresh(), "999:other"), { botToken: BOT, ownerId: OWNER }))
      .toMatchObject({ ok: false, reason: "bad_hash" });
  });

  it("rejects an auth_date older than 300 seconds", () => {
    const old = String(Math.floor(Date.now() / 1000) - 301);
    expect(verifyInitData(sign(fresh({ auth_date: old })), { botToken: BOT, ownerId: OWNER }))
      .toMatchObject({ ok: false, reason: "stale" });
  });

  it("rejects an auth_date in the future beyond the same window", () => {
    const future = String(Math.floor(Date.now() / 1000) + 301);
    expect(verifyInitData(sign(fresh({ auth_date: future })), { botToken: BOT, ownerId: OWNER }))
      .toMatchObject({ ok: false, reason: "stale" });
  });

  it("rejects a valid signature from somebody who is not the owner", () => {
    const other = sign(fresh({ user: JSON.stringify({ id: 1234, first_name: "Z" }) }));
    expect(verifyInitData(other, { botToken: BOT, ownerId: OWNER }))
      .toMatchObject({ ok: false, reason: "not_owner" });
  });

  it("rejects empty, hash-less and unparseable input", () => {
    for (const bad of ["", "hash=abc", "user=notjson&auth_date=1&hash=abc"]) {
      expect(verifyInitData(bad, { botToken: BOT, ownerId: OWNER }).ok).toBe(false);
    }
  });
});
