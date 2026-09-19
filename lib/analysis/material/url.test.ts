import { describe, expect, it } from "vitest";
import { fetchUrlText, stripHtml } from "./url";

describe("stripHtml", () => {
  it("removes scripts, styles and tags, collapses whitespace", () => {
    expect(stripHtml("<html><script>x()</script><style>a{}</style><p>Hello <b>world</b></p>\n\n<p>again</p></html>")).toBe("Hello world again");
  });
});

describe("fetchUrlText", () => {
  it("returns null for non-https", async () => {
    expect(await fetchUrlText("http://a.b")).toBeNull();
  });

  it("caps body to 20480 bytes", async () => {
    const fetchFn = (async () => new Response("<p>" + "a".repeat(50000) + "</p>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const t = await fetchUrlText("https://a.b/", fetchFn);
    expect(t!.length).toBeLessThanOrEqual(20480);
  });

  it("returns null on non-2xx", async () => {
    const fetchFn = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchUrlText("https://a.b/", fetchFn)).toBeNull();
  });
});
