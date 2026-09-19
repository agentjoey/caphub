"use client";

import { useState } from "react";
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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    const tags = tagsText.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    const error = await onSave(type, usage, tags);
    setSaving(false);
    if (error) setMessage(error);
  }

  const isDisabled = disabled || saving;

  return (
    <div className="suggestion-editor">
      <label htmlFor="suggestion-editor-type">
        类型
        <select
          id="suggestion-editor-type"
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
            <input type="radio" name="suggestion-editor-usage" value={u} checked={usage === u} onChange={() => setUsage(u)} />
            {USAGE_LABEL[u]}
          </label>
        ))}
      </fieldset>
      <label htmlFor="suggestion-editor-tags">
        标签
        <input
          id="suggestion-editor-tags"
          type="text"
          value={tagsText}
          disabled={isDisabled}
          onChange={(e) => setTagsText(e.target.value)}
        />
      </label>
      <p className="suggestion-editor__hint">英文小写，可用连字符，1–6 个</p>
      {message && <p className="inline-error">{message}</p>}
      <button type="button" className="btn btn--primary" disabled={isDisabled} onClick={handleSave}>
        保存并保留
      </button>
    </div>
  );
}
