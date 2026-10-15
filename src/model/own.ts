/**
 * Questions the user types, in place of the ones the view offers. A user
 * question is an option without code: an AI model writes the cell that
 * answers it, as it does for the offered options marked "needs AI".
 */

import type { IOption, IPlacement, QuestionType } from '../tokens';
import { QUESTION_TYPES } from '../tokens';

/**
 * The type of a user question, from its words: it sorts the question in
 * the Exploration panel's counts, as the type of an offered question does.
 */
export function guessType(text: string): QuestionType {
  return keywordType(text) ?? 'descriptive';
}

/**
 * The words of each type, in the order that the rules read them: a question
 * with words of two types, such as "How robust is the adjusted estimate to
 * missing-data handling?", takes the first.
 */
const TYPE_WORDS: [QuestionType, RegExp[]][] = [
  [
    'causal',
    [
      /\b(cause[sd]?|causing|because|effects? of|due to|leads? to|led to|confound\w*|mediat\w*|counterfactual\w*|(treatment|causal) effects?)\b/,
      // The methods that estimate an effect, by their names (design
      // iteration 1.100): "Estimate it with inverse probability weighting"
      // was typed Descriptive.
      /\b(inverse[- ]probability|ipt?w|aipw|tmle|g[- ]?(formula|computation|estimation|methods?)|standardi[sz]ation|doubly[- ]robust|propensit\w*|instrumental[- ]variables?|diff(erence)?s?[- ]in[- ]diff(erence)?s?|regression[- ]discontinuity|synthetic[- ]controls?)\b/,
      // Matching on the confounders, and not ids that match.
      /\bmatch(ed|ing) on\b|\bmatched (pairs?|controls?|samples?|cohorts?|analys[ie]s)\b|\b(by|with|using|via) ([\w-]+ )?matching\b(?! (ids?|keys?|rows?|records?|names?|values?|columns?)\b)/,
      // An effect adjusted for other variables, and not p-values adjusted
      // for multiple tests.
      /\b(adjust(ed|ing|ment|s)?|control(led|ling|s)?) for\b(?! multiple| multiplicity)|\badjusted (effects?|estimates?)\b/
    ]
  ],
  [
    'quality',
    [
      /\b(missing\w*|dropouts?|drop(?:ped)? out|attrition|duplicat\w*|outliers?|errors?|wrong|quality|clean\w*|valid\w*|impossible)\b/,
      // Values never measured, and the people left out for it: "Does
      // leaving out the 63 people with no 1982 weight bias the effect?"
      /\b(imput\w*|complete[- ]cases?|non-?respon\w*|censor\w*|lost to follow-?up|loss to follow-?up)\b/,
      /\b(leav(e|es|ing)|left) out (the )?([\d,]+ )?(people|persons?|participants?|patients?|subjects?|respondents?|rows?|records?|cases?|observations?)\b/
    ]
  ],
  [
    'model',
    [
      /\b(models?|fit|fits|fitted|residuals?|coefficients?|interactions?|predict\w*|regression)\b/
    ]
  ],
  [
    'association',
    [
      /\b(associat\w*|correlat\w*|relates?|related|relationship|differ\w*|compar\w*|versus|vs)\b/
    ]
  ]
];

/**
 * The type the keywords of a question give, or null when none matches: then
 * the model chosen for user questions in the settings can give it.
 */
export function keywordType(text: string): QuestionType | null {
  const words = text.toLowerCase();
  return (
    TYPE_WORDS.find(([, patterns]) =>
      patterns.some(pattern => pattern.test(words))
    )?.[0] ?? null
  );
}

/**
 * A follow-up question that a model wrote, "association: Does sleep relate
 * to pain?", as its type and its question. A type of the five stands: the
 * model wrote the question, and why it asks it. A follow-up without one, or
 * with a label of the model's own such as "robustness", gets the type of its
 * words, as a user question does, else descriptive (design iteration 1.100).
 */
export function followUpOf(item: string): {
  type: QuestionType;
  text: string;
} {
  const [head, ...rest] = item.split(':');
  const type = QUESTION_TYPES.find(
    known => known.id === head.trim().toLowerCase()
  )?.id;
  if (type && rest.length) {
    return { type, text: rest.join(':').trim() };
  }
  const text = item.trim();
  return { type: guessType(text), text };
}

