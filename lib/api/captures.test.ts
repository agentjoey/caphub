import { describe, expect, it, vi } from "vitest";
import { handleCreateCapture } from "./captures";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("handleCreateCapture", () => {
  const submit = async (input: { kind: string }) => ({ captureId: "cap_1", runId: "run_1", duplicate: false, kind: input.kind });

  it("treats a bare https url as url kind", async () => {
    const form = new FormData();
    form.set("text", "https://example.com/x");
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: 10
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ captureId: "cap_1", kind: "url" });
  });

  it("treats plain text as text kind", async () => {
    const form = new FormData();
    form.set("text", "just some notes");
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: 10
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ captureId: "cap_1", kind: "text" });
  });

  it("accepts a supported image within the size limit", async () => {
    const form = new FormData();
    form.set("file", new File([PNG_BYTES], "a.png", { type: "image/png" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: PNG_BYTES.length
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ captureId: "cap_1", kind: "image" });
  });

  it("accepts a jpeg by its magic bytes", async () => {
    const form = new FormData();
    form.set("file", new File([JPEG_BYTES], "a.jpg", { type: "image/jpeg" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: JPEG_BYTES.length
    });
    expect(res.status).toBe(200);
  });

  it("accepts a webp by its magic bytes", async () => {
    const form = new FormData();
    form.set("file", new File([WEBP_BYTES], "a.webp", { type: "image/webp" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: WEBP_BYTES.length
    });
    expect(res.status).toBe(200);
  });

  it("rejects when the file's magic bytes don't match its declared type", async () => {
    const form = new FormData();
    // Declared PNG, but the bytes are actually a JPEG signature.
    form.set("file", new File([JPEG_BYTES], "a.png", { type: "image/png" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: 100
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("does not match") });
  });

  it("rejects oversize file", async () => {
    const form = new FormData();
    form.set("file", new File([PNG_BYTES], "a.png", { type: "image/png" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: 1
    });
    expect(res.status).toBe(400);
  });

  it("rejects unsupported mime", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(1)], "a.gif", { type: "image/gif" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: 10
    });
    expect(res.status).toBe(400);
  });

  it("rejects when neither file nor text is provided", async () => {
    const form = new FormData();
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: 10
    });
    expect(res.status).toBe(400);
  });

  it("rejects with 413 before reading the body when Content-Length exceeds the limit plus multipart overhead", async () => {
    const form = new FormData();
    form.set("text", "hello");
    const request = new Request("http://l/api/captures", { method: "POST", body: form });
    const formDataSpy = vi.spyOn(request, "formData");
    // Override content-length to simulate a huge declared upload without actually sending one.
    Object.defineProperty(request, "headers", {
      value: new Headers([...request.headers.entries(), ["content-length", String(10 * 1024 * 1024)]])
    });
    const res = await handleCreateCapture(request, { submit: submit as never, maxUploadBytes: 10 });
    expect(res.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it("maps a known validation error from submit() to 400 with its message", async () => {
    const form = new FormData();
    form.set("text", "some plain text");
    const failingSubmit = async () => {
      throw new Error("url must use https");
    };
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: failingSubmit as never,
      maxUploadBytes: 10
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "url must use https" });
  });

  it("maps an unrecognized submit() error to a generic 500", async () => {
    const form = new FormData();
    form.set("text", "hello");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingSubmit = async () => {
      throw new Error("ECONNRESET");
    };
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: failingSubmit as never,
      maxUploadBytes: 10
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "submit failed" });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
