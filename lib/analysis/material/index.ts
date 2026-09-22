import { prepareImage, type ImageMaterial } from "./image";
import { fetchUrlText } from "./url";
import { parseYouTubeUrl, type YouTubeMeta } from "./youtube";

export type { YouTubeMeta };
export type Material =
  | ImageMaterial
  | { kind: "text"; text: string }
  | { kind: "url"; url: string; text: string | null }
  | { kind: "video"; platform: "youtube"; url: string; videoId: string; meta: YouTubeMeta | null };

export interface MaterialDeps {
  ocr?: (png: Uint8Array) => Promise<string>;
  fetch?: typeof fetch;
  /** YouTube Data API v3 key, used by the pipeline's own metadata fetch step (not by prepareMaterial itself). */
  youtubeApiKey?: string;
}

export async function prepareMaterial(
  capture: { kind: "image" | "text" | "url"; bytes?: Uint8Array; text?: string | null; url?: string | null },
  deps: MaterialDeps = {},
  signal?: AbortSignal
): Promise<Material> {
  switch (capture.kind) {
    case "image":
      return prepareImage(capture.bytes!, { ocr: deps.ocr }, signal);
    case "text":
      return { kind: "text", text: capture.text! };
    case "url": {
      const videoId = parseYouTubeUrl(capture.url!);
      if (videoId) return { kind: "video", platform: "youtube", url: `https://www.youtube.com/watch?v=${videoId}`, videoId, meta: null };
      return { kind: "url", url: capture.url!, text: await fetchUrlText(capture.url!, deps.fetch) };
    }
  }
}
