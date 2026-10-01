/**
 * "Leave out these rows" on the quick look of a number (design iteration
 * 1.85). The quick look lists the lowest and the highest values of a column,
 * "0 ×5" and "999.9 ×4" for the readings of the home energy data, and its
 * output carries those values as code (`whybook.summary`). The analyst picks
 * how far in from each end the rows go, and a cell makes a clean frame
 * without them, names the rule and prints how many rows went.
 */
import type * as nbformat from '@jupyterlab/nbformat';

import { identifier } from './bars';
import { pyComment, pyString } from './pycode';

/** One value at an end of a column: as Python code that compares equal to it, and its rows. */
export interface IEnd {
  value: string;
  rows: number;
}

/** The ends of a column that a quick look showed, as `whybook.summary` gives them. */
export interface IExtremes {
  frame: string;
  column: string;
  rows: number;
  /** The lowest values, the lowest first. */
  lowest: IEnd[];
  /** The highest values, the highest first. */
  highest: IEnd[];
}

/** How far in from each end the rows go: the index of the last value that goes, or null for none. */
export interface ICuts {
  low: number | null;
  high: number | null;
}

/**
 * A number as Python code, as `whybook.summary` writes one: 0.0, -2.5e-07,
 * 999.9 or float("inf"). A value goes into the code of a cell that runs, so
 * nothing else passes.
 */
const NUMBER = /^-?(?:\d+(?:\.\d*)?(?:e[-+]?\d+)?|float\("inf"\))$/i;

function isEnds(value: unknown): value is IEnd[] {
  return (
    Array.isArray(value) &&
    value.every(
      end =>
        typeof end === 'object' &&
        end !== null &&
        typeof (end as IEnd).value === 'string' &&
        NUMBER.test((end as IEnd).value) &&
        typeof (end as IEnd).rows === 'number'
    )
  );
}

/** The ends that an output of a quick look carries in its metadata, or null. */
export function extremesOf(outputs: nbformat.IOutput[]): IExtremes | null {
  for (const output of outputs) {
    const meta = output.metadata as
      { whybook?: { extremes?: Partial<IExtremes> } } | undefined;
    const found = meta?.whybook?.extremes;
    if (
      found &&
      typeof found.frame === 'string' &&
      // The frame's name goes into the code as it is.
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(found.frame) &&
      typeof found.column === 'string' &&
      typeof found.rows === 'number' &&
      isEnds(found.lowest) &&
      isEnds(found.highest)
    ) {
      return found as IExtremes;
    }
  }
  return null;
}

/** A value as the words say it: 0 for 0.0, 999.9 as it is. */
export function valueText(value: string): string {
  return value.replace(/^(-?\d+)\.0$/, '$1');
}

/** The rows that a cut takes from one end: the rows of every value up to it. */
export function rowsUpTo(ends: IEnd[], index: number): number {
  return ends.slice(0, index + 1).reduce((total, end) => total + end.rows, 0);
}

/** The rule in words: "kwh_import is 0 or less, or 999.9 or more". */
export function ruleText(extremes: IExtremes, cuts: ICuts): string {
  const parts: string[] = [];
  if (cuts.low !== null) {
    parts.push(`${valueText(extremes.lowest[cuts.low].value)} or less`);
  }
  if (cuts.high !== null) {
    parts.push(`${valueText(extremes.highest[cuts.high].value)} or more`);
  }
  return `${extremes.column} is ${parts.join(', or ')}`;
}

/**
 * The cell that leaves out the rows: a mask from the rule, the clean frame
 * under `name`, and a line with how many rows went. A missing value stays,
 * as no comparison takes it. Each bound is the value as the quick look gave
 * it, in the column's own type: 999.9 finds the float32 readings of
 * 999.900024, which `isin([999.9])` does not.
 */
export function leaveOutCode(
  extremes: IExtremes,
  cuts: ICuts,
  name: string
): { text: string; code: string } {
  const { frame } = extremes;
  const column = `${frame}[${pyString(extremes.column)}]`;
  const tests: string[] = [];
  if (cuts.low !== null) {
    tests.push(`(${column} <= ${extremes.lowest[cuts.low].value})`);
  }
  if (cuts.high !== null) {
    tests.push(`(${column} >= ${extremes.highest[cuts.high].value})`);
  }
  const rule = ruleText(extremes, cuts);
  const text = `Leave out the rows of ${frame} where ${rule}`;
  const mask = `_${identifier(extremes.column)}_left_out`;
  const code = [
    pyComment(text),
    `${mask} = ${tests.join(' | ')}`,
    `${name} = ${frame}[~${mask}].copy()`,
    // The words stay out of the f-string, where a quote or a brace would end them.
    `print(f"Left out {${mask}.sum():,} of {len(${frame}):,} rows,", ${pyString(`where ${rule}.`)})`,
    `del ${mask}`
  ].join('\n');
  return { text, code };
}

/** The name of the clean frame: readings_clean, or readings_clean_2 when that is taken. */
export function cleanName(frame: string, taken: Set<string>): string {
  const base = identifier(`${frame}_clean`);
  let name = base;
  for (let count = 2; taken.has(name); count++) {
    name = `${base}_${count}`;
  }
  return name;
}
