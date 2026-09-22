// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VideoSummary, momentSeconds } from "./video-summary";
import type { VideoDetail } from "../../lib/library/queries";

afterEach(cleanup);

const baseVideo: VideoDetail = {
  videoId: "abc123XYZ_9",
  title: "How to build agents",
  channel: "Some Channel",
  durationSec: 754,
  clipped: false,
  failed: false,
  moments: []
};

describe("momentSeconds", () => {
  it("parses mm:ss", () => {
    expect(momentSeconds("01:57")).toBe(117);
  });

  it("parses h:mm:ss", () => {
    expect(momentSeconds("1:02:03")).toBe(3723);
  });

  it("returns null for invalid input", () => {
    expect(momentSeconds("x")).toBeNull();
  });
});

describe("VideoSummary", () => {
  it("renders nothing when video is null", () => {
    const { container } = render(<VideoSummary video={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the title link, channel · duration, and no notices/moments when clean", () => {
    render(<VideoSummary video={baseVideo} locale="zh" />);
    const titleLink = screen.getByRole("link", { name: "How to build agents" });
    expect(titleLink.getAttribute("href")).toBe(`https://www.youtube.com/watch?v=${baseVideo.videoId}`);
    expect(screen.getByText("Some Channel · 12:34")).toBeTruthy();
    expect(screen.queryByText(/90 分钟/)).toBeNull();
    expect(screen.queryByText(/仅依据标题与简介/)).toBeNull();
    expect(screen.queryByText("关键片段")).toBeNull();
  });

  it("falls back to the watch URL as the title text when title is null", () => {
    render(<VideoSummary video={{ ...baseVideo, title: null }} locale="zh" />);
    const link = screen.getByRole("link", { name: `https://www.youtube.com/watch?v=${baseVideo.videoId}` });
    expect(link).toBeTruthy();
  });

  it("shows the locale-appropriate unknown-duration label when durationSec is null", () => {
    render(<VideoSummary video={{ ...baseVideo, durationSec: null }} locale="zh" />);
    expect(screen.getByText("Some Channel · 未知")).toBeTruthy();
  });

  it("shows the English unknown-duration label in en locale", () => {
    render(<VideoSummary video={{ ...baseVideo, durationSec: null }} locale="en" />);
    expect(screen.getByText("Some Channel · unknown")).toBeTruthy();
  });

  it("shows the clipped notice", () => {
    render(<VideoSummary video={{ ...baseVideo, clipped: true }} locale="zh" />);
    expect(screen.getByText("视频超过 90 分钟，只分析了前 90 分钟")).toBeTruthy();
  });

  it("shows the failed notice", () => {
    render(<VideoSummary video={{ ...baseVideo, failed: true }} locale="zh" />);
    expect(screen.getByText("视频未能读取，仅依据标题与简介")).toBeTruthy();
  });

  it("renders key moments with links using &t=<sec>s for valid timestamps", () => {
    render(<VideoSummary video={{ ...baseVideo, moments: [{ t: "01:57", note: "重点讲解" }] }} locale="zh" />);
    expect(screen.getByText("关键片段")).toBeTruthy();
    const momentLink = screen.getByRole("link", { name: "01:57" });
    expect(momentLink.getAttribute("href")).toBe(`https://www.youtube.com/watch?v=${baseVideo.videoId}&t=117s`);
    expect(screen.getByText("重点讲解")).toBeTruthy();
  });

  it("does not render a link for an invalid moment timestamp", () => {
    render(<VideoSummary video={{ ...baseVideo, moments: [{ t: "bad-time", note: "note" }] }} locale="zh" />);
    expect(screen.queryByRole("link", { name: "bad-time" })).toBeNull();
    expect(screen.getByText("bad-time")).toBeTruthy();
  });
});
