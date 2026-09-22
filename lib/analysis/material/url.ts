import { isIP } from "node:net";
import { lookup as defaultDnsLookup } from "node:dns/promises";

export { defaultDnsLookup };
import { stripNul } from "../../text/sanitize";

export const MAX_URL_BODY_BYTES = 102_400;
export const URL_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;

export interface DnsRecord {
  address: string;
  family: number;
}

export type DnsLookup = (hostname: string, options: { all: true }) => Promise<DnsRecord[]>;

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Collapses spaces/tabs inside each line, trims each line, and keeps at most one blank line in a row. */
function tidyLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const BLOCK_TAGS = "p|div|br|li|ul|ol|h[1-6]|pre|blockquote|tr|section|article|header|footer|hr";

/**
 * Like stripHtml, but keeps block-level and <br> boundaries as line breaks, so a prompt's own
 * line structure survives and prompt locators (prompt-locate.ts) slice it back out intact.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return tidyLines(text).replace(/\n{2,}/g, "\n");
}

function isIPv4(address: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function ipv4InRange(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

// Loopback, RFC 1918 private ranges, link-local, CGNAT (RFC 6598) and "this network".
function isNonPublicIPv4(address: string): boolean {
  return (
    ipv4InRange(address, "127.0.0.0", 8) ||
    ipv4InRange(address, "10.0.0.0", 8) ||
    ipv4InRange(address, "172.16.0.0", 12) ||
    ipv4InRange(address, "192.168.0.0", 16) ||
    ipv4InRange(address, "169.254.0.0", 16) ||
    ipv4InRange(address, "100.64.0.0", 10) ||
    ipv4InRange(address, "0.0.0.0", 8)
  );
}

// Expands a normalized IPv6 literal into eight 16-bit groups, handling
// "::" compression and a trailing embedded IPv4 dotted quad.
function expandIPv6(address: string): number[] | null {
  let addr = address;
  const ipv4Tail = addr.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4Tail) {
    const quad = ipv4Tail[1].split(".").map(Number);
    const hi = ((quad[0] << 8) | quad[1]).toString(16);
    const lo = ((quad[2] << 8) | quad[3]).toString(16);
    addr = `${addr.slice(0, addr.length - ipv4Tail[1].length)}${hi}:${lo}`;
  }
  const parts = addr.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":").filter(Boolean) : [];
  if (parts.length === 1) {
    if (head.length !== 8) return null;
    return head.map((g) => parseInt(g, 16));
  }
  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

// Loopback (::1), unique local (fc00::/7) and link-local (fe80::/10); also
// unwraps IPv4-mapped addresses (::ffff:a.b.c.d) and checks the embedded v4.
function isNonPublicIPv6(address: string): boolean {
  const groups = expandIPv6(address.toLowerCase());
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const mapped = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isNonPublicIPv4(mapped);
  }
  return false;
}

function isNonPublicIpLiteral(address: string, family: number): boolean {
  return family === 4 || isIPv4(address) ? isNonPublicIPv4(address) : isNonPublicIPv6(address);
}

function isDisallowedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  return [".localhost", ".internal", ".local"].some((suffix) => host.endsWith(suffix));
}

/**
 * Host/credential/IP-range safety check shared by every caller that fetches an
 * externally-supplied URL, independent of scheme. Rejects embedded credentials,
 * localhost-ish hostnames, and hosts that are (or resolve to) a loopback,
 * private, link-local or CGNAT address -- guarding against SSRF and DNS rebinding.
 */
export async function isSafeHost(url: URL, dnsLookup: DnsLookup): Promise<boolean> {
  if (url.username || url.password) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isDisallowedHostname(hostname)) return false;
  const literalFamily = isIP(hostname);
  if (literalFamily) return !isNonPublicIpLiteral(hostname, literalFamily);
  try {
    const records = await dnsLookup(hostname, { all: true });
    if (records.length === 0) return false;
    return records.every((record) => !isNonPublicIpLiteral(record.address, record.family));
  } catch {
    return false;
  }
}

async function isSafeUrl(url: URL, dnsLookup: DnsLookup): Promise<boolean> {
  if (url.protocol !== "https:") return false;
  return isSafeHost(url, dnsLookup);
}

export async function fetchUrlText(
  url: string,
  fetchFn: typeof fetch = globalThis.fetch,
  dnsLookup: DnsLookup = defaultDnsLookup
): Promise<string | null> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (!(await isSafeUrl(current, dnsLookup))) return null;
      const response = await fetchFn(current.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
          "user-agent": "caphub/2 (+https://caphub.agentjoey.ai)"
        }
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (redirectCount >= MAX_REDIRECTS) return null;
        try {
          current = new URL(location, current);
        } catch {
          return null;
        }
        continue;
      }
      if (!response.ok) return null;
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < MAX_URL_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.byteLength;
      }
      await reader.cancel().catch(() => {});
      const raw = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_URL_BODY_BYTES));
      const type = response.headers.get("content-type") ?? "";
      return stripNul(type.includes("html") ? htmlToText(raw) : tidyLines(raw));
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
