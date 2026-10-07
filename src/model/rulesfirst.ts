/**
 * Rules first, and a model when the rules cannot tell: the owner's rule.
 * Two places of the view follow it.
 *
 * - The values offered from a constant's chip follow the kind of the
 *   constant, which rules read on the server (whybook/server/questions/
 *   values.py). When no rule knows the kind, the model chosen for More
 *   questions suggests values, and without one the view keeps half below
 *   and above the value.
 * - A drop or a click asks that model for questions in the background, next
 *   to the questions of the templates, as "More questions from AI" does: the
 *   setting "Questions from a model" says always (the default, since the
 *   first drops of a new notebook got generic templates alone), only when no
 *   template fits, or never.
 */
import type { IOption, IWrittenBy } from '../tokens';
import type { ISuggestedValue } from './api';
import { needsAI } from './questionorder';

/**
 * When a drop or a click asks the model of More questions for questions:
 * always, next to the templates' questions; only when no template fits; or
 * never, when only "More questions from AI" asks.
 */
export type ModelQuestions = 'always' | 'no-template' | 'never';

/**
 * The setting "Questions from a model", from what JupyterLab gives: the
 * saved choice, else the switch that it replaced, `aiWhenNoTemplate`, whose
 * saved false reads as never. `own` is what the analyst saved.
 */
export function readModelQuestions(
  value: unknown,
  own: { modelQuestions?: unknown; aiWhenNoTemplate?: unknown }
): ModelQuestions {
  if (own.modelQuestions === undefined && own.aiWhenNoTemplate === false) {
    return 'never';
  }
  return value === 'no-template' || value === 'never' ? value : 'always';
}

/**
 * Whether a request asks the model for questions with these options: never
 * with the setting at never, and with "only when no template fits" when a
 * template question runs.
 */
export function asksModel(
  when: ModelQuestions,
  options: Pick<IOption, 'code'>[]
): boolean {
  switch (when) {
    case 'always':
      return true;
    case 'no-template':
      return noTemplateFits(options);
    case 'never':
      return false;
  }
}

/**
 * How the values offered for a constant were chosen: by the rules, by a
 * model, 'asking' while a model suggests them, or 'fallback', half below and
 * above, when no rule knows the kind and no model answered.
 */
export type ValuesBy = 'rules' | 'model' | 'asking' | 'fallback';

/** Where the values offered for a constant come from, as the questions of its chip say. */
export interface IDecisionValues {
  by: ValuesBy;
  /** The kind of the constant: the rules' words, "a count of days", or the model's. */
  kind: string | null;
  /** How the values were chosen: "common lengths of time", or "half below and above its value". */
  rule: string | null;
  /** Why no model suggested values, for 'fallback': none answers, the cap, or its error. */
  why: string | null;
  /** The model that suggested the values, for 'model'. */
  model?: IWrittenBy;
  /** The stage of the model's work, for 'asking'. */
  stage?: string | null;
}

/** The values that a model suggested for one constant, which the view keeps while the page is open. */
export interface IModelValues {
  /** The model's words for the kind of the constant. */
  kind: string;
  values: ISuggestedValue[];
  by: IWrittenBy;
  /** 'claude' for the connected model, 'local' for a model of the server: the options' origin. */
  origin: 'claude' | 'local';
}

/** The templates of the options that carry values: they wait while a model suggests values. */
const VALUE_TEMPLATES = new Set(['what_if_value', 'what_if_sweep']);

/** Whether an option of a chip's questions tries values, as a branch or a sweep. */
export function triesValues(option: Pick<IOption, 'template'>): boolean {
  return VALUE_TEMPLATES.has(option.template ?? '');
}

/**
 * The options of a chip's questions with the model's mark on those that try
 * its values: the AI tag says which model proposed them, and what the model
 * reads the constant as, in its tooltip. A value that the analyst picks is
 * still theirs: its chip says "you" (./decisions.ts).
 */
export function markModelValues(
  options: IOption[],
  found: IModelValues
): IOption[] {
  return options.map(option =>
    triesValues(option)
      ? {
          ...option,
          origin: found.origin,
          by: found.by,
          ...(found.kind ? { kind: found.kind } : {})
        }
      : option
  );
}

/**
 * The line above the values of a constant, short (design iteration 1.86).
 * With rules, the kind and how they chose: "A count of days: common lengths
 * of time." While a model suggests values, "Analysing…", which the view
 * draws with a bar. After a model answered, none: the AI tag on each of its
 * values says so, and its tooltip has the kind. With no model, how the
 * values were chosen and that no model answers: "Half and double the value:
 * no AI model answers." The reason that no model answers is the line's
 * tooltip (`valuesWhy`).
 */
export function valuesCaption(values: IDecisionValues): string {
  switch (values.by) {
    case 'rules':
      return values.kind && values.rule
        ? `${capital(values.kind)}: ${values.rule}.`
        : '';
    case 'model':
      return '';
    case 'asking':
      return 'Analysing…';
    case 'fallback':
      return values.rule
        ? `${capital(values.rule.replace(/\bits value\b/, 'the value'))}: no AI model answers.`
        : 'No AI model answers.';
  }
}

/** Why no model suggests values, as the tooltip of the line for 'fallback': the connection, the setting or the cap. */
export function valuesWhy(values: IDecisionValues): string | undefined {
  return values.by === 'fallback' && values.why ? values.why : undefined;
}

function capital(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * Why no model suggests values or questions: none answers, or the notebook's
 * AI answers reached its cap. `reason` is why the task's model cannot run,
 * or null when it can.
 */
export function noModelNote(
  what: 'values' | 'questions',
  reason: string | null,
  capped: boolean
): string | null {
  const fits = what === 'values' ? 'values that fit it' : 'questions';
  if (reason) {
    return `A model would suggest ${fits}, and none answers: ${reason}.`;
  }
  if (capped) {
    return `A model would suggest ${fits}, and the notebook's AI answers reached its cap.`;
  }
  return null;
}

/**
 * Whether no template fits a request: it got no question, or only questions
 * that need AI. The view then asks the model for questions at once.
 */
export function noTemplateFits(options: Pick<IOption, 'code'>[]): boolean {
  return options.every(needsAI);
}

/**
 * The key of a request, for asking the model once: what was dropped or
 * clicked, and onto what. A cell counts with its code, so a changed cell is
 * a new request.
 */
export function requestKey(
  source: string,
  target: { item?: string; cell?: { id: string; source: string } }
): string {
  return JSON.stringify([
    source,
    target.item ?? null,
    target.cell ? [target.cell.id, target.cell.source] : null
  ]);
}
