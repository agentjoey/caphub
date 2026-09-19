// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

import { CaptureForm } from "./capture-form";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pngFile(name = "shot.png") {
  return new File(["fake"], name, { type: "image/png" });
}

describe("CaptureForm", () => {
  it("disables the link and text inputs once an image is chosen", () => {
    render(<CaptureForm />);
    const input = screen.getByLabelText("截图文件") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });
    expect((screen.getByLabelText(/^链接\s/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^文字\s/) as HTMLInputElement).disabled).toBe(true);
  });

  it("blocks submit and warns when both link and text are filled", () => {
    render(<CaptureForm />);
    fireEvent.change(screen.getByLabelText(/^链接\s/), { target: { value: "https://example.com" } });
    fireEvent.change(screen.getByLabelText(/^文字\s/), { target: { value: "some text" } });
    expect(screen.getByRole("button", { name: "链接和文字请只填一项" })).toHaveProperty("disabled", true);
  });

  it("blocks submit and shows an inline error when the link does not start with https://", () => {
    render(<CaptureForm />);
    fireEvent.change(screen.getByLabelText(/^链接\s/), { target: { value: "http://example.com" } });
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "链接需以 https:// 开头");
    expect(screen.getByRole("button", { name: "链接需以 https:// 开头" })).toHaveProperty("disabled", true);
  });

  it("shows the duplicate notice with a link to the existing card when the API reports a duplicate", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ captureId: "cap_1", kind: "text", duplicate: true, capabilityId: "cab_1" })
    });
    render(<CaptureForm />);
    fireEvent.change(screen.getByLabelText(/^文字\s/), { target: { value: "some text" } });
    fireEvent.click(screen.getByRole("button", { name: "投递" }));
    await waitFor(() => expect(screen.getByText(/这条内容之前投递过，已指向原记录/)).toBeTruthy());
    expect(screen.getByRole("link", { name: "查看已有卡片" }).getAttribute("href")).toBe("/library/cab_1");
  });

  it("shows the duplicate notice without a link when the duplicate has no capability card", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ captureId: "cap_1", kind: "text", duplicate: true, capabilityId: null })
    });
    render(<CaptureForm />);
    fireEvent.change(screen.getByLabelText(/^文字\s/), { target: { value: "some text" } });
    fireEvent.click(screen.getByRole("button", { name: "投递" }));
    await waitFor(() => expect(screen.getByText(/这条内容之前投递过，已指向原记录/)).toBeTruthy());
    expect(screen.queryByRole("link", { name: "查看已有卡片" })).toBeNull();
  });
});
