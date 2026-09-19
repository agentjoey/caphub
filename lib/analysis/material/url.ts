export const MAX_URL_BODY_BYTES = 20_480;
export const URL_TIMEOUT_MS = 15_000;

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchUrlText(url: string, fetchFn: typeof fetch = globalThis.fetch): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
        "user-agent": "caphub/2 (+https://caphub.agentjoey.ai)"
      }
    });
    if (!response.ok) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_URL_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => {});
    const raw = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_URL_BODY_BYTES));
    const type = response.headers.get("content-type") ?? "";
    return type.includes("html") ? stripHtml(raw) : raw.replace(/\s+/g, " ").trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
