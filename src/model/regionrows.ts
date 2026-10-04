/**
 * Questions about the rows of a range picked on a plot (design iteration
 * 1.85): who they are, and how the groups compare there. Pain step 28 of
 * the testers' second pass: weeks 20 to 28 picked on the trajectory of
 * pain asked only about the interval method of the card.
 */
import type { IOption, IPlacement } from '../tokens';
import { pyComment, pyString } from './pycode';

/** A column of the frame, as the kernel's listing gives it. */
export interface IListedColumn {
  label: string;
  kind?: string;
  unique?: number | null;
}

/** Names that say a column splits the units into compared groups. */
const GROUPS = /(^|_)(arm|group|treat\w*|tariff|cohort|condition)($|_)/i;

/**
 * The column whose groups a range compares: the plot's own groups, then a
 * column of two to six levels whose name says it splits the units, then
 * any column of two to six levels.
 */
export function groupOf(
  by: string | null,
  columns: IListedColumn[],
  exclude: (string | null | undefined)[]
): string | null {
  if (by) {
    return by;
  }
  const levels = columns.filter(
    column =>
      (column.kind === 'categorical' || column.kind === 'binary') &&
      typeof column.unique === 'number' &&
      column.unique >= 2 &&
      column.unique <= 6 &&
      !exclude.includes(column.label)
  );
  return (
    levels.find(column => GROUPS.test(column.label))?.label ??
    levels[0]?.label ??
    null
  );
}

/**
 * "Who is in these rows?" and, with a column of groups and a y, "How do the
 * groups of <column> compare here?": the code of each runs on the rows of
 * the range, `mask`, and counts one mean per unit when the frame has the
 * unit (`whybook.who_is_in`, `whybook.compare_levels`).
 */
export function rowsQuestions(options: {
  frame: string;
  /** The pandas mask of the range's rows. */
  mask: string;
  /** The range in words: "20 <= week <= 28". */
  where: string;
  y: string | null;
  unit: string | null;
  group: string | null;
  placement: IPlacement;
  /** What tells this range apart in the ids of the questions. */
  key: string;
}): IOption[] {
  const { frame, mask, where, y, unit, group, placement, key } = options;
  const byUnit = unit ? `, unit=${pyString(unit)}` : '';
  const noun = unit ? unit.replace(/_?id$/i, '') || unit : null;
  const questions: IOption[] = [
    {
      id: `region:who:${frame}:${key}`,
      text: 'Who is in these rows?',
      type: 'descriptive',
      origin: 'template',
      probability: 0.7,
      reasons: ['the rows of the range, against all the rows'],
      effect: noun
        ? `The ${noun}s here, and the share of each level, here and in all`
        : 'The share of each level, here and in all rows',
      placement,
      code: [
        pyComment(`Who is in the rows of ${frame} where ${where}?`),
        'import whybook',
        '',
        `whybook.who_is_in(${frame}, ${mask}${byUnit})`
      ].join('\n')
    }
  ];
  if (group && y && group !== y) {
    questions.push({
      id: `region:groups:${frame}:${group}:${key}`,
      text: `How do the groups of ${group} compare here?`,
      type: 'association',
      origin: 'template',
      probability: 0.65,
      reasons: [`${y} by ${group}, in the rows of the range`],
      effect: noun
        ? `One mean of ${y} per ${noun}, and an F test, in the range`
        : `The means of ${y}, and an F test, in the range`,
      placement,
      code: [
        pyComment(`How do the groups of ${group} compare where ${where}?`),
        'import whybook',
        '',
        `whybook.compare_levels(${frame}[${mask}], ${pyString(y)}, ${pyString(group)}${byUnit})`
      ].join('\n')
    });
  }
  return questions;
}
