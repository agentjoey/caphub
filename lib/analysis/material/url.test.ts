import { describe, expect, it, vi } from "vitest";
import { fetchUrlText, stripHtml, type DnsLookup } from "./url";

// A stand-in for `dns.promises.lookup` that resolves any hostname to a
// single public address, so tests never touch real DNS or the network.
const publicLookup: DnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];

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
    const t = await fetchUrlText("https://a.b/", fetchFn, publicLookup);
    expect(t!.length).toBeLessThanOrEqual(20480);
  });

  it("returns null on non-2xx", async () => {
    const fetchFn = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchUrlText("https://a.b/", fetchFn, publicLookup)).toBeNull();
  });

  it("returns null when a redirect points at a non-https URL", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://internal.example/" } })) as unknown as typeof fetch;
    expect(await fetchUrlText("https://a.b/", fetchFn, publicLookup)).toBeNull();
  });

  it("returns null when a redirect points at a link-local IP literal", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } })) as unknown as typeof fetch;
    expect(await fetchUrlText("https://a.b/", fetchFn, publicLookup)).toBeNull();
  });

  it("returns null when the https host resolves to a private address", async () => {
    const fetchFn = vi.fn(async () => new Response("should not be reached", { status: 200 })) as unknown as typeof fetch;
    const privateLookup: DnsLookup = async () => [{ address: "10.0.0.5", family: 4 }];
    expect(await fetchUrlText("https://a.b/", fetchFn, privateLookup)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("follows one allowed redirect hop to a public https URL and returns its text", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target === "https://a.b/") {
        return new Response(null, { status: 302, headers: { location: "https://public.example/landing" } });
      }
      return new Response("<p>Hello redirected world</p>", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const text = await fetchUrlText("https://a.b/", fetchFn, publicLookup);
    expect(text).toBe("Hello redirected world");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
