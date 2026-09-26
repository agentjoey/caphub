import { describe, expect, it, vi } from "vitest";
import { fetchUrlText, stripHtml, htmlToText, isSafeHost, resolveSafeHostAddresses, MAX_URL_BODY_BYTES, type DnsLookup, type DnsRecord } from "./url";

// A stand-in for `dns.promises.lookup` that resolves any hostname to a
// single public address, so tests never touch real DNS or the network.
const publicLookup: DnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("stripHtml", () => {
  it("removes scripts, styles and tags, collapses whitespace", () => {
    expect(stripHtml("<html><script>x()</script><style>a{}</style><p>Hello <b>world</b></p>\n\n<p>again</p></html>")).toBe("Hello world again");
  });
});

describe("htmlToText", () => {
  it("keeps block and <br> boundaries as line breaks and collapses runs of spaces within a line", () => {
    expect(htmlToText("<div><p>第一行</p><p>第二行  有  空格<br>第三行</p></div><script>x()</script>")).toBe(
      "第一行\n第二行 有 空格\n第三行"
    );
  });

  it("keeps <pre> content's own line breaks", () => {
    expect(htmlToText("<pre>line 1\n  line 2</pre>")).toBe("line 1\nline 2");
  });
});

describe("fetchUrlText", () => {
  it("returns null for non-https", async () => {
    expect(await fetchUrlText("http://a.b")).toBeNull();
  });

  it("caps body to MAX_URL_BODY_BYTES", async () => {
    const fetchFn = (async () => new Response("<p>" + "a".repeat(200_000) + "</p>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const t = await fetchUrlText("https://a.b/", fetchFn, publicLookup);
    expect(t!.length).toBeLessThanOrEqual(MAX_URL_BODY_BYTES);
  });

  it("keeps line breaks in plain-text bodies", async () => {
    const fetchFn = (async () => new Response("a\n\n\nb   c", { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    expect(await fetchUrlText("https://a.b/", fetchFn, publicLookup)).toBe("a\n\nb c");
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

  it("cancels redirect response bodies before following the next URL", async () => {
    let bodyCanceled = false;
    let calls = 0;
    const redirectBody = new ReadableStream<Uint8Array>({ cancel() { bodyCanceled = true; } });
    const fetchFn = vi.fn(async () => {
      if (calls++ === 0) return new Response(redirectBody, { status: 302, headers: { location: "https://public.example/landing" } });
      return new Response("landed", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;

    await expect(fetchUrlText("https://a.b/", fetchFn, publicLookup)).resolves.toBe("landed");
    expect(bodyCanceled).toBe(true);
  });

  it("cancels non-2xx response bodies before returning null", async () => {
    let bodyCanceled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { bodyCanceled = true; } });
    const fetchFn = vi.fn(async () => new Response(body, { status: 500 })) as unknown as typeof fetch;

    await expect(fetchUrlText("https://a.b/", fetchFn, publicLookup)).resolves.toBeNull();
    expect(bodyCanceled).toBe(true);
  });

  it("pins the resolved public address on each redirect hop", async () => {
    const addresses: Record<string, DnsRecord> = {
      "a.b": { address: "93.184.216.34", family: 4 },
      "public.example": { address: "8.8.8.8", family: 4 }
    };
    const resolved: string[] = [];
    const lookup: DnsLookup = async (hostname) => {
      resolved.push(hostname);
      return [addresses[hostname]];
    };
    const originalFetch = globalThis.fetch;
    const globalFetch = vi.fn(async () => new Response("global fetch bypass", { status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    const transport = vi.fn(async (url: URL, pinned: readonly DnsRecord[]) => {
      if (url.hostname === "a.b") return new Response(null, { status: 302, headers: { location: "https://public.example/landing" } });
      expect(pinned).toEqual([addresses["public.example"]]);
      return new Response("pinned response", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const call = fetchUrlText as unknown as (
      url: string,
      fetchFn: typeof fetch | undefined,
      dnsLookup: DnsLookup,
      pinnedTransport: (url: URL, addresses: readonly DnsRecord[], init: RequestInit) => Promise<Response>
    ) => Promise<string | null>;

    try {
      await expect(call("https://a.b/", globalFetch as unknown as typeof fetch, lookup, transport)).resolves.toBe("pinned response");
      expect(transport).toHaveBeenCalledTimes(2);
      expect(resolved).toEqual(["a.b", "public.example"]);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("rejects the IPv6 unspecified address", async () => {
    expect(await isSafeHost(new URL("https://[::]/"), publicLookup)).toBe(false);
  });

  it.each(["0.0.0.0", "224.0.0.1", "240.0.0.1", "255.255.255.255"])("rejects non-public IPv4 address %s", async (address) => {
    expect(await isSafeHost(new URL(`https://${address}/`), publicLookup)).toBe(false);
  });

  it("rejects malformed DNS address records", async () => {
    const malformedLookup: DnsLookup = async () => [{ address: "2001:db8::zz", family: 6 }];
    expect(await isSafeHost(new URL("https://a.b/"), malformedLookup)).toBe(false);
  });

  it("returns on timeout even when DNS resolution never settles", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn();
    const stalledLookup: DnsLookup = async () => new Promise(() => {});
    const promise = fetchUrlText("https://a.b/", fetchFn as unknown as typeof fetch, stalledLookup);
    const observed = promise.then((value) => value, (error) => error);

    try {
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(Promise.race([observed, Promise.resolve("still-pending")])).resolves.toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start DNS resolution for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const dnsLookup = vi.fn(async () => { throw new Error("DNS should not run"); });

    await expect(resolveSafeHostAddresses(new URL("https://a.b/"), dnsLookup, controller.signal)).resolves.toBeNull();
    expect(dnsLookup).not.toHaveBeenCalled();
  });
});
