import { describe, expect, it, vi } from "vitest";
import { prepareMaterial } from "./index";

describe("prepareMaterial url capture", () => {
  it("recognises a YouTube link as a video material without fetching it, and leaves meta for the pipeline", async () => {
    const fetchFn = vi.fn();
    const material = await prepareMaterial({ kind: "url", url: "https://youtu.be/tYvu6IpSfiM" }, { fetch: fetchFn as never });
    expect(material).toEqual({ kind: "video", platform: "youtube", url: "https://www.youtube.com/watch?v=tYvu6IpSfiM", videoId: "tYvu6IpSfiM", meta: null });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
