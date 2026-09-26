import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPinnedHttp, type PinnedAddress } from "./safe-http";

const LOOPBACK: PinnedAddress = { address: "127.0.0.1", family: 4 };
const servers: Array<ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>> = [];

async function listen(server: (typeof servers)[number]): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("fetchPinnedHttp", () => {
  it("connects to the supplied address and preserves the URL host header", async () => {
    let receivedHost = "";
    let receivedPath = "";
    const server = createHttpServer((request, response) => {
      receivedHost = request.headers.host ?? "";
      receivedPath = request.url ?? "";
      response.writeHead(200, { "content-type": "text/plain" }).end("pinned");
    });
    const port = await listen(server);
    const response = await fetchPinnedHttp(new URL(`http://origin.test:${port}/path?q=1`), [LOOPBACK]);

    expect(await response.text()).toBe("pinned");
    expect(receivedHost).toBe(`origin.test:${port}`);
    expect(receivedPath).toBe("/path?q=1");
  });

  it("does not reuse an earlier socket when the validated pin changes", async () => {
    let requestCount = 0;
    const server = createHttpServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "text/plain", connection: "keep-alive" }).end(`request ${requestCount}`);
    });
    const port = await listen(server);
    const url = new URL(`http://origin.test:${port}/`);
    const first = await fetchPinnedHttp(url, [LOOPBACK]);
    expect(await first.text()).toBe("request 1");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(fetchPinnedHttp(url, [{ address: "127.0.0.2", family: 4 }], { signal: controller.signal })).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(requestCount).toBe(1);
  });

  it("rejects an IP literal when the supplied pin does not match it", async () => {
    await expect(fetchPinnedHttp(new URL("http://93.184.216.34/"), [LOOPBACK]))
      .rejects.toThrow("pinned transport address does not match the URL IP literal");
  });

  it("keeps TLS SNI and certificate checks on the original hostname", async () => {
    const certUrl = new URL("./test-fixtures/origin-test-cert.pem", import.meta.url);
    const keyUrl = new URL("./test-fixtures/origin-test-key.pem", import.meta.url);
    const [cert, key] = await Promise.all([readFile(certUrl), readFile(keyUrl)]);
    const context = createSecureContext({ cert, key });
    let receivedSni = "";
    let receivedHost = "";
    const server = createHttpsServer({
      cert,
      key,
      SNICallback(servername, callback) {
        receivedSni = servername;
        callback(null, context);
      }
    }, (request, response) => {
      receivedHost = request.headers.host ?? "";
      response.writeHead(200, { "content-type": "text/plain" }).end("tls-pinned");
    });
    const port = await listen(server);
    const response = await fetchPinnedHttp(new URL(`https://origin.test:${port}/secure`), [LOOPBACK], { ca: cert });

    expect(await response.text()).toBe("tls-pinned");
    expect(receivedSni).toBe("origin.test");
    expect(receivedHost).toBe(`origin.test:${port}`);
    await expect(fetchPinnedHttp(new URL(`https://wrong.test:${port}/secure`), [LOOPBACK], { ca: cert }))
      .rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("decodes compressed response bodies and removes stale encoding headers", async () => {
    let acceptEncoding = "";
    const compressed = gzipSync(Buffer.from("decoded response"));
    const server = createHttpServer((request, response) => {
      acceptEncoding = request.headers["accept-encoding"] ?? "";
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "content-length": String(compressed.length)
      }).end(compressed);
    });
    const port = await listen(server);
    const response = await fetchPinnedHttp(new URL(`http://origin.test:${port}/compressed`), [LOOPBACK]);

    expect(acceptEncoding).toContain("gzip");
    expect(await response.text()).toBe("decoded response");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("aborts an in-progress response body and closes the pinned socket", async () => {
    let markRequestClosed!: () => void;
    const requestClosed = new Promise<void>((resolve) => { markRequestClosed = resolve; });
    const server = createHttpServer((request, response) => {
      request.once("close", markRequestClosed);
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      response.write("first chunk");
    });
    const port = await listen(server);
    const controller = new AbortController();
    const response = await fetchPinnedHttp(new URL(`http://origin.test:${port}/slow`), [LOOPBACK], { signal: controller.signal });
    const reader = response.body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first chunk");
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await requestClosed;
  });

  it("closes the pinned socket when a response body is canceled", async () => {
    let markRequestClosed!: () => void;
    const requestClosed = new Promise<void>((resolve) => { markRequestClosed = resolve; });
    const server = createHttpServer((request, response) => {
      request.once("close", markRequestClosed);
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      response.write("first chunk");
    });
    const port = await listen(server);
    const response = await fetchPinnedHttp(new URL(`http://origin.test:${port}/cancel`), [LOOPBACK]);
    const reader = response.body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first chunk");
    await reader.cancel();
    await requestClosed;
  });
});
