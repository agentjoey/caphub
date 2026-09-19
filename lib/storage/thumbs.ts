import sharp from "sharp";

const DIGEST_RE = /^[a-f0-9]{64}$/;

/** thumb/sha256/<first 2 hex>/<64-hex sha256 of the ORIGINAL image bytes>.webp */
export function thumbKeyFor(digest: string): string {
  if (!DIGEST_RE.test(digest)) throw new TypeError("digest must be a 64-char lowercase hex sha256");
  return `thumb/sha256/${digest.slice(0, 2)}/${digest}.webp`;
}

/** Generates a display thumbnail: orientation-corrected, fit within 480x480, webp q72. */
export async function makeThumbnail(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await sharp(Buffer.from(bytes), { failOn: "error" })
    .rotate()
    .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
  return new Uint8Array(buf);
}
