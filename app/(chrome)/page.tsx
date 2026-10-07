import Link from "next/link";
import { listRecentCaptures } from "../../lib/captures/captures";
import { relativeTime } from "../../lib/library/format";
import { libraryStats } from "../../lib/library/queries";
import { getRuntime } from "../../lib/runtime";
import { getLocale } from "../../lib/i18n/locale";
import { format, getDict } from "../../lib/i18n";
import { PipelineWatcher } from "../../components/shell/pipeline-watcher";
import { CaptureForm } from "./capture-form";
import { RecentRow } from "./recent-row";

export const dynamic = "force-dynamic";

export default async function Page() {
  const locale = await getLocale();
  const dict = getDict(locale);
  const { pool } = getRuntime();
  const [items, stats] = await Promise.all([listRecentCaptures(pool), libraryStats(pool)]);
  const inFlight = items.some((item) => item.runState === "queued" || item.runState === "running");
  return (
    <div className="caphub-page">
      <PipelineWatcher active={inFlight} />
      <section className="caphub-intro">
        <div>
          <h1>{dict.home.title}</h1>
          <p>{dict.home.subtitle}</p>
        </div>
        <Link className="caphub-quiet-button" href="/review">{format(dict.home.goReview, { count: stats.pending })}</Link>
      </section>
      <CaptureForm locale={locale} />
      <section className="recent">
        <div className="caphub-section-heading"><h2>{dict.home.recentTitle}</h2><span>{dict.home.recentSub}</span></div>
        {items.length === 0 ? (
          <p className="empty">{dict.home.empty}</p>
        ) : (
          <ul className="list">
            {items.map((item) => (
              <li key={item.id}><RecentRow item={item} relativeTime={relativeTime(item.createdAt, locale)} locale={locale} /></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
