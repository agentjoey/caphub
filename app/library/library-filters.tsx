import Link from "next/link";
import { PROGRESS_VALUES, progressLabel, usageLabel } from "../../lib/library/labels";
import type { LibraryFilter } from "../../lib/library/queries";
import { libraryHref } from "../../lib/library/search-params";
import { getDict, type Locale } from "../../lib/i18n";

const USAGES: Array<"integrate" | "reference"> = ["integrate", "reference"];

export function LibraryFilters({ filter, locale = "zh" }: { filter: LibraryFilter; locale?: Locale }) {
  const dict = getDict(locale).library;
  return (
    <div>
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
      </div>
      {/* Shown regardless of the usage filter above: listLibrary's SQL pins usage='reference'
          whenever a progress filter is set, so these chips can never surface integrate cards —
          don't "fix" this by gating the chips on usage=reference instead. */}
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
  );
}
