import Link from "next/link";
import type { CapabilityType } from "../../lib/analysis/card";
import { loadScenarios } from "../../lib/analysis/scenarios";
import { CapturePreview } from "../../components/capability/capture-preview";
import { ScoreBadge } from "../../components/capability/score-badge";
import { TagList } from "../../components/capability/tag-list";
import { relativeTime } from "../../lib/library/format";
import { progressLabel, typeLabel, usageLabel } from "../../lib/library/labels";
import { embedSearchQuery } from "../../lib/library/query-embedding";
import { allTags, libraryStats, listLibrary, scenarioStats, TO_BUILD_PROGRESS, PAGE_SIZE } from "../../lib/library/queries";
import { matchScenarios } from "../../lib/library/scenario-match";
import { displaySerial, parseSerialQuery } from "../../lib/library/serial";
import { libraryHref, parseLibraryParams } from "../../lib/library/search-params";
import { getRuntime } from "../../lib/runtime";
import { getLocale } from "../../lib/i18n/locale";
import { format, getDict } from "../../lib/i18n";
import { LibraryFilters } from "./library-filters";

export const dynamic = "force-dynamic";

const TOP_TAGS = 30;
/** Tags shown on a library list row before the `+N` remainder (M3.8 design decision 4) — few enough that the score/progress badges above them stay the row's loudest marks. */
const LIST_ROW_TAGS = 3;
const TYPES: CapabilityType[] = ["skill", "experience", "plugin", "prompt", "tool", "model", "other"];

