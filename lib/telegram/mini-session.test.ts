import { describe, expect, it } from "vitest";
import { issueMiniSession, verifyMiniSession } from "./mini-session";

const BOT = "123456:test-token";

describe("mini session cookie", () => {
  it("round-trips a freshly issued session", () => {
    const v = issueMiniSession("99", { botToken: BOT });
    expect(verifyMiniSession(v, { botToken: BOT, ownerId: "99" })).toBe(true);
  });

  it("rejects a session that expired", () => {
    const issued = issueMiniSession("99", { botToken: BOT, now: new Date("2026-09-21T00:00:00Z") });
    const later = new Date("2026-09-21T12:00:01Z"); // 12h TTL + 1s
    expect(verifyMiniSession(issued, { botToken: BOT, ownerId: "99", now: later })).toBe(false);
  });

  it("rejects a tampered payload, a tampered signature, and a different bot token", () => {
    const v = issueMiniSession("99", { botToken: BOT });
    const [payload, sig] = v.split(".");
    const otherPayload = Buffer.from(JSON.stringify({ u: "1234", e: Date.now() + 1000 })).toString("base64url");
    expect(verifyMiniSession(`${otherPayload}.${sig}`, { botToken: BOT, ownerId: "99" })).toBe(false);
    expect(verifyMiniSession(`${payload}.${"0".repeat(sig.length)}`, { botToken: BOT, ownerId: "99" })).toBe(false);
    expect(verifyMiniSession(v, { botToken: "999:other", ownerId: "99" })).toBe(false);
  });

  it("rejects a session belonging to another user, and undefined", () => {
    expect(verifyMiniSession(issueMiniSession("1234", { botToken: BOT }), { botToken: BOT, ownerId: "99" })).toBe(false);
    expect(verifyMiniSession(undefined, { botToken: BOT, ownerId: "99" })).toBe(false);
  });
});
