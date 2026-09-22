/**
 * Shared with `lib/analysis/prompts.ts` (video metadata sent to the model) and
 * `components/capability/video-summary.tsx` (the detail page's video panel) so the two
 * never drift into inconsistent formatting. `null` (unknown duration) renders as the
 * Chinese "未知" here; the UI component handles the locale-appropriate label itself
 * rather than relying on this string, since this function has no locale of its own.
 */
export function formatDuration(sec: number | null): string {
  if (sec === null) return "未知";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
