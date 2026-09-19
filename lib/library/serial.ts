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

/**
 * The serial to show for a card, or null when it shouldn't be displayed. A discarded card keeps
 * its serial in the DB (so it isn't reused if the card is later kept) but never shows it — the
 * number is only meaningful for the keep set the user browses.
 */
export function displaySerial(verdict: "keep" | "discard" | "pending", type: CapabilityType, serial: number | null): string | null {
  if (verdict !== "keep") return null;
  return formatSerial(type, serial);
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
