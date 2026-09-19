"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isNavCurrent } from "./nav";

const DEFAULT_LABELS: Record<string, string> = Object.fromEntries(NAV_ITEMS.map((item) => [item.href, item.label]));

export function PrimaryNav({
  labels = DEFAULT_LABELS,
  navAria = "主导航"
}: {
  labels?: Record<string, string>;
  navAria?: string;
}) {
  const pathname = usePathname();
  return (
    <nav className="primary-nav" aria-label={navAria}>
      {NAV_ITEMS.map((item) => (
        <Link key={item.href} href={item.href} aria-current={isNavCurrent(item.href, pathname) ? "page" : undefined}>
          {labels[item.href] ?? item.label}
        </Link>
      ))}
    </nav>
  );
}
