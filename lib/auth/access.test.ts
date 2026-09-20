import { describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { verifyAccessJwt } from "./access";

let counter = 0;

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const sign = (claims: Record<string, unknown>, kid = "k1") =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid }).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  // Each test gets its own team domain so the module-level JWKS cache never leaks keys between tests.
  const teamDomain = `team-${++counter}.cloudflareaccess.com`;
  return { fetchFn, sign, privateKey, teamDomain };
}

describe("verifyAccessJwt", () => {
  it("accepts a token with matching aud and iss", async () => {
    const { fetchFn, sign, teamDomain } = await setup();
    const token = await sign({ aud: "aud1", iss: `https://${teamDomain}`, email: "a@b.c" });
    await expect(
      verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn })
    ).resolves.toEqual({ email: "a@b.c", commonName: "" });
  });

  it("returns the common_name identity for a service-token JWT with no email", async () => {
    const { fetchFn, sign, teamDomain } = await setup();
    const token = await sign({ aud: "aud1", iss: `https://${teamDomain}`, common_name: "caphub-agent" });
    await expect(verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn }))
      .resolves.toEqual({ email: "", commonName: "caphub-agent" });
  });

  it("still rejects a JWT carrying neither email nor common_name", async () => {
    const { fetchFn, sign, teamDomain } = await setup();
    const token = await sign({ aud: "aud1", iss: `https://${teamDomain}` });
    await expect(verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn }))
      .rejects.toThrow(/ACCESS_IDENTITY_MISSING/);
  });

  it("rejects wrong aud", async () => {
    const { fetchFn, sign, teamDomain } = await setup();
    const token = await sign({ aud: "other", iss: `https://${teamDomain}`, email: "a@b.c" });
    await expect(
      verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn })
    ).rejects.toThrow();
  });

  it("rejects wrong issuer", async () => {
    const { fetchFn, sign, teamDomain } = await setup();
    const token = await sign({ aud: "aud1", iss: "https://other-team.cloudflareaccess.com" });
    await expect(
      verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn })
    ).rejects.toThrow();
  });

  it("rejects a token with no email claim", async () => {
    const { fetchFn, sign, teamDomain } = await setup();
    const token = await sign({ aud: "aud1", iss: `https://${teamDomain}` });
    await expect(
      verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn })
    ).rejects.toThrow("ACCESS_IDENTITY_MISSING");
  });

  it("rejects an expired token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const teamDomain = `team-${++counter}.cloudflareaccess.com`;
    const token = await new SignJWT({ aud: "aud1", iss: `https://${teamDomain}`, email: "a@b.c" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    await expect(verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn })).rejects.toThrow();
  });

  it("rejects a token signed with the wrong key (bad signature, known kid)", async () => {
    const { publicKey } = await generateKeyPair("RS256");
    const { privateKey: impostorPrivate } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const teamDomain = `team-${++counter}.cloudflareaccess.com`;
    // Signed with a key whose public half was never published under this kid.
    const token = await new SignJWT({ aud: "aud1", iss: `https://${teamDomain}`, email: "a@b.c" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuedAt().setExpirationTime("1h").sign(impostorPrivate);
    await expect(verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn })).rejects.toThrow();
  });

  it("throws when aud is empty", async () => {
    const { fetchFn, sign, teamDomain } = await setup();
    const token = await sign({ aud: "aud1", iss: `https://${teamDomain}`, email: "a@b.c" });
    await expect(verifyAccessJwt(token, { aud: "", teamDomain, fetch: fetchFn })).rejects.toThrow("ACCESS_AUD_REQUIRED");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when teamDomain is not a valid hostname", async () => {
    const { fetchFn, sign } = await setup();
    const token = await sign({ aud: "aud1", iss: "https://not-a-hostname", email: "a@b.c" });
    await expect(verifyAccessJwt(token, { aud: "aud1", teamDomain: "not-a-hostname", fetch: fetchFn })).rejects.toThrow("ACCESS_TEAM_DOMAIN_INVALID");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refetches the JWKS once when the kid is unknown (key rotation)", async () => {
    const { privateKey: oldPrivate, publicKey: oldPublic } = await generateKeyPair("RS256");
    const { privateKey: newPrivate, publicKey: newPublic } = await generateKeyPair("RS256");
    const oldJwk = { ...(await exportJWK(oldPublic)), kid: "old", alg: "RS256", use: "sig" };
    const newJwk = { ...(await exportJWK(newPublic)), kid: "new", alg: "RS256", use: "sig" };

    const teamDomain = `rotation-${Math.random()}.cloudflareaccess.com`;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ keys: [oldJwk] }), { status: 200, headers: { "content-type": "application/json" } }));
    // Prime the cache with the stale JWKS (only "old" kid known).
    await expect(
      verifyAccessJwt(
        await new SignJWT({ aud: "aud1", iss: `https://${teamDomain}`, email: "a@b.c" })
          .setProtectedHeader({ alg: "RS256", kid: "old" }).setIssuedAt().setExpirationTime("1h").sign(oldPrivate),
        { aud: "aud1", teamDomain, fetch: fetchFn as unknown as typeof fetch }
      )
    ).resolves.toEqual({ email: "a@b.c", commonName: "" });

    // Now the server has rotated to a new key not yet in our cache.
    fetchFn.mockImplementation(async () => new Response(JSON.stringify({ keys: [newJwk] }), { status: 200, headers: { "content-type": "application/json" } }));
    const token = await new SignJWT({ aud: "aud1", iss: `https://${teamDomain}`, email: "rotated@b.c" })
      .setProtectedHeader({ alg: "RS256", kid: "new" }).setIssuedAt().setExpirationTime("1h").sign(newPrivate);

    await expect(
      verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn as unknown as typeof fetch })
    ).resolves.toEqual({ email: "rotated@b.c", commonName: "" });
  });
});
