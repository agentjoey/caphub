// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CapturePreview, CollapsedCapturePreview, type CapturePreviewData } from "./capture-preview";
import { formatDateTime } from "../../lib/library/format";

afterEach(cleanup);

const baseImage: CapturePreviewData = {
  kind: "image", objectKey: "sha256/ab/" + "a".repeat(64), thumbKey: "thumb/sha256/ab/" + "a".repeat(64) + ".webp",
  text: null, url: null
};

describe("CapturePreview (thumb size)", () => {
  it("uses the thumbnail key for the thumb-size tile when present", () => {
    render(<CapturePreview capture={baseImage} size="thumb" />);
    expect(screen.getByRole("img").getAttribute("src")).toBe(`/api/objects/${baseImage.thumbKey}`);
  });

  it("falls back to the original when no thumbnail exists yet", () => {
    render(<CapturePreview capture={{ ...baseImage, thumbKey: null }} size="thumb" />);
    expect(screen.getByRole("img").getAttribute("src")).toBe(`/api/objects/${baseImage.objectKey}`);
  });

  it("swaps a failed tile (purged original, no thumbnail) for the no-image placeholder instead of a broken image", () => {
    const { container } = render(<CapturePreview capture={{ ...baseImage, thumbKey: null }} size="thumb" />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
    const tile = container.querySelector("span.thumb");
    expect(tile?.textContent).toBe("无图");
  });
});

describe("CapturePreview (full size)", () => {
  it("uses the original image when the retention window shows it isn't purged", () => {
    render(<CapturePreview capture={{ ...baseImage, retentionEligibleAt: "2026-10-20T00:00:00.000Z", retentionPurgedAt: null }} size="full" />);
    expect(screen.getByRole("img").getAttribute("src")).toBe(`/api/objects/${baseImage.objectKey}`);
    expect(screen.queryByText(/仅保留缩略图/)).toBeNull();
  });

  it("shows the thumbnail with a purge note (server-known purge) instead of ever requesting the original", () => {
    render(<CapturePreview capture={{ ...baseImage, retentionEligibleAt: "2026-09-20T08:00:00.000Z", retentionPurgedAt: "2026-09-20T08:00:00.000Z" }} size="full" />);
    expect(screen.getByRole("img").getAttribute("src")).toBe(`/api/objects/${baseImage.thumbKey}`);
    expect(screen.getByText(`原图已于 ${formatDateTime("2026-09-20T08:00:00.000Z")} 清除，仅保留缩略图`)).toBeTruthy();
  });

  it("falls back to the thumbnail (with no purge claim) on a client onError, since the server hasn't confirmed a purge", () => {
    render(<CapturePreview capture={{ ...baseImage, retentionEligibleAt: "2026-09-20T08:00:00.000Z", retentionPurgedAt: null }} size="full" />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe(`/api/objects/${baseImage.objectKey}`);
    fireEvent.error(img);
    expect(screen.getByRole("img").getAttribute("src")).toBe(`/api/objects/${baseImage.thumbKey}`);
    expect(screen.queryByText(/清除/)).toBeNull();
  });

  it("shows a placeholder instead of a broken image when the server-known-purged original has no thumbnail", () => {
    render(<CapturePreview capture={{ ...baseImage, thumbKey: null, retentionEligibleAt: "2026-09-20T08:00:00.000Z", retentionPurgedAt: "2026-09-20T08:00:00.000Z" }} size="full" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("无图")).toBeTruthy();
  });

  it("shows a placeholder when there is neither an original nor a thumbnail", () => {
    render(<CapturePreview capture={{ kind: "image", objectKey: null, thumbKey: null, text: null, url: null }} size="full" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("无图")).toBeTruthy();
  });
});

const baseUrl: CapturePreviewData = { kind: "url", objectKey: null, thumbKey: null, text: null, url: "https://example.com/some-article" };
const youtubeUrl: CapturePreviewData = { kind: "url", objectKey: null, thumbKey: null, text: null, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };

describe("CapturePreview (url kind)", () => {
  it("renders the plain link placeholder for a non-YouTube link (thumb)", () => {
    render(<CapturePreview capture={baseUrl} size="thumb" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("链接")).toBeTruthy();
  });

  it("renders the original link unchanged for a non-YouTube link (full)", () => {
    render(<CapturePreview capture={baseUrl} size="full" />);
    expect(screen.queryByRole("img")).toBeNull();
    const link = screen.getByRole("link", { name: baseUrl.url! });
    expect(link.getAttribute("href")).toBe(baseUrl.url);
  });

  it("renders the i.ytimg thumbnail for a YouTube link (thumb)", () => {
    const { container } = render(<CapturePreview capture={youtubeUrl} size="thumb" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
    // Decorative (always beside the title or link): hidden from assistive tech.
    expect(img.getAttribute("alt")).toBe("");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders the thumbnail plus the original link for a YouTube link (full)", () => {
    const { container } = render(<CapturePreview capture={youtubeUrl} size="full" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
    expect(img.getAttribute("alt")).toBe("");
    const link = screen.getByRole("link", { name: youtubeUrl.url! });
    expect(link.getAttribute("href")).toBe(youtubeUrl.url);
  });
});

describe("CollapsedCapturePreview", () => {
  it("renders a <details> titled 原始投递, closed by default", () => {
    const { container } = render(<CollapsedCapturePreview capture={baseImage} />);
    const details = container.querySelector("details.capture-collapse") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("原始投递");
  });

  it("still renders the purged-original fallback (thumbnail + purge note) inside the collapsed block", () => {
    render(
      <CollapsedCapturePreview
        capture={{ ...baseImage, retentionEligibleAt: "2026-09-20T08:00:00.000Z", retentionPurgedAt: "2026-09-20T08:00:00.000Z" }}
      />
    );
    expect(screen.getByRole("img").getAttribute("src")).toBe(`/api/objects/${baseImage.thumbKey}`);
    expect(screen.getByText(`原图已于 ${formatDateTime("2026-09-20T08:00:00.000Z")} 清除，仅保留缩略图`)).toBeTruthy();
  });
});
