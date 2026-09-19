import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { makeThumbnail, thumbKeyFor } from "./thumbs";

async function pngOf(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  return new Uint8Array(buf);
}

describe("thumbKeyFor", () => {
  it("builds the thumb key from the original digest's first two hex chars and full digest", () => {
    const digest = "ab" + "c".repeat(62);
    expect(thumbKeyFor(digest)).toBe(`thumb/sha256/ab/${digest}.webp`);
  });

  it("rejects a digest that isn't 64 lowercase hex chars", () => {
    expect(() => thumbKeyFor("not-a-digest")).toThrow();
  });
});

describe("makeThumbnail", () => {
  it("produces a webp image resized to fit within 480x480, preserving aspect ratio", async () => {
    const bytes = await pngOf(1000, 500);
    const out = await makeThumbnail(bytes);
    const meta = await sharp(Buffer.from(out)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBeLessThanOrEqual(480);
    expect(meta.height).toBeLessThanOrEqual(480);
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(240);
  });

  it("does not enlarge an image smaller than 480x480", async () => {
    const bytes = await pngOf(100, 60);
    const out = await makeThumbnail(bytes);
    const meta = await sharp(Buffer.from(out)).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(60);
  });

  it("rejects invalid image bytes", async () => {
    await expect(makeThumbnail(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
