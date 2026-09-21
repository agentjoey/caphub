import Link from "next/link";
import { AnalysisDetails } from "../../../components/capability/analysis-details";
import { CardSummary } from "../../../components/capability/card-summary";
import { MiniActions } from "../../../components/mini/mini-actions";
import { RouterBackButton } from "../../../components/mini/router-back-button";
import { getCapabilityDetail, listPending, PAGE_SIZE } from "../../../lib/library/queries";
import { getRuntime } from "../../../lib/runtime";
import { getLocale } from "../../../lib/i18n/locale";
import { format, getDict } from "../../../lib/i18n";

export const dynamic = "force-dynamic";

/**
 * `/mini/review` — the Telegram mini app's pending-decisions queue. Mobile counterpart of
 * `app/review/page.tsx`: same data path (listPending + getCapabilityDetail per row), one
 * `MiniActions` per card (decide/edit/rerun only — no delete, no progress: a still-pending card
 * has neither, same as desktop's ReviewCard). No card here binds Telegram's MainButton to
 * "keep" — with up to PAGE_SIZE cards on the page at once there is no single "current" card for
 * a *global* MainButton to represent, so every action here stays an in-page control instead.
 */
export default async function MiniReviewPage({
  searchParams
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.page) ? params.page[0] : params.page;
  const n = Number(raw);
  const page = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  const locale = await getLocale();
  const dict = getDict(locale);
  const { pool } = getRuntime();
  const { items, total } = await listPending(pool, { page });
  const details = await Promise.all(items.map((row) => getCapabilityDetail(pool, row.id)));
  const hasPrev = page > 1;
  const hasNext = page * PAGE_SIZE < total;

  return (
    <div className="mini-review">
      <RouterBackButton />
      <div className="page-head">
        <h1 className="page-title">{dict.review.title}</h1>
        <p className="page-subtitle">{format(dict.review.subtitle, { count: total })}</p>
      </div>
      {items.length === 0 ? (
        <p className="empty">{dict.review.empty}</p>
      ) : (
        <>
          <div>
            {items.map((row, index) => {
              const detail = details[index];
              if (!detail) return null;
              return (
                <div key={row.id} id={row.id} className="review-item">
                  <CardSummary row={row} locale={locale} />
                  <AnalysisDetails detail={detail} locale={locale} />
                  <MiniActions
                    id={row.id}
                    captureId={row.captureId}
                    updatedAt={row.updatedAt}
                    verdict={row.verdict}
                    type={row.type}
                    usage={row.usage}
                    tags={row.tags}
                    enableMainButton={false}
                    locale={locale}
                  />
                </div>
              );
            })}
          </div>
          {(hasPrev || hasNext) && (
            <nav className="pagination">
              {hasPrev && <Link className="pagination__prev" href={`/mini/review?page=${page - 1}`}>{dict.library.prevPage}</Link>}
              {hasNext && <Link className="pagination__next" href={`/mini/review?page=${page + 1}`}>{dict.library.nextPage}</Link>}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
