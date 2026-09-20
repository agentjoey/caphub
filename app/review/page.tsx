import Link from "next/link";
import { ReviewCard } from "../../components/review/review-card";
import { getCapabilityDetail, listPending, PAGE_SIZE } from "../../lib/library/queries";
import { getRuntime } from "../../lib/runtime";
import { getLocale } from "../../lib/i18n/locale";
import { format, getDict } from "../../lib/i18n";

export const dynamic = "force-dynamic";

function pageNumber(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export default async function Page({
  searchParams
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const page = pageNumber(params.page);
  const locale = await getLocale();
  const dict = getDict(locale);
  const { pool } = getRuntime();
  const { items, total } = await listPending(pool, { page });
  const details = await Promise.all(items.map((row) => getCapabilityDetail(pool, row.id)));
  const hasPrev = page > 1;
  const hasNext = page * PAGE_SIZE < total;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{dict.review.title}</h1>
          <p className="page-subtitle">{format(dict.review.subtitle, { count: total })}</p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="empty">{dict.review.empty}</p>
      ) : (
        <>
          <div>
            {items.map((row, index) => {
              const detail = details[index];
              return detail ? <ReviewCard key={row.id} row={row} detail={detail} locale={locale} /> : null;
            })}
          </div>
          {(hasPrev || hasNext) && (
            <nav className="pagination">
              {hasPrev && <Link className="pagination__prev" href={`/review?page=${page - 1}`}>{dict.library.prevPage}</Link>}
              {hasNext && <Link className="pagination__next" href={`/review?page=${page + 1}`}>{dict.library.nextPage}</Link>}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
