import { describe, expect, it } from "vitest";
import { dictZh } from "./dict-zh";
import { dictEn } from "./dict-en";
import { format, getDict, intlLocale } from "./index";

function keySet(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keySet(v, prefix ? `${prefix}.${k}` : k));
}

function leaves(obj: unknown): string[] {
  if (typeof obj === "string") return [obj];
  if (typeof obj !== "object" || obj === null) return [];
  return Object.values(obj as Record<string, unknown>).flatMap(leaves);
}

describe("i18n dictionaries", () => {
  it("dict-zh and dict-en have identical key sets", () => {
    expect(keySet(dictEn).sort()).toEqual(keySet(dictZh).sort());
  });

  it("has no empty string leaves in either dictionary", () => {
    expect(leaves(dictZh).some((v) => v.trim() === "")).toBe(false);
    expect(leaves(dictEn).some((v) => v.trim() === "")).toBe(false);
  });

  it("getDict resolves zh and en, defaulting anything else to zh via getLocale (see locale.test)", () => {
    expect(getDict("zh")).toBe(dictZh);
    expect(getDict("en")).toBe(dictEn);
  });

  it("intlLocale maps to Intl locale tags", () => {
    expect(intlLocale("zh")).toBe("zh-CN");
    expect(intlLocale("en")).toBe("en-US");
  });

  it("format interpolates {name} placeholders and leaves unknown ones untouched", () => {
    expect(format("去 Review（{count}）", { count: 3 })).toBe("去 Review（3）");
    expect(format("Go to Review ({count})", { count: 3 })).toBe("Go to Review (3)");
    expect(format("no placeholders here", {})).toBe("no placeholders here");
    expect(format("missing {other}", {})).toBe("missing {other}");
  });
});
