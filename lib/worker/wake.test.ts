import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Waker, setLocalWakeHook, startWakeServer, wakeUrl, wakeWorker } from "./wake";

afterEach(() => setLocalWakeHook(null));

describe("Waker", () => {
  it("times out when nobody wakes it", async () => {
    vi.useFakeTimers();
    try {
      const waker = new Waker();
      const result = waker.wait(1000, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns as soon as it is woken", async () => {
    const waker = new Waker();
    const result = waker.wait(60_000, new AbortController().signal);
    waker.wake();
    expect(await result).toBe("woken");
  });

  it("remembers a wake that arrived while nobody was waiting, exactly once", async () => {
    const waker = new Waker();
    waker.wake();
    waker.wake();
    expect(await waker.wait(60_000, new AbortController().signal)).toBe("woken");
    vi.useFakeTimers();
    try {
      const second = waker.wait(10, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(10);
      expect(await second).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting on abort (shutdown)", async () => {
    const waker = new Waker();
    const controller = new AbortController();
    const result = waker.wait(60_000, controller.signal);
    controller.abort();
    expect(await result).toBe("aborted");
  });
});

describe("wakeUrl", () => {
  it("prefers an explicit WORKER_WAKE_URL", () => {
    expect(wakeUrl({ WORKER_WAKE_URL: "http://example.internal:1/wake", RAILWAY_PROJECT_ID: "p" })).toBe("http://example.internal:1/wake");
  });

  it("defaults to the worker's Railway private address when running on Railway", () => {
    expect(wakeUrl({ RAILWAY_PROJECT_ID: "p" })).toBe("http://worker.railway.internal:8787/wake");
  });

  it("is off elsewhere (local dev, tests)", () => {
    expect(wakeUrl({})).toBeNull();
  });
});

describe("wakeWorker", () => {
  it("calls the in-process hook inside the worker, without any network call", () => {
    const hook = vi.fn();
    const fetchImpl = vi.fn();
    setLocalWakeHook(hook);
    wakeWorker("telegram", { WORKER_WAKE_URL: "http://x/wake" }, fetchImpl as never);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs to the wake URL from the web process and never throws when that fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => wakeWorker("capture", { WORKER_WAKE_URL: "http://x/wake" }, fetchImpl as never)).not.toThrow();
      await vi.waitFor(() => expect(log).toHaveBeenCalled());
      expect(fetchImpl).toHaveBeenCalledWith("http://x/wake", expect.objectContaining({ method: "POST" }));
      expect(String(log.mock.calls[0][0])).toContain("worker_wake_failed");
    } finally {
      log.mockRestore();
    }
  });

  it("does nothing when there is no hook and no URL", () => {
    const fetchImpl = vi.fn();
    wakeWorker("capture", {}, fetchImpl as never);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("startWakeServer", () => {
  it("wakes on POST /wake and answers anything else with 404", async () => {
    const onWake = vi.fn();
    const server = await startWakeServer({ port: 0, host: "127.0.0.1", onWake });
    try {
      const { port } = server.address() as AddressInfo;
      const ok = await fetch(`http://127.0.0.1:${port}/wake`, { method: "POST" });
      expect(ok.status).toBe(204);
      expect(onWake).toHaveBeenCalledTimes(1);
      const get = await fetch(`http://127.0.0.1:${port}/wake`);
      expect(get.status).toBe(404);
      const other = await fetch(`http://127.0.0.1:${port}/nope`, { method: "POST" });
      expect(other.status).toBe(404);
      expect(onWake).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reports a port already in use instead of crashing the worker", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      await expect(startWakeServer({ port, host: "127.0.0.1", onWake: () => {} })).rejects.toThrow();
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
