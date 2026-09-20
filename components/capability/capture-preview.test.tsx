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
