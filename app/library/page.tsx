import Link from "next/link";
import type { CapabilityType } from "../../lib/analysis/card";
import { loadScenarios } from "../../lib/analysis/scenarios";
import { CapturePreview } from "../../components/capability/capture-preview";
import { TagList } from "../../components/capability/tag-list";
import { relativeTime } from "../../lib/library/format";
import { TYPE_LABEL, USAGE_LABEL } from "../../lib/library/labels";
import { embedSearchQuery } from "../../lib/library/query-embedding";
import { allTags, libraryStats, listLibrary, scenarioStats, PAGE_SIZE } from "../../lib/library/queries";
import { matchScenarios } from "../../lib/library/scenario-match";
import { formatSerial, parseSerialQuery } from "../../lib/library/serial";
import { libraryHref, parseLibraryParams } from "../../lib/library/search-params";
import { getRuntime } from "../../lib/runtime";
import { LibraryFilters } from "./library-filters";

export const dynamic = "force-dynamic";

const TOP_TAGS = 30;
const TYPES: CapabilityType[] = ["skill", "experience", "plugin", "prompt", "other"];

export default async function Page({
  searchParams
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const filter = parseLibraryParams(params);
  const { pool, config } = getRuntime();

  const q = filter.q;
  const isSerialQuery = Boolean(q && parseSerialQuery(q) !== null);
  const scenarios = await loadScenarios(pool);
  const matchedScenarioSlugs = q && !isSerialQuery ? matchScenarios(q, scenarios) : [];
  const queryEmbedding = q && !isSerialQuery ? await embedSearchQuery(config.providers.geminiApiKey, q) : null;

  const [stats, scenarioCounts, tags, { items, total }] = await Promise.all([
    libraryStats(pool),
    scenarioStats(pool, { discarded: filter.discarded }),
    allTags(pool),
    listLibrary(pool, filter, { queryEmbedding, matchedScenarioSlugs })
  ]);
  const topTags = tags.slice(0, TOP_TAGS);
  const hasFilters = Boolean(filter.q || filter.types?.length || filter.tags?.length || filter.scenarios?.length || filter.usage || filter.discarded);
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
    ...(filter.discarded ? [{ name: "discarded", value: "1" }] : [])
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">能力库</h1>
          <p className="page-subtitle">共 {stats.total} 个能力</p>
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
              <div className="stat__label">{TYPE_LABEL[type]}</div>
              <div className="stat__value">{stats.byType[type]}</div>
            </Link>
          );
        })}
        <div className="stat">
          <div className="stat__label">标签</div>
          <div className="stat__value">{stats.tagCount}</div>
        </div>
        <Link className="stat stat--accent" href="/review">
          <div className="stat__label">待 Review</div>
          <div className="stat__value">{stats.pending}</div>
        </Link>
      </div>
      <form className="search-form" action="/library" method="get">
        <input type="search" name="q" defaultValue={filter.q ?? ""} placeholder="搜索能力…" aria-label="搜索能力" />
        {hiddenFields.map((field, index) => (
          <input key={`${field.name}-${field.value}-${index}`} type="hidden" name={field.name} value={field.value} />
        ))}
        <button type="submit" className="btn">搜索</button>
      </form>
      <LibraryFilters filter={filter} />
      {visibleScenarios.length > 0 && (
        <div className="filter-row">
          {visibleScenarios.map((s) => {
            const active = filter.scenarios?.includes(s.slug) ?? false;
            const nextScenarios = active
              ? (filter.scenarios ?? []).filter((v) => v !== s.slug)
              : [...(filter.scenarios ?? []), s.slug];
            return (
              <Link
                key={s.slug}
                className="chip"
                aria-current={active ? "true" : undefined}
                href={libraryHref(filter, { scenarios: nextScenarios.length > 0 ? nextScenarios : undefined })}
              >
                {s.labelZh} ({scenarioCountBySlug.get(s.slug) ?? 0})
              </Link>
            );
          })}
        </div>
      )}
      {topTags.length > 0 && (
        <div className="filter-row">
          {topTags.map((tag) => {
            const active = filter.tags?.includes(tag.name) ?? false;
            const nextTags = active
              ? (filter.tags ?? []).filter((t) => t !== tag.name)
              : [...(filter.tags ?? []), tag.name];
            return (
              <Link
                key={tag.name}
                className="chip"
                aria-current={active ? "true" : undefined}
                href={libraryHref(filter, { tags: nextTags.length > 0 ? nextTags : undefined })}
              >
                {tag.name} ({tag.count})
              </Link>
            );
          })}
        </div>
      )}
      {items.length === 0 ? (
        <p className="empty">
          {hasFilters ? (
            <>没有符合条件的能力。<Link href="/library">清除筛选</Link></>
          ) : (
            "库里还没有保留的能力。"
          )}
        </p>
      ) : (
        <>
          <ul className="list">
            {items.map((row) => (
              <li key={row.id}>
                <Link className="list-row" href={`/library/${row.id}`}>
                  <CapturePreview capture={row.capture} size="thumb" />
                  <div>
                    <div className="list-row__title">
                      {row.title}
                      {formatSerial(row.type, row.serial) && (
                        <span className="serial"> {formatSerial(row.type, row.serial)}</span>
                      )}
                    </div>
                    <div className="list-row__meta">
                      <span className="badge badge--type">{TYPE_LABEL[row.type]}</span>
                      <span className="badge badge--usage">{USAGE_LABEL[row.usage]}</span>
                      <span>{relativeTime(row.createdAt)}</span>
                    </div>
                    <TagList tags={row.tags} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {(hasPrev || hasNext) && (
            <nav className="pagination">
              {hasPrev && <Link href={libraryHref(filter, { page: filter.page - 1 })}>上一页</Link>}
              {hasNext && <Link href={libraryHref(filter, { page: filter.page + 1 })}>下一页</Link>}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
