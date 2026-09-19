import Link from "next/link";
import { notFound } from "next/navigation";
import { loadScenarios } from "../../../lib/analysis/scenarios";
import { AnalysisDetails } from "../../../components/capability/analysis-details";
import { CapturePreview } from "../../../components/capability/capture-preview";
import { PlaybookView } from "../../../components/capability/playbook-view";
import { VerdictBadge } from "../../../components/capability/verdict-badge";
import { formatDateTime } from "../../../lib/library/format";
import { errorLabel, typeLabel, usageLabel } from "../../../lib/library/labels";
import { getCapabilityDetail } from "../../../lib/library/queries";
import { formatSerial } from "../../../lib/library/serial";
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
  const serial = formatSerial(detail.type, detail.serial);
  const cardScenarios = scenarios.filter((s) => detail.scenarios.includes(s.slug));

  return (
    <div>
      <p><Link href="/library">{dict.detail.back}</Link></p>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {detail.title}
            {serial && <span className="serial"> {serial}</span>}
          </h1>
          <p className="page-subtitle">
            {typeLabel(detail.type, locale)} · {usageLabel(detail.usage, locale)} · <VerdictBadge verdict={detail.verdict} verdictBy={detail.verdictBy} locale={locale} /> · {format(dict.detail.createdAt, { date: formatDateTime(detail.createdAt, locale) })}
          </p>
          {cardScenarios.length > 0 && (
            <div className="filter-row">
              {cardScenarios.map((s) => (
                <Link key={s.slug} className="chip" href={libraryHref({ page: 1 }, { scenarios: [s.slug] })}>
                  {locale === "en" ? s.labelEn : s.labelZh}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="detail-grid">
        <div>
          <section className="panel">
            <h2>{dict.detail.howToUse}</h2>
            <PlaybookView playbook={detail.playbook} type={detail.type} locale={locale} />
            <p className="card-summary">{detail.summary}</p>
            {detail.signals.length > 0 && (
              <ul className="card-signals">
                {detail.signals.map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            )}
            {detail.sourceUrl && (
              <p><a href={detail.sourceUrl} target="_blank" rel="noreferrer">{detail.sourceUrl}</a></p>
            )}
          </section>
        </div>
        <div>
          <CapturePreview
            capture={{ ...detail.capture, retentionEligibleAt: detail.retentionEligibleAt, retentionPurgedAt: detail.retentionPurgedAt }}
            size="full"
            locale={locale}
          />
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
          <p className="page-subtitle">{format(dict.detail.syncedAt, { date: detail.syncedAt ? formatDateTime(detail.syncedAt, locale) : dict.detail.notSynced })}</p>
        </div>
      </div>
      <AnalysisDetails detail={detail} locale={locale} />
    </div>
  );
}
