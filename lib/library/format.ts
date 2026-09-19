const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

export function relativeTime(iso: string): string {
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
const dtf = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

/** Absolute date+time, formatted server-side to avoid hydration mismatches (e.g. "2026-09-19 08:00"). */
export function formatDateTime(iso: string): string {
  return dtf.format(new Date(iso)).replace(/\//g, "-");
}
