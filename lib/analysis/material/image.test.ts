import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { prepareImage } from "./image";

describe("prepareImage", () => {
  it("normalizes to png with bounded size and uses injected ocr", async () => {
    const jpeg = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const m = await prepareImage(new Uint8Array(jpeg), { ocr: async () => "hello" });
    expect(m.kind).toBe("image");
    expect(m.width).toBe(2000);
    expect(m.ocrText).toBe("hello");
    expect((await sharp(m.png).metadata()).format).toBe("png");
  });

  it("tolerates ocr failure", async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).png().toBuffer();
    const m = await prepareImage(new Uint8Array(png), {
      ocr: async () => {
        throw new Error("boom");
      }
    });
    expect(m.ocrText).toBe("");
  });
});
