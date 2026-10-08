import type { IGuardHeld } from './guard';
import { PathExt } from '@jupyterlab/coreutils';
import type { IOutputModel } from '@jupyterlab/rendermime';

import type {
  IEpiNotebookMeta,
  IPlotPayload,
  IWrittenBy,
  StreamEvent
} from '../tokens';
import { PLOT_MIME } from '../tokens';
import { axesOf } from './axes';
import type { IComparison } from './crosskernel';
import { readHtml } from './frametable';
import { outputText } from './logs';
import { outputKind } from './notebook';
import { plotGlyph } from './outputs';
import { pyString } from './pycode';
import { keptCells } from './runs';
import { htmlOf, tableInfo, tableText } from './tables';

/**
 * An answer by an agent: the remote model adds and runs as many cells as
 * the question needs, and side explorations as branches, through tools
 * that the view runs (whybook/server/agent.py). The view keeps each run
 * with its steps, the agent's words, and the answer it ends with.
 */

/** The most characters of a text that a tool result carries. */
export const RESULT_TEXT = 2000;

/** The most characters of a file that the agent writes: MAX_FILE_CHARS on the server. */
export const FILE_CHARS = 20000;

/**
 * The first words of a file that the agent wrote: the mark that says so,
 * where a program reads it (architecture/limits.md, "Constraints").
 */
export const AI_FILE_MARK = '# Written by AI';

/** How the view shows a run, for review: roadmap item 1.35. */
export type AgentView = 'strip' | 'card' | 'sidebar';

/** A step that the server asks the view to run: a tool call of the agent. */
export interface IAgentToolEvent {
  type: 'tool';
  run: string;
  call: string;
  name: string;
  input: Record<string, unknown>;
}

/** The events of a run's stream. */
export type IAgentEvent =
  | StreamEvent
  | IAgentToolEvent
  | IGuardHeld
  | { type: 'started'; run: string; keep_local: boolean }
  | { type: 'text'; text: string }
  | { type: 'ping' };

/** One output of a cell that the agent ran, as the agent reads it. */
export interface IAgentOutput {
  kind: string;
  /** Printed text, or a table as text, cut to RESULT_TEXT. */
  text?: string;
  lines?: number;
  rows?: number | null;
  cols?: number | null;
  columns?: string[];
  /** What a plot draws: its kind, its axes' labels and its title. */
  plot?: { kind?: string; x?: string; y?: string; title?: string };
  /** What a local model wrote about a table, when the data stays here. */
  description?: string;
  headline?: string;
}

/** A file that a step of the agent wrote. */
export interface IAgentFile {
  /** The path from the server's root. */
  path: string;
  /** The path as the notebook's folder sees it, as the agent gave it. */
  name: string;
  lines: number;
  /** What the step wrote, with the AI mark on its first line. */
  content: string;
  /** The file before the step, or null when the step made it. */
  previous: string | null;
  /**
   * The notebook's record of the file before the step: the run that wrote
   * `previous`, which Remove puts back with it.
   */
  previousRecord?: NonNullable<IEpiNotebookMeta['files']>[string] | null;
}

/**
 * A step of a run: one cell, the branches of one cell, a file, a notebook
 * that the run made, frames written to files for it, or the comparison that
 * the run wrote at its end (design iteration 1.69).
 */
export interface IAgentStep {
  /** The server's id of the tool call; the comparison's is "compare". */
  call: string;
  tool:
    | 'run_cell'
    | 'explore'
    | 'write_file'
    | 'new_notebook'
    | 'share_frames'
    | 'compare';
  title: string;
  why: string;
  /** The cells the step added, in order. */
  cells: string[];
  /**
   * The path of the notebook that holds the step's cells, from the server's
   * root, when it is not the notebook where the question was asked.
   */
  notebook?: string;
  /**
   * The code that the step wrote in each of its cells, by the cell's id:
   * Remove asks first when a cell holds other code now.
   */
  code?: Record<string, string>;
  /** The file the step wrote, for write_file. */
  file?: IAgentFile | null;
  state: 'running' | 'done' | 'error';
  error: string | null;
  /**
   * The errors of the step's cells before their last run, by the cell's
   * id, each as its first line, the oldest first: the agent fixed the cell
   * in place after them, or removed it after the last (design iteration
   * 1.103). The run's card names them, so that no error is hidden.
   */
  failures?: Record<string, string[]>;
  /** The cells of the step that the agent removed after they failed. */
  removed?: string[];
}

