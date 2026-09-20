import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "./safe-url";

describe("safeHttpUrl", () => {
  it("passes through http/https URLs unchanged", () => {
    expect(safeHttpUrl("https://github.com/joey/thing")).toBe("https://github.com/joey/thing");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com");
  });

  it("rejects javascript: and data: URLs", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects other non-http(s) schemes", () => {
    expect(safeHttpUrl("ftp://example.com/file")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects strings that don't parse as URLs, and null/undefined/empty", () => {
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
  });
});
