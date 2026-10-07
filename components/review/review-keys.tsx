"use client";

import { useEffect, useState } from "react";
import { format } from "../../lib/i18n";

/** Fired on `window` by ReviewCard once a card's decision is saved; `detail` is `{ id }`. */
export const REVIEW_DONE_EVENT = "caphub:review-done";

const ACTION_FOR_KEY: Record<string, string> = { y: "keep", x: "discard", e: "edit", r: "rerun" };

function pendingCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-review-item][data-state='idle']"));
}

function focusCard(card: HTMLElement | undefined) {
  if (!card) return;
  card.focus({ preventScroll: true });
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  card.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Keyboard triage for the Review page: J/K step through the cards still pending, Y/X/E/R press
 * the current card's keep/discard/edit/rerun button. The "current" card is whichever one holds
 * focus, else the first pending card. Keys typed into a field, and any key with ⌘/Ctrl/Alt, are
 * left alone. Also shows how many cards are left, counting down as ReviewCard reports decisions.
 */
export function ReviewKeys({ total, labels }: { total: number; labels: { remaining: string; hint: string } }) {
  const [decided, setDecided] = useState(0);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const cards = pendingCards();
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-review-item]") ?? null;
      const index = focused ? cards.indexOf(focused) : -1;
      if (key === "j" || key === "k") {
        event.preventDefault();
        const next = key === "j" ? (index < 0 ? 0 : index + 1) : (index < 0 ? 0 : index - 1);
        focusCard(cards[Math.max(0, Math.min(cards.length - 1, next))]);
        return;
      }
      const action = ACTION_FOR_KEY[key];
      if (!action) return;
      const card = index >= 0 ? cards[index] : cards[0];
      const button = card?.querySelector<HTMLButtonElement>(`button[data-action='${action}']`);
      if (!button || button.disabled) return;
      event.preventDefault();
      button.click();
    }

    function onDone(event: Event) {
      setDecided((n) => n + 1);
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      const all = Array.from(document.querySelectorAll<HTMLElement>("[data-review-item]"));
      const from = all.findIndex((el) => el.id === id);
      const next = all.slice(from + 1).find((el) => el.dataset.state === "idle") ?? pendingCards()[0];
      // Only take focus if it was on (or inside) the card just decided — never yank it out of
      // another card's open editor.
      const active = document.activeElement;
      const decidedCard = id ? document.getElementById(id) : null;
      if (!active || active === document.body || (decidedCard && decidedCard.contains(active))) focusCard(next);
    }

    document.addEventListener("keydown", onKeyDown);
    window.addEventListener(REVIEW_DONE_EVENT, onDone);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(REVIEW_DONE_EVENT, onDone);
    };
  }, []);

  return (
    <div className="review-keys">
      <p className="review-keys__remaining" aria-live="polite">{format(labels.remaining, { count: Math.max(0, total - decided) })}</p>
      <p className="review-keys__hint" aria-hidden="true">{labels.hint}</p>
    </div>
  );
}