export interface IAgentRun {
  /** The server's id of the run, once it started. */
  id: string | null;
  /** What the review guard held back in this run, in reject mode: its strip lists them. */
  held?: IGuardHeld[];
  /**
   * The cell whose strip shows the run, right above the run's cells: the
   * cell that they go after, which is the cell asked about when no cell
   * below it ran (./placement.ts); or the run's first cell, for a question
   * at the end or while another strip holds that cell.
   */
  stripId: string;
  question: string;
  /** The cell the question is about, if any. */
  anchor: string | null;
  state: 'starting' | 'working' | 'done' | 'failed' | 'stopped';
  steps: IAgentStep[];
  /** What the agent wrote between its steps. */
  notes: string[];
  thinking: string | null;
  answer: string | null;
  /** The labels of the cells that show the answer. */
  answerCells: string[];
  followUp: string[];
  by: IWrittenBy | null;
  /** The cells that the answer names, by the label it names them with. */
  answerRefs?: Record<string, string>;
  costUsd: number | null;
  /** How long the run took, in seconds, once it ended. */
  seconds?: number | null;
  /**
   * The cost cap that stopped the run, in US dollars: what was left under
   * the notebook's cap, or the server's cap of a run, whichever was lower.
   */
  capped?: IRunCap | null;
  /**
   * Asks the question again, from the start: a run cannot go on from where
   * it stopped. Set for a run that the notebook's cap may stop.
   */
  restart?: (() => Promise<void>) | null;
  /** Its cells were removed: the run's end is not kept in the notebook. */
  discarded?: boolean;
  /**
   * What the analyst changed since the run, while Remove asks before it
   * throws the changes away: the labels of cells and the names of files.
   */
  removeAsk?: string[] | null;
  error: string | null;
  started: number;
  /** Whether the data stayed on this machine for the run. */
  keepLocal: boolean;
  /** The notebooks that the run made beside the first, in order. */
  notebooks?: IRunNotebook[];
  /** The files that share_frames wrote, for Remove. */
  frames?: IFrameFile[];
  /**
   * The kernel that the question compares the notebook with: "Would I get
   * the same results in R?" names the R kernel it would use.
   */
  compare?: { name: string; displayName: string; label: string } | null;
  /**
   * The estimates of both notebooks, checked against their outputs, which
   * the run wrote into the first notebook as a text cell at its end.
   */
  comparison?: IComparison | null;
  /**
   * A run that ended before, drawn again from the notebook's record of it
   * (design iteration 1.73): when it ended, and whether the record holds its
   * steps and its answer, which records of older versions lack.
   * Its strip has no Remove, since the record keeps no code to check the
   * cells against.
   */
  past?: { at: string; full: boolean } | null;
}

/** A notebook that a run made beside the first, with a kernel of the server. */
export interface IRunNotebook {
  /** Its path from the server's root. */
  path: string;
  /** The kernelspec's name, such as xr. */
  kernel: string;
  /** The kernel's name in the view, such as "R 4.4.3 (xr)". */
  displayName: string;
  /** The language's name in the view's messages: Python, R. */
  label: string;
  sandboxed: boolean;
  /** The text cell that the view wrote first in it, which names the question. */
  intro: string | null;
  /** The language and its version, as the kernel said: "R 4.4.3". */
  version?: string | null;
  /** Whether its kernel reads parquet: share_frames writes CSV otherwise. */
  parquet?: boolean;
}

/** A file that a run's share_frames wrote, from the server's root. */
export interface IFrameFile {
  path: string;
  /** Whether a file of that name was there before: Remove leaves it. */
  existed: boolean;
}

