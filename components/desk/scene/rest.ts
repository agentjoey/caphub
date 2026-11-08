export type RestState = {
  state: "rest" | "open" | "moving" | "grab" | "gone";
  sleeping: boolean;
  animating: boolean;
  dropDelay: number;
};
/** Kinematic open/removed sheets need no frames; pending drops and dynamic bodies do. */
export function isEverythingAtRest(papers: RestState[], dragging: boolean): boolean {
  return !dragging && papers.every(p => !p.animating && p.dropDelay <= 0 &&
    (p.state === "open" || p.state === "gone" || (p.state === "rest" && p.sleeping)));
}
