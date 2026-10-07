import Link from "next/link";
import type { Scenario } from "../../../lib/analysis/scenarios";
import { PROGRESS_VALUES, progressLabel, usageLabel } from "../../../lib/library/labels";
import type { LibraryFilter } from "../../../lib/library/queries";
import { libraryHref } from "../../../lib/library/search-params";
import { format, getDict, type Locale } from "../../../lib/i18n";

const USAGES: Array<"integrate" | "reference"> = ["integrate", "reference"];

export interface ScenarioOption extends Pick<Scenario, "slug" | "labelZh" | "labelEn"> { count: number }

/** How many of the panel's own filters (not search, type or tag) are applied — shown on its summary. */
export function panelFilterCount(filter: LibraryFilter): number {
  return (filter.usage ? 1 : 0) + (filter.discarded ? 1 : 0) + (filter.includeRetired ? 1 : 0) + (filter.deepAnalyzed ? 1 : 0)
    + (filter.progress?.length ?? 0) + (filter.scenarios?.length ?? 0);
}

/**
 * The library's secondary filters, folded behind one "筛选" disclosure (2026-10-08 refresh: the
 * page used to open on ~50 chips). Status toggles, self-build progress and scenarios; what is
 * applied stays visible outside the fold as ActiveFilters chips.
 */
export function LibraryFilters({ filter, locale = "zh", scenarios = [] }: { filter: LibraryFilter; locale?: Locale; scenarios?: ScenarioOption[] }) {
  const dict = getDict(locale).library;
  const applied = panelFilterCount(filter);
  return (
    <details className="filter-panel">
      <summary>{applied > 0 ? format(dict.filtersCount, { count: applied }) : dict.filters}</summary>
      <div className="filter-panel__body">
        <div className="filter-group">
          <p className="filter-group__label">{dict.filterGroupStatus}</p>
          <div className="filter-row">
            {USAGES.map((usage) => {
              const active = filter.usage === usage;
              return (
                <Link
                  key={usage}
                  className="chip"
                  aria-current={active ? "true" : undefined}
                  href={libraryHref(filter, { usage: active ? undefined : usage })}
                >
                  {usageLabel(usage, locale)}
                </Link>
              );
            })}
            <Link
              className="chip"
              aria-current={filter.discarded ? "true" : undefined}
              href={libraryHref(filter, { discarded: filter.discarded ? undefined : true })}
            >
              {dict.discarded}
            </Link>
            <Link
              className="chip"
              aria-current={filter.includeRetired ? "true" : undefined}
              href={libraryHref(filter, { includeRetired: filter.includeRetired ? undefined : true })}
            >
              {dict.includeRetired}
            </Link>
            <Link
              className="chip"
              aria-current={filter.deepAnalyzed ? "true" : undefined}
              href={libraryHref(filter, { deepAnalyzed: filter.deepAnalyzed ? undefined : true })}
            >
              {dict.deepAnalyzed}
            </Link>
          </div>
        </div>
        {/* Shown regardless of the usage filter above: listLibrary's SQL pins usage='reference'
            whenever a progress filter is set, so these chips can never surface integrate cards —
            don't "fix" this by gating the chips on usage=reference instead. */}
        <div className="filter-group">
          <p className="filter-group__label">{dict.filterGroupProgress}</p>
          <div className="filter-row">
            {PROGRESS_VALUES.map((progress) => {
              const active = filter.progress?.includes(progress) ?? false;
              const next = active
                ? (filter.progress ?? []).filter((p) => p !== progress)
                : [...(filter.progress ?? []), progress];
              return (
                <Link
                  key={progress}
                  className="chip"
                  aria-current={active ? "true" : undefined}
                  href={libraryHref(filter, { progress: next.length > 0 ? next : undefined })}
                >
                  {progressLabel(progress, locale)}
                </Link>
              );
            })}
          </div>
        </div>
        {scenarios.length > 0 && (
          <div className="filter-group">
            <p className="filter-group__label">{dict.filterGroupScenario}</p>
            <div className="filter-row">
              {scenarios.map((s) => {
                const active = filter.scenarios?.includes(s.slug) ?? false;
                const next = active
                  ? (filter.scenarios ?? []).filter((v) => v !== s.slug)
                  : [...(filter.scenarios ?? []), s.slug];
                return (
                  <Link
                    key={s.slug}
                    className="chip chip--scenario"
                    aria-current={active ? "true" : undefined}
                    href={libraryHref(filter, { scenarios: next.length > 0 ? next : undefined })}
                  >
                    {locale === "en" ? s.labelEn : s.labelZh} <span className="chip__count">{s.count}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
