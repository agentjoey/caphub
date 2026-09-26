import { withTimeout } from "./structured";
import { stripHtml, resolveSafeHostAddresses, defaultDnsLookup, type DnsLookup } from "./material/url";
import { fetchPinnedHttp, type PinnedHttpTransport } from "./material/safe-http";

/** Hard timeout for the whole fetchCanonical call (metadata + readme + page, whichever path runs). */
export const CANONICAL_TIMEOUT_MS = 10_000;
/** Response bodies are read up to this many bytes; anything beyond is dropped, never causes a failure. */
export const MAX_CANONICAL_BODY_BYTES = 512 * 1024;
/** Redirect hops a single fetch may follow before it is treated as unreachable. */
const MAX_REDIRECTS = 2;

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "caphub/2 (+https://caphub.agentjoey.ai)";

export interface CanonicalFacts {
  repo_url?: string;
  stars?: number;
  last_update?: string;
  license?: string;
  homepage?: string;
}

export type CanonicalResult =
  | { kind: "page"; url: string; title: string; text: string }
  | { kind: "repo"; url: string; title: string; text: string; facts: CanonicalFacts }
  | null;

export interface FetchCanonicalOptions {
  fetch: typeof fetch;
  signal?: AbortSignal;
  /** Overridable for tests; defaults to real DNS resolution. */
  dnsLookup?: DnsLookup;
  /** Overrides the production pinned transport in deterministic tests. */
  transport?: PinnedHttpTransport;
}

interface GithubRepoMeta {
  html_url?: string;
  full_name?: string;
  description?: string | null;
  homepage?: string | null;
  stargazers_count?: number;
  pushed_at?: string;
  license?: { spdx_id?: string | null } | null;
}

function parseGithubRepo(url: URL): { owner: string; repo: string } | null {
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const [owner, repoRaw] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/, "");
  if (!repo) return null;
  return { owner, repo };
}

/** http(s)-only, and never a loopback/private/link-local/CGNAT host -- guards every fetch this module makes, including the fixed GitHub API hosts (DNS rebinding still applies to them). */
async function isAllowedTarget(url: URL, dnsLookup: DnsLookup, signal: AbortSignal) {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return resolveSafeHostAddresses(url, dnsLookup, signal);
}

/**
 * Fetches `url`, re-checking target safety on every redirect hop instead of
 * letting the runtime follow redirects blindly. Returns `null` -- never
 * throws -- for an unsafe target, a network error, or a redirect chain that
 * is too long or points somewhere unsafe.
 */
async function safeFetch(
  url: URL,
  fetchFn: typeof fetch | undefined,
  signal: AbortSignal,
  dnsLookup: DnsLookup,
  headers: Record<string, string>,
  transport: PinnedHttpTransport
): Promise<Response | null> {
  let current = url;
  for (let redirectCount = 0; ; redirectCount += 1) {
    const addresses = await isAllowedTarget(current, dnsLookup, signal);
    if (!addresses) return null;
    let response: Response;
    try {
      const init = { signal, redirect: "manual" as const, headers };
      response = fetchFn
        ? await fetchFn(current.toString(), init)
        : await transport(current, addresses, init);
    } catch {
      return null;
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      if (redirectCount >= MAX_REDIRECTS) return null;
      try {
        current = new URL(location, current);
      } catch {
        return null;
      }
      continue;
    }
    return response;
  }
}