// Where a user question's cell goes, by its first words, as
// research/local_predictors/rules.py measured them: a look that the notebook
// need not keep, a change of the cell, or a variant of it beside it.
const LOOK =
  /^(show|list|print|display|peek|glance)\b|^(what|which) columns\b|^how (many rows|big|large)\b/;
const CHANGE =
  /^(also |now )?(add|remove|drop|include|exclude|use|switch|replace|change|sort|cluster|rename|fix|filter|keep)\b/;
const VARIANT =
  /\bwhat if\b|^try\b|^would\b|^refit\b|\bwithout\b|\bsensitiv\w*|\bdoes .* hold\b/;

// Words before the question itself, typed or spoken: "So, show the rows",
// "Can you add age", "I'd like to refit". With them in front, 27 of the 34
// user questions that the first words place lost their place
// (research/voice-questions.md); the rules read the words after them.
const OPENER =
  /^(?:(?:so|okay|ok|um+|uh+|er+|right|well|alright|hmm+)[,.]?\s+|(?:can|could|would) you(?: please)?\s+|please\s+|i(?:['’]d| would)? (?:like|want) to\s+|let['’]?s\s+)+/;

/** The kind of place a user question's words suggest, or null for the default. */
export function guessPlace(text: string): 'preview' | 'edit' | 'branch' | null {
  const words = text.toLowerCase().trim().replace(OPENER, '');
  if (LOOK.test(words)) {
    return 'preview';
  }
  if (CHANGE.test(words)) {
    return 'edit';
  }
  if (VARIANT.test(words)) {
    return 'branch';
  }
  return null;
}

/** The place a typed question's first words choose, when the request offers it, or null. */
export function wordPlace(
  text: string,
  places: IPlacement[]
): IPlacement | null {
  const kind = guessPlace(text);
  return (kind && places.find(place => place.kind === kind)) || null;
}

// The separators of a list of alternatives: commas, "and", "or", "vs".
const LIST_SEPARATOR = /(\s*,\s*|\s+(?:and|or|vs\.?|versus)\s+)/i;

/** A word of a question without the quotes and the marks around it. */
function bare(word: string | undefined): string {
  return (word ?? '').replace(/^[`'"([]+|[`'")\]?.!,;:]+$/g, '');
}

/**
 * The most branches that one user question makes, as the server's guard on
 * the branches of one call (MAX_BRANCHES in whybook/server/agent.py).
 */
export const MAX_BRANCHES = 20;

/**
 * The names of the notebook that a user question lists as alternatives: two
 * or more of them, joined by commas, "and", "or", "vs" or "versus", such as
 * "sleep_hours, mood or analgesic_use". The box then offers to explore in
 * parallel, and a model writes the question of each branch (design
 * iteration 1.126): no rule splits the words.
 */
export function listedNames(text: string, names: string[]): string[] {
  const known = new Set(names.filter(name => name.length > 1));
  if (known.size < 2) {
    return [];
  }
  // The text between separators, and each separator: words, sep, words, ...
  const parts = text.split(LIST_SEPARATOR).filter((_, i) => i % 2 === 0);
  const words = parts.map(part => part.trim().split(/\s+/).map(bare));
  let best: string[] = [];
  for (let start = 0; start < words.length - 1; start++) {
    const first = words[start][words[start].length - 1];
    if (!known.has(first)) {
      continue;
    }
    const run = [first];
    for (let next = start + 1; next < words.length; next++) {
      const name = words[next][0];
      if (!known.has(name) || run.includes(name)) {
        break;
      }
      run.push(name);
      // A list goes on past a part that holds one name alone.
      if (words[next].length > 1) {
        break;
      }
    }
    if (run.length > best.length) {
      best = run;
    }
  }
  return best.length >= 2 ? best : [];
}

/** A user question as an option: an AI model writes its cell. */
export function ownOption(
  text: string,
  placement: IPlacement | null,
  type: QuestionType = guessType(text)
): IOption {
  return {
    id: `own:${text}`,
    text,
    type,
    origin: 'user',
    probability: null,
    reasons: ['your own question'],
    effect: 'AI writes the cell',
    placement,
    code: null
  };
}
