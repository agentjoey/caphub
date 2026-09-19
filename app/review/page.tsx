import Link from "next/link";
import { ReviewCard } from "../../components/review/review-card";
import { getCapabilityDetail, listPending, PAGE_SIZE } from "../../lib/library/queries";
import { getRuntime } from "../../lib/runtime";

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
  const { pool } = getRuntime();
  const { items, total } = await listPending(pool, { page });
  const details = await Promise.all(items.map((row) => getCapabilityDetail(pool, row.id)));
  const hasPrev = page > 1;
  const hasNext = page * PAGE_SIZE < total;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Review</h1>
          <p className="page-subtitle">{total} 张待决卡片</p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="empty">没有待决的卡片。新投递的内容分析完成后，拿不准的会出现在这里。</p>
      ) : (
        <>
          <div>
            {items.map((row, index) => {
              const detail = details[index];
              return detail ? <ReviewCard key={row.id} row={row} detail={detail} /> : null;
            })}
          </div>
          {(hasPrev || hasNext) && (
            <nav className="pagination">
              {hasPrev && <Link href={`/review?page=${page - 1}`}>上一页</Link>}
              {hasNext && <Link href={`/review?page=${page + 1}`}>下一页</Link>}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
