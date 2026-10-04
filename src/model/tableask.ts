/**
 * Questions about a table of a data frame in an output: its columns, picked
 * by their headers, and its rows, picked by their labels.
 *
 * A header asks what a column of the frame dropped onto itself asks, and two
 * headers what one column dropped onto the other asks. Rows ask about the
 * rows of the frame behind them, with what sets them apart, as a region
 * brushed in a plot does. When the view cannot tell which frame the table
 * shows, or which of its columns or rows a pick is, the request says so and
 * offers the questions it can still ask.
 */

import type { IAnchor, IItem, IOption, IPlacement } from '../tokens';
import { identifier } from './bars';
import type { EpiModel, IAskBase } from './epimodel';
import type { IReadTable, ITableSource, TableTarget } from './frametable';
import { frameColumn, resolveTable } from './frametable';
import { pythonString } from './kernel';
import { notebookMeta, outputKind, outputsOf } from './notebook';
import { pyComment, pyString } from './pycode';
import { fingerprint, htmlOf, tableInfo } from './tables';

/** Where a table is: the cell, and the output of the cell that holds it. */
export interface ITablePlace {
  cellId: string;
  output: number;
}

/** A difference between the rows picked and the other rows of the frame. */
export interface IRowDifference {
  column: string;
  /** The mean of a number column, or the share of a level of another. */
  kind: 'number' | 'level';
  level?: string;
  inside: number;
  outside: number;
  /** In standard deviations for a number, in shares for a level. */
  gap: number;
}

/** The rows of a frame behind rows picked in a table: kernel code table_rows. */
export interface ITableRowsSummary {
  rows: number;
  total_rows: number;
  /**
   * The rows in words, as a condition: `arm = A`, `index in 0 and 1`; for
   * rows found by their places, the places: `rows 3 and 997`.
   */
  where: string;
  /**
   * Python code for the rows, checked to pick the same rows; null without
   * it. For a polars frame, an expression for `filter`.
   */
  mask: string | null;
  /** Whether the rows were found by their places in the frame, from 0. */
  positions?: boolean;
  /** The library of the frame, when the kernel read it with narwhals: `polars`. */
  library?: string;
  unit?: string;
  units?: number;
  differences: IRowDifference[];
  /** One sentence on what sets the rows apart. */
  seen: string;
  error?: string;
  /** Set with the error when the frame is not in the kernel. */
  missing?: boolean;
}

export interface ITableAsk extends IAskBase {
  kind: 'table';
  cellId: string;
  output: number;
  /** The frame the table shows, and what its rows and headers are. */
  source: ITableSource;
  /** The headers picked, each with the headers above it. */
  headers: string[][];
  /** The labels of the rows picked, down to the level clicked. */
  rows: string[][];
  /** What the popup says first: why the view cannot ask more, when it cannot. */
  note: string | null;
  summary: ITableRowsSummary | null;
  options: IOption[];
  /** The pick in a few words, for the head of the popup. */
  title: string;
  /** What the pick is, for an AI model that writes a cell about it. */
  about: string;
}

/** The picks of a question request that a table made, for the table to show. */
export interface ITablePicks extends ITablePlace {
  /** The table's place among the tables of the output. */
  table: number;
  headers: string[][];
  rows: number[];
}

const origins = new WeakMap<object, ITablePicks>();

/** The picks behind a question request, when a table made it. */
export function picksOf(ask: object | null): ITablePicks | null {
  return ask ? (origins.get(ask) ?? null) : null;
}

function remember(ask: object | null, picks: ITablePicks): void {
  if (ask) {
    origins.set(ask, picks);
  }
}

let counter = 1000000;

/** The dtypes of number columns, as the variable listing names them (narwhals). */
const NUMBER_DTYPE = /^(Int|UInt|Float|Decimal)/;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Names in words: "a", "a and b", "a, b, c and 2 more". */
export function listed(names: string[], and = 'and'): string {
  const shown =
    names.length > 4
      ? [...names.slice(0, 3), `${names.length - 3} more`]
      : names;
  return shown.length > 1
    ? `${shown.slice(0, -1).join(', ')} ${and} ${shown[shown.length - 1]}`
    : (shown[0] ?? '');
}

