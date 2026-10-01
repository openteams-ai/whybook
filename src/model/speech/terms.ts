import type { IItem, IVariable } from '../../tokens';
import type { IKeyTerm } from './engine';

/**
 * The names in play, favoured by the recognizer: the drop's source and
 * target most, then the columns of a dropped frame, the kernel's variables
 * and a few words that questions use. research/voice-questions.md, "What to
 * send": a short list works better than a long one, so the protein columns
 * of a wide frame stay out unless they are dropped.
 */
export const DROPPED_BOOST = 3;
export const OTHER_BOOST = 1;
export const MAX_TERMS = 100;
const MAX_COLUMNS = 40;
const MAX_VARIABLES = 60;
const VOCABULARY = ['covariate', 'confounder', 'residuals'];

/** A name as the analyst says it: `pain_score` as "pain score". */
export function spoken(name: string): string {
  return name
    .replace(/[_.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What an item is called aloud: a file without its folder and extension, a table by its name. */
function itemName(item: IItem): string {
  if (item.kind === 'file') {
    return (item.path ?? item.name)
      .split('/')
      .pop()!
      .replace(/\.[A-Za-z0-9]+$/, '');
  }
  if (item.kind === 'table') {
    return item.table ?? item.name;
  }
  return item.name;
}

/**
 * The key terms for a recording: each name once, as it is said, with the
 * highest boost it gets. Names shorter than three letters, such as `x` or
 * `df`, are left out: favouring them adds them where nobody said them.
 */
export function keyTerms(input: {
  /** The drop's source and target, when a drop asks. */
  dropped: IItem[];
  variables: IVariable[];
}): IKeyTerm[] {
  const terms = new Map<string, IKeyTerm>();
  const add = (name: string | undefined, boost: number) => {
    const phrase = spoken(name ?? '');
    if (phrase.length < 3) {
      return;
    }
    const key = phrase.toLowerCase();
    const known = terms.get(key);
    if (known) {
      known.boost = Math.max(known.boost, boost);
    } else if (terms.size < MAX_TERMS) {
      terms.set(key, { phrase, boost });
    }
  };
  const frames = new Map(
    input.variables.map(variable => [variable.name, variable])
  );
  for (const item of input.dropped) {
    add(itemName(item), DROPPED_BOOST);
  }
  for (const item of input.dropped) {
    if (item.kind === 'column') {
      add(item.parent, OTHER_BOOST);
    }
    const frame = item.kind === 'variable' ? frames.get(item.name) : undefined;
    for (const column of (frame?.columns ?? []).slice(0, MAX_COLUMNS)) {
      add(column.name, OTHER_BOOST);
    }
  }
  for (const variable of input.variables.slice(0, MAX_VARIABLES)) {
    add(variable.name, OTHER_BOOST);
  }
  for (const word of VOCABULARY) {
    add(word, OTHER_BOOST);
  }
  return Array.from(terms.values());
}
