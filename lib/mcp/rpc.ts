import { TOOL_DEFS, type ToolName } from "./schema";
import {
  appendNote,
  getCapability,
  getStats,
  listRecent,
  listToBuild,
  searchCapabilities,
  setBuildProgress,
  type ToolDeps
} from "./tools";

const PROTOCOL_FALLBACK = "2025-06-18";

interface JsonRpcRequestBody {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

const jsonRpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });
const toolResult = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const toolError = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });

type JsonSchemaProperty = {
  type?: string;
  enum?: readonly unknown[];
  items?: JsonSchemaProperty;
};

type ToolInputSchema = {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
};

/**
 * Minimal, hand-rolled JSON Schema check — just enough to keep a wrong-typed argument from an
 * AI client out of the tool functions. Not a general validator: only the shapes our own
 * schema.ts actually uses (string / integer / number / array / enum, required).
 */
function validateArgs(schema: ToolInputSchema, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "arguments must be a JSON object";
  }
  const record = args as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in record) || record[key] === undefined || record[key] === null) {
      return `missing required argument: ${key}`;
    }
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    const err = validateValue(key, prop, value);
    if (err) return err;
  }
  return null;
}

function validateValue(key: string, prop: JsonSchemaProperty, value: unknown): string | null {
  switch (prop.type) {
    case "string":
      if (typeof value !== "string") return `argument ${key} must be a string`;
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `argument ${key} must be an integer`;
      break;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) return `argument ${key} must be a number`;
      break;
    case "array":
      if (!Array.isArray(value)) return `argument ${key} must be an array`;
      break;
    default:
      break;
  }
  if (prop.enum && !prop.enum.includes(value)) {
    return `argument ${key} must be one of: ${prop.enum.join(", ")}`;
  }
  return null;
}

type ToolHandler = (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown> | unknown;

const TOOL_HANDLERS: Record<ToolName, ToolHandler> = {
  search_capabilities: (deps, args) => searchCapabilities(deps, args as never),
  get_capability: (deps, args) => getCapability(deps, args as never),
  list_to_build: (deps, args) => listToBuild(deps, args as never),
  list_recent: (deps, args) => listRecent(deps, args as never),
  get_stats: (deps) => getStats(deps),
  set_build_progress: (deps, args) => setBuildProgress(deps, args as never),
  append_build_note: (deps, args) => appendNote(deps, args as never)
};

function extractSerial(args: unknown): string | undefined {
  if (typeof args === "object" && args !== null && "serial" in args) {
    const serial = (args as Record<string, unknown>).serial;
    return typeof serial === "string" ? serial : undefined;
  }
  return undefined;
}

async function callTool(deps: ToolDeps, params: Record<string, unknown> | undefined) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (typeof name !== "string") return toolError("missing tool name");

  const def = TOOL_DEFS.find((t) => t.name === name);
  const handler = TOOL_HANDLERS[name as ToolName];
  if (!def || !handler) return toolError(`unknown tool: ${String(name)}`);

  const validationError = validateArgs(def.inputSchema as ToolInputSchema, args);
  if (validationError) return toolError(validationError);

  const started = Date.now();
  const serial = extractSerial(args);
  const log = (ok: boolean) => console.log(JSON.stringify({ tool: name, serial, ok, durationMs: Date.now() - started }));

  try {
    const value = await handler(deps, args as Record<string, unknown>);
    const businessError = asBusinessError(value);
    if (businessError) {
      log(false);
      return toolError(businessError);
    }
    log(true);
    return toolResult(value);
  } catch (err) {
    log(false);
    const message = err instanceof Error ? err.message : "tool call failed";
    return toolError(message);
  }
}

/**
 * A tool's own failure never throws — {@link getCapability} returns `null` for an unknown serial,
 * and the two write tools return `{ ok: false, error }`. Both must surface as `isError` content
 * per the task's global constraint, not as a bare successful result.
 */
function asBusinessError(value: unknown): string | null {
  if (value === null) return "未找到该编号";
  if (typeof value === "object" && value !== null && "ok" in value && (value as { ok: unknown }).ok === false) {
    const error = (value as { ok: false; error?: unknown }).error;
    return typeof error === "string" ? error : "tool call failed";
  }
  return null;
}

export async function handleMcpRequest(deps: ToolDeps, request: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, "invalid request");
  }
  const body = parsed as JsonRpcRequestBody;
  const { id, method } = body;

  // Notifications carry no id and never get a JSON-RPC response — answering one is a protocol
  // violation. Real clients send more than notifications/initialized (e.g. notifications/cancelled).
  if (id === undefined && typeof method === "string" && method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize":
      return jsonRpc(id, {
        protocolVersion: typeof body.params?.protocolVersion === "string" ? body.params.protocolVersion : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "caphub", version: "2.0.0" }
      });
    case "ping":
      return jsonRpc(id, {});
    case "tools/list":
      return jsonRpc(id, { tools: TOOL_DEFS });
    case "tools/call":
      return jsonRpc(id, await callTool(deps, body.params));
    default:
      return rpcError(id, -32601, `unknown method: ${String(method)}`);
  }
}
