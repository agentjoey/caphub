import { format, getDict, type Locale } from "../../lib/i18n";
import { errorLabel, typeLabel, usageLabel, verdictLabel } from "../../lib/library/labels";
import { pipelineStages } from "../../lib/captures/stage";
import type { DeskItem } from "./desk-items";
export function itemTitle(item: DeskItem, locale: Locale) {
  const d = getDict(locale).desk;
  return item.kind === "pending" ? item.title : item.kind === "running" ? d.running : d.failed;
}
export function suggestion(
  item: Extract<
    DeskItem,
    {
      kind: "pending";
    }
  >,
  locale: Locale
) {
  return format(getDict(locale).cardSummary.suggestion, {
    verdict: verdictLabel(item.suggestedVerdict, locale),
    confidence: item.confidence.toFixed(2),
    reason: item.suggestedReason
  });
}
export function itemText(item: DeskItem, locale: Locale) {
  if (item.kind === "pending")
    return [
      item.title,
      typeLabel(item.type, locale),
      suggestion(item, locale),
      item.summary,
      ...item.summaryPoints.map((p) => `${p.label}: ${p.text}`),
      item.tags.join(", "),
      usageLabel(item.usage, locale)
    ].join("\n");
  if (item.kind === "failed")
    return [itemTitle(item, locale), item.preview, errorLabel(item.errorCode, locale)]
      .filter(Boolean)
      .join("\n");
  const { stages, current } = pipelineStages(item.captureKind, item.url, item.okSteps);
  return [
    itemTitle(item, locale),
    item.preview,
    ...stages.map(
      (s, i) => `${i < stages.indexOf(current) ? "✓ " : ""}${getDict(locale).recentRow.stages[s]}`
    )
  ]
    .filter(Boolean)
    .join("\n");
}
