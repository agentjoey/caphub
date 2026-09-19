/**
 * Postgres text/jsonb columns cannot hold U+0000 at all (writing it raises
 * 22P05, "unsupported Unicode escape sequence"). These helpers strip it — and,
 * for provider text we don't otherwise trust, the rest of the C0 control range
 * — before a string reaches a SQL parameter.
 */

const NUL = /\u0000/g;

/** Removes U+0000 from a string. */
export function stripNul(value: string): string {
  return value.replace(NUL, "");
}

// C0 controls other than tab (\t), line feed (\n) and carriage return (\r).
const CONTROL_CHARS_EXCEPT_TAB_LF_CR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Removes C0 control characters, keeping \t, \n and \r. */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS_EXCEPT_TAB_LF_CR, "");
}

/**
 * JSON.stringify with a replacer that strips U+0000 from every string value
 * (including nested ones), so the resulting JSON text is always safe to bind
 * as a jsonb parameter.
 */
export function jsonStringifyStripNul(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "string" ? stripNul(v) : v));
}
