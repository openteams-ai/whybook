import type { IOption, IWrittenBy } from '../tokens';

/**
 * The order that the model chosen for "Question order" gives the offered
 * questions: while it works, once it answered and the pointer is still on
 * the list, once its order shows, or why the rules' order stayed.
 */
export interface IQuestionOrder {
  state: 'pending' | 'held' | 'done' | 'failed';
  /** The model chosen, as the settings name it. */
  name: string;
  /** The model, once it answered. */
  by: IWrittenBy | null;
  message: string | null;
  /** The model's probability of each question, by id, once it answered. */
  scores?: Record<string, number>;
  /** Shows the model's order, while it is held. */
  show?: () => void;
}

/** A list of questions that a model may order. */
export interface IOrdered {
  order?: IQuestionOrder | null;
}

function percent(value: number): string {
  return `${Math.round(100 * value)}%`;
}

/**
 * The questions in the order of a model's probabilities, best first. A
 * question with no probability from the model keeps its place in the rules'
 * order, after the others. A question that the model scored shows the
 * model's probability, and its reasons end with both numbers.
 */
export function orderByScores(
  options: IOption[],
  scores: Record<string, number>,
  name: string
): IOption[] {
  return options
    .map((option, index) => ({ option, index, score: scores[option.id] }))
    .sort((a, b) => {
      if (a.score === undefined || b.score === undefined) {
        return a.score === b.score
          ? a.index - b.index
          : a.score === undefined
            ? 1
            : -1;
      }
      return b.score - a.score || a.index - b.index;
    })
    .map(({ option, score }) =>
      score === undefined
        ? option
        : {
            ...option,
            probability: score,
            reasons: [
              ...option.reasons,
              `${name} gives ${percent(score)}` +
                (option.probability === null
                  ? ''
                  : `; the rules gave ${percent(option.probability)}`)
            ]
          }
    );
}

/** Whether a question needs an AI model: no template wrote code for it. */
export function needsAI(option: Pick<IOption, 'code'>): boolean {
  return !option.code;
}

/**
 * The questions with the ones that run first, while no AI model answers the
 * others, so that a limit on the questions offered keeps them. Each group
 * keeps its order. With a model, the list as it is.
 */
export function runnableFirst<T extends Pick<IOption, 'code'>>(
  options: T[],
  aiOff: boolean
): T[] {
  return aiOff
    ? [
        ...options.filter(option => !needsAI(option)),
        ...options.filter(needsAI)
      ]
    : options;
}
