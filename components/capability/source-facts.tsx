import type { SourceFacts as SourceFactsData } from "../../lib/analysis/card";
import { format, getDict, intlLocale, type Locale } from "../../lib/i18n";

function LinkValue({ url }: { url: string }) {
  return <a href={url} target="_blank" rel="noreferrer">{url}</a>;
}

/**
 * Objective facts about where a capability came from. Every field is optional: a field the
 * analysis never found is skipped, and the whole block disappears when nothing but `as_of`
 * is left — an empty table would read as "we checked and there is nothing", which is wrong.
 */
export function SourceFacts({
  facts,
  locale = "zh"
}: {
  facts: SourceFactsData | null | undefined;
  locale?: Locale;
}) {
  const dict = getDict(locale).detail;
  const f = facts ?? {};
  const rows: Array<{ key: string; label: string; value: React.ReactNode; numeric?: boolean }> = [];
  if (f.repo_url) rows.push({ key: "repo", label: dict.repoUrl, value: <LinkValue url={f.repo_url} /> });
  if (typeof f.stars === "number") {
    rows.push({ key: "stars", label: dict.stars, value: new Intl.NumberFormat(intlLocale(locale)).format(f.stars), numeric: true });
  }
  if (f.last_update) rows.push({ key: "last_update", label: dict.lastUpdate, value: f.last_update, numeric: true });
  if (f.license) rows.push({ key: "license", label: dict.license, value: f.license });
  if (f.homepage) rows.push({ key: "homepage", label: dict.homepage, value: <LinkValue url={f.homepage} /> });
  if (rows.length === 0) return null;

  return (
    <section className="panel source-facts-panel">
      <h2 className="panel-title">{dict.sourceFacts}</h2>
      <dl className="source-facts">
        {rows.map((row) => (
          <div key={row.key} className="source-facts__row">
            <dt>{row.label}</dt>
            <dd className={row.numeric ? "num" : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {f.as_of && <p className="source-facts__as-of">{format(dict.factsAsOf, { date: f.as_of })}</p>}
    </section>
  );
}
