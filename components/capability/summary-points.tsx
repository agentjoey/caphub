import { summaryPointLabel, type SummaryPoint } from "../../lib/analysis/card";

// Re-exported so this module is the one import a renderer needs for the `**标签。** 说明`
// pattern; the definition itself lives beside the schema (lib/analysis/card.ts) because the
// Telegram formatter renders the same labels and must not import a React component.
export { summaryPointLabel };

/**
 * A capability's summary: the prose lead (`summary`) followed by its structured
 * `summary_points`, one `**标签。** 说明` line each.
 *
 * `points` is `[]` for every card not re-enriched since migration 012, and `undefined` for a
 * caller that has no such field at all — both fall back to the prose lead alone. Neither the
 * lead nor the point list is given a heading of its own, and a blank lead renders no paragraph,
 * so a card with nothing to say never leaves an empty heading or an empty block behind.
 */
export function SummaryBody({
  summary,
  points,
  className
}: {
  summary: string;
  points: SummaryPoint[] | undefined;
  className?: string;
}) {
  const lead = summary.trim();
  // `points` is stored jsonb (see the doc comment above) -- a malformed row (missing/non-string
  // `label`/`text`) is read defensively here, like deep_analysis's readers, and dropped rather
  // than throwing and 500-ing the page.
  const shown = (points ?? [])
    .map((p) => ({ label: summaryPointLabel(typeof p?.label === "string" ? p.label : ""), text: typeof p?.text === "string" ? p.text.trim() : "" }))
    // A label with no sentence behind it is a lead-in to nothing — dropped rather than rendered
    // as a stray bold fragment. A sentence with no label still carries its idea, so it stays.
    .filter((p) => p.text !== "");
  return (
    <>
      {lead !== "" && <p className={className}>{lead}</p>}
      {shown.length > 0 && (
        <ul className="summary-points">
          {shown.map((p, index) => (
            <li key={index}>
              {p.label !== "" && <b>{p.label}</b>}
              {p.label !== "" && p.text !== "" ? " " : null}
              {p.text}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
