import Link from "next/link";
import { getLocale } from "../../../../lib/i18n/locale";
import { getDict } from "../../../../lib/i18n";

export default async function NotFound() {
  const locale = await getLocale();
  const dict = getDict(locale).notFound;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{dict.title}</h1>
          <p className="page-subtitle">{dict.subtitle}</p>
        </div>
      </div>
      <p className="empty">
        <Link href="/library">{dict.back}</Link>
      </p>
    </div>
  );
}
