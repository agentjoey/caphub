"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
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
  const navRef = useRef<HTMLElement>(null);
  // The current item's underline is one bar that slides between items, measured after layout. Until
  // it is measured (server render, first paint) each link's own CSS underline shows instead, and
  // the very first placement doesn't animate — only moves between pages do.
  const [bar, setBar] = useState<{ left: number; width: number; moved: boolean } | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const place = () => {
      const current = nav.querySelector<HTMLElement>("a[aria-current='page']");
      if (!current) return setBar(null);
      // Match the static underline: the link's box minus its horizontal padding.
      const style = getComputedStyle(current);
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padRight = parseFloat(style.paddingRight) || 0;
      const left = current.offsetLeft + padLeft;
      const width = Math.max(0, current.offsetWidth - padLeft - padRight);
      setBar((prev) => ({ left, width, moved: prev !== null }));
    };
    place();
    // Labels change width when the web font arrives or the locale switches.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(nav);
    return () => observer?.disconnect();
  }, [pathname]);
  return (
    <nav className="primary-nav" aria-label={navAria} ref={navRef} data-bar={bar ? "" : undefined}>
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
      {bar && (
        <span
          className="primary-nav__bar"
          aria-hidden="true"
          data-moved={bar.moved ? "" : undefined}
          style={{ transform: `translateX(${bar.left}px) scaleX(${bar.width})` }}
        />
      )}
    </nav>
  );
}
