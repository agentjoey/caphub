import Link from "next/link";
import { cookies } from "next/headers";
import { loadScenarios } from "../../lib/analysis/scenarios";
import { MINI_COOKIE, verifyMiniSession } from "../../lib/telegram/mini-session";
import { ScoreBadge } from "../../components/capability/score-badge";
import { TagList } from "../../components/capability/tag-list";
import { embedSearchQuery } from "../../lib/library/query-embedding";
import { allTags, libraryStats, listLibrary, scenarioStats } from "../../lib/library/queries";
import { matchScenarios } from "../../lib/library/scenario-match";
import { displaySerial, parseSerialQuery } from "../../lib/library/serial";
import { libraryHref, parseLibraryParams } from "../../lib/library/search-params";
import { getRuntime } from "../../lib/runtime";
import { getLocale } from "../../lib/i18n/locale";
import { format, getDict } from "../../lib/i18n";
import { MiniFilters } from "./mini-filters";

export const dynamic = "force-dynamic";

/** Tags shown on a mini list row before the `+N` remainder — same cap as the desktop library
 * list (M3.8 design decision 4), kept as its own local constant rather than importing the
 * private one from `app/library/page.tsx`. */
const LIST_ROW_TAGS = 3;

/**
 * `GET /mini` is the one route `lib/auth/guard.ts` lets through without a mini-session cookie —
 * it has to, or the shell that exchanges `initData` for that cookie could never load. So the
 * exemption is paid for here instead: the page verifies the cookie itself and, without a valid
 * one, renders the shell and nothing else. That is what keeps a Cloudflare Access session alone
 * (no Telegram) from reading the library, paging it via `?page=N`, or spending the Gemini
 * embedding key via `?q=…`. The check must stay `verifyMiniSession` — the same function the
 * guard uses — so the two can never drift apart into two different notions of "signed in".
 */
async function hasMiniSession(telegram: { botToken?: string; ownerChatId?: string }): Promise<boolean> {
  const botToken = telegram.botToken?.trim();
  const ownerId = telegram.ownerChatId?.trim();
  if (!botToken || !ownerId) return false; // Fail closed, exactly like the guard.
  const store = await cookies();
  return verifyMiniSession(store.get(MINI_COOKIE)?.value, { botToken, ownerId });
}

/**
 * `/mini` — the Telegram mini app's library entry page.
 *
 * Data path is intentionally identical to `app/(chrome)/library/page.tsx`:
 * parseLibraryParams -> matchScenarios / embedSearchQuery -> listLibrary. Do not fork this into
 * a second search implementation — extend the shared lib functions instead.
 */
export default async function MiniLibraryPage({
  searchParams
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { pool, config } = getRuntime();
  const locale = await getLocale();
  const dict = getDict(locale);

  // Before any query, any embedding call and even before reading the search params: without a
  // verified Telegram session this render must produce no library data at all. TelegramProvider
  // exchanges initData and calls router.refresh(), which re-runs this page with the cookie set.
  if (!(await hasMiniSession(config.telegram))) {
    return (
      <div className="mini-library">
        <h1 className="page-title">{dict.library.title}</h1>
        <p className="page-subtitle">{dict.mini.connecting}</p>
      </div>
    );
  }

  const params = await searchParams;
  const filter = parseLibraryParams(params);

  const q = filter.q;
  const isSerialQuery = Boolean(q && parseSerialQuery(q) !== null);
  const scenarios = await loadScenarios(pool);
  const matchedScenarioSlugs = q && !isSerialQuery ? matchScenarios(q, scenarios) : [];
  const queryEmbeddingPromise = q && !isSerialQuery ? embedSearchQuery(config.providers.geminiApiKey, q) : Promise.resolve(null);

  const [stats, scenarioCounts, tags, queryEmbedding] = await Promise.all([
    libraryStats(pool),
    scenarioStats(pool, { discarded: filter.discarded }),
    allTags(pool),
    queryEmbeddingPromise
  ]);
  const { items, total } = await listLibrary(pool, filter, { queryEmbedding, matchedScenarioSlugs });
  const remaining = total - items.length;
  const scenarioCountBySlug = new Map(scenarioCounts.map((s) => [s.slug, s.count]));
  const hasFilters = Boolean(filter.q || filter.types?.length || filter.tags?.length || filter.scenarios?.length);

  const hiddenFields: Array<{ name: string; value: string }> = [
    ...(filter.types ?? []).map((value) => ({ name: "type", value })),
    ...(filter.tags ?? []).map((value) => ({ name: "tag", value })),
    ...(filter.scenarios ?? []).map((value) => ({ name: "scenario", value }))
  ];

  return (
    <div className="mini-library">
      <h1 className="page-title">{dict.library.title}</h1>
      <p className="page-subtitle">{format(dict.library.subtitle, { count: stats.total })}</p>
      <form className="search-form" action="/mini" method="get">
        <input type="search" name="q" defaultValue={filter.q ?? ""} placeholder={dict.library.searchPlaceholder} aria-label={dict.library.searchAria} />
        {hiddenFields.map((field, index) => (
          <input key={`${field.name}-${field.value}-${index}`} type="hidden" name={field.name} value={field.value} />
        ))}
        <button type="submit" className="btn">{dict.library.searchButton}</button>
      </form>
      <MiniFilters filter={filter} locale={locale} byType={stats.byType} scenarios={scenarios} scenarioCountBySlug={scenarioCountBySlug} tags={tags} />
      {items.length === 0 ? (
        <p className="empty">
          {hasFilters ? (
            <>{dict.library.emptyWithFilters}<Link href="/mini">{dict.library.clearFilters}</Link></>
          ) : (
            dict.library.emptyNoFilters
          )}
        </p>
      ) : (
        <ul className="list">
          {items.map((row) => (
            <li key={row.id}>
              {/* Carries the current q/type/scenario/tag filter into the detail route (Task 4) so
                  Telegram's native BackButton there returns to this same filtered view instead
                  of an unfiltered list. `page` is pinned to 1 explicitly (not just omitted from
                  the patch) — libraryHref's page-reset guard only fires when the patch touches a
                  non-page field, so an empty patch on a page-2+ list would otherwise leak
                  `&page=2` onto the detail URL, which means nothing there. */}
              <Link
                className={`list-row list-row--mini${row.status !== "active" ? " list-row--muted" : ""}`}
                href={libraryHref(filter, { page: 1 }, `/mini/library/${row.id}`)}
              >
                <div>
                  <div className="list-row__title">
                    {row.title}
                    {displaySerial(row.verdict, row.type, row.serial) && (
                      <span className="serial"> {displaySerial(row.verdict, row.type, row.serial)}</span>
                    )}
                  </div>
                  <div className="list-row__meta">
                    <ScoreBadge score={row.score} reason={row.scoreReason} locale={locale} />
                  </div>
                  <TagList tags={row.tags} max={LIST_ROW_TAGS} quiet />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {remaining > 0 && (
        // The subtitle above states the library's full total (`stats.total`), but this page only
        // ever renders one `listLibrary` page (PAGE_SIZE=20) of the *filtered* result — this
        // footer is what keeps that number honest instead of silently truncating the list.
        <p className="mini-more">
          <Link
            className="chip"
            href={libraryHref(filter, { page: filter.page + 1 }, "/mini")}
          >
            {format(dict.library.moreFooter, { count: remaining })}
          </Link>
        </p>
      )}
    </div>
  );
}
