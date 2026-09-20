import { getDict, type Locale } from "../../lib/i18n";

/**
 * The first pass's ≤3 unresolved "couldn't tell, needs checking" items (M3.7 card.ts's
 * `open_questions`), rendered as a short muted list after 价值信号. Renders nothing when the
 * array is empty — a card the enrich pass fully resolved (or that never had any) shows no
 * 待核实 section at all.
 */
export function OpenQuestions({ questions, locale = "zh" }: { questions: string[]; locale?: Locale }) {
  if (questions.length === 0) return null;
  const dict = getDict(locale).detail;
  return (
    <section className="panel">
      <h2 className="panel-title">{dict.openQuestions}</h2>
      <ul className="open-questions">
        {questions.map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ul>
    </section>
  );
}
