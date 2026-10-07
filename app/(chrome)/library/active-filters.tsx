import Link from "next/link";
import type { Scenario } from "../../../lib/analysis/scenarios";
import { progressLabel, usageLabel } from "../../../lib/library/labels";
import type { LibraryFilter } from "../../../lib/library/queries";
import { libraryHref } from "../../../lib/library/search-params";
import { format, getDict, type Locale } from "../../../lib/i18n";

/**
 * The filters currently narrowing the library, outside the collapsed filter panel: one removable
 * chip each, so a closed panel never hides why the grid is short. The search text and the type bar
 * show their own state and are left out. Tags appear here only — the tag cloud is gone (owner
 * ruling 2026-10-08), but a `tag=` link still filters.
 */
export function ActiveFilters({ filter, scenarios, locale }: {
  filter: LibraryFilter; scenarios: Pick<Scenario, "slug" | "labelZh" | "labelEn">[]; locale: Locale;
}) {
  const dict = getDict(locale).library;
  const chips: Array<{ key: string; label: string; href: string }> = [];
  for (const tag of filter.tags ?? []) {
    const rest = (filter.tags ?? []).filter((t) => t !== tag);
    chips.push({ key: `tag:${tag}`, label: tag, href: libraryHref(filter, { tags: rest.length ? rest : undefined }) });
  }
  for (const slug of filter.scenarios ?? []) {
    const scenario = scenarios.find((s) => s.slug === slug);
    const rest = (filter.scenarios ?? []).filter((s) => s !== slug);
    const label = scenario ? (locale === "en" ? scenario.labelEn : scenario.labelZh) : slug;
    chips.push({ key: `scenario:${slug}`, label, href: libraryHref(filter, { scenarios: rest.length ? rest : undefined }) });
  }
  if (filter.usage) chips.push({ key: "usage", label: usageLabel(filter.usage, locale), href: libraryHref(filter, { usage: undefined }) });
  for (const progress of filter.progress ?? []) {
    const rest = (filter.progress ?? []).filter((p) => p !== progress);
    chips.push({ key: `progress:${progress}`, label: progressLabel(progress, locale), href: libraryHref(filter, { progress: rest.length ? rest : undefined }) });
  }
  if (filter.discarded) chips.push({ key: "discarded", label: dict.discarded, href: libraryHref(filter, { discarded: undefined }) });
  if (filter.includeRetired) chips.push({ key: "retired", label: dict.includeRetired, href: libraryHref(filter, { includeRetired: undefined }) });
  if (filter.deepAnalyzed) chips.push({ key: "deep", label: dict.deepAnalyzed, href: libraryHref(filter, { deepAnalyzed: undefined }) });
  if (chips.length === 0) return null;

  return (
    <div className="active-filters">
      {chips.map((chip) => (
        <Link key={chip.key} className="chip chip--active" href={chip.href} aria-label={format(dict.removeFilter, { label: chip.label })}>
          {chip.label}<span aria-hidden="true" className="chip__x">×</span>
        </Link>
      ))}
      {chips.length > 1 && <Link className="active-filters__clear" href="/library">{dict.clearAll}</Link>}
    </div>
  );
}
