import { VERDICT_LABEL } from "../../lib/library/labels";

export function VerdictBadge({ verdict, verdictBy }: { verdict: "keep" | "discard" | "pending"; verdictBy?: "auto" | "human" | null }) {
  return (
    <>
      <span className={`badge badge--${verdict}`}>{VERDICT_LABEL[verdict]}</span>
      {verdictBy === "auto" && <span className="badge badge--auto">自动</span>}
      {verdictBy === "human" && <span className="badge badge--human">人工</span>}
    </>
  );
}
