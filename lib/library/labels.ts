import type { CapabilityType } from "../analysis/card";

export const TYPE_LABEL: Record<CapabilityType, string> = { skill: "技能", experience: "经验", plugin: "插件", prompt: "提示词", other: "其他" };
export const USAGE_LABEL = { integrate: "直接整合", reference: "参考自研" } as const;
export const VERDICT_LABEL = { keep: "保留", discard: "丢弃", pending: "待决" } as const;
export const RUN_STATE_LABEL = { queued: "排队中", running: "分析中", done: "已建卡", failed: "失败" } as const;

const ERRORS: Record<string, string> = {
  OBJECT_UNAVAILABLE: "原图已过期，无法重跑",
  BUDGET: "超出单次分析预算",
  TIMEOUT: "模型响应超时",
  INVALID_OUTPUT: "模型输出不合规（已重试）",
  AUTHENTICATION: "模型 key 无效",
  BILLING: "模型额度不足或被限流",
  UNAVAILABLE: "模型服务不可用",
  LEASE_EXPIRED: "分析进程中断次数过多",
  PIPELINE_UNAVAILABLE: "分析管线未配置",
  CAPTURE_NOT_FOUND: "投递记录不存在",
  INVALID_IMAGE: "图片无法解析",
  INTERNAL: "内部错误"
};

export function errorLabel(code: string | null): string {
  if (!code) return "";
  return ERRORS[code] ?? `分析失败（${code}）`;
}
