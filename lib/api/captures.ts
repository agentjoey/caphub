import type { CaptureInput } from "../captures/dedupe";
import type { SubmitResult } from "../captures/captures";
import type { ImageMime } from "../storage/s3";

const MIMES = new Set<ImageMime>(["image/png", "image/jpeg", "image/webp"]);

export interface HandleCreateCaptureDeps {
  submit(input: CaptureInput): Promise<SubmitResult>;
  maxUploadBytes: number;
}

export async function handleCreateCapture(request: Request, deps: HandleCreateCaptureDeps): Promise<Response> {
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
    input = { source: "web", kind: "image", bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type as ImageMime };
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
    return Response.json({ error: error instanceof Error ? error.message : "submit failed" }, { status: 400 });
  }
}