/**
 * The rows picked, as a noun phrase: "rows 0 and 1", "the rows where arm is
 * A", "3 picked rows". `names` are the names of the levels that label the
 * rows: the keys of a groupby, or the names of the index.
 */
export function rowsWords(names: string[], picks: string[][]): string {
  if (picks.every(pick => pick.length === 1)) {
    const labels = [...new Set(picks.map(pick => pick[0]))];
    if (!names[0]) {
      return labels.length === 1
        ? `row ${labels[0]}`
        : `rows ${listed(labels)}`;
    }
    return `the rows where ${names[0]} is ${listed(labels, 'or')}`;
  }
  if (picks.length === 1) {
    const parts = picks[0].map(
      (label, level) =>
        `${names[level] || `level ${level + 1} of the index`} is ${label}`
    );
    return `the rows where ${parts.join(' and ')}`;
  }
  return `${picks.length} picked rows`;
}

/** A label as polars writes it, for the popup: `"A"` is A, and a cut one ends in …. */
export function polarsLabel(label: string): string {
  return label.length >= 2 && label.startsWith('"')
    ? label.endsWith('"')
      ? label.slice(1, -1)
      : label.slice(1)
    : label;
}

/**
 * The labels that find the rows picked in a polars table, which writes no
 * row labels: the rows' places in the frame, from 0, as the table shows
 * them or as a column made by `with_row_index()` holds them; or the values
 * of the key columns of a group_by. A string saying why when the table does
 * not show a column it needs.
 */
export function polarsPicks(
  read: IReadTable,
  source: ITableSource,
  positions: number[]
):
  | {
      labels: string[][];
      places: boolean;
      /** For rows found by their places: what each shows, by column, for the kernel to check. */
      cells: Record<string, string>[];
    }
  | string {
  const picked = read.rows.filter(row => positions.includes(row.position));
  const shown = picked.map(row =>
    Object.fromEntries(
      read.columns.map(column => [
        column.path[0],
        row.cells?.[column.position] ?? ''
      ])
    )
  );
  const from = source.place ? [source.place] : (source.keys ?? []);
  if (!from.length) {
    return {
      labels: picked.map(row => row.labels),
      places: true,
      cells: shown
    };
  }
  const where = from.map(
    column => read.columns.find(each => each.path[0] === column)?.position
  );
  const absent = from.filter((_, index) => where[index] === undefined);
  if (absent.length) {
    return `The table does not show ${listed(absent)}, which Whybook needs to find these rows in ${source.frame}. Keep the table as a variable to ask about its own rows.`;
  }
  return {
    labels: picked.map(row => where.map(place => row.cells?.[place!] ?? '')),
    places: !!source.place,
    cells: source.place ? shown : []
  };
}

/** The pick in a few words, for the head of the popup: "rows 0 and 1", "arm A". */
function shortWords(names: string[], picks: string[][]): string {
  if (picks.every(pick => pick.length === 1)) {
    const labels = [...new Set(picks.map(pick => pick[0]))];
    return names[0]
      ? `${names[0]} ${listed(labels)}`
      : labels.length === 1
        ? `row ${labels[0]}`
        : `rows ${listed(labels)}`;
  }
  return picks.length === 1 ? picks[0].join(', ') : `${picks.length} rows`;
}

/** How the output of a table came from its cell. */
function outputPlace(model: EpiModel, place: ITablePlace) {
  const cell = model.cell(place.cellId);
  const outputs = cell ? outputsOf(cell.model) : [];
  const output = outputs[place.output];
  const displays = outputs.filter(
    each => each.type === 'display_data' && outputKind(each) === 'table'
  );
  return {
    source: cell?.model.sharedModel.getSource() ?? '',
    label: cell?.label ?? 'the cell',
    count: cell?.count ?? null,
    output: {
      type: output?.type ?? '',
      display: output ? displays.indexOf(output) : -1,
      displays: displays.length,
      tables: output ? tableInfo(htmlOf(output)).tables : 0
    }
  };
}

