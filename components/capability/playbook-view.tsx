import type { CapabilityType, Playbook } from "../../lib/analysis/card";
import { format, getDict, type Locale } from "../../lib/i18n";
import { CopyButton } from "./copy-button";

function repoUrl(repo: string): string {
  return repo.startsWith("https://") ? repo : `https://github.com/${repo}`;
}

export function PlaybookView({ playbook, type, locale = "zh" }: { playbook: Playbook; type: CapabilityType; locale?: Locale }) {
  void type;
  const dict = getDict(locale).playbookView;
  if (playbook.kind === "integrate") {
    return (
      <div>
        {playbook.install.map((command, index) => (
          <div key={index}>
            <pre>{command}</pre>
            <CopyButton text={command} locale={locale} />
          </div>
        ))}
        {playbook.repo && (
          <div>
            <a href={repoUrl(playbook.repo)} target="_blank" rel="noreferrer">{playbook.repo}</a>
          </div>
        )}
        {playbook.prompt_text && (
          <div>
            <pre>{playbook.prompt_text}</pre>
            <CopyButton text={playbook.prompt_text} label={dict.copyAll} locale={locale} />
          </div>
        )}
      </div>
    );
  }
  if (playbook.kind === "reference") {
    return (
      <ol>
        {playbook.points.map((point, index) => (
          <li key={index}>{point}</li>
        ))}
      </ol>
    );
  }
  return (
    <div>
      <pre>{playbook.content}</pre>
      {playbook.when_to_use && <p>{format(dict.whenToUse, { value: playbook.when_to_use })}</p>}
    </div>
  );
}
