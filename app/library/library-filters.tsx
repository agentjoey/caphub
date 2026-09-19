import Link from "next/link";
import { USAGE_LABEL } from "../../lib/library/labels";
import type { LibraryFilter } from "../../lib/library/queries";
import { libraryHref } from "../../lib/library/search-params";

const USAGES: Array<"integrate" | "reference"> = ["integrate", "reference"];

export function LibraryFilters({ filter }: { filter: LibraryFilter }) {
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
              {USAGE_LABEL[usage]}
            </Link>
          );
        })}
        <Link
          className="chip"
          aria-current={filter.discarded ? "true" : undefined}
          href={libraryHref(filter, { discarded: filter.discarded ? undefined : true })}
        >
          已丢弃
        </Link>
      </div>
    </div>
  );
}
