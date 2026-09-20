import { describe, expect, it, vi } from "vitest";
import type { ToolDeps } from "./tools";
import { handleMcpRequest } from "./rpc";

const fakePool = (rows: unknown[] = []) => ({ query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) });
const deps: ToolDeps = { pool: fakePool() as never };

const call = (body: unknown) =>
  handleMcpRequest(
    deps,
    new Request("https://x/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  );

describe("handleMcpRequest", () => {
  it("answers initialize with the client's protocol version and a tools capability", async () => {
    const res = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } }
    });
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("caphub");
  });

  it("accepts the initialized notification with 202 and no body", async () => {
    const res = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("lists all seven tools with input schemas", async () => {
    const body = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "append_build_note",
      "get_capability",
      "get_stats",
      "list_recent",
      "list_to_build",
      "search_capabilities",
      "set_build_progress"
    ]);
    for (const tool of body.result.tools) expect(tool.inputSchema.type).toBe("object");
  });

  it("returns -32601 for an unknown method", async () => {
    const body = await (await call({ jsonrpc: "2.0", id: 3, method: "tools/nope" })).json();
    expect(body.error.code).toBe(-32601);
  });

  it("returns a tool error as isError content, not a transport error", async () => {
    const body = await (
      await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_capability", arguments: { serial: "SKL-9999" } } })
    ).json();
    expect(body.result.isError).toBe(true);
    expect(body.error).toBeUndefined();
  });

  it("rejects a malformed body with -32700", async () => {
    const res = await handleMcpRequest(deps, new Request("https://x/api/mcp", { method: "POST", body: "not json" }));
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("rejects a literal null body with a JSON-RPC error instead of throwing", async () => {
    const res = await call(null);
    expect(res.status).not.toBe(500);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it("rejects a primitive body with -32600, not -32601", async () => {
    const body = await (await call(5)).json();
    expect(body.error.code).toBe(-32600);
  });

  it("answers a non-initialized notification (e.g. notifications/cancelled) with 202 and no body", async () => {
    const res = await call({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("returns a tool error, not a transport error, when a required argument is missing", async () => {
    const body = await (
      await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_capabilities", arguments: {} } })
    ).json();
    expect(body.result.isError).toBe(true);
    expect(body.error).toBeUndefined();
  });

  it("returns a tool error for an unknown tool name", async () => {
    const body = await (
      await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "not_a_tool", arguments: {} } })
    ).json();
    expect(body.result.isError).toBe(true);
  });

  it("answers ping with an empty result", async () => {
    const body = await (await call({ jsonrpc: "2.0", id: 7, method: "ping" })).json();
    expect(body.result).toEqual({});
  });

  describe("logging on rejected tool calls", () => {
    it("logs a line, in the same shape as a successful call, for an unknown tool name", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await call({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "not_a_tool", arguments: {} } });
      expect(log).toHaveBeenCalledTimes(1);
      const line = JSON.parse(log.mock.calls[0][0] as string);
      expect(line).toMatchObject({ tool: "not_a_tool", ok: false });
      expect(typeof line.durationMs).toBe("number");
      log.mockRestore();
    });

    it("logs a line for a rejected argument validation failure", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "search_capabilities", arguments: {} } });
      expect(log).toHaveBeenCalledTimes(1);
      const line = JSON.parse(log.mock.calls[0][0] as string);
      expect(line).toMatchObject({ tool: "search_capabilities", ok: false });
      log.mockRestore();
    });

    it("does not log for a successful call yet double-log", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await call({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_stats", arguments: {} } });
      expect(log).toHaveBeenCalledTimes(1);
      const line = JSON.parse(log.mock.calls[0][0] as string);
      expect(line).toMatchObject({ tool: "get_stats", ok: true });
      log.mockRestore();
    });
  });
});
