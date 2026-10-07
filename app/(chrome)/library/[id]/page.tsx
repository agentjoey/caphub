import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NO_OVERLAP } from "../../../../lib/analysis/card";
import { loadScenarios } from "../../../../lib/analysis/scenarios";
import { AnalysisDetails } from "../../../../components/capability/analysis-details";
import { BuildNotes } from "../../../../components/capability/build-notes";
import { CollapsedCapturePreview } from "../../../../components/capability/capture-preview";
import { DeepAnalysisSection } from "../../../../components/capability/deep-analysis";
import { OpenQuestions } from "../../../../components/capability/open-questions";
import { OverlapNotice } from "../../../../components/capability/overlap-notice";
import { PlaybookView, playbookHasContent, repoUrl } from "../../../../components/capability/playbook-view";
import { ProgressControl } from "../../../../components/capability/progress-control";
import { ScoreBadge } from "../../../../components/capability/score-badge";
import { SourceFacts } from "../../../../components/capability/source-facts";
import { SourcePrompts } from "../../../../components/capability/source-prompts";
import { StatusControl } from "../../../../components/capability/status-control";
import { SummaryBody } from "../../../../components/capability/summary-points";
import { VerdictBadge } from "../../../../components/capability/verdict-badge";
import { VideoSummary } from "../../../../components/capability/video-summary";
import { formatDateTime } from "../../../../lib/library/format";
import { errorLabel, typeLabel, usageLabel } from "../../../../lib/library/labels";
import { getCapabilityDetail } from "../../../../lib/library/queries";
import { safeHttpUrl } from "../../../../lib/library/safe-url";
import { displaySerial } from "../../../../lib/library/serial";
import { libraryHref } from "../../../../lib/library/search-params";
import { getRuntime } from "../../../../lib/runtime";
import { getLocale } from "../../../../lib/i18n/locale";
import { format, getDict } from "../../../../lib/i18n";
import { SharedTitle } from "../../../../components/library/shared-title";
import { PipelineWatcher } from "../../../../components/shell/pipeline-watcher";
import { DetailActions } from "./detail-actions";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pool } = getRuntime();
  const locale = await getLocale();
  const dict = getDict(locale);
  const [detail, scenarios] = await Promise.all([getCapabilityDetail(pool, id), loadScenarios(pool)]);
  if (!detail || detail.deletedAt) notFound();
  // Pending cards live on /review, not in the library — send the viewer there instead of
  // rendering a library detail page for a card that hasn't been decided yet. redirect() throws,
  // so it must run outside any try/catch.
  if (detail.verdict === "pending") redirect(`/review#${id}`);
  const serial = displaySerial(detail.verdict, detail.type, detail.serial);
  // A card kept before migration 010 (or never re-analyzed since) has `overlap = '{}'::jsonb` in
  // the database, not the full { relation: 'none', ... } shape — normalize defensively rather
  // than assume every row was written by the current analysis code.
  const overlap = detail.overlap?.relation ? detail.overlap : NO_OVERLAP;
  const cardScenarios = scenarios.filter((s) => detail.scenarios.includes(s.slug));
  // 怎么用's playbook already shows the repo/source link for an `integrate` card (PlaybookView) --
  // the standalone `detail.sourceUrl` line right below it is then a duplicate of the exact same
  // URL (pre-existing bug, not from this branch; see .agent/screens/m3_8/after/library-demo-cab-1-1440.png).
  // Normalized trivially (trailing slash) before comparing, since that's the only variance seen
  // between the two: `playbook.repo` is the raw value the model wrote, `detail.sourceUrl` is a
  // separately-sourced field that can carry (or drop) a trailing slash for the same link.
  const normalizeUrl = (url: string) => url.replace(/\/+$/, "");
  const playbookUrl = detail.playbook.kind === "integrate" && detail.playbook.repo ? repoUrl(detail.playbook.repo) : null;
  const sourceUrlIsDuplicate = playbookUrl !== null && normalizeUrl(playbookUrl) === normalizeUrl(detail.sourceUrl ?? "");
  // A completed deep analysis is content the owner asked to read first (walkthrough decision);
  // the trigger/running/failed states are a call to action, not content, so they stay put — only
  // `Boolean(detail.deepAnalysis)` promotes the section, never runState alone.
  const hasDeepAnalysis = Boolean(detail.deepAnalysis);
  const deepAnalysisSection = (
    <DeepAnalysisSection
      captureId={detail.captureId}
      analysis={detail.deepAnalysis}
      analysisOf={detail.deepAnalysisOf}
      runState={detail.deepRunState}
      errorCode={detail.deepRunErrorCode}
      locale={locale}
    />
  );

  // Section order is Human-decided (M3.5 design decision 2), shared with the Telegram card:
  // summary → scenarios/usage/score → value signals → playbook → source facts → folded details.
  // The right-hand column (screenshot, source facts, actions) stacks under the main column on
  // narrow screens, which keeps that same reading order on one column. When a deep analysis is
  // present, it is promoted to the top of the main column, ahead of 一句话总结 (walkthrough
  // decision on the two live-analyzed cards); absent, it stays at the foot of the page as today.
  // M3.7 task 4: 待核实 (open_questions) slots in right after value signals, before 怎么用; the
  // right column's screenshot is now collapsed behind a closed-by-default <details> since it's a
  // provenance artifact, not the headline.
  // Background work this page reports on (a rerun, a deep analysis, a DeepSeek re-review): keep
  // re-rendering while any of it is in flight, so its result replaces the "refresh later" notice.
  const inFlight = (state: string | null) => state === "queued" || state === "running";
  const watching = inFlight(detail.runState) || inFlight(detail.deepRunState) || Boolean(detail.reviewRequestedAt);

  return (
    <div>
      <PipelineWatcher active={watching} />
      <p className="back-link"><Link href="/library">{dict.detail.back}</Link></p>
      <div className="page-head">
        <div>
          <SharedTitle id={detail.id}>
            <h1 className="page-title">
              {detail.title}
              {serial && <span className="serial"> {serial}</span>}
              <ScoreBadge score={detail.score} reason={detail.scoreReason} locale={locale} />
              {detail.deepAnalysis && (
                <span className="badge badge--deep" title={dict.deepAnalysis.badgeAria}>{dict.deepAnalysis.badge}</span>
              )}
              {detail.enrichedAt && (
                <span className="badge badge--enriched" title={format(dict.detail.enrichedBadgeAria, { date: formatDateTime(detail.enrichedAt, locale) })}>
                  {format(dict.detail.enrichedBadge, { date: formatDateTime(detail.enrichedAt, locale) })}
                </span>
              )}
              {detail.status === "deprecated" && (
                <span className="badge badge--status-deprecated">{dict.statusBadge.deprecated}</span>
              )}
              {detail.status === "superseded" && (
                detail.supersededBy && detail.supersededBySerial ? (
                  <Link className="badge badge--status-superseded" href={`/library/${detail.supersededBy}`}>
                    {format(dict.statusBadge.supersededBy, { target: detail.supersededBySerial })}
                  </Link>
                ) : (
                  <span className="badge badge--status-superseded">{dict.statusBadge.supersededGeneric}</span>
                )
              )}
            </h1>
          </SharedTitle>
          <p className="page-subtitle detail-meta">
            {typeLabel(detail.type, locale)} · <VerdictBadge verdict={detail.verdict} verdictBy={detail.verdictBy} locale={locale} /> · {format(dict.detail.createdAt, { date: formatDateTime(detail.createdAt, locale) })}
          </p>
        </div>
      </div>
      <div className="detail-grid">
        <div>
          {hasDeepAnalysis && deepAnalysisSection}
          <section className="panel">
            <h2 className="panel-title">{dict.detail.summary}</h2>
            <SummaryBody summary={detail.summary} points={detail.summaryPoints} className="card-summary detail-summary" />
            <div className="filter-row detail-facets">
              {cardScenarios.map((s) => (
                <Link key={s.slug} className="chip chip--scenario" href={libraryHref({ page: 1 }, { scenarios: [s.slug] })}>
                  {locale === "en" ? s.labelEn : s.labelZh}
                </Link>
              ))}
              <span className="badge badge--usage">{usageLabel(detail.usage, locale)}</span>
            </div>
          </section>
          <VideoSummary video={detail.video} locale={locale} />
          {detail.signals.length > 0 && (
            <section className="panel">
              <h2 className="panel-title">{dict.detail.signals}</h2>
              <ul className="card-signals">
                {detail.signals.map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            </section>
          )}
          <OpenQuestions questions={detail.openQuestions} locale={locale} />
          <SourcePrompts prompts={detail.prompts} locale={locale} />
          {(playbookHasContent(detail.playbook, detail.type) || (detail.sourceUrl && !sourceUrlIsDuplicate)) && (
            <section className="panel">
              <h2 className="panel-title">{dict.detail.howToUse}</h2>
              <PlaybookView playbook={detail.playbook} type={detail.type} locale={locale} />
              {detail.sourceUrl && !sourceUrlIsDuplicate && (
                // detail.sourceUrl is model-supplied (analysis's source_url) and the zod schema
                // accepts any z.string().url() value, including javascript:/data: — only render an
                // anchor when it parses as http/https (see safeHttpUrl).
                <p className="detail-source">
                  {safeHttpUrl(detail.sourceUrl) ? (
                    <a href={detail.sourceUrl} target="_blank" rel="noreferrer">{detail.sourceUrl}</a>
                  ) : (
                    detail.sourceUrl
                  )}
                </p>
              )}
            </section>
          )}
        </div>
        <div>
          <CollapsedCapturePreview
            capture={{ ...detail.capture, retentionEligibleAt: detail.retentionEligibleAt, retentionPurgedAt: detail.retentionPurgedAt }}
            locale={locale}
          />
          <SourceFacts facts={detail.sourceFacts} locale={locale} />
          {overlap.relation !== "none" && (
            <OverlapNotice id={detail.id} updatedAt={detail.updatedAt} overlap={overlap} locale={locale} />
          )}
          <StatusControl id={detail.id} updatedAt={detail.updatedAt} status={detail.status} statusNote={detail.statusNote} locale={locale} />
          {detail.usage === "reference" && (
            // No `key` here (nor on DetailActions): these are two siblings of the same children
            // list, so keying both on detail.updatedAt gave them the SAME key and React rendered
            // the panels twice after a refresh ("Encountered two children with the same key").
            // Both panels still need a fresh optimistic-lock token after the *other* one saves
            // and calls router.refresh() — they get it from this updatedAt prop, which each one
            // re-seeds its internal token state from when it changes (no remount required).
            <ProgressControl
              id={detail.id}
              updatedAt={detail.updatedAt}
              progress={detail.progress}
              progressLink={detail.progressLink}
              locale={locale}
            />
          )}
          <BuildNotes notes={detail.buildNotes} locale={locale} />
          <DetailActions
            id={detail.id}
            captureId={detail.captureId}
            updatedAt={detail.updatedAt}
            verdict={detail.verdict}
            type={detail.type}
            usage={detail.usage}
            tags={detail.tags}
            reviewPending={Boolean(detail.reviewRequestedAt)}
            locale={locale}
          />
          {detail.reviewRequestedAt && (
            <p className="notice">{dict.detail.reviewingNotice}</p>
          )}
          {detail.reviewError && (
            <p className="inline-error">{dict.detail.reviewFailedPrefix}{errorLabel(detail.reviewError, locale)}</p>
          )}
          {detail.reviewNote && (
            <div className="panel review-note">
              <p>{detail.reviewNote.agrees ? dict.detail.reviewNoteAgree : dict.detail.reviewNoteDisagree}</p>
              {detail.reviewNote.points.length > 0 && (
                <ul>
                  {detail.reviewNote.points.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="detail-synced">{format(dict.detail.syncedAt, { date: detail.syncedAt ? formatDateTime(detail.syncedAt, locale) : dict.detail.notSynced })}</p>
        </div>
      </div>
      {!hasDeepAnalysis && deepAnalysisSection}
      <AnalysisDetails detail={detail} locale={locale} />
    </div>
  );
}
