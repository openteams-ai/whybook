import type { AskedOutcome, IAskedQuestion } from '../tokens';

/** A question as the notebook's log keeps it, with how its answer ended. */
export type LoggedQuestion = IAskedQuestion & { outcome?: AskedOutcome };

/** A code cell that answers a question: whether it ran, and whether it raised. */
export interface IAnsweringCell {
  question: IAskedQuestion;
  ran: boolean;
  failed: boolean;
}

/**
 * The questions that count as asked, and those whose answer failed. A
 * question counts once a cell that answers it ran without an error, or once
 * the log records that its answer ran: an edit in place, a preview, an agent's
 * cells. A cell that raised, or an answer that the AI could not write, is a
 * failed question. A cell comes before the log, so a failed cell that runs
 * again without an error counts. A question with neither, such as one still
 * written or run, does not count.
 */
export function countAsked(
  log: LoggedQuestion[],
  cells: IAnsweringCell[]
): { asked: IAskedQuestion[]; failed: IAskedQuestion[] } {
  const questions = new Map<string, IAskedQuestion>();
  const state = new Map<string, AskedOutcome>();
  for (const entry of log) {
    questions.set(entry.id, entry);
    if (entry.outcome) {
      state.set(entry.id, entry.outcome);
    }
  }
  const fromCells = new Map<string, AskedOutcome>();
  for (const cell of cells) {
    const id = cell.question.id;
    if (!questions.has(id)) {
      questions.set(id, cell.question);
    }
    if (!cell.ran) {
      continue;
    }
    // One answer that ran without an error is enough.
    if (!cell.failed) {
      fromCells.set(id, 'ran');
    } else if (!fromCells.has(id)) {
      fromCells.set(id, 'failed');
    }
  }
  const asked: IAskedQuestion[] = [];
  const failed: IAskedQuestion[] = [];
  for (const [id, question] of questions) {
    const outcome = fromCells.get(id) ?? state.get(id);
    if (outcome === 'ran') {
      asked.push(question);
    } else if (outcome === 'failed') {
      failed.push(question);
    }
  }
  return { asked, failed };
}
