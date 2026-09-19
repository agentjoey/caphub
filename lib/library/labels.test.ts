import { describe, expect, it } from "vitest";
import { TYPE_LABEL, errorLabel } from "./labels";

describe("labels", () => {
  it("maps types to Chinese", () => { expect(TYPE_LABEL.experience).toBe("经验"); });
  it("maps known error codes and falls back", () => {
    expect(errorLabel("OBJECT_UNAVAILABLE")).toBe("原图已过期，无法重跑");
    expect(errorLabel("BUDGET")).toBe("超出单次分析预算");
    expect(errorLabel("SOMETHING")).toBe("分析失败（SOMETHING）");
    expect(errorLabel(null)).toBe("");
  });
});
