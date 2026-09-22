import { z } from "zod";

export interface YouTubeMeta { title: string; channel: string; publishedAt: string; durationSec: number | null; description: string }

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com", "youtube-nocookie.com"]);

/** The 11-char video id of an https YouTube link (watch / youtu.be / shorts / live / embed), or null. */
export function parseYouTubeUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const candidate = url.hostname === "youtu.be" ? segments[0]
    : segments[0] === "watch" ? url.searchParams.get("v")
    : ["shorts", "live", "embed"].includes(segments[0] ?? "") ? segments[1]
    : null;
  return candidate && ID.test(candidate) ? candidate : null;
}

/** Seconds in an ISO 8601 duration such as "PT1H2M3S" / "P1DT1S"; null when unparseable. */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m || iso === "P" || iso === "PT") return null;
  const [d, h, min, s] = m.slice(1).map((v) => Number(v ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

const responseSchema = z.object({
  items: z.array(z.object({
    snippet: z.object({ title: z.string(), channelTitle: z.string(), publishedAt: z.string(), description: z.string().default("") }),
    contentDetails: z.object({ duration: z.string() }).partial().default({})
  }))
});

const TIMEOUT_MS = 10_000;

/**
 * Public metadata for one video via YouTube Data API v3 (`videos.list`). Every failure -- no key,
 * network, HTTP error, unexpected shape, no such video -- resolves to null: metadata only enriches
 * the analysis, it must never fail it. The key only ever travels in the query string.
 */
export async function fetchYouTubeMeta(videoId: string, apiKey: string | undefined, fetchFn: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<YouTubeMeta | null> {
  if (!apiKey) return null;
  const params = new URLSearchParams({ part: "snippet,contentDetails", id: videoId, key: apiKey });
  try {
    const response = await fetchFn(`https://www.googleapis.com/youtube/v3/videos?${params}`, { signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const parsed = responseSchema.safeParse(await response.json());
    const item = parsed.success ? parsed.data.items[0] : undefined;
    if (!item) return null;
    return {
      title: item.snippet.title, channel: item.snippet.channelTitle, publishedAt: item.snippet.publishedAt,
      durationSec: item.contentDetails.duration ? parseIsoDuration(item.contentDetails.duration) : null,
      description: item.snippet.description
    };
  } catch {
    return null;
  }
}
