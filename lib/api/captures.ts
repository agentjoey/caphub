import type { CaptureInput } from "../captures/dedupe";
import type { SubmitResult } from "../captures/captures";
import type { ImageMime } from "../storage/s3";

const MIMES = new Set<ImageMime>(["image/png", "image/jpeg", "image/webp"]);
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export interface HandleCreateCaptureDeps {
  submit(input: CaptureInput): Promise<SubmitResult>;
  maxUploadBytes: number;
}

function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// Errors thrown by submitCapture()'s dependencies for malformed input (as opposed to
// infrastructure failures) are safe to surface verbatim as 400s.
function isValidationError(message: string): boolean {
  return /url must use https/i.test(message) || /invalid/i.test(message);
}

export async function handleCreateCapture(request: Request, deps: HandleCreateCaptureDeps): Promise<Response> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > deps.maxUploadBytes + MULTIPART_OVERHEAD_BYTES) {
      return Response.json({ error: "payload too large" }, { status: 413 });
    }
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "invalid form" }, { status: 400 });
  }

  const file = form.get("file");
  const text = form.get("text");
  let input: CaptureInput;

  if (file instanceof File && file.size > 0) {
    if (!MIMES.has(file.type as ImageMime)) return Response.json({ error: "unsupported image type" }, { status: 400 });
    if (file.size > deps.maxUploadBytes) return Response.json({ error: "file too large" }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sniffed = sniffImageMime(bytes);
    if (sniffed === null || sniffed !== file.type) {
      return Response.json({ error: "file content does not match declared type" }, { status: 400 });
    }
    input = { source: "web", kind: "image", bytes, mimeType: file.type as ImageMime };
  } else if (typeof text === "string" && text.trim()) {
    const trimmed = text.trim();
    input = /^https:\/\/\S+$/.test(trimmed) ? { source: "web", kind: "url", url: trimmed } : { source: "web", kind: "text", text: trimmed };
  } else {
    return Response.json({ error: "file or text required" }, { status: 400 });
  }

  try {
    const result = await deps.submit(input);
    return Response.json({ ...result, kind: input.kind });
  } catch (error) {
    const message = error instanceof Error ? error.message : "submit failed";
    if (error instanceof Error && isValidationError(message)) {
      return Response.json({ error: message }, { status: 400 });
    }
    console.error("captures submit failed", error);
    return Response.json({ error: "submit failed" }, { status: 500 });
  }
}
