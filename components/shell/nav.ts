export const NAV_ITEMS = [
  { href: "/", label: "投递" },
  { href: "/review", label: "Review" },
  { href: "/library", label: "能力库" }
] as const;

export function isNavCurrent(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
