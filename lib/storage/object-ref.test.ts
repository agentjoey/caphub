import { describe, expect, it } from "vitest";
import { objectRefFor } from "./object-ref";

describe("objectRefFor", () => {
  it("derives sha256 key like v1", () => {
    const ref = objectRefFor(new TextEncoder().encode("hello"));
    expect(ref.digest).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(ref.key).toBe(`sha256/2c/${ref.digest}`);
    expect(ref.bytes).toBe(5);
  });
  it("rejects empty input", () => {
    expect(() => objectRefFor(new Uint8Array())).toThrow();
  });
});
