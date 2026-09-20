/**
 * A card's tag chips.
 *
 * `max` caps how many are shown and folds the rest into a `+N` remainder (M3.8 design decision
 * 4 — a library list row shows 3, so the tags never crowd the score and progress badges);
 * `quiet` de-emphasises the whole strip for the same reason.
 */
export function TagList({ tags, max, quiet }: { tags: string[]; max?: number; quiet?: boolean }) {
  if (tags.length === 0) return null;
  const limit = max !== undefined && max >= 0 ? max : tags.length;
  const shown = tags.slice(0, limit);
  const rest = tags.slice(limit);
  return (
    <ul className={`tag-list${quiet ? " tag-list--quiet" : ""}`}>
      {shown.map((tag) => (
        <li key={tag} className="tag">{tag}</li>
      ))}
      {rest.length > 0 && (
        <li className="tag tag--more" title={rest.join("、")}>+{rest.length}</li>
      )}
    </ul>
  );
}
