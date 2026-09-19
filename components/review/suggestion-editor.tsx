"use client";

import { useId, useState } from "react";
import { capabilityTypeSchema, type CapabilityType } from "../../lib/analysis/card";
import { TYPE_LABEL, USAGE_LABEL } from "../../lib/library/labels";

const TYPES = capabilityTypeSchema.options;
const USAGES = ["integrate", "reference"] as const;

export function SuggestionEditor({
  initialType,
  initialUsage,
  initialTags,
  disabled = false,
  onSave
}: {
  initialType: CapabilityType;
  initialUsage: "integrate" | "reference";
  initialTags: string[];
  disabled?: boolean;
  onSave: (type: CapabilityType, usage: "integrate" | "reference", tags: string[]) => Promise<string | null>;
}) {
  const [type, setType] = useState<CapabilityType>(initialType);
  const [usage, setUsage] = useState<"integrate" | "reference">(initialUsage);
  const [tagsText, setTagsText] = useState(initialTags.join(", "));
  const [message, setMessage] = useState<string | null>(null);
  const uid = useId();
  const typeId = `${uid}-type`;
  const tagsId = `${uid}-tags`;
  const tagsHintId = `${uid}-tags-hint`;
  const usageGroupName = `${uid}-usage`;

  // No local "saving" flag: ReviewCard sets its shared busy state synchronously before awaiting
  // the save (see saveEdit in review-card.tsx), so the `disabled` prop already reflects an
  // in-flight request by the time this component re-renders — a second local flag would just be
  // a second source of truth that could drift from it.
  async function handleSave() {
    setMessage(null);
    const tags = tagsText.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    const error = await onSave(type, usage, tags);
    if (error) setMessage(error);
  }

  const isDisabled = disabled;

  return (
    <div className="suggestion-editor">
      <label htmlFor={typeId}>
        类型
        <select
          id={typeId}
          value={type}
          disabled={isDisabled}
          onChange={(e) => setType(e.target.value as CapabilityType)}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
      </label>
      <fieldset disabled={isDisabled}>
        <legend>用法</legend>
        {USAGES.map((u) => (
          <label key={u}>
            <input type="radio" name={usageGroupName} value={u} checked={usage === u} onChange={() => setUsage(u)} />
            {USAGE_LABEL[u]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={tagsId}>
        标签
        <input
          id={tagsId}
          type="text"
          value={tagsText}
          disabled={isDisabled}
          aria-describedby={tagsHintId}
          onChange={(e) => setTagsText(e.target.value)}
        />
      </label>
      <p id={tagsHintId} className="suggestion-editor__hint">英文小写，可用连字符，1–6 个</p>
      {message && <p className="inline-error">{message}</p>}
      <button type="button" className="btn btn--primary" disabled={isDisabled} onClick={handleSave}>
        保存并保留
      </button>
    </div>
  );
}
