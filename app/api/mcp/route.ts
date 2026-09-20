import { handleMcpRequest } from "../../../lib/mcp/rpc";
import { getRuntime } from "../../../lib/runtime";

// Authentication is handled upstream by proxy.ts's guardRequest, which allowlists this path to
// one Cloudflare Access service token (see lib/auth/guard.ts). Do not re-check identity here.
export async function POST(request: Request): Promise<Response> {
  const { pool, config } = getRuntime();
  return handleMcpRequest({ pool, geminiApiKey: config.providers.geminiApiKey }, request);
}
