import { z } from "zod";
import type { StructuredInput } from "../analysis/structured";

export function buildStructuredPrompt(input: StructuredInput): string {
  const schema = JSON.stringify(z.toJSONSchema(input.schema));
  const correction = input.correction
    ? `\n\n上一次输出未通过校验，问题：\n${input.correction.issues.map((i) => `- ${i}`).join("\n")}\n请修正后重新输出。`
    : "";
  return `${input.prompt}\n\n只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。JSON Schema：\n${schema}${correction}`;
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // Tolerate a single leading/trailing prose line wrapped around one JSON object:
    // extract from the first "{" to the matching last "}" before giving up.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through to the original error below
      }
    }
    throw error;
  }
}
