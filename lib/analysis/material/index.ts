import { prepareImage, type ImageMaterial } from "./image";
import { fetchUrlText } from "./url";

export type Material = ImageMaterial | { kind: "text"; text: string } | { kind: "url"; url: string; text: string | null };

export interface MaterialDeps {
  ocr?: (png: Uint8Array) => Promise<string>;
  fetch?: typeof fetch;
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
    case "url":
      return { kind: "url", url: capture.url!, text: await fetchUrlText(capture.url!, deps.fetch) };
  }
}