/** Which frame the table of an output shows, as the view works it out now. */
export function tableSource(
  model: EpiModel,
  place: ITablePlace,
  read: IReadTable
): ITableSource {
  const { source, output } = outputPlace(model, place);
  return resolveTable(read, {
    source,
    output,
    frames: model
      .variables()
      .filter(variable => variable.kind === 'dataframe')
      .map(variable => ({
        name: variable.name,
        columns: (variable.columns ?? []).map(column => column.label),
        rows: variable.rows ?? null,
        stale: !!variable.stale
      }))
  });
}

function columnItem(frame: string, label: string): IItem {
  return {
    kind: 'column',
    name: `${frame}[${pythonString(label)}]`,
    label,
    parent: frame
  };
}

/** The frame as an item: its own questions, as a drop of it onto itself asks. */
export function frameItem(frame: string): IItem {
  return { kind: 'variable', name: frame, label: frame };
}

function inKernel(model: EpiModel, name: string): boolean {
  const variable = model.variable(name);
  return (
    !!model.sessionContext.session?.kernel && !!variable && !variable.stale
  );
}

function newAsk(
  model: EpiModel,
  place: ITablePlace,
  source: ITableSource,
  anchor: IAnchor | null,
  fields: Partial<ITableAsk>
): ITableAsk {
  return {
    kind: 'table',
    id: ++counter,
    anchor,
    loading: false,
    error: null,
    cellId: place.cellId,
    output: place.output,
    source,
    headers: [],
    rows: [],
    note: null,
    summary: null,
    options: [],
    title: '',
    about: '',
    ...fields
  };
}

/** Draw a request again once it changed, while it is the one shown. */
function refresh(model: EpiModel, ask: ITableAsk): void {
  if (model.ask === ask) {
    model.showAsk(ask);
  }
}

type HeaderTarget = Extract<TableTarget, { kind: 'header' }>;

/** Why the view cannot ask about a header as it asks about a column. */
function headerNote(
  source: ITableSource,
  label: string,
  column: string | null
): string {
  const frame = source.frame;
  if (!frame) {
    return source.reason;
  }
  if (source.headers === 'statistics') {
    return `${label} is a statistic of ${frame}, not one of its columns.`;
  }
  if (source.headers !== 'columns') {
    return `Whybook cannot tell which column of ${frame} ${label} is.`;
  }
  return column
    ? source.reason
    : `${label} is not a column of ${frame}: the code of the table makes it.`;
}

/**
 * Ask about the columns under one header, or two: what a column dropped onto
 * itself, or onto the other column, asks. With a source picked in the click
 * interaction, the column is its target.
 */
export function askTableHeaders(
  model: EpiModel,
  place: ITablePlace & { table: number },
  read: IReadTable,
  picks: HeaderTarget[],
  anchor: IAnchor | null
): void {
  const source = tableSource(model, place, read);
  const frame = source.frame;
  const columns = frame
    ? (model.variable(frame)?.columns ?? []).map(column => column.label)
    : [];
  // A key of the groups is a column of the frame: pandas writes it as the
  // name of the index, polars as a column of the table.
  const found = picks.map(pick =>
    frame &&
    (pick.index ||
      source.headers === 'columns' ||
      (source.keys ?? []).includes(pick.path[0]))
      ? frameColumn(pick.path, columns)
      : null
  );
  const remembered: ITablePicks = {
    ...place,
    headers: picks.map(pick => pick.path),
    rows: []
  };
  if (frame && found.every(label => label !== null)) {
    const items = found.map(label => columnItem(frame, label!));
    const modifiers = { ...model.pickModifiers };
    if (model.armed) {
      model.pick(items[items.length - 1], modifiers, anchor);
    } else {
      void model.askDrop(
        items[0],
        { item: items[items.length > 1 ? 1 : 0] },
        modifiers,
        anchor,
        { popover: true }
      );
    }
    remember(model.ask, remembered);
    return;
  }
  const { label: cellLabel } = outputPlace(model, place);
  const labels = picks.map(pick => pick.path[pick.path.length - 1]);
  const missing = picks.findIndex((_, index) => found[index] === null);
  const ask = newAsk(model, place, source, anchor, {
    headers: remembered.headers,
    note: headerNote(source, labels[missing], found[missing]),
    title: `${labels.join(' + ')} in ${cellLabel}`,
    about: `the column${labels.length > 1 ? 's' : ''} ${listed(labels)} of the table that cell ${cellLabel} shows${source.expression ? ` (${source.expression})` : ''}`
  });
  ask.options = otherOptions(model, place, source, {
    headers: labels,
    words: null
  });
  model.showAsk(ask);
  remember(ask, remembered);
}

