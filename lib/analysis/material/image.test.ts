import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { packagedLangPath, prepareImage } from "./image";

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

  it("rejects undecodable bytes with code INVALID_IMAGE", async () => {
    await expect(prepareImage(new Uint8Array([1, 2, 3, 4]), { ocr: async () => "" })).rejects.toMatchObject({ code: "INVALID_IMAGE", message: "INVALID_IMAGE" });
  });
});

describe("packagedLangPath", () => {
  it("stages packaged eng and chi_sim traineddata locally without touching the network", () => {
    const dir = packagedLangPath();
    expect(existsSync(`${dir}/eng.traineddata.gz`)).toBe(true);
    expect(existsSync(`${dir}/chi_sim.traineddata.gz`)).toBe(true);
  });
});