export default async function Page({
  searchParams
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const filter = parseLibraryParams(params);
  const { pool, config } = getRuntime();
  const locale = await getLocale();
  const dict = getDict(locale);

  const q = filter.q;
  const isSerialQuery = Boolean(q && parseSerialQuery(q) !== null);
  const scenarios = await loadScenarios(pool);
  const matchedScenarioSlugs = q && !isSerialQuery ? matchScenarios(q, scenarios) : [];
  // Kicked off alongside stats/tags/scenario counts below (it's a ~15s-timeout network call to
  // the embedding provider, not a local DB query) rather than awaited up front; only listLibrary
  // actually needs the resolved value.
  const queryEmbeddingPromise = q && !isSerialQuery ? embedSearchQuery(config.providers.geminiApiKey, q) : Promise.resolve(null);

  const [stats, scenarioCounts, tags, queryEmbedding] = await Promise.all([
    libraryStats(pool),
    scenarioStats(pool, { discarded: filter.discarded }),
    allTags(pool),
    queryEmbeddingPromise
  ]);
  const { items, total } = await listLibrary(pool, filter, { queryEmbedding, matchedScenarioSlugs });
  const topTags = tags.slice(0, TOP_TAGS);
  const hasFilters = Boolean(filter.q || filter.types?.length || filter.tags?.length || filter.scenarios?.length || filter.usage || filter.progress?.length || filter.discarded || filter.includeRetired || filter.deepAnalyzed);
  const hasPrev = filter.page > 1;
  const hasNext = filter.page * PAGE_SIZE < total;

  const scenarioCountBySlug = new Map(scenarioCounts.map((s) => [s.slug, s.count]));
  const visibleScenarios = scenarios.filter((s) => {
    const count = scenarioCountBySlug.get(s.slug) ?? 0;
    const selected = filter.scenarios?.includes(s.slug) ?? false;
    return count > 0 || selected;
  });

  const hiddenFields: Array<{ name: string; value: string }> = [
    ...(filter.types ?? []).map((value) => ({ name: "type", value })),
    ...(filter.tags ?? []).map((value) => ({ name: "tag", value })),
    ...(filter.scenarios ?? []).map((value) => ({ name: "scenario", value })),
    ...(filter.usage ? [{ name: "usage", value: filter.usage }] : []),
    ...(filter.progress ?? []).map((value) => ({ name: "progress", value })),
    ...(filter.discarded ? [{ name: "discarded", value: "1" }] : []),
    ...(filter.includeRetired ? [{ name: "includeRetired", value: "1" }] : []),
    ...(filter.deepAnalyzed ? [{ name: "deep", value: "1" }] : [])
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{dict.library.title}</h1>
          <p className="page-subtitle">{format(dict.library.subtitle, { count: stats.total })}</p>
        </div>
      </div>
      <div className="stat-bar">
        {TYPES.map((type) => {
          const active = filter.types?.includes(type) ?? false;
          const nextTypes = active
            ? (filter.types ?? []).filter((t) => t !== type)
            : [...(filter.types ?? []), type];
          return (
            <Link
              key={type}
              className="stat"
              aria-current={active ? "true" : undefined}
              href={libraryHref(filter, { types: nextTypes.length > 0 ? nextTypes : undefined })}
            >
              <div className="stat__label">{typeLabel(type, locale)}</div>
              <div className="stat__value">{stats.byType[type]}</div>
            </Link>
          );
        })}
        <div className="stat">
          <div className="stat__label">{dict.library.tagsStat}</div>
          <div className="stat__value">{stats.tagCount}</div>
        </div>
        <Link className="stat stat--accent" href="/review">
          <div className="stat__label">{dict.library.pendingStat}</div>
          <div className="stat__value">{stats.pending}</div>
        </Link>
        {(() => {
          const toBuildActive = filter.usage === "reference" &&
            TO_BUILD_PROGRESS.every((p) => filter.progress?.includes(p)) &&
            filter.progress?.length === TO_BUILD_PROGRESS.length;
          return (
            <Link
              className="stat"
              aria-current={toBuildActive ? "true" : undefined}
              href={libraryHref(filter, toBuildActive
                ? { usage: undefined, progress: undefined }
                : { usage: "reference", progress: [...TO_BUILD_PROGRESS] })}
            >
              <div className="stat__label">{dict.library.toBuildStat}</div>
              <div className="stat__value">{stats.toBuild}</div>
            </Link>
          );
        })()}
      </div>
      <form className="search-form" action="/library" method="get">
        <input type="search" name="q" defaultValue={filter.q ?? ""} placeholder={dict.library.searchPlaceholder} aria-label={dict.library.searchAria} />
        {hiddenFields.map((field, index) => (
          <input key={`${field.name}-${field.value}-${index}`} type="hidden" name={field.name} value={field.value} />
        ))}
        <button type="submit" className="btn">{dict.library.searchButton}</button>
      </form>
      <LibraryFilters filter={filter} locale={locale} />
      {visibleScenarios.length > 0 && (
        <div className="filter-row scenario-row">
          {visibleScenarios.map((s) => {
            const active = filter.scenarios?.includes(s.slug) ?? false;
            const nextScenarios = active
              ? (filter.scenarios ?? []).filter((v) => v !== s.slug)
              : [...(filter.scenarios ?? []), s.slug];
            return (
              <Link
                key={s.slug}
                className="chip chip--scenario"
                aria-current={active ? "true" : undefined}
                href={libraryHref(filter, { scenarios: nextScenarios.length > 0 ? nextScenarios : undefined })}
              >
                {locale === "en" ? s.labelEn : s.labelZh} <span className="chip__count">{scenarioCountBySlug.get(s.slug) ?? 0}</span>
              </Link>
            );
          })}
        </div>
      )}
      {topTags.length > 0 && (
        <div className="filter-row tag-row">
          {topTags.map((tag) => {
            const active = filter.tags?.includes(tag.name) ?? false;
            const nextTags = active
              ? (filter.tags ?? []).filter((t) => t !== tag.name)
              : [...(filter.tags ?? []), tag.name];
            return (
              <Link
                key={tag.name}
                className="chip chip--tag"
                aria-current={active ? "true" : undefined}
                href={libraryHref(filter, { tags: nextTags.length > 0 ? nextTags : undefined })}
              >
                {tag.name} <span className="chip__count">{tag.count}</span>
              </Link>
            );
          })}
        </div>
      )}
      {items.length === 0 ? (
        <p className="empty">
          {hasFilters ? (
            <>{dict.library.emptyWithFilters}<Link href="/library">{dict.library.clearFilters}</Link></>
          ) : (
            dict.library.emptyNoFilters
          )}
        </p>
      ) : (
        <>
          <ul className="list">
            {items.map((row) => (
              <li key={row.id}>
                <Link className={`list-row${row.status !== "active" ? " list-row--muted" : ""}`} href={`/library/${row.id}`}>
                  <CapturePreview capture={row.capture} size="thumb" locale={locale} />
                  <div>
                    <div className="list-row__title">
                      {row.title}
                      {displaySerial(row.verdict, row.type, row.serial) && (
                        <span className="serial"> {displaySerial(row.verdict, row.type, row.serial)}</span>
                      )}
                    </div>
                    <div className="list-row__meta">
                      <span className="badge badge--type">{typeLabel(row.type, locale)}</span>
                      <span className="badge badge--usage">{usageLabel(row.usage, locale)}</span>
                      {row.status === "deprecated" && (
                        <span className="badge badge--status-deprecated">{dict.statusBadge.deprecated}</span>
                      )}
                      {row.status === "superseded" && (
                        <span className="badge badge--status-superseded">{dict.statusBadge.supersededGeneric}</span>
                      )}
                      <ScoreBadge score={row.score} reason={row.scoreReason} locale={locale} />
                      {row.hasDeepAnalysis && (
                        <span className="badge badge--deep" title={dict.deepAnalysis.badgeAria}>{dict.deepAnalysis.badge}</span>
                      )}
                      {row.usage === "reference" && (
                        <span className={`badge badge--progress${row.progress === "done" ? " badge--progress-done" : ""}`}>
                          {progressLabel(row.progress, locale)}
                        </span>
                      )}
                      <span>{relativeTime(row.createdAt, locale)}</span>
                    </div>
                    <TagList tags={row.tags} max={LIST_ROW_TAGS} quiet />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {(hasPrev || hasNext) && (
            <nav className="pagination">
              {hasPrev && <Link className="pagination__prev" href={libraryHref(filter, { page: filter.page - 1 })}>{dict.library.prevPage}</Link>}
              {hasNext && <Link className="pagination__next" href={libraryHref(filter, { page: filter.page + 1 })}>{dict.library.nextPage}</Link>}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
