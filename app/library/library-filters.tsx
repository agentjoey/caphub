import Link from "next/link";
import { usageLabel } from "../../lib/library/labels";
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
      </div>
    </div>
  );
}
