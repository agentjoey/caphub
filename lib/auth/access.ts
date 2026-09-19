import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";

const JWKS_TTL_MS = 10 * 60 * 1000;

interface CacheEntry { keys: JSONWebKeySet; fetchedAt: number }

const jwksCache = new Map<string, CacheEntry>();

async function fetchJwks(teamDomain: string, fetchFn: typeof fetch): Promise<JSONWebKeySet> {
  const response = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`ACCESS_JWKS_FETCH_FAILED: ${response.status}`);
  return (await response.json()) as JSONWebKeySet;
}

async function getJwks(teamDomain: string, fetchFn: typeof fetch, forceRefresh: boolean): Promise<JSONWebKeySet> {
  const cached = jwksCache.get(teamDomain);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  const keys = await fetchJwks(teamDomain, fetchFn);
  jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

export async function verifyAccessJwt(
  token: string,
  opts: { aud: string; teamDomain: string; fetch?: typeof fetch; now?: () => Date }
): Promise<{ email: string }> {
  const fetchFn = opts.fetch ?? fetch;
  const issuer = `https://${opts.teamDomain}`;
  const verifyWith = async (keys: JSONWebKeySet) => {
    const jwks = createLocalJWKSet(keys);
    return jwtVerify(token, jwks, { audience: opts.aud, issuer, currentDate: opts.now?.() });
  };

  let keys = await getJwks(opts.teamDomain, fetchFn, false);
  let payload;
  try {
    ({ payload } = await verifyWith(keys));
  } catch (error) {
    if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
    keys = await getJwks(opts.teamDomain, fetchFn, true);
    ({ payload } = await verifyWith(keys));
  }

  const email = typeof payload.email === "string" ? payload.email : "";
  if (!email) throw new Error("ACCESS_EMAIL_MISSING");
  return { email };
}
