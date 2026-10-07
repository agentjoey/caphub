import { describe, expect, it } from "vitest";
import { pipelineStages } from "./stage";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("pipelineStages", () => {
  it("an image starts on reading the screenshot", () => {
    expect(pipelineStages("image", null, [])).toEqual({ stages: ["read", "search", "reason", "verdict"], current: "read" });
  });

  it("an image moves to search once vision has succeeded", () => {
    expect(pipelineStages("image", null, ["vision"]).current).toBe("search");
  });

  it("text has no reading stage at all, so it never shows a step that cannot light up", () => {
    expect(pipelineStages("text", null, [])).toEqual({ stages: ["search", "reason", "verdict"], current: "search" });
  });

  it("a plain link behaves like text", () => {
    expect(pipelineStages("url", "https://github.com/a/b", ["search"])).toEqual({ stages: ["search", "reason", "verdict"], current: "reason" });
  });

  it("a YouTube link watches the video first; the metadata fetch alone does not finish that stage", () => {
    expect(pipelineStages("url", YT, ["fetch"])).toEqual({ stages: ["watch", "search", "reason", "verdict"], current: "watch" });
    expect(pipelineStages("url", YT, ["fetch", "vision"]).current).toBe("search");
  });

  it("once reason has succeeded the run is storing its verdict", () => {
    expect(pipelineStages("image", null, ["vision", "search", "reason"]).current).toBe("verdict");
  });

  it("stays on the first unfinished stage even if a later step is somehow recorded", () => {
    expect(pipelineStages("image", null, ["search"]).current).toBe("read");
  });
});
