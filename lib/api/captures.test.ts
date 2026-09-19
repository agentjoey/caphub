import { describe, expect, it } from "vitest";
import { handleCreateCapture } from "./captures";

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
    form.set("file", new File([new Uint8Array(5)], "a.png", { type: "image/png" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: 10
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ captureId: "cap_1", kind: "image" });
  });

  it("rejects oversize file", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(11)], "a.png", { type: "image/png" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: submit as never,
      maxUploadBytes: 10
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

  it("returns 400 when submit rejects", async () => {
    const form = new FormData();
    form.set("text", "hello");
    const failingSubmit = async () => {
      throw new Error("boom");
    };
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), {
      submit: failingSubmit as never,
      maxUploadBytes: 10
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "boom" });
  });
});
