import { describe, expect, it, vi } from "vitest";
import { fetchCanonical, MAX_CANONICAL_BODY_BYTES } from "./canonical";
import type { DnsLookup } from "./material/url";

// A stand-in for `dns.promises.lookup` that resolves any hostname to a
// single public address, so tests never touch real DNS or the network.
const publicLookup: DnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" }, ...init });
}

describe("fetchCanonical", () => {
  it("extracts title and text from a plain page", async () => {
    const fetchFn = vi.fn(async () => htmlResponse("<html><head><title>Widget Co</title></head><body><p>Widgets for everyone.</p></body></html>"));
    const result = await fetchCanonical("https://widget.example/product", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result).toEqual({ kind: "page", url: "https://widget.example/product", title: "Widget Co", text: "Widget Co Widgets for everyone." });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns null without fetching for a non-http(s) URL", async () => {
    const fetchFn = vi.fn();
    const result = await fetchCanonical("ftp://widget.example/file", { fetch: fetchFn as unknown as typeof fetch });
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns null without fetching for a loopback IP literal", async () => {
    const fetchFn = vi.fn();
    const result = await fetchCanonical("http://127.0.0.1/admin", { fetch: fetchFn as unknown as typeof fetch });
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns null without fetching for a link-local (metadata service) IP literal", async () => {
    const fetchFn = vi.fn();
    const result = await fetchCanonical("http://169.254.169.254/latest/meta-data", { fetch: fetchFn as unknown as typeof fetch });
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns null without fetching when the hostname resolves to a private address", async () => {
    const fetchFn = vi.fn();
    const privateLookup: DnsLookup = async () => [{ address: "10.0.0.5", family: 4 }];
    const result = await fetchCanonical("https://internal.example/", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: privateLookup });
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not follow a redirect that points at a private/link-local address", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    const result = await fetchCanonical("https://widget.example/redirector", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to a safe public URL", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target === "https://widget.example/redirector") {
        return new Response(null, { status: 302, headers: { location: "https://widget.example/landing" } });
      }
      return htmlResponse("<html><head><title>Landing</title></head><body><p>Landed safely.</p></body></html>");
    });
    const result = await fetchCanonical("https://widget.example/redirector", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    // `url` reflects the canonical input, not the redirect target -- consistent with the rest of the module.
    expect(result).toEqual({ kind: "page", url: "https://widget.example/redirector", title: "Landing", text: "Landing Landed safely." });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns null on a 404", async () => {
    const fetchFn = vi.fn(async () => new Response("not found", { status: 404 }));
    const result = await fetchCanonical("https://widget.example/gone", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result).toBeNull();
  });

  it("returns null when the HTML has no usable text", async () => {
    const fetchFn = vi.fn(async () => htmlResponse("<html><head><script>x()</script></head><body>   </body></html>"));
    const result = await fetchCanonical("https://widget.example/empty", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result).toBeNull();
  });

  it("caps an oversized response body instead of failing", async () => {
    const body = `<html><body><p>${"a".repeat(MAX_CANONICAL_BODY_BYTES * 2)}</p></body></html>`;
    const fetchFn = vi.fn(async () => htmlResponse(body));
    const result = await fetchCanonical("https://widget.example/huge", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result?.kind).toBe("page");
    expect(result!.text.length).toBeLessThanOrEqual(MAX_CANONICAL_BODY_BYTES);
  });

  it("caps an oversized response with no readable stream (arrayBuffer fallback) by bytes, not characters", async () => {
    // A multi-byte character sitting right at the byte cutoff must not corrupt decoding,
    // and the cap must bind on bytes: a body of many 3-byte characters must be truncated
    // to <= MAX_CANONICAL_BODY_BYTES bytes, not <= MAX_CANONICAL_BODY_BYTES characters.
    const raw = "€".repeat(MAX_CANONICAL_BODY_BYTES); // 3 bytes per char in UTF-8
    const body = `<html><body><p>${raw}</p></body></html>`;
    const response = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(response, "body", { value: null });
    const fetchFn = vi.fn(async () => response);
    const result = await fetchCanonical("https://widget.example/huge-no-stream", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result?.kind).toBe("page");
    expect(Buffer.byteLength(result!.text, "utf8")).toBeLessThanOrEqual(MAX_CANONICAL_BODY_BYTES);
  });

  it("times out after 10s and returns null", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      });
      const promise = fetchCanonical("https://widget.example/slow", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetches README and repo metadata for a GitHub repo URL", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target === "https://api.github.com/repos/acme/widget") {
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/widget",
            full_name: "acme/widget",
            description: "A widget library",
            homepage: "https://widget.example",
            stargazers_count: 42,
            pushed_at: "2026-01-02T03:04:05Z",
            license: { spdx_id: "MIT" }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (target === "https://api.github.com/repos/acme/widget/readme") {
        return new Response("# Widget\n\nDoes widget things.", { status: 200, headers: { "content-type": "text/plain" } });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    const result = await fetchCanonical("https://github.com/acme/widget/tree/main", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result).toEqual({
      kind: "repo",
      url: "https://github.com/acme/widget",
      title: "acme/widget",
      text: "# Widget\n\nDoes widget things.",
      facts: {
        repo_url: "https://github.com/acme/widget",
        stars: 42,
        last_update: "2026-01-02T03:04:05Z",
        license: "MIT",
        homepage: "https://widget.example"
      }
    });
  });

  it("degrades to a plain page fetch when the GitHub API returns 403", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target === "https://api.github.com/repos/acme/widget") {
        return new Response("rate limited", { status: 403 });
      }
      if (target === "https://github.com/acme/widget") {
        return htmlResponse("<html><head><title>acme/widget</title></head><body><p>GitHub page</p></body></html>");
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    const result = await fetchCanonical("https://github.com/acme/widget", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result).toEqual({ kind: "page", url: "https://github.com/acme/widget", title: "acme/widget", text: "acme/widget GitHub page" });
  });

  it("degrades to a plain page fetch when a repo-shaped URL 404s on the API", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target === "https://api.github.com/repos/acme/ghost") {
        return new Response("not found", { status: 404 });
      }
      if (target === "https://github.com/acme/ghost") {
        return htmlResponse("<html><head><title>404</title></head><body><p>Page not found, but here is text.</p></body></html>");
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    const result = await fetchCanonical("https://github.com/acme/ghost", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result).toEqual({ kind: "page", url: "https://github.com/acme/ghost", title: "404", text: "404 Page not found, but here is text." });
  });

  it("falls back to the repo description when the README fetch fails", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target === "https://api.github.com/repos/acme/widget") {
        return new Response(JSON.stringify({ html_url: "https://github.com/acme/widget", full_name: "acme/widget", description: "A widget library" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (target === "https://api.github.com/repos/acme/widget/readme") {
        return new Response("nope", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    const result = await fetchCanonical("https://github.com/acme/widget", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result).toEqual({
      kind: "repo",
      url: "https://github.com/acme/widget",
      title: "acme/widget",
      text: "A widget library",
      facts: { repo_url: "https://github.com/acme/widget" }
    });
  });

  it("applies the same host-safety guard to the GitHub API host on the repo path", async () => {
    // github.com itself resolves fine, but api.github.com is made to resolve to a private
    // address -- the repo metadata call must be rejected without ever reaching fetch, and
    // the module must still degrade to a plain page fetch of the original github.com URL.
    const scopedLookup: DnsLookup = async (hostname) =>
      hostname === "api.github.com" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "93.184.216.34", family: 4 }];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target === "https://github.com/acme/widget") {
        return htmlResponse("<html><head><title>acme/widget</title></head><body><p>GitHub page</p></body></html>");
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    const result = await fetchCanonical("https://github.com/acme/widget", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: scopedLookup });
    expect(result).toEqual({ kind: "page", url: "https://github.com/acme/widget", title: "acme/widget", text: "acme/widget GitHub page" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith("https://github.com/acme/widget", expect.anything());
  });

  it("returns null when nothing usable was obtained at all", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await fetchCanonical("https://widget.example/down", { fetch: fetchFn as unknown as typeof fetch, dnsLookup: publicLookup });
    expect(result).toBeNull();
  });
});
