import { format, getDict, type Locale } from "../../lib/i18n";
import { formatDuration } from "../../lib/text/duration";
import type { VideoDetail } from "../../lib/library/queries";

/** `"mm:ss"` or `"h:mm:ss"` (as written by the video extraction, see lib/analysis/schema) to
 * seconds, for the `&t=` deep link into the video; `null` for anything else (2 or 3 numeric
 * parts, each a non-negative integer) so an unparseable moment renders as plain text instead
 * of a broken link. */
export function momentSeconds(t: string): number | null {
  const parts = t.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** One timestamped list (视频要点 / 关键片段): the timestamp deep-links into the video when it
 * parses, and renders as plain text when it doesn't (or when the point spans the whole video). */
function TimedList({ title, items, watch }: {
  title: string; items: Array<{ t: string | null; text: string }>; watch: (sec?: number) => string;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <h3 className="video-summary__subtitle">{title}</h3>
      <ul className="video-moments">
        {items.map((item, i) => {
          const sec = item.t === null ? null : momentSeconds(item.t);
          return (
            <li key={i}>
              {item.t !== null && (sec === null
                ? <span className="video-moments__t">{item.t}</span>
                : <a className="video-moments__t" href={watch(sec)} target="_blank" rel="noreferrer">{item.t}</a>)}
              {item.t !== null && " "}{item.text}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Server Component (no interaction of its own): the capability detail page's video panel,
 * assembled from `CapabilityDetail.video` (Task 5's `buildVideoDetail`). Renders nothing for a
 * non-YouTube capture (`video === null`).
 */
export function VideoSummary({ video, locale = "zh" }: { video: VideoDetail | null; locale?: Locale }) {
  if (!video) return null;
  const dict = getDict(locale).detail;
  const watch = (sec?: number) => `https://www.youtube.com/watch?v=${video.videoId}${sec ? `&t=${sec}s` : ""}`;
  // durationSec 0 (a live stream, or otherwise never resolved) is treated the same as null: an
  // unknown duration, not a literal "0:00".
  const durationKnown = video.durationSec !== null && video.durationSec !== 0;
  const duration = durationKnown ? formatDuration(video.durationSec) : dict.videoUnknownDuration;
  // The duration renders even without a channel; the whole meta line only disappears when there
  // is neither a channel nor a known duration to show.
  const showMeta = video.channel !== null || durationKnown;
  return (
    <section className="panel">
      <h2 className="panel-title">{dict.video}</h2>
      <p className="video-summary__title"><a href={watch()} target="_blank" rel="noreferrer">{video.title ?? watch()}</a></p>
      {showMeta && (
        <p className="video-summary__meta">
          {video.channel ? format(dict.videoMeta, { channel: video.channel, duration }) : duration}
        </p>
      )}
      {video.clipped && <p className="prompt-notice">{dict.videoClipped}</p>}
      {video.failed && <p className="prompt-notice">{dict.videoFailed}</p>}
      <TimedList title={dict.videoPoints} items={video.points.map((p) => ({ t: p.t, text: p.point }))} watch={watch} />
      <TimedList title={dict.videoMoments} items={video.moments.map((m) => ({ t: m.t, text: m.note }))} watch={watch} />
    </section>
  );
}
