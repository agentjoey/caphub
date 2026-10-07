"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { format } from "../../lib/i18n";
import { NAV_ITEMS, isNavCurrent } from "./nav";

const DEFAULT_LABELS: Record<string, string> = Object.fromEntries(NAV_ITEMS.map((item) => [item.href, item.label]));

export function PrimaryNav({
  labels = DEFAULT_LABELS,
  navAria = "主导航",
  counts = {},
  countAria = "{label}，{count} 条待处理"
}: {
  labels?: Record<string, string>;
  navAria?: string;
  /** Per-item outstanding count (e.g. pending reviews); shown after the label only when > 0. */
  counts?: Partial<Record<string, number>>;
  /** Spoken name for an item carrying a count; `{label}` and `{count}` are filled in. */
  countAria?: string;
}) {
  const pathname = usePathname();
  return (
    <nav className="primary-nav" aria-label={navAria}>
      {NAV_ITEMS.map((item) => {
        const label = labels[item.href] ?? item.label;
        const count = counts[item.href] ?? 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isNavCurrent(item.href, pathname) ? "page" : undefined}
            aria-label={count > 0 ? format(countAria, { label, count }) : undefined}
          >
            {label}
            {count > 0 && <span className="nav-count" aria-hidden="true">{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
