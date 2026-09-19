import Link from "next/link";

export default function NotFound() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">能力不存在</h1>
          <p className="page-subtitle">这个能力可能已被删除，或链接有误。</p>
        </div>
      </div>
      <p className="empty">
        <Link href="/library">← 返回能力库</Link>
      </p>
    </div>
  );
}
