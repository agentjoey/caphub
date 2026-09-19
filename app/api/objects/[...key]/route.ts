import { handleObjectRequest } from "../../../../lib/objects/serve";
import { getRuntime } from "../../../../lib/runtime";

export async function GET(_request: Request, context: { params: Promise<{ key: string[] }> }) {
  const { key } = await context.params;
  const { pool, objects } = getRuntime();
  return handleObjectRequest(key.join("/"), { pool, objects });
}
