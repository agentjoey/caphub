import { notFound, redirect } from "next/navigation";
import { NO_OVERLAP } from "../../../../lib/analysis/card";
import { AnalysisDetails } from "../../../../components/capability/analysis-details";
import { BuildNotes } from "../../../../components/capability/build-notes";
import { CollapsedCapturePreview } from "../../../../components/capability/capture-preview";
import { DeepAnalysisSection } from "../../../../components/capability/deep-analysis";
import { OpenQuestions } from "../../../../components/capability/open-questions";
import { OverlapNotice } from "../../../../components/capability/overlap-notice";
import { PlaybookView, playbookHasContent, repoUrl } from "../../../../components/capability/playbook-view";
import { ScoreBadge } from "../../../../components/capability/score-badge";
import { SourceFacts } from "../../../../components/capability/source-facts";
import { SourcePrompts } from "../../../../components/capability/source-prompts";
import { StatusControl } from "../../../../components/capability/status-control";
import { SummaryBody } from "../../../../components/capability/summary-points";
import { VerdictBadge } from "../../../../components/capability/verdict-badge";
import { VideoSummary } from "../../../../components/capability/video-summary";
import { MiniActions } from "../../../../components/mini/mini-actions";
import { RouterBackButton } from "../../../../components/mini/router-back-button";
import { formatDateTime } from "../../../../lib/library/format";
import { errorLabel, usageLabel } from "../../../../lib/library/labels";
import { getCapabilityDetail } from "../../../../lib/library/queries";
import { safeHttpUrl } from "../../../../lib/library/safe-url";
import { displaySerial } from "../../../../lib/library/serial";
import { getRuntime } from "../../../../lib/runtime";
import { getLocale } from "../../../../lib/i18n/locale";
import { format, getDict } from "../../../../lib/i18n";

export const dynamic = "force-dynamic";

/**
 * `/mini/library/[id]` — the Telegram mini app's card detail page. Mobile counterpart of
 * `app/library/[id]/page.tsx`; same guards (a deleted card 404s, a still-pending card redirects
 * to the mini review queue) so an id reached from a stale link (e.g. deleted or decided in
 * another tab since the list was rendered) degrades the same way the desktop page does, instead
 * of crashing.
 *
 * Content order is task-4-brief.md's mobile order (not the desktop's two-column layout):
 * 深度分析（若有）置顶 → 结构化摘要 → 价值信号 → 待核实 → 怎么用 → 来源事实 → 写操作 →
 * 自研进度与笔记 → 有效性状态 / 疑似重复 → 复核意见 / 同步状态 → 原始投递（折叠）→ 分析详情（折叠）。
 */
export default async function MiniDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pool } = getRuntime();
  const locale = await getLocale();
  const dict = getDict(locale);
  const detail = await getCapabilityDetail(pool, id);
  if (!detail || detail.deletedAt) notFound();
  if (detail.verdict === "pending") redirect(`/mini/review#${id}`);

  const serial = displaySerial(detail.verdict, detail.type, detail.serial);
  const overlap = detail.overlap?.relation ? detail.overlap : NO_OVERLAP;
  const playbookUrl = detail.playbook.kind === "integrate" && detail.playbook.repo ? repoUrl(detail.playbook.repo) : null;
  const normalizeUrl = (url: string) => url.replace(/\/+$/, "");
  const sourceUrlIsDuplicate = playbookUrl !== null && normalizeUrl(playbookUrl) === normalizeUrl(detail.sourceUrl ?? "");
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

  return (
    <div className="mini-detail">
      <RouterBackButton />
      <div className="page-head">
        <h1 className="page-title">
          {detail.title}
          {serial && <span className="serial"> {serial}</span>}
          <ScoreBadge score={detail.score} reason={detail.scoreReason} locale={locale} />
          {detail.deepAnalysis && (
            <span className="badge badge--deep" title={dict.deepAnalysis.badgeAria}>{dict.deepAnalysis.badge}</span>
          )}
          {detail.status === "deprecated" && (
            <span className="badge badge--status-deprecated">{dict.statusBadge.deprecated}</span>
          )}
          {detail.status === "superseded" && (
            <span className="badge badge--status-superseded">
              {detail.supersededBySerial ? format(dict.statusBadge.supersededBy, { target: detail.supersededBySerial }) : dict.statusBadge.supersededGeneric}
            </span>
          )}
        </h1>
        <p className="page-subtitle detail-meta">
          <VerdictBadge verdict={detail.verdict} verdictBy={detail.verdictBy} locale={locale} /> · {format(dict.detail.createdAt, { date: formatDateTime(detail.createdAt, locale) })}
        </p>
      </div>

      {hasDeepAnalysis && deepAnalysisSection}

      <section className="panel">
        <h2 className="panel-title">{dict.detail.summary}</h2>
        <SummaryBody summary={detail.summary} points={detail.summaryPoints} className="card-summary detail-summary" />
        <span className="badge badge--usage">{usageLabel(detail.usage, locale)}</span>
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

      <SourceFacts facts={detail.sourceFacts} locale={locale} />

      <MiniActions
        id={detail.id}
        captureId={detail.captureId}
        updatedAt={detail.updatedAt}
        verdict={detail.verdict}
        type={detail.type}
        usage={detail.usage}
        tags={detail.tags}
        progress={detail.usage === "reference" ? detail.progress : null}
        progressLink={detail.progressLink}
        allowDelete
        locale={locale}
      />

      <BuildNotes notes={detail.buildNotes} locale={locale} />

      {overlap.relation !== "none" && (
        <OverlapNotice id={detail.id} updatedAt={detail.updatedAt} overlap={overlap} locale={locale} />
      )}
      <StatusControl id={detail.id} updatedAt={detail.updatedAt} status={detail.status} statusNote={detail.statusNote} locale={locale} />

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

      {!hasDeepAnalysis && deepAnalysisSection}

      <CollapsedCapturePreview
        capture={{ ...detail.capture, retentionEligibleAt: detail.retentionEligibleAt, retentionPurgedAt: detail.retentionPurgedAt }}
        locale={locale}
      />
      <AnalysisDetails detail={detail} locale={locale} />
    </div>
  );
}
