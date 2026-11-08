/** Shared by lying-flat pile sheets and the file-to-pile animation target. */
export const pileYaw = (index: number) => Math.PI + Math.sin(index * 13) * 0.22;
export type OpenBand = { top: number; bottom: number };
/** All measurements are relative to the scene's top edge, in CSS pixels. */
export function fitOpenBand(band: OpenBand, width: number, height: number, aspect: number) {
  const top = Math.max(0, band.top) + 12;
  const bottom = Math.min(height, band.bottom) - 12;
  const sheetHeight = Math.max(0, Math.min(bottom - top, width * .9 / aspect));
  return { top: (top + bottom - sheetHeight) / 2, height: sheetHeight, width: sheetHeight * aspect };
}
type Point = { x: number; z: number };
/** Bounded rejection sampling. A crowded desk uses the best available candidate, never a grid. */
export function scatterPosition(mobile: boolean, radius: number, occupied: Point[], pile: Point, random = Math.random): Point {
  let best: Point = { x: mobile ? -.75 : -2, z: -.75 }, bestClearance = -Infinity;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const point = { x: mobile ? -.75 + random() * 1.5 : -2 + random() * 3.4,
      z: mobile ? -.8 + random() * 1.7 : -.75 + random() * 1.85 };
    if (Math.hypot(point.x - pile.x, point.z - pile.z) < .9) continue;
    const clearance = Math.min(...occupied.map(p => Math.hypot(point.x-p.x, point.z-p.z)));
    if (clearance > bestClearance) { best = point; bestClearance = clearance; }
    if (clearance >= radius * 2.3) return point;
  }
  return best;
}
