import { describe, expect, it, vi } from "vitest";
import { fetchYouTubeMeta, parseIsoDuration, parseYouTubeUrl } from "./youtube";

describe("parseYouTubeUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=tYvu6IpSfiM", "tYvu6IpSfiM"],
    ["https://youtube.com/watch?v=tYvu6IpSfiM&t=42s", "tYvu6IpSfiM"],
    ["https://m.youtube.com/watch?v=tYvu6IpSfiM", "tYvu6IpSfiM"],
    ["https://youtu.be/tYvu6IpSfiM?si=FB-YBM4O1x617C_H", "tYvu6IpSfiM"],
    ["https://www.youtube.com/shorts/tYvu6IpSfiM", "tYvu6IpSfiM"],
    ["https://www.youtube.com/live/tYvu6IpSfiM?feature=share", "tYvu6IpSfiM"],
    ["https://www.youtube-nocookie.com/embed/tYvu6IpSfiM", "tYvu6IpSfiM"],
    ["https://www.youtube.com/embed/tYvu6IpSfiM", "tYvu6IpSfiM"]
  ])("%s → %s", (url, id) => expect(parseYouTubeUrl(url)).toBe(id));

  it.each([
    "http://youtu.be/tYvu6IpSfiM",
    "https://youtube.com/channel/UCAVDRj14A9W2Zix1Y5EUm7Q",
    "https://www.youtube.com/watch?v=short",
    "https://evil.com/watch?v=tYvu6IpSfiM",
    "https://youtube.com.evil.com/watch?v=tYvu6IpSfiM",
    "not a url"
  ])("rejects %s", (url) => expect(parseYouTubeUrl(url)).toBeNull());
});

describe("parseIsoDuration", () => {
  it("parses hours/minutes/seconds", () => {
    expect(parseIsoDuration("PT16M55S")).toBe(1015);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT7M")).toBe(420);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(parseIsoDuration("garbage")).toBeNull();
  });
});

describe("fetchYouTubeMeta", () => {
  const item = { snippet: { title: "T", channelTitle: "C", publishedAt: "2026-09-20T00:00:00Z", description: "D https://github.com/a/b" }, contentDetails: { duration: "PT5M21S" } };
  it("returns meta and never puts the key anywhere but the query string", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ items: [item] }), { status: 200 }));
    const meta = await fetchYouTubeMeta("C-RdbraCrew", "KEY", fetchFn as never);
    expect(meta).toEqual({ title: "T", channel: "C", publishedAt: "2026-09-20T00:00:00Z", durationSec: 321, description: "D https://github.com/a/b" });
    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toContain("id=C-RdbraCrew");
    expect(url).toContain("part=snippet%2CcontentDetails");
  });
  it("returns null without a key, on HTTP error, on empty items, or on throw", async () => {
    expect(await fetchYouTubeMeta("x", undefined, vi.fn() as never)).toBeNull();
    expect(await fetchYouTubeMeta("x", "K", (async () => new Response("no", { status: 403 })) as never)).toBeNull();
    expect(await fetchYouTubeMeta("x", "K", (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as never)).toBeNull();
    expect(await fetchYouTubeMeta("x", "K", (async () => { throw new Error("net"); }) as never)).toBeNull();
  });

  it("still applies the internal timeout cap when a caller signal is passed, instead of replacing it", async () => {
    const caller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    const pending = fetchYouTubeMeta("x", "K", fetchFn as never, caller.signal);

    // The signal handed to fetch must be a composed one (caller signal AND the internal
    // timeout), never the caller's own signal object -- otherwise passing a long-lived caller
    // signal (e.g. a run's signal, as Task 4 will) would silently drop the 10s cap.
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(caller.signal);

    // Aborting the caller's signal must abort the composed signal too, proving the composition
    // actually includes the caller signal (not just the timeout).
    caller.abort();
    expect(await pending).toBeNull();
  });
});