/** Reads a response body up to `maxBytes`, decoding what was read even when the stream is larger or unreadable. Byte-accurate: truncation happens on the raw bytes, not on decoded characters. */
async function readLimitedBody(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch {
      return null;
    }
    return new TextDecoder().decode(new Uint8Array(buffer).subarray(0, maxBytes));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

async function cancelResponseBody(response: Response | null | undefined): Promise<void> {
  await response?.body?.cancel().catch(() => {});
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim();
}

async function fetchPage(
  url: URL,
  fetchFn: typeof fetch | undefined,
  signal: AbortSignal,
  dnsLookup: DnsLookup,
  transport: PinnedHttpTransport
): Promise<{ title: string; text: string } | null> {
  const response = await safeFetch(url, fetchFn, signal, dnsLookup, {
    accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
    "user-agent": USER_AGENT
  }, transport);
  if (!response) return null;
  if (!response.ok) {
    await cancelResponseBody(response);
    return null;
  }
  const raw = await readLimitedBody(response, MAX_CANONICAL_BODY_BYTES);
  if (raw === null) return null;
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("html") || /<html[\s>]/i.test(raw.slice(0, 1000));
  const title = isHtml ? extractTitle(raw) : "";
  const text = isHtml ? stripHtml(raw) : raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { title, text };
}

async function fetchGithubRepo(
  owner: string,
  repo: string,
  fetchFn: typeof fetch | undefined,
  signal: AbortSignal,
  dnsLookup: DnsLookup,
  transport: PinnedHttpTransport
): Promise<CanonicalResult> {
  const metaResponse = await safeFetch(new URL(`${GITHUB_API_BASE}/repos/${owner}/${repo}`), fetchFn, signal, dnsLookup, {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT
  }, transport);
  if (!metaResponse) return null;
  if (!metaResponse.ok) {
    await cancelResponseBody(metaResponse);
    return null;
  }

  const metaBody = await readLimitedBody(metaResponse, MAX_CANONICAL_BODY_BYTES);
  let meta: GithubRepoMeta | null = null;
  try {
    meta = metaBody ? JSON.parse(metaBody) as GithubRepoMeta : null;
  } catch {
    meta = null;
  }
  if (!meta) return null;

  const facts: CanonicalFacts = {};
  if (typeof meta.html_url === "string" && meta.html_url) facts.repo_url = meta.html_url;
  if (typeof meta.stargazers_count === "number") facts.stars = meta.stargazers_count;
  if (typeof meta.pushed_at === "string" && meta.pushed_at) facts.last_update = meta.pushed_at;
  if (meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION") facts.license = meta.license.spdx_id;
  if (typeof meta.homepage === "string" && meta.homepage.trim()) facts.homepage = meta.homepage;

  let text = "";
  const readmeResponse = await safeFetch(new URL(`${GITHUB_API_BASE}/repos/${owner}/${repo}/readme`), fetchFn, signal, dnsLookup, {
    accept: "application/vnd.github.raw",
    "user-agent": USER_AGENT
  }, transport);
  if (readmeResponse?.ok) {
    const raw = await readLimitedBody(readmeResponse, MAX_CANONICAL_BODY_BYTES);
    text = raw?.trim() ?? "";
  } else {
    await cancelResponseBody(readmeResponse);
  }
  if (!text && typeof meta.description === "string") text = meta.description.trim();

  const title = meta.full_name || `${owner}/${repo}`;
  const url = facts.repo_url ?? `https://github.com/${owner}/${repo}`;
  return { kind: "repo", url, title, text, facts };
}

/**
 * Fetches the authoritative source page for a capability's canonical URL.
 * Detects GitHub repos and returns README text plus repo facts (stars, license,
 * last update, homepage) sourced from the GitHub API; otherwise fetches and
 * extracts the plain page text. Every target -- the caller's URL, the GitHub
 * API host, and every redirect hop -- is checked against the same
 * loopback/private/link-local safety guard `lib/analysis/material/url.ts`
 * uses, since `url` ultimately comes from externally submitted content.
 * Never throws -- every failure path (bad protocol, unsafe host, timeout,
 * oversized/empty/non-2xx response, API rate limiting) resolves to `null` so
 * the caller can fall back to search.
 */
export async function fetchCanonical(url: string, options: FetchCanonicalOptions): Promise<CanonicalResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
  const dnsLookup = options.dnsLookup ?? defaultDnsLookup;
  // The production caller passes the global fetch explicitly. Treat that exact function as the
  // default transport so it cannot re-resolve a hostname after our safety check. Distinct fetch
  // functions remain an intentional test seam.
  const fetchFn = options.fetch === globalThis.fetch ? undefined : options.fetch;
  const transport = options.transport ?? fetchPinnedHttp;
  const baseSignal = options.signal ?? new AbortController().signal;
  const t = withTimeout(baseSignal, CANONICAL_TIMEOUT_MS);
  try {
    const repoMatch = parseGithubRepo(parsed);
    if (repoMatch) {
      // fetchGithubRepo is expected to resolve to null on any failure, but a mid-stream body-read
      // rejection (e.g. the README fetch's reader.read()) can still reject rather than resolve --
      // wrapped here so that reaches the same degrade-to-plain-page path as every other failure
      // mode, instead of escaping to this function's own outer catch and skipping it entirely.
      let repoResult: CanonicalResult = null;
      try {
        repoResult = await fetchGithubRepo(repoMatch.owner, repoMatch.repo, fetchFn, t.signal, dnsLookup, transport);
      } catch {
        repoResult = null;
      }
      if (repoResult) return repoResult;
      // Metadata fetch failed, was rate-limited, a mid-stream read failed, or the repo doesn't
      // exist -- degrade to a plain page fetch.
    }
    const page = await fetchPage(parsed, fetchFn, t.signal, dnsLookup, transport);
    return page ? { kind: "page", url: parsed.toString(), title: page.title, text: page.text } : null;
  } catch {
    return null;
  } finally {
    t.clear();
  }
}
