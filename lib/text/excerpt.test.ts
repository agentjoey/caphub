import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureTextExcerpt, TEXT_PREVIEW_LIMIT } from "./excerpt";

describe("captureTextExcerpt", () => {
  it("keeps short text and cuts long text at the limit with an ellipsis", () => {
    expect(captureTextExcerpt("短文本")).toBe("短文本");
    const long = "字".repeat(TEXT_PREVIEW_LIMIT + 5);
    expect(captureTextExcerpt(long)).toBe(`${"字".repeat(TEXT_PREVIEW_LIMIT)}…`);
  });

  it("is a server-safe module: no \"use client\" directive", () => {
    // Guards the /mini/review crash: a Server Component (CardSummary) calls this function, and
    // any export of a "use client" module is a client reference that cannot be called on the server.
    const source = readFileSync(new URL("./excerpt.ts", import.meta.url), "utf8");
    expect(source.trimStart().startsWith('"use client"')).toBe(false);
  });
});
