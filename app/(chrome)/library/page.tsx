import Link from "next/link";
import type { CapabilityType } from "../../../lib/analysis/card";
import { loadScenarios } from "../../../lib/analysis/scenarios";
import { CapabilityCard } from "../../../components/library/capability-card";
import { relativeTime } from "../../../lib/library/format";
import { typeLabel } from "../../../lib/library/labels";
import { embedSearchQuery } from "../../../lib/library/query-embedding";
import { libraryStats, listLibrary, scenarioStats, TO_BUILD_PROGRESS, PAGE_SIZE } from "../../../lib/library/queries";
import { matchScenarios } from "../../../lib/library/scenario-match";
import { parseSerialQuery } from "../../../lib/library/serial";
import { libraryHref, parseLibraryParams } from "../../../lib/library/search-params";
import { getRuntime } from "../../../lib/runtime";
import { getLocale } from "../../../lib/i18n/locale";
import { format, getDict } from "../../../lib/i18n";
import { ActiveFilters } from "./active-filters";
import { LibraryFilters } from "./library-filters";

export const dynamic = "force-dynamic";

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
  // Kicked off alongside stats/scenario counts below (it's a ~15s-timeout network call to the
  // embedding provider, not a local DB query) rather than awaited up front; only listLibrary
  // actually needs the resolved value.
  const queryEmbeddingPromise = q && !isSerialQuery ? embedSearchQuery(config.providers.geminiApiKey, q) : Promise.resolve(null);

  const [stats, scenarioCounts, queryEmbedding] = await Promise.all([
    libraryStats(pool),
    scenarioStats(pool, { discarded: filter.discarded }),
    queryEmbeddingPromise
  ]);
  const { items, total } = await listLibrary(pool, filter, { queryEmbedding, matchedScenarioSlugs });
  const hasFilters = Boolean(filter.q || filter.types?.length || filter.tags?.length || filter.scenarios?.length || filter.usage || filter.progress?.length || filter.discarded || filter.includeRetired || filter.deepAnalyzed);
  const hasPrev = filter.page > 1;
  const hasNext = filter.page * PAGE_SIZE < total;

  const scenarioCountBySlug = new Map(scenarioCounts.map((s) => [s.slug, s.count]));
  const scenarioOptions = scenarios
    .map((s) => ({ ...s, count: scenarioCountBySlug.get(s.slug) ?? 0 }))
    .filter((s) => s.count > 0 || (filter.scenarios?.includes(s.slug) ?? false));
  // Scenarios the search text itself names, offered as one-click narrowing above the results.
  const relatedScenarios = scenarios.filter((s) => matchedScenarioSlugs.includes(s.slug) && !(filter.scenarios?.includes(s.slug) ?? false));

  const toBuildActive = filter.usage === "reference" &&
    TO_BUILD_PROGRESS.every((p) => filter.progress?.includes(p)) &&
    filter.progress?.length === TO_BUILD_PROGRESS.length;

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
        <div className="library-queues">
          {stats.pending > 0 && (
            <Link className="queue-link queue-link--review" href="/review">
              {dict.library.pendingStat}<span className="queue-link__count">{stats.pending}</span>
            </Link>
          )}
          <Link
            className="queue-link"
            aria-current={toBuildActive ? "true" : undefined}
            href={libraryHref(filter, toBuildActive
              ? { usage: undefined, progress: undefined }
              : { usage: "reference", progress: [...TO_BUILD_PROGRESS] })}
          >
            {dict.library.toBuildStat}<span className="queue-link__count">{stats.toBuild}</span>
          </Link>
        </div>
      </div>
      <form className="search-form" action="/library" method="get">
        <input type="search" name="q" defaultValue={filter.q ?? ""} placeholder={dict.library.searchPlaceholder} aria-label={dict.library.searchAria} />
        {hiddenFields.map((field, index) => (
          <input key={`${field.name}-${field.value}-${index}`} type="hidden" name={field.name} value={field.value} />
        ))}
        <button type="submit" className="btn">{dict.library.searchButton}</button>
      </form>
      <div className="library-controls">
        <nav className="type-bar" aria-label={dict.library.typeBarAria}>
          <Link className="chip" aria-current={!filter.types?.length ? "true" : undefined} href={libraryHref(filter, { types: undefined })}>
            {dict.library.allTypes} <span className="chip__count">{stats.total}</span>
          </Link>
          {TYPES.filter((type) => stats.byType[type] > 0 || filter.types?.includes(type)).map((type) => {
            const active = filter.types?.includes(type) ?? false;
            const nextTypes = active
              ? (filter.types ?? []).filter((t) => t !== type)
              : [...(filter.types ?? []), type];
            return (
              <Link
                key={type}
                className="chip"
                aria-current={active ? "true" : undefined}
                href={libraryHref(filter, { types: nextTypes.length > 0 ? nextTypes : undefined })}
              >
                {typeLabel(type, locale)} <span className="chip__count">{stats.byType[type]}</span>
              </Link>
            );
          })}
        </nav>
        <LibraryFilters filter={filter} locale={locale} scenarios={scenarioOptions} />
      </div>
      <ActiveFilters filter={filter} scenarios={scenarios} locale={locale} />
      {relatedScenarios.length > 0 && (
        <div className="related-row">
          <span className="kicker">{dict.library.relatedScenarios}</span>
          {relatedScenarios.map((s) => (
            <Link
              key={s.slug}
              className="chip chip--scenario"
              href={libraryHref(filter, { scenarios: [...(filter.scenarios ?? []), s.slug] })}
            >
              {locale === "en" ? s.labelEn : s.labelZh}
            </Link>
          ))}
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
          {hasFilters && <p className="result-count">{format(dict.library.resultCount, { count: total })}</p>}
          <ul className="cap-grid">
            {items.map((row) => (
              <li key={row.id}>
                <CapabilityCard row={row} locale={locale} relativeTime={relativeTime(row.createdAt, locale)} />
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