/**
 * Ask about rows picked in a table: the rows of the frame behind them, what
 * sets them apart, and questions about them. Rows that stand for columns of
 * the frame, as in `df.describe().T`, ask about those columns.
 */
export async function askTableRows(
  model: EpiModel,
  place: ITablePlace & { table: number },
  read: IReadTable,
  picks: string[][],
  positions: number[],
  anchor: IAnchor | null
): Promise<void> {
  const source = tableSource(model, place, read);
  const remembered: ITablePicks = { ...place, headers: [], rows: positions };
  const polars = read.library === 'polars';
  if (source.frame && source.rows === 'columns' && picks.length <= 2) {
    const columns = (model.variable(source.frame)?.columns ?? []).map(
      column => column.label
    );
    // A polars matrix has no row labels: its rows are its columns, in order,
    // or `corr(label=...)` names them in a first column of its own.
    const first = read.columns[0]?.path[0] ?? '';
    const named = !columns.includes(first);
    const labels = polars
      ? read.rows
          .filter(row => positions.includes(row.position))
          .map(row =>
            read.cut.columns
              ? ''
              : named
                ? polarsLabel(row.cells?.[read.columns[0].position] ?? '')
                : (read.columns[Number(row.labels[0])]?.path[0] ?? '')
          )
      : picks.map(pick => pick[0]);
    if (labels.every(label => columns.includes(label))) {
      askTableHeaders(
        model,
        place,
        read,
        labels.map(label => ({
          kind: 'header',
          path: [label],
          columns: [],
          index: true
        })),
        anchor
      );
      remember(model.ask, remembered);
      return;
    }
  }
  const { label: cellLabel } = outputPlace(model, place);
  const frame = source.frame;
  // polars: the places, or the values of the key columns, that find the rows.
  const found =
    polars &&
    frame &&
    (source.rows === 'rows' || source.rows === 'groups') &&
    source.keys !== null
      ? polarsPicks(read, source, positions)
      : null;
  const labels = found && typeof found !== 'string' ? found.labels : picks;
  const places = !!found && typeof found !== 'string' && found.places;
  const names = places ? [] : source.keys?.length ? source.keys : read.index;
  const shown = polars
    ? labels.map(pick => pick.map(label => polarsLabel(label)))
    : labels;
  const words = rowsWords(names, shown);
  const ask = newAsk(model, place, source, anchor, {
    rows: shown,
    title: frame
      ? `${shortWords(names, shown)} of ${frame}`
      : `${shortWords(names, shown)} of the table in ${cellLabel}`,
    about: `${words} of the table that cell ${cellLabel} shows${source.expression ? ` (${source.expression})` : ''}`
  });
  model.showAsk(ask);
  remember(ask, remembered);
  if (model.askUnsupported(ask)) {
    // A kernel of another language: the popup says what it lacks.
    return;
  }
  if (
    !frame ||
    (source.rows !== 'rows' && source.rows !== 'groups') ||
    source.keys === null ||
    typeof found === 'string'
  ) {
    ask.note =
      typeof found === 'string'
        ? found
        : source.rows === 'columns'
          ? `${source.reason} Pick one or two of these rows to ask about those columns.`
          : source.reason;
    ask.options = otherOptions(model, place, source, { headers: [], words });
    refresh(model, ask);
    return;
  }
  const resume = () =>
    void askTableRows(model, place, read, picks, positions, anchor);
  if (!inKernel(model, frame)) {
    await model.needData(ask, [frame], place.cellId, resume);
    return;
  }
  ask.loading = true;
  refresh(model, ask);
  const unit = notebookMeta(model.notebook).unit;
  try {
    const summary = await model.bridge.run<ITableRowsSummary>('table_rows', {
      frame,
      keys: places ? [] : source.keys,
      labels,
      unit: unit ?? null,
      ...(polars
        ? {
            positions: places,
            // The kernel checks the frame still holds them at their places.
            cells:
              found && typeof found !== 'string' && source.asIs
                ? found.cells
                : []
          }
        : {})
    });
    if (summary.missing) {
      await model.needData(ask, [frame], place.cellId, resume);
      return;
    }
    if (summary.error) {
      throw new Error(summary.error);
    }
    ask.summary = summary;
    ask.about = summary.positions
      ? `${summary.where} of ${frame}, counted from 0, picked in the table that cell ${cellLabel} shows`
      : `the rows of ${frame} where ${summary.where}, picked in the table that cell ${cellLabel} shows`;
    const variable = model.variable(frame);
    const packages = model.bridge.snapshot?.packages;
    const keys = places ? [] : source.keys;
    ask.options = rowOptions({
      frame,
      summary,
      words,
      keys,
      cellId: place.cellId,
      cellLabel,
      scipy: !packages || 'scipy' in packages,
      missingValues: (variable?.columns ?? []).some(
        column => (column.missing ?? 0) > 0
      ),
      unit:
        unit && variable?.columns?.some(column => column.label === unit)
          ? unit
          : null,
      numbers:
        !variable?.columns ||
        variable.columns.some(
          column =>
            NUMBER_DTYPE.test(column.dtype ?? '') &&
            !keys.includes(column.label)
        )
    });
  } catch (error) {
    ask.error = describe(error);
  }
  ask.loading = false;
  refresh(model, ask);
}

