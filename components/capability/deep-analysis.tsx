"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { deepAnalysisAction } from "../../app/actions";
import type { DeepAnalysis } from "../../lib/analysis/card";
import { formatDateTime } from "../../lib/library/format";
import { errorLabel } from "../../lib/library/labels";
import { safeHttpUrl } from "../../lib/library/safe-url";
import { format, getDict, type Locale } from "../../lib/i18n";

type State = "idle" | "busy" | "queued";

/** Width below which every section starts collapsed (owner ruling: 手机上单栏、分区全部默认折叠). */
const NARROW_QUERY = "(max-width: 720px)";

function mediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(NARROW_QUERY);
}

/**
 * Whether the viewport is narrow, as an external store rather than state synced in an effect:
 * the server snapshot is always `false` (so the server markup and hydration agree — 架构 open),
 * and the client snapshot takes over right after hydration, collapsing everything on a phone.
 */
function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = mediaQuery();
      if (!mql || typeof mql.addEventListener !== "function") return () => {};
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => mediaQuery()?.matches ?? false,
    () => false
  );
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * One collapsible section of a deep analysis. Controlled (`open`/`onToggle`) rather than using
 * `<details defaultOpen>` so the narrow-viewport collapse above can close 架构 after hydration.
 * The item count sits in the summary so the owner can see how much is inside without opening it.
 */
function Section({
  title, count, open, onToggle, summary, children
}: {
  title: string; count: string; open: boolean; onToggle: (next: boolean) => void;
  summary?: string; children: ReactNode;
}) {
  return (
    <details className="deep-section" open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="deep-section__title">{title}</span>
        <span className="deep-section__count">{count}</span>
      </summary>
      {summary && <p className="deep-section__summary">{summary}</p>}
      {children}
    </details>
  );
}

/** A `[n]` citation linking down to the collapsed source list at the bottom of the section. */
function SourceRef({ index, label }: { index: number; label: string }) {
  return (
    <a className="deep-ref" href={`#deep-source-${index + 1}`} aria-label={label}>[{index + 1}]</a>
  );
}

/**
 * The 深度分析 section of a card's detail page: triggers a deep-analysis run and renders its
 * result. Owner design decision 5 — a deep analysis must never read as a wall of text, so the
 * result is a summary strip plus six collapsible, count-labeled sections of short bullets (never
 * paragraphs), with cases citing their retrieved source and an empty field dropping its whole
 * section rather than rendering an empty heading.
 *
 * `analysis` is stored jsonb written by a schema-validated pipeline (see lib/analysis/deep.ts),
 * but it is still read defensively here (`?? []`, optional chaining) — a row written by an older
 * or future shape must degrade to fewer sections, never crash the detail page.
 */
