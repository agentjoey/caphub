import { copyFileSync, existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

export const MAX_EDGE_PX = 2000;
export const OCR_TIMEOUT_MS = 15_000;

export interface ImageMaterial {
  kind: "image";
  png: Uint8Array;
  ocrText: string;
  width: number;
  height: number;
}

const localRequire = createRequire(import.meta.url);

interface PackagedLanguageData {
  code: string;
  gzip: boolean;
  langPath: string;
}

const PACKAGED_LANGUAGES = ["eng", "chi_sim"] as const;

function resolvePackagedLanguage(language: (typeof PACKAGED_LANGUAGES)[number]): PackagedLanguageData {
  const packageName = language === "eng" ? "@tesseract.js-data/eng" : "@tesseract.js-data/chi_sim";
  return localRequire(packageName) as PackagedLanguageData;
}

// tesseract.js only accepts a single `langPath` per worker, but each
// `@tesseract.js-data/*` package ships its traineddata under its own
// directory. Stage symlinks (falling back to copies) for every packaged
// language into one directory so a single worker can load them together
// without ever reaching out to a CDN.
let sharedLangPath: string | undefined;

function packagedLangPath(): string {
  if (sharedLangPath) return sharedLangPath;
  const dir = mkdtempSync(path.join(tmpdir(), "caphub-tessdata-"));
  for (const language of PACKAGED_LANGUAGES) {
    const data = resolvePackagedLanguage(language);
    const filename = `${data.code}.traineddata${data.gzip ? ".gz" : ""}`;
    const source = path.join(data.langPath, filename);
    const target = path.join(dir, filename);
    if (existsSync(target)) continue;
    try {
      symlinkSync(source, target);
    } catch {
      copyFileSync(source, target);
    }
  }
  sharedLangPath = dir;
  return dir;
}

let recognizer: Promise<{ recognize(png: Uint8Array): Promise<string> }> | undefined;

async function packagedOcr(png: Uint8Array): Promise<string> {
  recognizer ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker([...PACKAGED_LANGUAGES], 1, {
      langPath: packagedLangPath(),
      gzip: true,
      cacheMethod: "none"
    });
    return {
      async recognize(bytes: Uint8Array) {
        const result = await worker.recognize(Buffer.from(bytes));
        return result.data.text;
      }
    };
  })();
  return (await recognizer).recognize(png);
}

export async function prepareImage(
  bytes: Uint8Array,
  deps: { ocr?: (png: Uint8Array) => Promise<string> } = {},
  signal?: AbortSignal
): Promise<ImageMaterial> {
  const image = sharp(Buffer.from(bytes), { failOn: "error" }).rotate();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error("INVALID_IMAGE");
  const resized = meta.width > MAX_EDGE_PX || meta.height > MAX_EDGE_PX
    ? image.resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside" })
    : image;
  const { data, info } = await resized.png().toBuffer({ resolveWithObject: true });
  const png = new Uint8Array(data);
  const ocr = deps.ocr ?? packagedOcr;
  let ocrText = "";
  try {
    ocrText = await Promise.race([
      ocr(png),
      new Promise<string>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("OCR_TIMEOUT")), OCR_TIMEOUT_MS);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("ABORTED"));
          },
          { once: true }
        );
      })
    ]);
  } catch {
    ocrText = "";
  }
  return {
    kind: "image",
    png,
    ocrText: ocrText.replace(/\s+/g, " ").trim().slice(0, 8000),
    width: info.width,
    height: info.height
  };
}
