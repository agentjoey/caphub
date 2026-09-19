import { describe, expect, it } from "vitest";
import { EMBED_BACKOFF_INITIAL_MS, EMBED_BACKOFF_MAX_MS, EmbedBackoff } from "./embed-backoff";

describe("EmbedBackoff", () => {
  it("never skips before any error", () => {
    const backoff = new EmbedBackoff(() => 0);
    expect(backoff.shouldSkip()).toBe(false);
  });

  it("skips for a 5 minute window starting at the first error", () => {
    let now = 1_000_000;
    const backoff = new EmbedBackoff(() => now);
    backoff.onError();
    expect(backoff.shouldSkip()).toBe(true);
    now += EMBED_BACKOFF_INITIAL_MS - 1;
    expect(backoff.shouldSkip()).toBe(true);
    now += 1;
    expect(backoff.shouldSkip()).toBe(false);
  });

  it("doubles the delay per consecutive error", () => {
    let now = 0;
    const backoff = new EmbedBackoff(() => now);
    backoff.onError();
    now += EMBED_BACKOFF_INITIAL_MS; // window elapses
    backoff.onError();
    expect(backoff.shouldSkip()).toBe(true);
    now += EMBED_BACKOFF_INITIAL_MS * 2 - 1;
    expect(backoff.shouldSkip()).toBe(true);
    now += 1;
    expect(backoff.shouldSkip()).toBe(false);
  });

  it("caps the delay at 1 hour", () => {
    let now = 0;
    const backoff = new EmbedBackoff(() => now);
    for (let i = 0; i < 10; i++) {
      backoff.onError();
      now += EMBED_BACKOFF_MAX_MS + 1; // always let the window elapse before the next error
    }
    backoff.onError();
    const skipStart = now;
    expect(backoff.shouldSkip()).toBe(true);
    now = skipStart + EMBED_BACKOFF_MAX_MS - 1;
    expect(backoff.shouldSkip()).toBe(true);
    now = skipStart + EMBED_BACKOFF_MAX_MS + 1;
    expect(backoff.shouldSkip()).toBe(false);
  });

  it("resets the delay on success/idle, so the next error starts back at the 5 minute floor", () => {
    let now = 0;
    const backoff = new EmbedBackoff(() => now);
    backoff.onError();
    now += EMBED_BACKOFF_INITIAL_MS;
    backoff.onError(); // delay would now be 10 min if not reset
    backoff.reset();
    expect(backoff.shouldSkip()).toBe(false);
    now += 1;
    backoff.onError();
    const start = now;
    now = start + EMBED_BACKOFF_INITIAL_MS - 1;
    expect(backoff.shouldSkip()).toBe(true);
    now = start + EMBED_BACKOFF_INITIAL_MS + 1;
    expect(backoff.shouldSkip()).toBe(false);
  });
});
