import Link from "next/link";
import type { CapabilityType } from "../../lib/analysis/card";
import type { Scenario } from "../../lib/analysis/scenarios";
import { typeLabel } from "../../lib/library/labels";
import type { LibraryFilter } from "../../lib/library/queries";
import { libraryHref } from "../../lib/library/search-params";
import { type Locale } from "../../lib/i18n";

const TYPES: CapabilityType[] = ["skill", "experience", "plugin", "prompt", "tool", "model", "other"];
/** Top tags shown as chips — smaller than the desktop library's TOP_TAGS(30): a mobile row that
 * scrolls sideways still needs a bound, and the owner mostly narrows by type/scenario first. */
const TOP_TAGS = 15;
const MINI = "/mini";

/**
 * The library list's three filter facets (type, scenario, tag), each its own horizontally
 * scrolling chip row (`app/mini/mini.css`). Every chip is a plain `Link` built from the same
 * `libraryHref` the desktop `/library` page uses, just rooted at `/mini` instead of `/library` —
 * no second filter-toggle implementation.
 */
export function MiniFilters({
  filter,
  locale = "zh",
  byType,
  scenarios,
  scenarioCountBySlug,
  tags
}: {
  filter: LibraryFilter;
  locale?: Locale;
  byType: Record<CapabilityType, number>;
  scenarios: Scenario[];
  scenarioCountBySlug: Map<string, number>;
  tags: Array<{ name: string; count: number }>;
}) {
  const visibleTypes = TYPES.filter((type) => (byType[type] ?? 0) > 0 || (filter.types?.includes(type) ?? false));
  const visibleScenarios = scenarios.filter((s) => (scenarioCountBySlug.get(s.slug) ?? 0) > 0 || (filter.scenarios?.includes(s.slug) ?? false));
  const topTags = tags.slice(0, TOP_TAGS);

  return (
    <div className="mini-filters">
      {visibleTypes.length > 0 && (
        <div className="filter-row mini-filter-row">
          {visibleTypes.map((type) => {
            const active = filter.types?.includes(type) ?? false;
            const nextTypes = active
              ? (filter.types ?? []).filter((t) => t !== type)
              : [...(filter.types ?? []), type];
            return (
              <Link
                key={type}
                className="chip"
                aria-current={active ? "true" : undefined}
                href={libraryHref(filter, { types: nextTypes.length > 0 ? nextTypes : undefined }, MINI)}
              >
                {typeLabel(type, locale)} <span className="chip__count">{byType[type] ?? 0}</span>
              </Link>
            );
          })}
        </div>
      )}
      {visibleScenarios.length > 0 && (
        <div className="filter-row mini-filter-row">
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
                href={libraryHref(filter, { scenarios: nextScenarios.length > 0 ? nextScenarios : undefined }, MINI)}
              >
                {locale === "en" ? s.labelEn : s.labelZh} <span className="chip__count">{scenarioCountBySlug.get(s.slug) ?? 0}</span>
              </Link>
            );
          })}
        </div>
      )}
      {topTags.length > 0 && (
        <div className="filter-row mini-filter-row">
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
                href={libraryHref(filter, { tags: nextTags.length > 0 ? nextTags : undefined }, MINI)}
              >
                {tag.name} <span className="chip__count">{tag.count}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
