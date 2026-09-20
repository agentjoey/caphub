import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";

const JWKS_TTL_MS = 10 * 60 * 1000;
const FORCE_REFETCH_COOLDOWN_MS = 30 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5000;
const HOSTNAME_RE = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/;

interface CacheEntry { keys: JSONWebKeySet; fetchedAt: number }

const jwksCache = new Map<string, CacheEntry>();
const lastForcedRefetch = new Map<string, number>();

async function fetchJwks(teamDomain: string, fetchFn: typeof fetch): Promise<JSONWebKeySet> {
  const response = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`ACCESS_JWKS_FETCH_FAILED: ${response.status}`);
  return (await response.json()) as JSONWebKeySet;
}

async function getJwks(teamDomain: string, fetchFn: typeof fetch, forceRefresh: boolean): Promise<JSONWebKeySet> {
  const cached = jwksCache.get(teamDomain);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  if (forceRefresh) {
    const lastForced = lastForcedRefetch.get(teamDomain) ?? 0;
    if (Date.now() - lastForced < FORCE_REFETCH_COOLDOWN_MS) {
      // Within the cooldown window: avoid hammering the IdP on repeated
      // unknown-kid attempts (forged or replayed tokens). Fall back to
      // whatever we already have, if anything.
      if (cached) return cached.keys;
    } else {
      lastForcedRefetch.set(teamDomain, Date.now());
    }
  }
  const keys = await fetchJwks(teamDomain, fetchFn);
  jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

export async function verifyAccessJwt(
  token: string,
  opts: { aud: string; teamDomain: string; fetch?: typeof fetch; now?: () => Date }
): Promise<{ email: string; commonName: string }> {
  if (!opts.aud || !opts.aud.trim()) throw new Error("ACCESS_AUD_REQUIRED");
  if (!opts.teamDomain || !HOSTNAME_RE.test(opts.teamDomain.trim())) throw new Error("ACCESS_TEAM_DOMAIN_INVALID");

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
  const commonName = typeof payload.common_name === "string" ? payload.common_name : "";
  if (!email && !commonName) throw new Error("ACCESS_IDENTITY_MISSING");
  return { email, commonName };
}