/** The cap that stopped a run: the notebook's, or the server's cap of a run. */
export interface IRunCap {
  by: 'notebook' | 'server';
  usd: number;
}

/** The cap of a run's stopped result, as the server sends it, or null. */
export function runCap(value: unknown): IRunCap | null {
  const cap = value as { by?: unknown; usd?: unknown } | null | undefined;
  if (
    !cap ||
    (cap.by !== 'notebook' && cap.by !== 'server') ||
    typeof cap.usd !== 'number'
  ) {
    return null;
  }
  return { by: cap.by, usd: cap.usd };
}

function joined(value: unknown): string {
  return Array.isArray(value) ? value.join('') : String(value ?? '');
}

function cut(text: string): string {
  return text.length > RESULT_TEXT ? `${text.slice(0, RESULT_TEXT)}…` : text;
}

/**
 * The columns of a table, as the view's table reader reads a data frame of
 * pandas or polars: not the name of the index, which pandas writes under the
 * headers of a groupby. A column under two levels of headers is named as
 * pandas selects it, `("pain", "mean")`. Another table gives the headers of
 * its last header row.
 */
function tableColumns(html: string): string[] {
  const read = readHtml(html);
  if (read) {
    return read.columns
      .filter(column => column.path.length)
      .map(column =>
        column.path.length === 1
          ? column.path[0]
          : `(${column.path.map(pyString).join(', ')})`
      );
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // IRkernel writes the type of each column in a row of <chr>, <dbl> under
  // the names: the names are the last row that is not types. An output of
  // several tables gives the columns of the first.
  const first = doc.querySelector('table');
  const rows = Array.from(first?.querySelectorAll('thead tr') ?? []);
  const header =
    [...rows].reverse().find(row => !typeRow(row)) ??
    first?.querySelector('tr') ??
    null;
  return Array.from(header?.querySelectorAll('th') ?? [])
    .map(cell => cell.textContent?.trim() ?? '')
    .filter(Boolean);
}

/** A header row of IRkernel's types: <chr>, <dbl>, <fct>. */
function typeRow(row: Element): boolean {
  const cells = Array.from(row.querySelectorAll('th, td'));
  return (
    cells.length > 0 &&
    cells.every(cell => /^<[\w.]+>$/.test(cell.textContent?.trim() ?? ''))
  );
}

/**
 * The size that R's HTML writes in a table's caption: "A data.frame: 6 × 3",
 * "A tibble: 291 × 5", "A matrix: 2 × 2 of type int". IRkernel shows the
 * first and last rows of a long table, so the rows drawn are not its size.
 */
function captionSize(html: string): { rows: number; cols: number } | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const caption = doc.querySelector('table > caption')?.textContent ?? '';
  const match = /^\s*An? [\w.]+: ([\d,]+) × ([\d,]+)/.exec(caption);
  if (!match) {
    return null;
  }
  const count = (text: string) => parseInt(text.replace(/,/g, ''), 10);
  return { rows: count(match[1]), cols: count(match[2]) };
}

/**
 * The tables of an output that holds several, as SAS's ODS HTML does for a
 * procedure: each table's name, from its caption or its label, then its rows.
 */
