import * as T from "three";
import type { DeskItem, PileItem } from "../desk-items";
import { itemTitle, suggestion } from "../desk-copy";
import { getDict, type Locale } from "../../../lib/i18n";
import { errorLabel, typeLabel, usageLabel } from "../../../lib/library/labels";
import { relativeTime } from "../../../lib/library/format";
import { wrapText } from "./text";
import { pipelineStages } from "../../../lib/captures/stage";
export function drawFace(
  item: DeskItem | PileItem,
  locale: Locale,
  resolution: number,
  mobile: boolean,
  cssWidth = 512
) {
  const canvas = document.createElement("canvas");
  canvas.width = resolution;
  canvas.height = Math.round((resolution * 1434) / 1024);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(resolution / 1024, resolution / 1024);
  const pending = "kind" in item && item.kind === "pending",
    card = !("kind" in item) || pending;
  const dict = getDict(locale);
  const css = getComputedStyle(document.documentElement);
  const sans = `${css.getPropertyValue("--font-general-sans") || '"General Sans"'}, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif`;
  const mono = `${css.getPropertyValue("--font-plex-mono") || '"IBM Plex Mono"'}, ${sans}`;
  ctx.fillStyle = "kind" in item && item.kind === "running" ? "#fdf2de" : "#fbf8ee";
  ctx.fillRect(0, 0, 1024, 1434);
  ctx.fillStyle = "rgba(22,20,14,.14)";
  for (let x = 28; x < 1024; x += 32)
    for (let y = 28; y < 1434; y += 32) {
      ctx.beginPath();
      ctx.arc(x, y, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
  function text(
    value: string,
    x: number,
    y: number,
    size: number,
    weight = 400,
    color = "#16140e",
    width = 840,
    max = 1,
    line = 1.24,
    font = sans
  ) {
    // Design coordinates are nominal; enforce the specified CSS-pixel floor on narrow viewports.
    size = Math.max(size, Math.ceil((13 * 1024) / cssWidth));
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = color;
    const lines = wrapText(value, (s) => ctx.measureText(s).width, width, max);
    lines.forEach((s, i) => ctx.fillText(s, x, y + i * size * line));
    return lines.length * size * line;
  }
  function rule(y: number) {
    ctx.strokeStyle = "#6b6558";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(92, y);
    ctx.lineTo(932, y);
    ctx.stroke();
  }
  const serial = "serial" in item ? item.serial : pending ? dict.labels.verdict.pending : "";
  text(serial ?? "", 92, 112, 36, 600, "#16140e", 260, 1, 1.2, mono);
  if (card) {
    text(
      typeLabel(item.type, locale) + ("createdAt" in item ? `, ${relativeTime(item.createdAt, locale)}` : ""),
      330,
      112,
      31,
      400,
      "#6b6558",
      450
    );
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = item.score === 5 ? "#f3b44a" : "#16140e";
      ctx.strokeStyle = item.score === 5 ? "#7a4f00" : "#6b6558";
      if (item.score !== null && i < item.score) ctx.fillRect(822 + i * 22, 87, 13, 26);
      ctx.strokeRect(822 + i * 22, 87, 13, 26);
    }
  }
  rule(145);
  let y = 210;
  if (pending) {
    ctx.fillStyle = "#fdf2de";
    if (item.suggestedVerdict === "keep") ctx.fillRect(82, 174, 860, 100);
    else {
      ctx.strokeStyle = "#16140e";
      ctx.strokeRect(82, 174, 860, 100);
    }
    text(suggestion(item, locale), 100, y, 30, 500, "#7a4f00", 820, 2, 1.3);
    y = 345;
  }
  const points = pending && !mobile ? item.summaryPoints.slice(0, 4) : [];
  y +=
    text(
      card ? item.title : itemTitle(item, locale),
      92,
      y,
      mobile ? 78 : points.length ? 62 : 74,
      600,
      "#16140e",
      840,
      3
    ) + 30;
  if (card) {
    y +=
      text(
        item.summary,
        92,
        y,
        Math.max(mobile ? 46 : points.length ? 33 : 40, Math.ceil(((mobile ? 14 : 15) * 1024) / cssWidth)),
        400,
        "#4a463c",
        840,
        Math.min(
          points.length ? 5 : 8,
          Math.max(1, Math.floor((1170 - y) / (mobile ? 74 : points.length ? 54 : 65)))
        ),
        1.62
      ) + 28;
    for (const p of points) {
      if (y + 95 > 1250) break;
      text(p.label, 92, y, 25, 500, "#6b6558", 140, 2, 1.3, mono);
      y += text(p.text, 242, y, 30, 400, "#4a463c", 690, 2, 1.4) + 24;
    }
    if (serial && !pending && 1260 - y > 380) {
      ctx.globalAlpha = 0.08;
      text(serial, 92, 1160, 168, 600, "#16140e", 840, 1, 1.2, mono);
      ctx.globalAlpha = 1;
    }
    rule(1300);
    text(pending ? item.tags.join(" · ") : "", 92, 1355, 28, 400, "#6b6558", 460, 1, 1.2, mono);
    text(
      `${item.usage === "integrate" ? "■" : "□"} ${usageLabel(item.usage, locale)}`,
      570,
      1355,
      28,
      400,
      "#16140e",
      365,
      1,
      1.2,
      mono
    );
  } else {
    if (item.preview) y += text(item.preview, 92, y, 40, 400, "#4a463c", 840, 4, 1.62) + 40;
    if (item.kind === "running") {
      const { stages, current } = pipelineStages(item.captureKind, item.url, item.okSteps);
      const at = stages.indexOf(current);
      stages.forEach((stage, index) => {
        const marker = index < at ? "✓" : index === at ? "●" : "○";
        y += text(`${marker} ${dict.recentRow.stages[stage]}`, 92, y, 40, 500,
          index === at ? "#7a4f00" : index < at ? "#16140e" : "#6b6558", 840, 1, 1.62) + 22;
      });
    } else text(errorLabel(item.errorCode, locale), 92, y, 40, 400, "#4a463c", 840, 6, 1.62);
  }
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  texture.rotation = Math.PI;
  texture.center.set(0.5, 0.5);
  texture.repeat.set(1, -1);
  return texture;
}
