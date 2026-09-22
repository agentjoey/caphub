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

/**
 * Server Component (no interaction of its own): the capability detail page's video panel,
 * assembled from `CapabilityDetail.video` (Task 5's `buildVideoDetail`). Renders nothing for a
 * non-YouTube capture (`video === null`).
 */
export function VideoSummary({ video, locale = "zh" }: { video: VideoDetail | null; locale?: Locale }) {
  if (!video) return null;
  const dict = getDict(locale).detail;
  const watch = (sec?: number) => `https://www.youtube.com/watch?v=${video.videoId}${sec ? `&t=${sec}s` : ""}`;
  const duration = video.durationSec === null ? dict.videoUnknownDuration : formatDuration(video.durationSec);
  return (
    <section className="panel">
      <h2 className="panel-title">{dict.video}</h2>
      <p className="video-summary__title"><a href={watch()} target="_blank" rel="noreferrer">{video.title ?? watch()}</a></p>
      {video.channel && <p className="video-summary__meta">{format(dict.videoMeta, { channel: video.channel, duration })}</p>}
      {video.clipped && <p className="prompt-notice">{dict.videoClipped}</p>}
      {video.failed && <p className="prompt-notice">{dict.videoFailed}</p>}
      {video.moments.length > 0 && (
        <>
          <h3 className="video-summary__subtitle">{dict.videoMoments}</h3>
          <ul className="video-moments">
            {video.moments.map((m, i) => {
              const sec = momentSeconds(m.t);
              return (
                <li key={i}>
                  {sec === null
                    ? <span className="video-moments__t">{m.t}</span>
                    : <a className="video-moments__t" href={watch(sec)} target="_blank" rel="noreferrer">{m.t}</a>}
                  {" "}{m.note}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
