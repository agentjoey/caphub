import Link from "next/link";
import { notFound } from "next/navigation";
import { AnalysisDetails } from "../../../components/capability/analysis-details";
import { CapturePreview } from "../../../components/capability/capture-preview";
import { PlaybookView } from "../../../components/capability/playbook-view";
import { VerdictBadge } from "../../../components/capability/verdict-badge";
import { formatDateTime } from "../../../lib/library/format";
import { errorLabel, TYPE_LABEL, USAGE_LABEL } from "../../../lib/library/labels";
import { getCapabilityDetail } from "../../../lib/library/queries";
import { getRuntime } from "../../../lib/runtime";
import { DetailActions } from "./detail-actions";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pool } = getRuntime();
  const detail = await getCapabilityDetail(pool, id);
  if (!detail || detail.deletedAt) notFound();

  return (
    <div>
      <p><Link href="/library">← 能力库</Link></p>
      <div className="page-head">
        <div>
          <h1 className="page-title">{detail.title}</h1>
          <p className="page-subtitle">
            {TYPE_LABEL[detail.type]} · {USAGE_LABEL[detail.usage]} · <VerdictBadge verdict={detail.verdict} verdictBy={detail.verdictBy} /> · 创建于 {formatDateTime(detail.createdAt)}
          </p>
        </div>
      </div>
      <div className="detail-grid">
        <div>
          <section className="panel">
            <h2>怎么用</h2>
            <PlaybookView playbook={detail.playbook} type={detail.type} />
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
          />
          {detail.reviewRequestedAt && (
            <p className="notice">DeepSeek 复核中，稍后刷新查看</p>
          )}
          {detail.reviewError && (
            <p className="inline-error">复核失败：{errorLabel(detail.reviewError)}</p>
          )}
          {detail.reviewNote && (
            <div className="panel review-note">
              <p>复核意见：{detail.reviewNote.agrees ? "同意" : "不同意"}</p>
              {detail.reviewNote.points.length > 0 && (
                <ul>
                  {detail.reviewNote.points.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="page-subtitle">最后同步到 Obsidian：{detail.syncedAt ? formatDateTime(detail.syncedAt) : "尚未同步"}</p>
        </div>
      </div>
      <AnalysisDetails detail={detail} />
    </div>
  );
}
