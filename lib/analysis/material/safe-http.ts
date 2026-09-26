import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createUnzip } from "node:zlib";

export interface PinnedAddress {
  address: string;
  family: number;
}

export interface PinnedHttpOptions {
  method?: string;
  headers?: HeadersInit;
  signal?: AbortSignal | null;
  /** TLS trust override is only supplied by local transport tests. */
  ca?: string | Buffer;
}

export type PinnedHttpTransport = (
  url: URL,
  addresses: readonly PinnedAddress[],
  options?: PinnedHttpOptions
) => Promise<Response>;

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"
]);

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function responseHeaders(message: IncomingMessage, decompressed: boolean): Headers {
  const headers = new Headers();
  const connectionHeaders = new Set(
    String(message.headers.connection ?? "").split(",").map((header) => header.trim().toLowerCase()).filter(Boolean)
  );
  for (const [name, value] of Object.entries(message.headers)) {
    const key = name.toLowerCase();
    if (!value || HOP_BY_HOP_HEADERS.has(key) || connectionHeaders.has(key)) continue;
    if (decompressed && (key === "content-encoding" || key === "content-length")) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function decodedBody(message: IncomingMessage): { stream: Readable; decompressed: boolean } {
  const encodings = String(message.headers["content-encoding"] ?? "")
    .split(",").map((value) => value.trim().toLowerCase()).filter((value) => value && value !== "identity");
  if (encodings.length === 0) return { stream: message, decompressed: false };

  const decoders = encodings.slice().reverse().map((encoding) => {
    if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
    if (encoding === "deflate") return createUnzip();
    if (encoding === "br") return createBrotliDecompress();
    return null;
  });
  if (decoders.some((decoder) => decoder === null)) return { stream: message, decompressed: false };
  const validDecoders = decoders as ReturnType<typeof createGunzip>[];
  const finalStream = validDecoders[validDecoders.length - 1];
  pipeline([message, ...validDecoders], () => {});
  return { stream: finalStream, decompressed: true };
}

function responseBody(message: IncomingMessage, source: Readable): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value instanceof Uint8Array ? next.value : Buffer.from(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      const error = reason instanceof Error ? reason : undefined;
      if (!message.destroyed && !message.complete) message.destroy(error);
      if (source !== message && !source.destroyed) source.destroy(error);
      try {
        await iterator.return?.();
      } catch {
        // The stream is already being destroyed; cancellation has completed its job.
      }
    }
  }, { highWaterMark: 1 });
}

/**
 * Opens one HTTP(S) request through the supplied, already-validated DNS addresses.
 * The URL hostname remains in place so HTTP Host, TLS SNI, and certificate hostname
 * verification continue to use the original host while the socket connects to a pin.
 */
export const fetchPinnedHttp: PinnedHttpTransport = async (url, addresses, options = {}) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("pinned transport supports only HTTP(S)");
  if (url.username || url.password) throw new TypeError("pinned transport does not accept URL credentials");
  if (addresses.length === 0) throw new TypeError("pinned transport requires at least one resolved address");
  if (options.signal?.aborted) throw abortError();
  for (const { address, family } of addresses) {
    if (isIP(address) !== family) throw new TypeError("pinned transport received an invalid DNS address");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const literalFamily = isIP(hostname);
  if (literalFamily && (addresses.length !== 1 || addresses[0].family !== literalFamily || addresses[0].address.toLowerCase() !== hostname)) {
    throw new TypeError("pinned transport address does not match the URL IP literal");
  }
  const pinnedLookup: LookupFunction = (requestedHostname, lookupOptions, callback) => {
    if (requestedHostname.replace(/^\[|\]$/g, "").toLowerCase() !== hostname) {
      callback(Object.assign(new Error("pinned DNS hostname mismatch"), { code: "EHOSTUNREACH" }), [], 0);
      return;
    }
    const records = addresses.map(({ address, family }) => ({ address, family }));
    if (lookupOptions.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  };

  const headers = new Headers(options.headers);
  headers.set("host", url.host);
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip, deflate, br");
  const outgoingHeaders: Record<string, string> = {};
  headers.forEach((value, name) => { outgoingHeaders[name] = value; });
  const requestOptions: RequestOptions = {
    method: options.method ?? "GET",
    headers: outgoingHeaders,
    lookup: pinnedLookup,
    agent: false,
    ...(addresses.length > 1 ? { autoSelectFamily: true } : {}),
    signal: options.signal ?? undefined,
    ...(options.ca ? { ca: options.ca } : {})
  };
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    const req = request(url, requestOptions, (incoming) => {
      try {
        const { stream, decompressed } = decodedBody(incoming);
        const status = incoming.statusCode ?? 502;
        const bodyless = status === 204 || status === 205 || status === 304;
        const body = bodyless ? null : responseBody(incoming, stream);
        if (bodyless) incoming.resume();
        resolve(new Response(body, {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders(incoming, decompressed)
        }));
      } catch (error) {
        incoming.destroy(error instanceof Error ? error : undefined);
        reject(error);
      }
    });
    req.once("error", reject);
    req.end();
  });
};
