// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { CaptureForm } from "./capture-form";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each([false, true])(
  "preselects initialFile, calls onSubmitted only for new captures (duplicate=%s)",
  async (duplicate) => {
    const onSubmitted = vi.fn();
    const file = new File(["image"], "desk.png", { type: "image/png" });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ duplicate }) });
    vi.stubGlobal("fetch", fetcher);
    render(<CaptureForm initialFile={file} onSubmitted={onSubmitted} />);
    expect(screen.getByText("desk.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "投递" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(duplicate ? 0 : 1));
    expect(fetcher.mock.calls[0][1].body.get("file")).toBe(file);
    if (duplicate) expect(await screen.findByText(/这条内容之前投递过/)).toBeTruthy();
  }
);
