import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { loadScenarios } from "../../../lib/analysis/scenarios";
import { AnalysisDetails } from "../../../components/capability/analysis-details";
import { CapturePreview } from "../../../components/capability/capture-preview";
import { PlaybookView } from "../../../components/capability/playbook-view";
import { ProgressControl } from "../../../components/capability/progress-control";
import { ScoreBadge } from "../../../components/capability/score-badge";
import { SourceFacts } from "../../../components/capability/source-facts";
import { VerdictBadge } from "../../../components/capability/verdict-badge";
import { formatDateTime } from "../../../lib/library/format";
import { errorLabel, typeLabel, usageLabel } from "../../../lib/library/labels";
import { getCapabilityDetail } from "../../../lib/library/queries";
import { displaySerial } from "../../../lib/library/serial";
import { libraryHref } from "../../../lib/library/search-params";
import { getRuntime } from "../../../lib/runtime";
import { getLocale } from "../../../lib/i18n/locale";
import { format, getDict } from "../../../lib/i18n";
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
  const cardScenarios = scenarios.filter((s) => detail.scenarios.includes(s.slug));

  // Section order is Human-decided (M3.5 design decision 2), shared with the Telegram card:
  // summary → scenarios/usage/score → value signals → playbook → source facts → folded details.
  // The right-hand column (screenshot, source facts, actions) stacks under the main column on
  // narrow screens, which keeps that same reading order on one column.
  return (
    <div>
      <p className="back-link"><Link href="/library">{dict.detail.back}</Link></p>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {detail.title}
            {serial && <span className="serial"> {serial}</span>}
            <ScoreBadge score={detail.score} reason={detail.scoreReason} locale={locale} />
          </h1>
          <p className="page-subtitle detail-meta">
            {typeLabel(detail.type, locale)} · <VerdictBadge verdict={detail.verdict} verdictBy={detail.verdictBy} locale={locale} /> · {format(dict.detail.createdAt, { date: formatDateTime(detail.createdAt, locale) })}
          </p>
        </div>
      </div>
      <div className="detail-grid">
        <div>
          <section className="panel">
            <h2 className="panel-title">{dict.detail.summary}</h2>
            <p className="card-summary detail-summary">{detail.summary}</p>
            <div className="filter-row detail-facets">
              {cardScenarios.map((s) => (
                <Link key={s.slug} className="chip chip--scenario" href={libraryHref({ page: 1 }, { scenarios: [s.slug] })}>
                  {locale === "en" ? s.labelEn : s.labelZh}
                </Link>
              ))}
              <span className="badge badge--usage">{usageLabel(detail.usage, locale)}</span>
            </div>
          </section>
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
          <section className="panel">
            <h2 className="panel-title">{dict.detail.howToUse}</h2>
            <PlaybookView playbook={detail.playbook} type={detail.type} locale={locale} />
            {detail.sourceUrl && (
              <p className="detail-source"><a href={detail.sourceUrl} target="_blank" rel="noreferrer">{detail.sourceUrl}</a></p>
            )}
          </section>
        </div>
        <div>
          <CapturePreview
            capture={{ ...detail.capture, retentionEligibleAt: detail.retentionEligibleAt, retentionPurgedAt: detail.retentionPurgedAt }}
            size="full"
            locale={locale}
          />
          <SourceFacts facts={detail.sourceFacts} locale={locale} />
          {detail.usage === "reference" && (
            <ProgressControl
              id={detail.id}
              updatedAt={detail.updatedAt}
              progress={detail.progress}
              progressLink={detail.progressLink}
              locale={locale}
            />
          )}
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
      <AnalysisDetails detail={detail} locale={locale} />
    </div>
  );
}
