import { expect, it } from "vitest";
import { wrapText } from "./text";
const measure = (s: string) => Array.from(s).length;
it("wraps CJK and words and truncates the final line within the width", () => {
  expect(wrapText("你好世界你好", measure, 3, 2)).toEqual(["你好世", "界你好"]);
  expect(wrapText("hello world again", measure, 7, 2)).toEqual(["hello", "world…"]);
  expect(wrapText("abcdef", measure, 3, 1)).toEqual(["ab…"]);
  expect(wrapText("a\nb", measure, 5, 3)).toEqual(["a", "b"]);
  expect(wrapText("", measure, 3, 2)).toEqual([]);
});
it("breaks directly inside CJK after a Latin word, but preserves Latin words", () => {
  expect(wrapText("unslop 是一个量化工具", measure, 10, 3)).toEqual(["unslop 是一个", "量化工具"]);
  expect(wrapText("使用 hello/world 工具", measure, 11, 3)).toEqual(["使用", "hello/world", "工具"]);
});
it.each(Array.from("，。、；：！？）」』》】…\"'”’"))("keeps %s off the beginning of a wrapped line", punctuation => {
  const lines = wrapText(`默认输出${punctuation}继续`, measure, 4, 3);
  expect(lines).toEqual(["默认输", `出${punctuation}继续`]);
  expect(lines.every(line => measure(line) <= 4)).toBe(true);
});