function tablesText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('table'))
    .map(table => {
      const name =
        table.querySelector('caption')?.textContent?.trim() ||
        table.getAttribute('aria-label')?.trim() ||
        '';
      const rows = Array.from(table.querySelectorAll('tr')).map(row =>
        Array.from(row.children)
          .map(cell => cell.textContent?.trim() ?? '')
          .join(' | ')
      );
      return [name, ...rows].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/**
 * The outputs of a cell as a tool result gives them to the agent: printed
 * text, a table's size, columns and text, what a plot draws. The server
 * keeps only kinds, sizes, names and local descriptions when the data
 * stays on this machine.
 *
 * Any kernel's outputs read the same way (design iteration 1.69). xeus-r
 * prints a data frame as plain text, which the agent reads as printed text.
 * IRkernel draws it in HTML with a row of column types, and its size in the
 * caption. SAS's ODS HTML holds several tables in one output, each with its
 * name.
 */
export function agentOutputs(outputs: IOutputModel[]): IAgentOutput[] {
  const found: IAgentOutput[] = [];
  for (const output of outputs) {
    const kind = outputKind(output);
    if (kind === 'progress' || kind === 'widget') {
      continue;
    }
    if (kind === 'error') {
      // The error goes with the step, as its first line.
      continue;
    }
    if (kind === 'table') {
      const html = htmlOf(output);
      const info = tableInfo(html);
      const size = captionSize(html);
      const several = info.tables > 1;
      found.push({
        kind: 'table',
        rows: size?.rows ?? info.rows,
        cols: size?.cols ?? info.columns,
        columns: tableColumns(html).slice(0, 60),
        text: cut(
          several && !joined(output.data['text/plain']).trim()
            ? tablesText(html)
            : tableText(output)
        )
      });
      continue;
    }
    if (kind === 'plot' || kind === 'image' || kind === 'chart') {
      const { glyph, title } = plotGlyph(
        output.data as Record<string, unknown>
      );
      const axes = axesOf(output.data as Record<string, unknown>)?.axes[0];
      found.push({
        kind: 'plot',
        plot: {
          kind: glyph,
          ...(axes?.x.label || axes?.x.column
            ? { x: axes.x.column ?? axes.x.label }
            : {}),
          ...(axes?.y.label || axes?.y.column
            ? { y: axes.y.column ?? axes.y.label }
            : {}),
          ...(title ? { title } : {})
        }
      });
      continue;
    }
    const printed = outputText(output.data);
    if (printed) {
      found.push({
        kind: 'text',
        lines: printed.lines.length,
        text: cut(printed.lines.join('\n'))
      });
      continue;
    }
    const html = joined(output.data['text/html']);
    if (html) {
      found.push({ kind: 'html', text: cut(html.replace(/<[^>]+>/g, ' ')) });
    }
  }
  return found;
}

/**
 * The whole text of a cell's outputs, uncut, for a check that reads their
 * numbers: printed text, each table as text, the numbers that a plot of the
 * view's own draws, and each error as its name and message. Other pictures
 * and widgets have no text.
 */
export function cellOutputText(outputs: IOutputModel[]): string {
  const parts: string[] = [];
  for (const output of outputs) {
    const kind = outputKind(output);
    if (kind === 'error') {
      const error = output.toJSON() as { ename?: unknown; evalue?: unknown };
      parts.push(
        `${String(error.ename ?? 'Error')}: ${String(error.evalue ?? '')}`
      );
      continue;
    }
    if (kind === 'table') {
      const html = htmlOf(output);
      parts.push(
        tableInfo(html).tables > 1 && !joined(output.data['text/plain']).trim()
          ? tablesText(html)
          : tableText(output)
      );
      continue;
    }
    if (kind === 'plot') {
      // A plot of the view's own holds the numbers it draws.
      const payload = output.data[PLOT_MIME] as IPlotPayload | undefined;
      if (payload) {
        parts.push(plotNumbers(payload));
      }
      continue;
    }
    if (kind !== 'text' && kind !== 'log') {
      continue;
    }
    const printed = outputText(output.data);
    if (printed) {
      parts.push(printed.lines.join('\n'));
      continue;
    }
    const html = joined(output.data['text/html']);
    if (html) {
      parts.push(html.replace(/<[^>]+>/g, ' '));
    }
  }
  return parts.join('\n');
}

/**
 * The numbers that a plot of the view's own draws, one line a mark: each
 * point of a ribbon with its interval and its count, and each bar.
 */
export function plotNumbers(payload: IPlotPayload): string {
  const x = payload.source.x;
  const lines: string[] = [];
  for (const series of payload.series ?? []) {
    for (const point of series.points) {
      lines.push(
        `${series.name} ${x} ${point.x}: ${point.y} (${point.lo} to ${point.hi}), n ${point.n}`
      );
    }
  }
  for (const bar of payload.bars ?? []) {
    lines.push(`${bar.x}: ${bar.y}, n ${bar.n}`);
  }
  return lines.join('\n');
}

/** The id of the cell with this label, such as "[5]" or "[5b]", or null. */
export function cellByLabel(
  cells: { id: string; label: string }[],
  label: string | undefined | null
): string | null {
  if (!label) {
    return null;
  }
  const wanted = label.trim().replace(/^\[?/, '[').replace(/\]?$/, ']');
  return cells.find(cell => cell.label === wanted)?.id ?? null;
}

/**
 * The first line of the error that a cell's outputs hold, as its name and
 * message: "PatsyError: unrecognized token in constraint". Null for outputs
 * without an error.
 */
export function cellError(outputs: IOutputModel[]): string | null {
  for (const output of outputs) {
    if (outputKind(output) !== 'error') {
      continue;
    }
    const error = output.toJSON() as { ename?: unknown; evalue?: unknown };
    const name = String(error.ename ?? '') || 'Error';
    const message = String(error.evalue ?? '')
      .split('\n')[0]
      .trim();
    return message ? `${name}: ${message}` : name;
  }
  return null;
}

/**
 * The name of an error from its first line, "TypeError" for "TypeError:
 * only 0-dimensional arrays…", as the server's privacy.error_type reads it.
 */
export function errorName(line: string): string {
  const head = line.split(':', 1)[0].trim();
  return /^[\w.]{1,80}$/.test(head) ? head : 'an error';
}

/** A note on a step's line about a cell that failed (design iteration 1.103). */
export interface IStepNote {
  /**
   * fixed: the fix ran without an error; trying: the fix runs; again: the
   * fix failed too; removed: the agent removed the cell.
   */
  kind: 'fixed' | 'trying' | 'again' | 'removed';
  /** "fixed after TypeError", or "[5c] fixed after KeyError" on a step of several cells. */
  text: string;
  /** Each error, with its message, for the note's tooltip. */
  title: string;
}

/** The words of each note before the errors' names. */
const NOTE_VERBS: Record<IStepNote['kind'], string> = {
  fixed: 'fixed',
  trying: 'trying again',
  again: 'tried again',
  removed: 'removed'
};

/**
 * What became of the cells of a step that failed, in words: "fixed after
 * TypeError" for a cell that the agent fixed in place, "removed after
 * KeyError" for one that it removed, and "tried again after PatsyError"
 * while its fix fails too. Several errors go in their order: "fixed after
 * NameError, then TypeError". A step of several cells, the branches of
 * explore, names each cell by its label; `cellOf` gives a cell's label and
 * whether its outputs hold an error now, or null for a cell not here.
 */
export function stepNotes(
  step: IAgentStep,
  cellOf: (id: string) => { label: string; failed: boolean } | null
): IStepNote[] {
  const notes: IStepNote[] = [];
  const several = step.cells.length > 1;
  for (const id of step.cells) {
    const errors = step.failures?.[id] ?? [];
    if (!errors.length) {
      continue;
    }
    const removed = !!step.removed?.includes(id);
    const cell = removed ? null : cellOf(id);
    // The one cell of run_cell runs and fails with its step; a branch
    // fails while its outputs hold an error.
    const single = step.tool === 'run_cell';
    const kind: IStepNote['kind'] = removed
      ? 'removed'
      : single && step.state === 'running'
        ? 'trying'
        : (single ? step.state === 'error' : !!cell?.failed)
          ? 'again'
          : 'fixed';
    const verb = NOTE_VERBS[kind];
    const names = errors.map(errorName).join(', then ');
    const label = several ? (cell?.label ?? 'a branch') : null;
    notes.push({
      kind,
      text: `${label ? `${label} ` : ''}${verb} after ${names}`,
      title: errors.join('\n')
    });
  }
  return notes;
}

/**
 * Where a module that the agent asks to write goes: a path from the server's
 * root, inside the notebook's folder, or why not. Each part of the path is a
 * Python name, so that a cell can import the module. In a notebook whose
 * kernel runs R, the module is an R file that a cell reads with `source`.
 */
export function agentFilePath(
  notebookPath: string,
  requested: string,
  language: 'Python' | 'R' = 'Python'
): { path: string; name: string } | { error: string } {
  const name = requested.trim().replace(/\\/g, '/');
  if (!name) {
    return { error: 'the file needs a path' };
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    return { error: "the path must start from the notebook's folder" };
  }
  const parts = name.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) {
    return { error: "the path must stay inside the notebook's folder" };
  }
  const file = parts[parts.length - 1] ?? '';
  const extension = language === 'R' ? '.R' : '.py';
  if (!file.endsWith(extension)) {
    return {
      error:
        language === 'R'
          ? 'only an R module, a name ending in .R'
          : 'only a Python module, a name ending in .py'
    };
  }
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (
    !identifier.test(file.slice(0, -extension.length)) ||
    !parts.slice(0, -1).every(part => identifier.test(part))
  ) {
    return {
      error:
        'each part of the path must be a Python name: letters, digits and _'
    };
  }
  return {
    path: PathExt.join(PathExt.dirname(notebookPath), ...parts),
    name: parts.join('/')
  };
}

/**
 * A file as the agent writes it: its first line says that AI wrote it, for
 * which notebook and when, in place of any such line the content had.
 */
export function markedFile(
  content: string,
  notebook: string,
  model: string | null,
  at: string
): string {
  const lines = content.split('\n');
  const body = lines[0]?.startsWith(AI_FILE_MARK)
    ? lines.slice(1).join('\n')
    : content;
  const by = model ? `Whybook's agent, ${model}` : "Whybook's agent";
  return `${AI_FILE_MARK} (${by}) for ${notebook} on ${at.slice(0, 10)}.\n${body}`;
}

/** "1 cell", "3 cells". */
function cellCount(count: number): string {
  return count === 1 ? '1 cell' : `${count} cells`;
}

/**
 * What a run added, in words: its cells and files, and for a run that made
 * a notebook, the cells in each notebook: "1 cell here and 3 cells in
 * pain_diary_cohort.R.ipynb".
 */
export function runMade(run: IAgentRun): string {
  // A cell that the agent removed after it failed is not counted.
  const here = run.steps
    .filter(step => !step.notebook)
    .reduce((sum, step) => sum + keptCells(step).length, 0);
  const files = run.steps.filter(step => step.file && !step.error).length;
  const filesText = files
    ? ` and ${files === 1 ? '1 file' : `${files} files`}`
    : '';
  const others = run.notebooks ?? [];
  if (!others.length) {
    return cellCount(here) + filesText;
  }
  const parts = here ? [`${cellCount(here)} here`] : [];
  for (const notebook of others) {
    const count = run.steps
      .filter(step => step.notebook === notebook.path)
      .reduce((sum, step) => sum + keptCells(step).length, 0);
    parts.push(`${cellCount(count)} in ${PathExt.basename(notebook.path)}`);
  }
  return parts.join(' and ') + filesText;
}

/** A run's state in a few words, for its strip or card. */
export function runStatus(run: IAgentRun): string {
  const cells = run.steps.reduce(
    (sum, step) => sum + keptCells(step).length,
    0
  );
  const made = runMade(run);
  // The kernel of the one notebook that the run made.
  const kernel =
    run.notebooks?.length === 1 ? ` · ${run.notebooks[0].displayName}` : '';
  switch (run.state) {
    case 'starting':
      return 'Starting';
    case 'working':
      return cells ? `Working · ${made} so far` : 'Working';
    case 'done':
      return `Answered with ${made}${kernel}`;
    case 'stopped':
      return run.capped
        ? `Stopped at ${run.capped.by === 'notebook' ? "the notebook's cap" : 'the cost cap of a run'} · ${made} kept`
        : `Stopped · ${made} kept`;
    case 'failed':
    default:
      return 'Failed';
  }
}
