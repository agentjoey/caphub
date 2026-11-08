/** Canvas-independent, Unicode-safe wrapping. A truncated final line includes the ellipsis in its width. */
export function wrapText(
  text: string,
  measure: (s: string) => number,
  width: number,
  maxLines: number
): string[] {
  if (!text || width <= 0 || maxLines <= 0) return [];
  const lines: string[] = [];
  let remaining = text.trim();
  while (remaining && lines.length < maxLines) {
    const chars = Array.from(remaining);
    let end = 0;
    while (end < chars.length && chars[end] !== "\n" && measure(chars.slice(0, end + 1).join("")) <= width)
      end++;
    end = Math.max(1, end);
    if (lines.length === maxLines - 1 && end < chars.length) {
      while (end > 0 && measure(chars.slice(0, end).join("").trimEnd() + "…") > width) end--;
      lines.push(chars.slice(0, end).join("").trimEnd() + "…");
      break;
    }
    if (end < chars.length && /[A-Za-z0-9._\-/+]/.test(chars[end]) && /[A-Za-z0-9._\-/+]/.test(chars[end - 1])) {
      const space = chars.slice(0, end).lastIndexOf(" ");
      if (space > 0) end = space;
    }
    // Pull a preceding character down instead of orphaning closing punctuation.
    const prohibited = /[，。、；：！？）」』》】…"'”’]/;
    let next = end;
    while (next < chars.length && /\s/.test(chars[next])) next++;
    if (next < chars.length && prohibited.test(chars[next])) {
      while (end > 1 && (prohibited.test(chars[end]) || /\s/.test(chars[end]))) end--;
    }
    lines.push(chars.slice(0, end).join("").trimEnd());
    remaining = chars.slice(end).join("").trimStart();
  }
  return lines;
}
