import Link from "next/link";
import type { CapabilityType } from "../../lib/analysis/card";
import { TYPE_LABEL, USAGE_LABEL } from "../../lib/library/labels";
import type { LibraryFilter } from "../../lib/library/queries";
import { libraryHref } from "../../lib/library/search-params";

const TYPES: CapabilityType[] = ["skill", "experience", "plugin", "prompt", "other"];
const USAGES: Array<"integrate" | "reference"> = ["integrate", "reference"];

export function LibraryFilters({ filter }: { filter: LibraryFilter }) {
  return (
    <div>
      <div className="filter-row">
        {TYPES.map((type) => {
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
              {TYPE_LABEL[type]}
            </Link>
          );
        })}
      </div>
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
