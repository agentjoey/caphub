import { intlLocale, type Locale } from "../i18n";

const rtfCache = new Map<Locale, Intl.RelativeTimeFormat>();
function rtfFor(locale: Locale): Intl.RelativeTimeFormat {
  let rtf = rtfCache.get(locale);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });
    rtfCache.set(locale, rtf);
  }
  return rtf;
}

export function relativeTime(iso: string, locale: Locale = "zh"): string {
  const rtf = rtfFor(locale);
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60000);
  if (Math.abs(diffMinutes) < 60) return rtf.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return rtf.format(diffHours, "hour");
  const diffDays = Math.round(diffHours / 24);
  return rtf.format(diffDays, "day");
}

// Fixed timeZone so the output is identical regardless of the server host's local zone —
// this is rendered server-side (Server Components), so it must not depend on client hydration.
const dtfCache = new Map<Locale, Intl.DateTimeFormat>();
function dtfFor(locale: Locale): Intl.DateTimeFormat {
  let dtf = dtfCache.get(locale);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    dtfCache.set(locale, dtf);
  }
  return dtf;
}

/** Absolute date+time, formatted server-side to avoid hydration mismatches (e.g. "2026-09-19 08:00"). */
export function formatDateTime(iso: string, locale: Locale = "zh"): string {
  return dtfFor(locale).format(new Date(iso)).replace(/\//g, "-");
}
