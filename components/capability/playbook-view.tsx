import type { CapabilityType, Playbook } from "../../lib/analysis/card";
import { CopyButton } from "./copy-button";

export function PlaybookView({ playbook, type }: { playbook: Playbook; type: CapabilityType }) {
  void type;
  if (playbook.kind === "integrate") {
    return (
      <div>
        {playbook.install.map((command, index) => (
          <p key={index}>
            <pre>{command}</pre>
            <CopyButton text={command} />
          </p>
        ))}
        {playbook.repo && (
          <p>
            <a href={`https://github.com/${playbook.repo}`} target="_blank" rel="noreferrer">{playbook.repo}</a>
          </p>
        )}
        {playbook.prompt_text && (
          <p>
            <pre>{playbook.prompt_text}</pre>
            <CopyButton text={playbook.prompt_text} label="复制全文" />
          </p>
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
