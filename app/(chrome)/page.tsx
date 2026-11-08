import { listDeskRunning, listRecentCaptures } from "../../lib/captures/captures";
import { libraryStats, listLatestKept, listPendingForDesk } from "../../lib/library/queries";
import { getRuntime } from "../../lib/runtime";
import { getLocale } from "../../lib/i18n/locale";
import { relativeTime } from "../../lib/library/format";
import { Desk } from "../../components/desk/desk";
import { assembleDeskItems, pileItems } from "../../components/desk/desk-items";
import { RecentRow } from "./recent-row";
export const dynamic = "force-dynamic";
export default async function Page() {
  const locale = await getLocale();
  const { pool } = getRuntime();
  const [running, recent, pending, kept, stats] = await Promise.all([
    listDeskRunning(pool),
    listRecentCaptures(pool),
    listPendingForDesk(pool, 24),
    listLatestKept(pool, 5),
    libraryStats(pool)
  ]);
  // Fetch enough pending rows even when some also occur in running; dedup precedes the cap.
  const assembled = assembleDeskItems(running, recent, pending, Number.MAX_SAFE_INTEGER);
  const pendingRunning = running.filter((r) => r.capabilityId).length;
  const failures = recent.filter(
    (r) => r.runState === "failed" && !r.capabilityId && !running.some((x) => x.id === r.id)
  ).length;
  const captureSources = Object.fromEntries([
    ...recent.map((r) => [r.id, { kind: r.kind, url: r.url }] as const),
    ...pending.map((r) => [r.captureId, { kind: r.capture.kind, url: r.capture.url }] as const)
  ]);
  return (
    <Desk
      captureSources={captureSources}
      items={assembled.slice(0, 24)}
      pile={pileItems(kept)}
      total={stats.pending + running.length - pendingRunning + failures}
      libraryCount={stats.total}
      locale={locale}
      recent={
        <ul key="recent-captures">
          {recent.map((item) => (
            <li key={item.id}>
              <RecentRow item={item} relativeTime={relativeTime(item.createdAt, locale)} locale={locale} />
            </li>
          ))}
        </ul>
      }
    />
  );
}
