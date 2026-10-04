import type { IAgentRunRecord, IAskedQuestion } from '../tokens';

/** What an agent's run found, as the model that writes questions reads it. */
export interface IAgentFinding {
  question: string;
  answer: string;
}

/**
 * The most runs that a request for the model's questions carries, and the
 * most characters of each question and answer. The server cuts them again
 * (`found_from_json` in whybook/server/questions/claude_questions.py).
 */
export const FOUND = { runs: 3, question: 300, answer: 600 };

/**
 * What agents found in the notebook, the newest first: the question and the
 * answer of each run that ended with an answer, at most three, each cut. The
 * model that writes questions reads them, so that it does not ask again what
 * a run settled, or about a column that a run found missing (design
 * iteration 1.76). A record of a run that an older version kept has no
 * answer (./runs.ts).
 */
export function agentFindings(
  runs: Record<string, IAgentRunRecord> | undefined
): IAgentFinding[] {
  const when = (record: IAgentRunRecord) => Date.parse(record.at) || 0;
  return Object.values(runs ?? {})
    .filter(
      record =>
        typeof record?.answer === 'string' && record.answer.trim() !== ''
    )
    .sort((a, b) => when(b) - when(a))
    .slice(0, FOUND.runs)
    .map(record => ({
      question: (record.question ?? '').slice(0, FOUND.question),
      answer: record.answer!.trim().slice(0, FOUND.answer)
    }));
}

/**
 * The questions of a list that the notebook has not asked, by their id or
 * by their words, as the server leaves out a question of the model that
 * repeats one asked (`kept` in whybook/server/questions/claude_questions.py).
 */
export function notAsked<T extends Pick<IAskedQuestion, 'id' | 'text'>>(
  options: T[],
  asked: Pick<IAskedQuestion, 'id' | 'text'>[]
): T[] {
  const ids = new Set(asked.map(question => question.id));
  const texts = new Set(asked.map(question => words(question.text)));
  return options.filter(
    option => !ids.has(option.id) && !texts.has(words(option.text))
  );
}

function words(text: string): string {
  return text.trim().toLowerCase();
}
