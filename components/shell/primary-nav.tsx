"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isNavCurrent } from "./nav";

export function PrimaryNav() {
  const pathname = usePathname();
  return (
    <nav className="primary-nav" aria-label="主导航">
      {NAV_ITEMS.map((item) => (
        <Link key={item.href} href={item.href} aria-current={isNavCurrent(item.href, pathname) ? "page" : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
