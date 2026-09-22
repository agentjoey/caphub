import { format, getDict, type Locale } from "../../lib/i18n";
import { CopyButton } from "./copy-button";

/**
 * 「Prompt 原文」: the verbatim prompts taken from the input source (spec 2026-09-22), each in
 * full with its own copy button. Never model-written, so rendered as-is -- no truncation.
 */
export function SourcePrompts({ prompts, locale = "zh" }: { prompts: Array<{ text: string }>; locale?: Locale }) {
  if (prompts.length === 0) return null;
  const dict = getDict(locale);
  return (
    <section className="panel">
      <h2 className="panel-title">{dict.detail.sourcePrompts}</h2>
      <div className="source-prompts">
        {prompts.map((prompt, index) => (
          <div key={index} className="prompt-block">
            <div className="code-block__copy"><CopyButton text={prompt.text} label={dict.playbookView.copyAll} locale={locale} /></div>
            {prompts.length > 1 && <p className="source-prompts__index">{format(dict.detail.promptIndex, { n: index + 1 })}</p>}
            <pre>{prompt.text}</pre>
          </div>
        ))}
      </div>
    </section>
  );
}
