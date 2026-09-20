import type { BuildNote } from "../../lib/library/build-notes";
import { formatDateTime } from "../../lib/library/format";
import { getDict, type Locale } from "../../lib/i18n";

/**
 * The 自研笔记 section of a card's detail page: notes an external agent appended after it
 * implemented the capability itself (see `appendBuildNote`). Stored oldest-first (append-only),
 * shown newest-first so the latest update reads at the top. `by` is untrusted, self-reported
 * display text (see BuildNote) — rendered as plain text (JSX escapes it), never as markup.
 * An empty array renders nothing at all, no empty section heading.
 */
export function BuildNotes({ notes, locale = "zh" }: { notes: BuildNote[]; locale?: Locale }) {
  if (notes.length === 0) return null;
  const dict = getDict(locale).buildNotes;
  const ordered = [...notes].reverse();

  return (
    <section className="panel build-notes" id="build-notes">
      <h2 className="panel-title">{dict.title}</h2>
      <ul className="build-notes__list">
        {ordered.map((note, i) => (
          <li key={i}>
            <p className="build-notes__meta">{note.by} · {formatDateTime(note.at, locale)}</p>
            <p className="build-notes__text">{note.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
