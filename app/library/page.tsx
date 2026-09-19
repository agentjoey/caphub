import Link from "next/link";
import { CapturePreview } from "../../components/capability/capture-preview";
import { TagList } from "../../components/capability/tag-list";
import { relativeTime } from "../../lib/library/format";
import { TYPE_LABEL, USAGE_LABEL } from "../../lib/library/labels";
import { allTags, libraryStats, listLibrary, PAGE_SIZE } from "../../lib/library/queries";
import { libraryHref, parseLibraryParams } from "../../lib/library/search-params";
import { getRuntime } from "../../lib/runtime";
import { LibraryFilters } from "./library-filters";

export const dynamic = "force-dynamic";

const TOP_TAGS = 30;

export default async function Page({
  searchParams
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const filter = parseLibraryParams(params);
  const { pool } = getRuntime();
  const [stats, tags, { items, total }] = await Promise.all([
    libraryStats(pool),
    allTags(pool),
    listLibrary(pool, filter)
  ]);
  const topTags = tags.slice(0, TOP_TAGS);
  const hasFilters = Boolean(filter.q || filter.types?.length || filter.tags?.length || filter.usage || filter.discarded);
  const hasPrev = filter.page > 1;
  const hasNext = filter.page * PAGE_SIZE < total;

  const hiddenFields: Array<{ name: string; value: string }> = [
    ...(filter.types ?? []).map((value) => ({ name: "type", value })),
    ...(filter.tags ?? []).map((value) => ({ name: "tag", value })),
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
        <div className="stat">
          <div className="stat__label">{TYPE_LABEL.skill}</div>
          <div className="stat__value">{stats.byType.skill}</div>
        </div>
        <div className="stat">
          <div className="stat__label">{TYPE_LABEL.experience}</div>
          <div className="stat__value">{stats.byType.experience}</div>
        </div>
        <div className="stat">
          <div className="stat__label">{TYPE_LABEL.plugin}</div>
          <div className="stat__value">{stats.byType.plugin}</div>
        </div>
        <div className="stat">
          <div className="stat__label">{TYPE_LABEL.prompt}</div>
          <div className="stat__value">{stats.byType.prompt}</div>
        </div>
        <div className="stat">
          <div className="stat__label">{TYPE_LABEL.other}</div>
          <div className="stat__value">{stats.byType.other}</div>
        </div>
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
                    <div className="list-row__title">{row.title}</div>
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
          <nav className="pagination">
            {hasPrev
              ? <Link href={libraryHref(filter, { page: filter.page - 1 })}>上一页</Link>
              : <span aria-disabled="true">上一页</span>}
            {hasNext
              ? <Link href={libraryHref(filter, { page: filter.page + 1 })}>下一页</Link>
              : <span aria-disabled="true">下一页</span>}
          </nav>
        </>
      )}
    </div>
  );
}
