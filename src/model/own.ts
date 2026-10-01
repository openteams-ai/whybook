/**
 * Questions the user types, in place of the ones the view offers. A typed
 * question is an option without code: an AI model writes the cell that
 * answers it, as it does for the offered options marked "needs AI".
 */

import type { IOption, IPlacement, QuestionType } from '../tokens';

/**
 * The type of a typed question, from its words: it sorts the question in
 * the Exploration panel's counts, as the type of an offered question does.
 */
export function guessType(text: string): QuestionType {
  return keywordType(text) ?? 'descriptive';
}

/**
 * The type the keywords of a question give, or null when none matches: then
 * the model chosen for typed questions in the settings can give it.
 */
export function keywordType(text: string): QuestionType | null {
  const words = text.toLowerCase();
  if (
    /\b(cause[sd]?|causing|because|effect of|due to|leads? to|led to|confound\w*)\b/.test(
      words
    )
  ) {
    return 'causal';
  }
  if (
    /\b(missing|dropouts?|drop(?:ped)? out|attrition|duplicat\w*|outliers?|errors?|wrong|quality|clean\w*|valid\w*|impossible)\b/.test(
      words
    )
  ) {
    return 'quality';
  }
  if (
    /\b(models?|fit|fits|fitted|residuals?|coefficients?|interactions?|predict\w*|regression)\b/.test(
      words
    )
  ) {
    return 'model';
  }
  if (
    /\b(associat\w*|correlat\w*|relates?|related|relationship|differ\w*|compar\w*|versus|vs)\b/.test(
      words
    )
  ) {
    return 'association';
  }
  return null;
}

// Where a typed question's cell goes, by its first words, as
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
// typed questions that the first words place lost their place
// (research/voice-questions.md); the rules read the words after them.
const OPENER =
  /^(?:(?:so|okay|ok|um+|uh+|er+|right|well|alright|hmm+)[,.]?\s+|(?:can|could|would) you(?: please)?\s+|please\s+|i(?:['’]d| would)? (?:like|want) to\s+|let['’]?s\s+)+/;

/** The kind of place a typed question's words suggest, or null for the default. */
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

/** A typed question as an option: an AI model writes its cell. */
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