function after(cellId: string, cellLabel: string): IPlacement {
  return { kind: 'new', cell: cellId, label: `new cell after ${cellLabel}` };
}

/**
 * Questions about the rows picked, with code where a template fits: what
 * sets them apart, whether values are missing more often there, a test on
 * the column that differs most, and why, which an AI model answers.
 */
export function rowOptions(input: {
  frame: string;
  summary: ITableRowsSummary;
  /** The rows in words: "rows 0 and 1". */
  words: string;
  /** The columns that label the rows, left out of the comparisons. */
  keys: string[];
  cellId: string;
  cellLabel: string;
  scipy: boolean;
  /** Whether any column of the frame has missing values. */
  missingValues: boolean;
  /** The notebook's unit, when the frame has it: a test compares its means. */
  unit: string | null;
  /** Whether the frame has a number column besides the keys; true when unknown. */
  numbers?: boolean;
}): IOption[] {
  const { frame, summary, words, keys, cellId, cellLabel } = input;
  const mask = summary.mask;
  const placement = after(cellId, cellLabel);
  const others = summary.total_rows - summary.rows;
  const key = `table:${frame}:${fingerprint(mask ?? summary.where)}`;
  // The code is in the frame's own library: the kernel wrote the mask in it.
  const polars = summary.library === 'polars';
  const options: IOption[] = [];
  if (!summary.rows || !others) {
    return options;
  }
  if (mask) {
    const result = identifier(`${frame}_rows_apart`);
    if (!polars || input.numbers !== false) {
      options.push({
        id: `${key}:apart`,
        text: `What sets ${words} apart from the other rows of ${frame}?`,
        type: 'descriptive',
        origin: 'template',
        probability: 0.7,
        reasons: ['compares each number column here and in the other rows'],
        effect: 'Mean of each number column, here and in the other rows',
        placement,
        code: (polars ? polarsApart : pandasApart)(
          frame,
          mask,
          words,
          keys,
          result
        )
      });
    }
    if (input.missingValues) {
      const missing = identifier(`${frame}_rows_missing`);
      options.push({
        id: `${key}:missing`,
        text: `Are values missing more often in ${words}?`,
        type: 'quality',
        origin: 'template',
        probability: 0.55,
        reasons: ['missing values can gather in some rows'],
        effect: 'Share missing per column, here and in the other rows',
        placement,
        code: (polars ? polarsMissing : pandasMissing)(
          frame,
          mask,
          words,
          missing
        )
      });
    }
    const top = summary.differences.find(entry => entry.kind === 'number');
    const units = input.unit ? (summary.units ?? 0) : summary.rows;
    if (top && input.scipy && units >= 2 && others >= 2) {
      options.push(
        rowsTest(
          frame,
          mask,
          top.column,
          words,
          input.unit,
          placement,
          key,
          polars
        )
      );
    }
  }
  options.push({
    id: `${key}:why`,
    text: `Why do ${words} differ from the other rows of ${frame}?`,
    type: 'causal',
    origin: 'template',
    probability: 0.45,
    reasons: ['rows can differ because of who or what they measure'],
    effect: 'AI writes the check',
    placement,
    code: null
  });
  return options;
}

