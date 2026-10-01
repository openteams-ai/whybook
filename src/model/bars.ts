/**
 * Code for the rows behind the bars picked in a bar plot. A bar is a level
 * of the x column, and the plot keeps its label as text: `month` 3 is "3".
 */
import { pyComment, pyString } from './pycode';

/**
 * The pandas mask for the rows of the picked bars, such as
 * `diary["month"] == 3` or `diary["arm"].isin(["A", "B"])`. The column's tag
 * from the kernel's listing turns a label back into its value; without a
 * tag, the column is compared as text.
 */
export function barFilter(
  frame: string,
  x: string,
  values: string[],
  tag: string | null
): string {
  const column = `${frame}[${pyString(x)}]`;
  const numbers =
    (tag === 'int' || tag === 'num') &&
    values.every(
      value => value.trim() !== '' && Number.isFinite(Number(value))
    );
  const booleans =
    tag === 'bool' &&
    values.every(value => value === 'True' || value === 'False');
  const asText = !numbers && !booleans && (tag === null || tag === 'date');
  const literal = (value: string) =>
    numbers || booleans ? value : pyString(value);
  const target = asText ? `${column}.astype(str)` : column;
  return values.length === 1
    ? `${target} == ${literal(values[0])}`
    : `${target}.isin([${values.map(literal).join(', ')}])`;
}

/** The picked bars in words: "arm A", "week 3 and 4", "week 1, 2, 3 and 2 more". */
export function barsText(x: string, values: string[]): string {
  const shown =
    values.length > 3
      ? `${values.slice(0, 3).join(', ')} and ${values.length - 3} more`
      : values.length > 1
        ? `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`
        : values.join('');
  return `${x} ${shown}`;
}

/**
 * A cell that asks whether the picked bars differ from the others by more
 * than chance: a Welch t-test on the rows, or on one mean per unit when the
 * frame has the notebook's unit, as the rows of one patient are not
 * independent.
 */
export function barTest(options: {
  frame: string;
  x: string;
  y: string;
  values: string[];
  /** The kernel's tag for the x column, or null when it is not known. */
  tag: string | null;
  /** The unit column, when the frame has it. */
  unit: string | null;
  /** The picked bars and the others, in words. */
  picked: string;
  others: string;
}): { text: string; effect: string; noun: string; code: string } {
  const { frame, x, y, values, tag, unit, picked, others } = options;
  const noun = unit ? unit.replace(/_id$/, '') : 'row';
  const counted = unit ? `${noun}s` : 'rows';
  const effect = `Welch t-test on ${unit ? `per-${noun} means` : 'rows'}`;
  const verb = values.length === 1 ? 'Is' : 'Are';
  const text = `${verb} ${picked} different from ${others} by more than chance?`;
  const result = identifier(
    `${y}_${values.length === 1 ? values[0] : 'picked'}_vs_rest`
  );
  const mask = barFilter(frame, x, values, tag);
  const split = unit
    ? [
        `_rows = ${frame}.assign(_picked=${mask})`,
        `_means = _rows.groupby([${pyString(unit)}, "_picked"], observed=True)[${pyString(y)}].mean().reset_index()`,
        `_a = _means.loc[_means["_picked"], ${pyString(y)}]`,
        `_b = _means.loc[~_means["_picked"], ${pyString(y)}]`
      ]
    : [
        `_picked = ${mask}`,
        `_a = ${frame}.loc[_picked, ${pyString(y)}].dropna()`,
        `_b = ${frame}.loc[~_picked, ${pyString(y)}].dropna()`
      ];
  const code = [
    pyComment(text),
    'import pandas as pd',
    'from scipy import stats',
    '',
    ...split,
    '_test = stats.ttest_ind(_a, _b, equal_var=False)',
    `${result} = pd.DataFrame(`,
    `    {${pyString(counted)}: [len(_a), len(_b)], ${pyString(`mean ${y}`)}: [_a.mean(), _b.mean()]},`,
    `    index=[${pyString(picked)}, ${pyString(others)}],`,
    ').round(3)',
    // The words stay out of the f-string, where a quote or a brace would end them.
    `print(${pyString(`${effect}:`)}, f"t = {_test.statistic:.2f}, p = {_test.pvalue:.3g}")`,
    `del ${unit ? '_rows, _means' : '_picked'}, _a, _b, _test`,
    result
  ].join('\n');
  return { text, effect, noun, code };
}

/** A Python name from free text: `took_A_vs_rest`. */
export function identifier(text: string): string {
  const name = text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(name) ? `_${name}` : name || 'result';
}
