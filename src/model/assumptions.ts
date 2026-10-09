/**
 * The open assumptions of a notebook: the Exploration panel counts them, and
 * Worth asking next asks about them (open_assumption in
 * whybook/server/questions/cells.py holds the same rule).
 *
 * A value that a cell leaves to the default of code that the analyst or an
 * agent wrote, such as MIN_DAYS = 14 of prep.py, is an open assumption. A
 * library default, such as header='infer' of read_csv or how='inner' of
 * merge, is one only when a rule finds a sign that it changes the cell's
 * result: a read whose frame looks wrong, or a fit that stopped at its
 * iteration limit before it converged. Its chip shows it either way, in the
 * colour of a value that nobody chose.
 */
import type { IDecision, IVariable } from '../tokens';
import { callsOf, READER, shortFunction } from './decisions';

/**
 * The signs that split the values of a delimited file, with their names:
 * the comma last, since a read with pandas' defaults splits at commas
 * already.
 */
const SEPARATORS: [string, string][] = [
  [';', 'semicolons'],
  ['\t', 'tabs'],
  ['|', 'pipes'],
  [',', 'commas']
];
/** A column's name that is a number: a row of data read as the header. */
const NUMBER_NAME = /^[-+]?\d+(?:\.\d+)?$/;
/** A year is a name, as the columns of a wide table of years have it. */
const YEAR_NAME = /^(?:1[89]|20)\d\d$/;

/**
 * What shows that the read that made a frame went wrong, from the names of
 * its columns; null when it looks right. Three signs: one column whose name
 * holds a separator, columns named Unnamed, and a header made of numbers
 * other than years. frame_looks_misread on the server gives the same text:
 * the cases of whybook/server/tests/data/misread_frames.json hold for both.
 */
export function frameLooksMisread(
  frame: string,
  columns: string[]
): string | null {
  if (columns.length === 1) {
    const held = SEPARATORS.find(([sign]) => columns[0].includes(sign));
    if (held) {
      return `${frame} has one column, whose name holds ${held[1]}`;
    }
  }
  const unnamed = columns.filter(
    column => column.startsWith('Unnamed:') || !column.trim()
  );
  if (unnamed.length > 1) {
    return `${frame} has ${unnamed.length} columns named Unnamed`;
  }
  if (unnamed.length === 1) {
    return unnamed[0].trim()
      ? `${frame} has a column named ${unnamed[0]}`
      : `${frame} has a column without a name`;
  }
  const numbers = columns.filter(
    column => NUMBER_NAME.test(column.trim()) && !YEAR_NAME.test(column.trim())
  );
  if (columns.length > 1 && 2 * numbers.length > columns.length) {
    return `${frame} has numbers for column names: ${numbers.slice(0, 3).join(', ')}`;
  }
  return null;
}

/**
 * The sign of an iteration limit at which a fit stopped. stopped_at on the
 * server gives the same text.
 */
export function stoppedAt(decision: IDecision): string {
  return `the fit stopped at ${decision.name} = ${decision.value}, before it converged`;
}

/**
 * The frames of the kernel, with the names of their columns, as the view
 * sends them to the server.
 */
export function framesOf(variables: IVariable[]): Map<string, string[]> {
  const frames = new Map<string, string[]>();
  for (const variable of variables) {
    if (variable.kind === 'dataframe' && variable.columns) {
      frames.set(variable.name, [
        ...new Set(variable.columns.map(column => column.label))
      ]);
    }
  }
  return frames;
}

/**
 * The frames that a read made: the one that its cell defines under the name
 * of the file, or else each frame that the cell defines.
 */
function readFrames(
  decision: IDecision,
  defs: string[],
  frames: Map<string, string[]>
): string[] {
  const defined = defs.filter(name => frames.has(name));
  const files = new Set(callsOf(decision).map(call => call.target));
  const named = defined.filter(name => files.has(name));
  return named.length ? named : defined;
}

/**
 * The sign that a library default changes the result of its cell, from a
 * rule; null when no rule finds one. Two rules find such a sign: a read,
 * such as read_csv or R's read.csv, whose frame looks wrong, and an
 * iteration limit at which the cell's fit stopped before it converged
 * (design iteration 1.116), which the cell shows only then.
 */
export function defaultMatters(
  decision: IDecision,
  defs: string[],
  frames: Map<string, string[]>
): string | null {
  if (decision.when === 'not_converged') {
    return stoppedAt(decision);
  }
  if (!READER.test(shortFunction(decision))) {
    return null;
  }
  for (const frame of readFrames(decision, defs, frames)) {
    const sign = frameLooksMisread(frame, frames.get(frame) ?? []);
    if (sign) {
      return sign;
    }
  }
  return null;
}

/** Whether a decision of a cell whose code defines `defs` is an open assumption. */
export function isOpenAssumption(
  decision: IDecision,
  defs: string[],
  frames: Map<string, string[]>
): boolean {
  if (decision.provenance === 'defaulted') {
    return true;
  }
  return (
    decision.provenance === 'library_default' &&
    defaultMatters(decision, defs, frames) !== null
  );
}

/** The number of open assumptions of these code cells, with the kernel's variables. */
export function countOpenAssumptions(
  cells: {
    decisions: IDecision[];
    analysis?: { defs: string[] } | null;
  }[],
  variables: IVariable[]
): number {
  const frames = framesOf(variables);
  let count = 0;
  for (const cell of cells) {
    const defs = cell.analysis?.defs ?? [];
    count += cell.decisions.filter(decision =>
      isOpenAssumption(decision, defs, frames)
    ).length;
  }
  return count;
}