/** The mean of each number column in the rows picked and in the others, in pandas. */
function pandasApart(
  frame: string,
  mask: string,
  words: string,
  keys: string[],
  result: string
): string {
  const dropped = keys.length
    ? `.drop(columns=[${keys.map(pyString).join(', ')}], errors="ignore")`
    : '';
  return [
    pyComment(`What sets ${words} apart from the other rows of ${frame}?`),
    'import pandas as pd',
    '',
    `_rows = ${mask}`,
    `_numbers = ${frame}.select_dtypes("number")${dropped}`,
    `${result} = pd.DataFrame({`,
    '    "these rows": _numbers[_rows].mean(),',
    '    "other rows": _numbers[~_rows].mean(),',
    '})',
    `${result}["difference in SD"] = (${result}["these rows"] - ${result}["other rows"]) / _numbers.std()`,
    'del _rows, _numbers',
    `${result}.sort_values("difference in SD", key=abs, ascending=False).round(3)`
  ].join('\n');
}

/**
 * The same in polars: one row of means for the rows picked, one for the
 * others and one of standard deviations, turned into a row per column.
 */
function polarsApart(
  frame: string,
  mask: string,
  words: string,
  keys: string[],
  result: string
): string {
  const numbers = keys.length
    ? `cs.numeric() - cs.by_name(${keys.map(pyString).join(', ')}, require_all=False)`
    : 'cs.numeric()';
  return [
    pyComment(`What sets ${words} apart from the other rows of ${frame}?`),
    'import polars as pl',
    'import polars.selectors as cs',
    '',
    `_rows = ${mask}`,
    `_columns = ${frame}.select(${numbers}).columns`,
    `${result} = (`,
    '    pl.concat(',
    '        [',
    `            ${frame}.filter(_rows).select(_columns).mean(),`,
    `            ${frame}.filter(~_rows).select(_columns).mean(),`,
    `            ${frame}.select(_columns).std(),`,
    '        ],',
    '        how="vertical_relaxed",',
    '    )',
    '    .transpose(include_header=True, header_name="column", column_names=["these rows", "other rows", "sd"])',
    '    .with_columns(((pl.col("these rows") - pl.col("other rows")) / pl.col("sd")).fill_nan(None).alias("difference in SD"))',
    '    .drop("sd")',
    '    .sort(pl.col("difference in SD").abs(), descending=True, nulls_last=True)',
    '    .with_columns(cs.numeric().round(3))',
    ')',
    'del _rows, _columns',
    result
  ].join('\n');
}

/** The share of missing values of each column in the rows picked and in the others, in pandas. */
function pandasMissing(
  frame: string,
  mask: string,
  words: string,
  missing: string
): string {
  return [
    pyComment(`Are values missing more often in ${words}?`),
    'import pandas as pd',
    '',
    `_rows = ${mask}`,
    `${missing} = pd.DataFrame({`,
    `    "these rows": ${frame}[_rows].isna().mean(),`,
    `    "other rows": ${frame}[~_rows].isna().mean(),`,
    '}).round(3)',
    'del _rows',
    `${missing}[${missing}.max(axis=1) > 0].sort_values("these rows", ascending=False)`
  ].join('\n');
}

