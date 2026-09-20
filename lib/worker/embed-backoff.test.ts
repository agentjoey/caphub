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

describe("EmbedBackoff — injectable floor/cap", () => {
  it("uses the injected initial/max instead of the embed defaults", () => {
    let now = 0;
    const backoff = new EmbedBackoff({ now: () => now, initialMs: 2_000, maxMs: 60_000 });
    backoff.onError();
    expect(backoff.remainingMs()).toBe(2_000);
    now += 2_000;
    backoff.onError(); // doubles: 4_000
    expect(backoff.remainingMs()).toBe(4_000);
  });

  it("caps doubling at the injected max, not the embed default", () => {
    const backoff = new EmbedBackoff({ now: () => 0, initialMs: 2_000, maxMs: 60_000 });
    for (let i = 0; i < 10; i++) backoff.onError();
    expect(backoff.remainingMs()).toBe(60_000); // proves it isn't using the 5 min/1 h embed defaults
  });

  it("onError(overrideMs) backs off by exactly that long (e.g. a 429's retry_after), capped at max", () => {
    let now = 1_000;
    const backoff = new EmbedBackoff({ now: () => now, initialMs: 2_000, maxMs: 60_000 });
    backoff.onError(5_000);
    expect(backoff.remainingMs()).toBe(5_000);
    now += 5_000;
    expect(backoff.shouldSkip()).toBe(false);
  });

  it("onError(overrideMs) is capped at max even when the override is larger", () => {
    const backoff = new EmbedBackoff({ now: () => 0, initialMs: 2_000, maxMs: 60_000 });
    backoff.onError(999_000);
    expect(backoff.remainingMs()).toBe(60_000);
  });

  it("a plain onError() after an override doubles from the pre-override delay, not the override", () => {
    let now = 0;
    const backoff = new EmbedBackoff({ now: () => now, initialMs: 2_000, maxMs: 60_000 });
    backoff.onError(50_000); // override; internal doubling delay stays at 0
    now += 50_000;
    backoff.onError(); // no prior plain error yet -> floor
    expect(backoff.remainingMs()).toBe(2_000);
  });
});
