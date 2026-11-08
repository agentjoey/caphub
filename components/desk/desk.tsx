"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { decideAction, editSuggestionAction, rerunAction } from "../../app/actions";
import { CaptureForm } from "../../app/(chrome)/capture-form";
import { SuggestionEditor } from "../review/suggestion-editor";
import { format, getDict, type Locale } from "../../lib/i18n";
import type { CapabilityType } from "../../lib/analysis/card";
import { deskKey, type DeskItem, type PileItem } from "./desk-items";
import { itemText, itemTitle } from "./desk-copy";
import type { DeskScene } from "./scene";
const subscribeViewport = (notify: () => void) => {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
};
const mobileSnapshot = () => window.innerWidth < 700;
const listSnapshot = () => {
  try {
    return localStorage.getItem("caphub-desk-list") === "true";
  } catch {
    return false;
  }
};
const subscribeStorage = (notify: () => void) => {
  window.addEventListener("storage", notify);
  return () => window.removeEventListener("storage", notify);
};
const serverSnapshot = () => false;
type Props = {
  items: DeskItem[];
  pile: PileItem[];
  total: number;
  libraryCount: number;
  locale: Locale;
  recent?: ReactNode;
  captureSources?: Record<string, { kind: "image" | "text" | "url"; url: string | null }>;
};
export function Desk({ items, pile, total, libraryCount, locale, recent, captureSources = {} }: Props) {
  const dict = getDict(locale),
    d = dict.desk,
    router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const host = useRef<HTMLDivElement>(null),
    scene = useRef<DeskScene | null>(null),
    toolbar = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDialogElement>(null);
  const wall = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null);
  const storedList = useSyncExternalStore(subscribeStorage, listSnapshot, serverSnapshot);
  const mobile = useSyncExternalStore(subscribeViewport, mobileSnapshot, serverSnapshot);
  const [listChoice, setList] = useState<boolean | null>(null);
  const list = listChoice ?? storedList;
  const [ready, setReady] = useState(false),
    [unavailable, setUnavailable] = useState(false);
  const [selected, setSelected] = useState<string | null>(null),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    lock = useRef(false);
  const [message, setMessage] = useState<string | null>(null),
    [toast, setToast] = useState(""),
    [captureOpen, setCaptureOpen] = useState(false),
    [initialFile, setInitialFile] = useState<File | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, "keep" | "discard">>({});
  // Mirrors `optimistic` for the scene's pick callback, which is created once and would otherwise
  // read a stale closure: a card already kept/discarded must not be reopened before the refresh.
  const decided = useRef(optimistic);
  useEffect(() => {
    decided.current = optimistic;
  }, [optimistic]);
  const [rerunning, setRerunning] = useState<{ source: DeskItem; running: DeskItem } | null>(null);
  const visible = useMemo(
    () =>
      items.slice(0, mobile ? 10 : 24).map((item) => (rerunning?.source === item ? rerunning.running : item)),
    [items, mobile, rerunning]
  );
  const active = visible.find((i) => i.captureId === selected);
  const activeKey = active?.captureId;
  const latest = useRef({ visible, pile });
  useEffect(() => {
    latest.current = { visible, pile };
    scene.current?.sync(visible, pile);
  }, [visible, pile]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(
          e.target instanceof HTMLElement &&
          (e.target.closest("input, textarea, select, [contenteditable=true]") || e.target.closest("dialog"))
        )
      ) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    if (typeof window === "undefined" || list || unavailable || !host.current) return;
    let cancelled = false;
    const element = host.current;
    import("./scene")
      .then((m) =>
        m.createDeskScene(
          element,
          locale,
          (key) => {
            if (lock.current) return;
            const item = latest.current.visible.find((i) => deskKey(i) === key);
            if (item && decided.current[item.captureId]) return;
            if (item) {
              setSelected(item.captureId);
              setMessage(null);
              setEditing(false);
            }
          },
          () => routerRef.current.push("/library")
        )
      )
      .then((s) => {
        if (cancelled) {
          s.dispose();
          return;
        }
        scene.current = s;
        s.sync(latest.current.visible, latest.current.pile);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setUnavailable(true);
          setList(true);
        }
      });
    return () => {
      cancelled = true;
      scene.current?.dispose();
      scene.current = null;
      setReady(false);
    };
  }, [list, unavailable, locale]);
  useEffect(() => {
    if (!captureOpen && visible.some((i) => i.kind === "running")) {
      const timer = setInterval(() => router.refresh(), 3000);
      return () => clearInterval(timer);
    }
  }, [visible, captureOpen, router]);
  useEffect(() => {
    if (activeKey) toolbar.current?.focus();
  }, [activeKey]);
  useLayoutEffect(() => {
    const measure = () => {
      if (!host.current || !wall.current) return;
      const canvas = host.current.getBoundingClientRect();
      scene.current?.setOpenBand({
        top: wall.current.getBoundingClientRect().bottom - canvas.top,
        bottom: (actions.current?.getBoundingClientRect().top ?? canvas.bottom) - canvas.top
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const element of [host.current, wall.current, actions.current]) if (element) observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [ready, activeKey, editing, message]);
  function open(item: DeskItem) {
    if (lock.current) return;
    setSelected(item.captureId);
    setEditing(false);
    setMessage(null);
    scene.current?.open(deskKey(item));
  }
  function putBack() {
    if (lock.current) return;
    scene.current?.putBack();
    setSelected(null);
    setEditing(false);
  }
  function capture(file: File | null = null) {
    setInitialFile(file);
    setCaptureOpen(true);
    dialog.current?.showModal();
  }
  function closeCapture() {
    dialog.current?.close();
    setCaptureOpen(false);
  }
  function toggleList() {
    const value = !list;
    setList(value);
    try {
      localStorage.setItem("caphub-desk-list", String(value));
    } catch {}
  }
  async function act(
    action: "keep" | "discard" | "rerun" | "edit",
    edit?: {
      type: CapabilityType;
      usage: "integrate" | "reference";
      tags: string[];
    }
  ): Promise<string | null> {
    if (
      !active ||
      lock.current ||
      active.kind === "running" ||
      (active.kind !== "pending" && action !== "rerun")
    )
      return null;
    const item = active;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    setToast("");
    if (action === "keep" || action === "discard") {
      scene.current?.[action === "keep" ? "file" : "trash"](deskKey(item));
      setOptimistic((o) => ({ ...o, [item.captureId]: action }));
    }
    try {
      const result =
        action === "rerun"
          ? await rerunAction(item.captureId)
          : item.kind === "pending"
            ? action === "edit" && edit
              ? await editSuggestionAction(item.id, item.updatedAt, edit.type, edit.usage, edit.tags)
              : await decideAction(item.id, item.updatedAt, action as "keep" | "discard")
            : null;
      if (!result?.ok) {
        const error = result && !result.ok ? result.message : dict.detailActions.genericError;
        setMessage(error);
        setToast(error);
        setOptimistic((o) => {
          const next = { ...o };
          delete next[item.captureId];
          return next;
        });
        scene.current?.sync(latest.current.visible, latest.current.pile);
        scene.current?.open(deskKey(item));
        if (result && !result.ok && result.reason === "CONFLICT") router.refresh();
        return action === "edit" ? error : null;
      }
      if (action === "edit") {
        scene.current?.file(deskKey(item));
        setOptimistic((o) => ({ ...o, [item.captureId]: "keep" }));
      }
      if (action === "rerun") {
        scene.current?.putBack();
        const source = captureSources[item.captureId];
        setRerunning({
          source: item,
          running: {
            kind: "running",
            captureId: item.captureId,
            createdAt: item.createdAt,
            captureKind: source?.kind ?? (item.kind === "failed" ? item.captureKind : "text"),
            url: source?.url ?? null,
            okSteps: [],
            preview: item.kind === "pending" ? item.title : item.preview
          }
        });
      }
      setToast(
        action === "rerun"
          ? d.queued
          : format(action === "discard" ? d.discarded : d.kept, { title: itemTitle(item, locale) })
      );
      setSelected(null);
      setEditing(false);
      router.refresh();
      return null;
    } catch {
      setMessage(dict.detailActions.genericError);
      setToast(dict.detailActions.genericError);
      setOptimistic((o) => {
        const next = { ...o };
        delete next[item.captureId];
        return next;
      });
      scene.current?.sync(latest.current.visible, latest.current.pile);
      scene.current?.open(deskKey(item));
      return dict.detailActions.genericError;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const count =
    libraryCount +
    Object.entries(optimistic).filter(
      ([id, action]) =>
        action === "keep" && items.some((i) => i.captureId === id) && !pile.some((i) => i.captureId === id)
    ).length;
  return (
    <div
      className="desk-home"
      data-desk-rendering="off"
      data-busy={busy || undefined}
      data-list={list || !ready ? "true" : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length && !captureOpen) {
          e.preventDefault();
          const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
          if (file) capture(file);
        }
      }}
    >
      <div ref={wall} className="desk-wall">
        <form action="/library" method="get" role="search">
          <input ref={search} type="search" name="q" aria-label={d.search} placeholder={d.search} />
          <button type="submit">{d.searchButton}</button>
        </form>
        <button type="button" onClick={() => capture()}>
          {d.capture}
        </button>
      </div>
      <ul className="desk-accessible" aria-label={d.items}>
        {visible.filter((item) => !optimistic[item.captureId]).map((item) => (
          <li key={deskKey(item)}>
            <button
              disabled={busy}
              onFocus={() => scene.current?.focus(deskKey(item))}
              onBlur={() => scene.current?.focus(null)}
              onClick={() => open(item)}
            >
              {itemTitle(item, locale)}
            </button>
          </li>
        ))}
      </ul>
      <div ref={host} className="desk-canvas" aria-hidden="true" />
      <div className="desk-fallback" hidden={!list && ready}>
        <ul>
          {visible.map((item) => (
            <li key={deskKey(item)}>
              <Link href={item.kind === "pending" ? `/library/${item.id}` : "/review"}>
                {itemTitle(item, locale)}
              </Link>
              <p>{itemText(item, locale)}</p>
            </li>
          ))}
        </ul>
        {recent}
      </div>
      {!visible.length && <p className="desk-empty">{d.empty}</p>}
      <div className="desk-footer">
        <p>
          {format(d.count, { count: visible.length })}
          {total > visible.length && (
            <>
              {" "}
              · <Link href="/review">{format(d.overflow, { count: total - visible.length })}</Link>
            </>
          )}
        </p>
        <p>{d.hint}</p>
        {!unavailable && (
          <button type="button" onClick={toggleList}>
            {list ? d.scene : d.list}
          </button>
        )}
      </div>
      <Link className="desk-library" href="/library" title={d.openLibrary}>
        {format(d.library, { count })}
      </Link>
      {active && (
        <div ref={actions} className="desk-actions">
          {editing && active.kind === "pending" && (
            <SuggestionEditor
              initialType={active.type}
              initialUsage={active.usage}
              initialTags={active.tags}
              disabled={busy}
              locale={locale}
              onSave={(type, usage, tags) => act("edit", { type, usage, tags })}
            />
          )}
          <div
            ref={toolbar}
            role="toolbar"
            aria-label={d.toolbar}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (
                e.target instanceof HTMLElement &&
                e.target.closest("input, textarea, select, [contenteditable=true]")
              )
                return;
              // Leave browser and OS shortcuts (Cmd+R reload, Cmd+X cut…) alone.
              if (busy || e.metaKey || e.ctrlKey || e.altKey) return;
              const key = e.key.toLowerCase();
              if (key === "enter" && e.target === e.currentTarget && active.kind === "pending") {
                e.preventDefault();
                router.push(`/library/${active.id}`);
              }
              if (key === "escape") {
                e.preventDefault();
                putBack();
              }
              if (active.kind === "pending" && ["y", "x", "e"].includes(key)) {
                e.preventDefault();
                if (key === "e") setEditing((v) => !v);
                else void act(key === "y" ? "keep" : "discard");
              }
              if (key === "r" && active.kind !== "running") {
                e.preventDefault();
                void act("rerun");
              }
            }}
          >
            {active.kind === "pending" && (
              <>
                <button disabled={busy} onClick={() => act("keep")}>
                  {dict.detailActions.keep}
                  <kbd>Y</kbd>
                </button>
                <button disabled={busy} onClick={() => act("discard")}>
                  {dict.detailActions.discard}
                  <kbd>X</kbd>
                </button>
                <button disabled={busy} onClick={() => setEditing((v) => !v)}>
                  {dict.detailActions.editSuggestion}
                  <kbd>E</kbd>
                </button>
              </>
            )}
            {active.kind !== "running" && (
              <button disabled={busy} onClick={() => act("rerun")}>
                {dict.detailActions.rerun}
                <kbd>R</kbd>
              </button>
            )}
            {active.kind === "pending" && (
              <button disabled={busy} onClick={() => router.push(`/library/${active.id}`)}>
                {d.detail}
                <kbd>↵</kbd>
              </button>
            )}
            <button disabled={busy} onClick={putBack}>
              {d.back}
              <kbd>Esc</kbd>
            </button>
          </div>
          {message && <p className="desk-error">{message}</p>}
        </div>
      )}
      <div className="desk-sr" aria-live="polite">
        {active ? itemText(active, locale) : ""}
      </div>
      <div className="desk-toast" role="status" aria-live="polite">
        {toast}
      </div>
      <dialog
        ref={dialog}
        className="desk-dialog"
        aria-label={d.capture}
        onClose={() => setCaptureOpen(false)}
      >
        <button type="button" onClick={closeCapture}>
          {d.close}
        </button>
        {captureOpen && (
          <CaptureForm
            locale={locale}
            initialFile={initialFile}
            onSubmitted={() => {
              closeCapture();
              router.refresh();
            }}
          />
        )}
      </dialog>
    </div>
  );
}