/** The same in polars, where a missing value is null. */
function polarsMissing(
  frame: string,
  mask: string,
  words: string,
  missing: string
): string {
  return [
    pyComment(`Are values missing more often in ${words}?`),
    'import polars as pl',
    'import polars.selectors as cs',
    '',
    `_rows = ${mask}`,
    `${missing} = (`,
    '    pl.concat(',
    '        [',
    `            ${frame}.filter(_rows).select(pl.all().is_null().mean()),`,
    `            ${frame}.filter(~_rows).select(pl.all().is_null().mean()),`,
    '        ]',
    '    )',
    '    .transpose(include_header=True, header_name="column", column_names=["these rows", "other rows"])',
    '    .with_columns(cs.numeric().round(3))',
    '    .filter(pl.max_horizontal("these rows", "other rows") > 0)',
    '    .sort("these rows", descending=True)',
    ')',
    'del _rows',
    missing
  ].join('\n');
}

/**
 * A Welch t-test on a column, between the rows picked and the others: on
 * one mean per unit when the frame has the notebook's unit, as the rows of
 * one patient are not independent.
 */
function rowsTest(
  frame: string,
  mask: string,
  column: string,
  words: string,
  unit: string | null,
  placement: IPlacement,
  key: string,
  polars = false
): IOption {
  const noun = unit ? unit.replace(/_id$/, '') : 'row';
  const counted = unit ? `${noun}s` : 'rows';
  const effect = `Welch t-test on ${unit ? `per-${noun} means` : 'rows'}`;
  const text = `Is ${column} different in ${words} by more than chance?`;
  const result = identifier(`${frame}_rows_${column}`);
  const quoted = pyString(column);
  const mean = pyString(`mean ${column}`);
  const split = polars
    ? unit
      ? [
          `_rows = ${mask}`,
          `_means = ${frame}.group_by(${pyString(unit)}, _rows.alias("_picked")).agg(pl.col(${quoted}).mean())`,
          `_a = _means.filter(pl.col("_picked"))[${quoted}].drop_nulls()`,
          `_b = _means.filter(~pl.col("_picked"))[${quoted}].drop_nulls()`
        ]
      : [
          `_rows = ${mask}`,
          `_a = ${frame}.filter(_rows)[${quoted}].drop_nulls()`,
          `_b = ${frame}.filter(~_rows)[${quoted}].drop_nulls()`
        ]
    : unit
      ? [
          `_means = ${frame}.assign(_picked=${mask}).groupby([${pyString(unit)}, "_picked"], observed=True)[${quoted}].mean().reset_index()`,
          `_a = _means.loc[_means["_picked"], ${quoted}]`,
          `_b = _means.loc[~_means["_picked"], ${quoted}]`
        ]
      : [
          `_rows = ${mask}`,
          `_a = ${frame}.loc[_rows, ${quoted}].dropna()`,
          `_b = ${frame}.loc[~_rows, ${quoted}].dropna()`
        ];
  const table = polars
    ? [
        '_test = stats.ttest_ind(_a.to_numpy(), _b.to_numpy(), equal_var=False)',
        `${result} = pl.DataFrame(`,
        `    {"group": ["these rows", "other rows"], ${pyString(counted)}: [_a.len(), _b.len()], ${mean}: [_a.mean(), _b.mean()]}`,
        `).with_columns(pl.col(${mean}).round(3))`
      ]
    : [
        '_test = stats.ttest_ind(_a, _b, equal_var=False)',
        `${result} = pd.DataFrame(`,
        `    {${pyString(counted)}: [len(_a), len(_b)], ${mean}: [_a.mean(), _b.mean()]},`,
        '    index=["these rows", "other rows"],',
        ').round(3)'
      ];
  const intermediate = polars
    ? unit
      ? '_rows, _means'
      : '_rows'
    : unit
      ? '_means'
      : '_rows';
  return {
    id: `${key}:test:${column}`,
    text,
    type: 'association',
    origin: 'template',
    probability: 0.6,
    reasons: [
      unit
        ? `compares ${noun} means, as rows of one ${noun} are not independent`
        : 'compares the rows picked with the other rows'
    ],
    effect,
    placement,
    code: [
      pyComment(text),
      polars ? 'import polars as pl' : 'import pandas as pd',
      'from scipy import stats',
      '',
      ...split,
      ...table,
      // The words stay out of the f-string, where a quote or a brace would end them.
      `print(${pyString(`${effect}:`)}, f"t = {_test.statistic:.2f}, p = {_test.pvalue:.3g}")`,
      `del ${intermediate}, _a, _b, _test`,
      result
    ].join('\n')
  };
}

