import { describe, expect, it } from "vitest";
import { formatDuration } from "./duration";

describe("formatDuration", () => {
  it("returns 未知 for null", () => {
    expect(formatDuration(null)).toBe("未知");
  });

  it("formats under an hour as m:ss", () => {
    expect(formatDuration(117)).toBe("1:57");
  });

  it("formats an hour or more as h:mm:ss", () => {
    expect(formatDuration(3723)).toBe("1:02:03");
  });

  it("pads seconds and minutes-under-hour to two digits", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3605)).toBe("1:00:05");
  });
});
