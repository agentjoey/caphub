import type { CapabilityType } from "../analysis/card";

const PREFIX: Record<CapabilityType, string> = {
  skill: "SKL",
  experience: "EXP",
  plugin: "PLG",
  prompt: "PRM",
  other: "OTH"
};

/** Human-readable serial, e.g. "SKL-0012". Zero-pads to 4 digits; wider numbers pass through untruncated. */
export function formatSerial(type: CapabilityType, serial: number | null): string | null {
  if (serial === null) return null;
  return `${PREFIX[type]}-${String(serial).padStart(4, "0")}`;
}

// Either PREFIX + optional "-"/" " + digits (case-insensitive, prefix need not match the
// card's current type), or a bare "#" + digits. A plain number with no prefix or "#" is not
// a serial lookup — it falls through to ordinary text search.
const QUERY_RE = /^(?:(?:SKL|EXP|PLG|PRM|OTH)[\s-]?(\d+)|#(\d+))$/i;

export function parseSerialQuery(q: string): number | null {
  const m = QUERY_RE.exec(q.trim());
  if (!m) return null;
  return Number.parseInt(m[1] ?? m[2], 10);
}
