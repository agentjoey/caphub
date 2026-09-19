import Link from "next/link";
import { listRecentCaptures } from "../lib/captures/captures";
import { libraryStats } from "../lib/library/queries";
import { getRuntime } from "../lib/runtime";
import { CaptureForm } from "./capture-form";
import { RecentRow } from "./recent-row";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { pool } = getRuntime();
  const [items, stats] = await Promise.all([listRecentCaptures(pool), libraryStats(pool)]);
  return (
    <div className="caphub-page">
      <section className="caphub-intro">
        <div>
          <h1>投递一个能力。</h1>
          <p>上传截图、文字或链接，跟进分析并决定是否建档。</p>
        </div>
        <Link className="caphub-quiet-button" href="/review">去 Review（{stats.pending}）</Link>
      </section>
      <CaptureForm />
      <section className="recent">
        <div className="caphub-section-heading"><h2>最近投递</h2><span>最近 20 条</span></div>
        {items.length === 0 ? (
          <p className="empty">还没有投递。</p>
        ) : (
          <ul className="list">
            {items.map((item) => (
              <li key={item.id}><RecentRow item={item} /></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
