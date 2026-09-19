import { createHash } from "node:crypto";
import { z } from "zod";

export const objectRefSchema = z.object({
  key: z.string().regex(/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative()
});
export type ObjectRef = z.infer<typeof objectRefSchema>;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function objectRefFor(bytes: Uint8Array): ObjectRef {
  if (bytes.byteLength === 0) throw new TypeError("object bytes must be non-empty");
  const digest = sha256Hex(bytes);
  return { key: `sha256/${digest.slice(0, 2)}/${digest}`, digest, bytes: bytes.byteLength };
}
