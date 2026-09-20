import { capabilityTypeSchema, isValidTag, SCENARIO_SLUG_PATTERN, type CapabilityType } from "../analysis/card";
import { isProgress, type Progress } from "./labels";
import type { LibraryFilter } from "./queries";

type RawParams = Record<string, string | string[] | undefined>;

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Parses raw (Next.js) search params into a validated LibraryFilter, dropping any invalid values. */
export function parseLibraryParams(sp: RawParams): LibraryFilter {
  const qRaw = first(sp.q)?.trim();
  const types = toArray(sp.type).filter((t): t is CapabilityType => capabilityTypeSchema.safeParse(t).success);
  const tags = toArray(sp.tag).filter(isValidTag);
  const scenarios = toArray(sp.scenario).filter((s) => SCENARIO_SLUG_PATTERN.test(s));
  const progress = toArray(sp.progress).filter((p): p is Progress => isProgress(p));
  const usageRaw = first(sp.usage);
  const usage = usageRaw === "integrate" || usageRaw === "reference" ? usageRaw : undefined;
  const discarded = first(sp.discarded) === "1" ? true : undefined;
  const includeRetired = first(sp.includeRetired) === "1" ? true : undefined;
  const pageNum = Number(first(sp.page));
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? Math.floor(pageNum) : 1;

  return {
    q: qRaw && qRaw.length > 0 ? qRaw : undefined,
    types: types.length > 0 ? types : undefined,
    tags: tags.length > 0 ? tags : undefined,
    scenarios: scenarios.length > 0 ? scenarios : undefined,
    usage,
    progress: progress.length > 0 ? progress : undefined,
    discarded,
    includeRetired,
    page
  };
}

/**
 * Builds an /library href from a base filter with a patch applied. Changing any field
 * other than `page` itself resets pagination back to page 1 (omitted from the URL),
 * since a new filter combination invalidates the previous page offset.
 */
export function libraryHref(filter: LibraryFilter, patch: Partial<LibraryFilter>): string {
  const merged: LibraryFilter = { ...filter, ...patch };
  const changesOtherFields = Object.keys(patch).some((k) => k !== "page");
  if (changesOtherFields && !("page" in patch)) merged.page = 1;

  const params = new URLSearchParams();
  if (merged.q) params.set("q", merged.q);
  for (const type of merged.types ?? []) params.append("type", type);
  for (const tag of merged.tags ?? []) params.append("tag", tag);
  for (const scenario of merged.scenarios ?? []) params.append("scenario", scenario);
  if (merged.usage) params.set("usage", merged.usage);
  for (const progress of merged.progress ?? []) params.append("progress", progress);
  if (merged.discarded) params.set("discarded", "1");
  if (merged.includeRetired) params.set("includeRetired", "1");
  if (merged.page && merged.page > 1) params.set("page", String(merged.page));

  const qs = params.toString();
  return qs ? `/library?${qs}` : "/library";
}
