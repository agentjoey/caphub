import { copyFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

export const MAX_EDGE_PX = 2000;
export const OCR_TIMEOUT_MS = 15_000;
// Keep OCR text within a small, predictable token budget for downstream analysis prompts.
const OCR_TEXT_MAX_CHARS = 8000;

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

export function packagedLangPath(): string {
  if (sharedLangPath) return sharedLangPath;
  const dir = mkdtempSync(path.join(tmpdir(), "caphub-tessdata-"));
  for (const language of PACKAGED_LANGUAGES) {
    const data = resolvePackagedLanguage(language);
    const filename = `${data.code}.traineddata${data.gzip ? ".gz" : ""}`;
    const source = path.join(data.langPath, filename);
    const target = path.join(dir, filename);
    try {
      symlinkSync(source, target);
    } catch {
      copyFileSync(source, target);
    }
  }
  sharedLangPath = dir;
  return dir;
}

interface Recognizer {
  recognize(png: Uint8Array): Promise<string>;
  terminate(): Promise<void>;
}

let recognizer: Promise<Recognizer> | undefined;

function createPackagedRecognizer(): Promise<Recognizer> {
  return (async () => {
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
      },
      async terminate() {
        await worker.terminate();
      }
    };
  })();
}

async function packagedOcr(png: Uint8Array): Promise<string> {
  recognizer ??= createPackagedRecognizer();
  return (await recognizer).recognize(png);
}

// If OCR times out or is aborted, the shared worker may be mid-recognition
// with no way to cancel cleanly; terminate it and drop the memoized instance
// so the next call starts a fresh worker instead of starving behind a stuck one.
async function discardSharedRecognizer(): Promise<void> {
  const stale = recognizer;
  recognizer = undefined;
  if (!stale) return;
  try {
    const worker = await stale;
    await worker.terminate();
  } catch {
    // best-effort cleanup only
  }
}

async function runOcr(
  ocr: (png: Uint8Array) => Promise<string>,
  png: Uint8Array,
  usesSharedRecognizer: boolean,
  signal?: AbortSignal
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let timedOutOrAborted = false;
  try {
    return await Promise.race([
      ocr(png),
      new Promise<string>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOutOrAborted = true;
          reject(new Error("OCR_TIMEOUT"));
        }, OCR_TIMEOUT_MS);
        onAbort = () => {
          timedOutOrAborted = true;
          reject(new Error("ABORTED"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } catch {
    if (timedOutOrAborted && usesSharedRecognizer) await discardSharedRecognizer();
    return "";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export async function prepareImage(
  bytes: Uint8Array,
  deps: { ocr?: (png: Uint8Array) => Promise<string> } = {},
  signal?: AbortSignal
): Promise<ImageMaterial> {
  const invalid = (cause?: unknown) => Object.assign(new Error("INVALID_IMAGE", { cause }), { code: "INVALID_IMAGE" });
  const image = sharp(Buffer.from(bytes), { failOn: "error" }).rotate();
  const meta = await image.metadata().catch((error: unknown) => { throw invalid(error); });
  if (!meta.width || !meta.height) throw invalid();
  const resized = meta.width > MAX_EDGE_PX || meta.height > MAX_EDGE_PX
    ? image.resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside" })
    : image;
  const { data, info } = await resized.png().toBuffer({ resolveWithObject: true });
  const png = new Uint8Array(data);
  const usesSharedRecognizer = deps.ocr === undefined;
  const ocr = deps.ocr ?? packagedOcr;
  const ocrText = await runOcr(ocr, png, usesSharedRecognizer, signal);
  return {
    kind: "image",
    png,
    ocrText: ocrText.replace(/\s+/g, " ").trim().slice(0, OCR_TEXT_MAX_CHARS),
    width: info.width,
    height: info.height
  };
}
