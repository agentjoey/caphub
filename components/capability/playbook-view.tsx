import type { CapabilityType, Playbook } from "../../lib/analysis/card";
import { format, getDict, type Locale } from "../../lib/i18n";
import { CopyButton } from "./copy-button";

/** Exported so the detail page can compare 怎么用's own repo link against `detail.sourceUrl` and suppress a duplicate (AJ-… -- pre-existing bug, see page.tsx). */
export function repoUrl(repo: string): string {
  return repo.startsWith("https://") ? repo : `https://github.com/${repo}`;
}

export function PlaybookView({ playbook, type, locale = "zh" }: { playbook: Playbook; type: CapabilityType; locale?: Locale }) {
  const dict = getDict(locale).playbookView;
  if (playbook.kind === "integrate") {
    return (
      <div className="playbook">
        {playbook.install.length > 0 && (
          <div className="playbook__commands">
            {playbook.install.map((command, index) => (
              <div key={index} className="code-block">
                <pre>{command}</pre>
                <div className="code-block__copy"><CopyButton text={command} locale={locale} /></div>
              </div>
            ))}
          </div>
        )}
        {playbook.repo && (
          <p className="playbook__repo">
            <a href={repoUrl(playbook.repo)} target="_blank" rel="noreferrer">{playbook.repo}</a>
          </p>
        )}
        {playbook.usage_prompt && type !== "prompt" && (
          <div className="prompt-block playbook__usage-prompt">
            <p className="source-prompts__index">{dict.usagePromptLabel}</p>
            <div className="code-block__copy"><CopyButton text={playbook.usage_prompt} locale={locale} /></div>
            <pre>{playbook.usage_prompt}</pre>
          </div>
        )}
      </div>
    );
  }
  if (playbook.kind === "reference") {
    return (
      <ol className="playbook playbook__points">
        {playbook.points.map((point, index) => (
          <li key={index}>{point}</li>
        ))}
      </ol>
    );
  }
  return (
    <div className="playbook">
      <div className="prompt-block"><pre>{playbook.content}</pre></div>
      {playbook.when_to_use && <p className="playbook__when">{format(dict.whenToUse, { value: playbook.when_to_use })}</p>}
    </div>
  );
}

/** Whether 怎么用 has anything to show; an integrate card whose prompt moved to 「Prompt 原文」 may have nothing left. */
export function playbookHasContent(playbook: Playbook, type: CapabilityType): boolean {
  if (playbook.kind === "integrate") {
    return playbook.install.length > 0 || playbook.repo !== null || (!!playbook.usage_prompt && type !== "prompt");
  }
  return true;
}
