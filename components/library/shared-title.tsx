import { ViewTransition, type ReactNode } from "react";

/**
 * A capability's title, named for a shared-element View Transition so the library card's title
 * morphs into the detail page's heading on navigation (node_modules/next/dist/docs/01-app/
 * 02-guides/view-transitions.md, step 1). `default="none"` keeps it still on unrelated
 * navigations; `share="morph"` (required alongside it) styles the morph in globals.css.
 *
 * Next's App Router React exports `ViewTransition`; the stable `react` package the tests run on
 * does not, so without it this renders the title as-is. Browsers without the View Transitions
 * API simply navigate without the morph.
 */
export function SharedTitle({ id, children }: { id: string; children: ReactNode }) {
  if (!ViewTransition) return <>{children}</>;
  return (
    <ViewTransition name={`cap-title-${id}`} share="morph" default="none">
      {children}
    </ViewTransition>
  );
}
