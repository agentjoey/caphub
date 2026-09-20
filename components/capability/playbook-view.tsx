import type { CapabilityType, Playbook } from "../../lib/analysis/card";
import { format, getDict, type Locale } from "../../lib/i18n";
import { CopyButton } from "./copy-button";

/** Exported so the detail page can compare 怎么用's own repo link against `detail.sourceUrl` and suppress a duplicate (AJ-… -- pre-existing bug, see page.tsx). */
export function repoUrl(repo: string): string {
  return repo.startsWith("https://") ? repo : `https://github.com/${repo}`;
}

export function PlaybookView({ playbook, type, locale = "zh" }: { playbook: Playbook; type: CapabilityType; locale?: Locale }) {
  void type;
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
        {playbook.prompt_text && (
          <div className="prompt-block">
            <div className="code-block__copy"><CopyButton text={playbook.prompt_text} label={dict.copyAll} locale={locale} /></div>
            <pre>{playbook.prompt_text}</pre>
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