export function DeepAnalysisSection({
  captureId,
  analysis,
  analysisOf,
  runState,
  errorCode,
  locale = "zh"
}: {
  captureId: string;
  analysis: DeepAnalysis | null;
  analysisOf: string | null;
  runState: string | null;
  errorCode: string | null;
  locale?: Locale;
}) {
  const dict = getDict(locale).deepAnalysis;
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);
  // `open` holds only the sections the owner has actually toggled; anything untouched falls back
  // to the default below — 架构 alone, and nothing at all on a narrow viewport.
  const narrow = useNarrowViewport();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (key: string) => open[key] ?? (!narrow && key === "architecture");

  const active = runState === "queued" || runState === "running" || state === "queued";
  const failed = runState === "failed" && state === "idle";

  async function start() {
    if (active || state === "busy") return;
    setState("busy");
    setMessage(null);
    try {
      const result = await deepAnalysisAction(captureId);
      if (result.ok) {
        // The queued notice itself is rendered by the `active` branch below, which also hides the
        // trigger — so a second press can't queue anything before the page refreshes.
        setState("queued");
        router.refresh();
        return;
      }
      setMessage(result.message);
      setState("idle");
    } catch {
      setMessage(dict.genericError);
      setState("idle");
    }
  }

  const sources = analysis?.sources ?? [];
  const cases = analysis?.cases ?? [];
  const positive = analysis?.feedback?.positive ?? [];
  const negative = analysis?.feedback?.negative ?? [];
  const risks = analysis?.risks ?? [];
  const useCases = analysis?.use_cases ?? [];
  const architecture = analysis?.architecture;
  const implementation = analysis?.implementation;
  const count = (n: number) => format(dict.itemCount, { count: n });
  const toggle = (key: string) => (next: boolean) => setOpen((prev) => ({ ...prev, [key]: next }));

  return (
    <section className="panel deep-analysis" id="deep-analysis">
      <h2 className="panel-title">{dict.title}</h2>

      {analysis && (
        <>
          <div className="deep-strip">
            <p className="deep-strip__headline">{analysis.headline}</p>
            <div className="deep-strip__chips">
              {useCases[0] && <span className="chip">{dict.bestFor}：{useCases[0].title}</span>}
              {risks[0] && <span className="chip">{dict.topRisk}：{risks[0]}</span>}
              <span className="chip">{format(dict.sourceCount, { count: sources.length })}</span>
            </div>
          </div>

          {architecture && (
            <Section
              title={dict.architecture}
              count={count(architecture.points?.length ?? 0)}
              open={isOpen("architecture")}
              onToggle={toggle("architecture")}
              summary={architecture.summary}
            >
              <ul className="deep-points">
                {(architecture.points ?? []).map((point, i) => <li key={i}>{point}</li>)}
              </ul>
            </Section>
          )}

          {implementation && (
            <Section
              title={dict.implementation}
              count={count(implementation.points?.length ?? 0)}
              open={isOpen("implementation")}
              onToggle={toggle("implementation")}
              summary={implementation.summary}
            >
              <ul className="deep-points">
                {(implementation.points ?? []).map((point, i) => <li key={i}>{point}</li>)}
              </ul>
            </Section>
          )}

          {useCases.length > 0 && (
            <Section
              title={dict.useCases}
              count={count(useCases.length)}
              open={isOpen("useCases")}
              onToggle={toggle("useCases")}
            >
              <ul className="deep-points">
                {useCases.map((useCase, i) => (
                  <li key={i}><b>{useCase.title}</b>　{useCase.detail}</li>
                ))}
              </ul>
            </Section>
          )}

          {cases.length > 0 && (
            <Section
              title={dict.cases}
              count={count(cases.length)}
              open={isOpen("cases")}
              onToggle={toggle("cases")}
            >
              <ul className="deep-points">
                {cases.map((item, i) => (
                  <li key={i}>
                    <b>{item.title}</b>　{item.detail}
                    {item.source < sources.length && (
                      <SourceRef index={item.source} label={format(dict.sourceRefAria, { n: item.source + 1 })} />
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {(positive.length > 0 || negative.length > 0) && (
            <Section
              title={dict.feedback}
              count={count(positive.length + negative.length)}
              open={isOpen("feedback")}
              onToggle={toggle("feedback")}
            >
              {positive.length > 0 && (
                <>
                  <p className="deep-section__label">{dict.feedbackPositive}</p>
                  <ul className="deep-points">{positive.map((item, i) => <li key={i}>{item}</li>)}</ul>
                </>
              )}
              {negative.length > 0 && (
                <>
                  <p className="deep-section__label">{dict.feedbackNegative}</p>
                  <ul className="deep-points">{negative.map((item, i) => <li key={i}>{item}</li>)}</ul>
                </>
              )}
            </Section>
          )}

          {risks.length > 0 && (
            <Section
              title={dict.risks}
              count={count(risks.length)}
              open={isOpen("risks")}
              onToggle={toggle("risks")}
            >
              <ul className="deep-points">{risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul>
            </Section>
          )}

          {sources.length > 0 && (
            <details className="deep-sources">
              <summary>{format(dict.sourceCount, { count: sources.length })}</summary>
              <ol className="deep-sources__list">
                {sources.map((source, i) => {
                  // Model-supplied URLs (z.string().url() accepts javascript:/data:) — only render
                  // an anchor when it parses as http/https, same rule as AnalysisDetails.
                  const safe = safeHttpUrl(source.url);
                  const body = <>{source.title} · <span className="deep-sources__domain">{domain(source.url)}</span></>;
                  return (
                    <li key={i} id={`deep-source-${i + 1}`}>
                      {safe ? <a href={safe} target="_blank" rel="noreferrer">{body}</a> : body}
                    </li>
                  );
                })}
              </ol>
            </details>
          )}

          {analysisOf && (
            <p className="deep-analysis__based-on">{format(dict.basedOn, { date: formatDateTime(analysisOf, locale) })}</p>
          )}
        </>
      )}

      {active && <p className="notice">{state === "queued" ? dict.queuedNotice : dict.runningNotice}</p>}
      {failed && <p className="inline-error">{dict.failedPrefix}{errorLabel(errorCode, locale)}</p>}
      {!active && (
        <div className="deep-analysis__trigger">
          <button type="button" className="btn btn--primary" disabled={state === "busy"} onClick={start}>
            {state === "busy" ? dict.starting : (analysis || failed ? dict.retry : dict.start)}
          </button>
          <p className="deep-analysis__cost">{dict.costNote}</p>
        </div>
      )}
      {message && <p className="inline-error">{message}</p>}
    </section>
  );
}