/**
 * The questions the view can still ask when it cannot tell which frame, or
 * which of its columns or rows, a pick is: keep the table as a variable, so
 * that its own columns and rows can be asked about, and a question that an
 * AI model answers. A table of statistics is not kept: its rows are not rows
 * of data.
 */
function otherOptions(
  model: EpiModel,
  place: ITablePlace,
  source: ITableSource,
  pick: { headers: string[]; words: string | null }
): IOption[] {
  const { label, count } = outputPlace(model, place);
  const placement = after(place.cellId, label);
  const options: IOption[] = [];
  const expression = source.expression;
  const data = source.rows !== 'statistics' && source.rows !== 'columns';
  if (expression && expression !== source.frame && data) {
    const name = identifier(`table_${count ?? ''}`);
    options.push({
      id: `table:${place.cellId}:${place.output}:keep`,
      text: 'Keep this table as a variable, to ask about its columns and rows',
      type: 'descriptive',
      origin: 'template',
      probability: 0.5,
      reasons: ['a frame of its own is one that Whybook can read'],
      effect: `Runs ${expression} again as ${name}`,
      placement,
      code: [
        `# The table of ${label}, kept as ${name}`,
        `${name} = ${expression}`,
        name
      ].join('\n')
    });
  }
  if (pick.headers.length) {
    options.push({
      id: `table:${place.cellId}:${place.output}:${pick.headers.join('|')}:what`,
      text: `What does ${listed(pick.headers)} show in this table?`,
      type: 'descriptive',
      origin: 'template',
      probability: 0.4,
      reasons: ['the table does not say where the column comes from'],
      effect: 'AI writes the cell',
      placement,
      code: null
    });
  }
  if (pick.words && data) {
    options.push({
      id: `table:${place.cellId}:${place.output}:${fingerprint(pick.words)}:why`,
      text: `Why do ${pick.words} stand out in this table?`,
      type: 'causal',
      origin: 'template',
      probability: 0.4,
      reasons: ['Whybook cannot find these rows in a frame'],
      effect: 'AI writes the check',
      placement,
      code: null
    });
  }
  return options;
}

/**
 * Keep the rows picked in a table as a variable of their own, a new cell
 * after the table's cell, as a selection in a plot is kept.
 */
export function keepTableRows(model: EpiModel, ask: ITableAsk): void {
  const frame = ask.source.frame;
  const summary = ask.summary;
  if (!frame || !summary?.mask) {
    return;
  }
  const name = identifier(
    `${frame}_rows_${ask.rows.map(pick => pick.join('_')).join('_')}`
  ).slice(0, 40);
  const cell = model.cell(ask.cellId);
  const placement = after(ask.cellId, cell?.label ?? '');
  // A polars frame has no attrs to hold where its rows came from.
  const code = (
    summary.library === 'polars'
      ? [
          'import polars as pl',
          '',
          `${name} = ${frame}.filter(${summary.mask})`,
          `${name}.head()`
        ]
      : [
          ...(summary.mask.includes('pd.') ? ['import pandas as pd', ''] : []),
          `${name} = ${frame}[${summary.mask}].copy()`,
          `${name}.attrs["whybook"] = {"selection": {"of": ${pyString(frame)}, "where": ${pyString(summary.where)}}}`,
          `${name}.head()`
        ]
  ).join('\n');
  void model
    .apply(
      {
        id: `keep:${name}`,
        text: summary.positions
          ? `Keep ${summary.where} of ${frame} as ${name}`
          : `Keep the rows where ${summary.where} as ${name}`,
        type: 'descriptive',
        origin: 'template',
        probability: null,
        reasons: [],
        placement,
        code
      },
      placement
    )
    .then(() => model.select(name));
}
