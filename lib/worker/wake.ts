import { createServer, type Server } from "node:http";

/**
 * Waking the worker (2026-10-12, Neon compute-hours fix). The worker no longer polls the database
 * while idle — a query every 2 s kept the Neon compute awake 24/7 (80 CU-hrs in 11 days against a
 * 100/month free quota). Instead it sleeps until something wakes it:
 *
 * - the web app, after any write that can create worker work (a capture, a rerun, a deep
 *   analysis or re-review request, an edit that needs re-embedding), POSTs to the worker's wake
 *   endpoint over Railway's private network;
 * - inside the worker itself (the Telegram loop), the same `wakeWorker()` call goes to an
 *   in-process hook instead.
 *
 * A wake is only a hint "there may be work": losing one costs latency, never correctness — the
 * worker also wakes on its own every few hours and on every start.
 */

export const DEFAULT_WAKE_PORT = 8787;

let localHook: (() => void) | null = null;

/** Registered by the worker process so its own code (the Telegram loop) wakes it without HTTP. */
export function setLocalWakeHook(hook: (() => void) | null): void {
  localHook = hook;
}

/**
 * The worker's wake endpoint as seen from the web process: `WORKER_WAKE_URL` if set; otherwise,
 * on Railway (which injects `RAILWAY_PROJECT_ID` into every service), the worker service's private
 * address; otherwise (local dev, tests) none.
 */
export function wakeUrl(env: Readonly<Record<string, string | undefined>>): string | null {
  const explicit = env.WORKER_WAKE_URL?.trim();
  if (explicit) return explicit;
  if (env.RAILWAY_PROJECT_ID) return `http://worker.railway.internal:${DEFAULT_WAKE_PORT}/wake`;
  return null;
}

/** Tells the worker there may be new work. Fire-and-forget: returns at once and never throws. */
export function wakeWorker(
  reason: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch
): void {
  if (localHook) {
    localHook();
    return;
  }
  const url = wakeUrl(env);
  if (!url) return;
  fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(2_000) })
    .then((response) => {
      if (!response.ok) console.log(JSON.stringify({ event: "worker_wake_failed", reason, status: response.status }));
    })
    .catch((error: unknown) => {
      console.log(JSON.stringify({ event: "worker_wake_failed", reason, error: error instanceof Error ? error.message : String(error) }));
    });
}

/**
 * A wake-up latch for the worker's main loop. `wait()` resolves on `wake()`, on timeout, or on
 * abort; a `wake()` that lands while nobody is waiting is remembered (once) so the next `wait()`
 * returns immediately — a wake during a busy cycle is never lost.
 */
export class Waker {
  private pending = false;
  private release: ((value: "woken") => void) | null = null;

  wake(): void {
    if (this.release) {
      const release = this.release;
      this.release = null;
      release("woken");
    } else {
      this.pending = true;
    }
  }

  wait(ms: number, signal: AbortSignal): Promise<"woken" | "timeout" | "aborted"> {
    if (signal.aborted) return Promise.resolve("aborted");
    if (this.pending) {
      this.pending = false;
      return Promise.resolve("woken");
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish("timeout"), ms);
      const onAbort = () => finish("aborted");
      const finish = (result: "woken" | "timeout" | "aborted") => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.release = null;
        resolve(result);
      };
      this.release = finish;
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * The worker's wake endpoint: `POST /wake` → `onWake()`, 204; anything else 404. No secret: it is
 * bound for Railway's private network only (the worker has no public domain), and a wake is
 * harmless — at worst one extra empty poll.
 */
export function startWakeServer(opts: { port: number; host?: string; onWake: () => void }): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/wake") {
      opts.onWake();
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // "::" accepts IPv6 (Railway private networking) and, on dual-stack hosts, IPv4 as well.
    server.listen(opts.port, opts.host ?? "::", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
