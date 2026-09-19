import { listRecentCaptures } from "../lib/captures/captures";
import { getRuntime } from "../lib/runtime";
import { CaptureForm } from "./capture-form";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { queued: "排队中", running: "分析中", done: "已建卡", failed: "失败" };

export default async function Page() {
  const items = await listRecentCaptures(getRuntime().pool);
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1>投递</h1>
      <CaptureForm />
      <h2>最近 20 条</h2>
      <ul>
        {items.map((c) => (
          <li key={c.id}>
            <code>{c.id}</code> · {c.kind} · {c.runState ? LABEL[c.runState] : "—"}
            {c.errorCode ? ` (${c.errorCode})` : ""}
            {c.capabilityId ? ` → ${c.capabilityId}` : ""}
          </li>
        ))}
      </ul>
    </main>
  );
}
