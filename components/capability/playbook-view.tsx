import type { CapabilityType, Playbook } from "../../lib/analysis/card";
import { CopyButton } from "./copy-button";

function repoUrl(repo: string): string {
  return repo.startsWith("https://") ? repo : `https://github.com/${repo}`;
}

export function PlaybookView({ playbook, type }: { playbook: Playbook; type: CapabilityType }) {
  void type;
  if (playbook.kind === "integrate") {
    return (
      <div>
        {playbook.install.map((command, index) => (
          <div key={index}>
            <pre>{command}</pre>
            <CopyButton text={command} />
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
            <CopyButton text={playbook.prompt_text} label="复制全文" />
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
      {playbook.when_to_use && <p>适用场景：{playbook.when_to_use}</p>}
    </div>
  );
}
