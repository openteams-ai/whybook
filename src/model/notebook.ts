import type { ICellModel, ICodeCellModel } from '@jupyterlab/cells';
import type { INotebookModel } from '@jupyterlab/notebook';
import type { IOutputModel } from '@jupyterlab/rendermime';
import type { PartialJSONObject } from '@lumino/coreutils';

import type { IEpiCellMeta, IEpiNotebookMeta } from '../tokens';
import { codeKey } from './handedit';
import type { ILanguage } from './languages';
import { METADATA_KEY, PLOT_MIME, PROGRESS_MIME } from '../tokens';

export function cellMeta(cell: ICellModel): IEpiCellMeta {
  return (cell.getMetadata(METADATA_KEY) as IEpiCellMeta | undefined) ?? {};
}

export function setCellMeta(
  cell: ICellModel,
  patch: Partial<IEpiCellMeta>
): void {
  const next = { ...cellMeta(cell), ...patch };
  for (const key of Object.keys(next) as (keyof IEpiCellMeta)[]) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  cell.setMetadata(METADATA_KEY, next);
}

/**
 * The metadata that an answer writes on the cell it edits in place, and the
 * patch that puts the cell's metadata back, for Undo. Code that a model wrote
 * keeps the model's mark and what the model wrote about it, the summary, the
 * assumptions and the follow-up questions, as a new cell keeps them; they
 * replace the ones the cell had, which described the old code. An edit from a
 * template, with no `generated_by`, keeps what the cell had. The values that
 * the analyst chose for the edit join the cell's `user_values`. A template's
 * edit of a cell that no model wrote marks it `template`.
 */
export function editMeta(
  before: IEpiCellMeta,
  written: Partial<IEpiCellMeta>
): { patch: Partial<IEpiCellMeta>; restore: Partial<IEpiCellMeta> } {
  const patch: Partial<IEpiCellMeta> = { written_by: 'agent' };
  // The key of the code the view writes now, set before the code: the
  // analyst has not changed this code (./handedit.ts).
  if (written.view_code_key) {
    patch.view_code_key = written.view_code_key;
    patch.view_code = undefined;
  }
  if (written.generated_by) {
    patch.generated_by = written.generated_by;
    patch.summary = written.summary;
    patch.assumptions = written.assumptions;
    patch.follow_up = written.follow_up;
    // A model's code: the cell is no longer a template's.
    if (before.template) {
      patch.template = undefined;
    }
  } else if (!before.generated_by) {
    // A template's code, in a cell that no model wrote.
    patch.template = true;
  }
  // A value the analyst typed or picked stays theirs in the edited code.
  if (written.user_values?.length) {
    patch.user_values = [...(before.user_values ?? []), ...written.user_values];
  }
  // A key that the cell did not have is undefined here, and setCellMeta
  // deletes it.
  const restore: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof IEpiCellMeta)[]) {
    const value = before[key];
    restore[key] =
      value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  return { patch, restore: restore as Partial<IEpiCellMeta> };
}

export function notebookMeta(model: INotebookModel): IEpiNotebookMeta {
  return (
    (model.getMetadata(METADATA_KEY) as IEpiNotebookMeta | undefined) ?? {}
  );
}

export function setNotebookMeta(
  model: INotebookModel,
  patch: Partial<IEpiNotebookMeta>
): void {
  // A key set to undefined leaves the metadata, as in setCellMeta.
  const next = { ...notebookMeta(model), ...patch };
  for (const key of Object.keys(next) as (keyof IEpiNotebookMeta)[]) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  model.setMetadata(METADATA_KEY, next);
}

export function cellsOf(model: INotebookModel): ICellModel[] {
  const cells: ICellModel[] = [];
  for (let i = 0; i < model.cells.length; i++) {
    cells.push(model.cells.get(i));
  }
  return cells;
}

export function indexOf(model: INotebookModel, cellId: string): number {
  for (let i = 0; i < model.cells.length; i++) {
    if (model.cells.get(i).id === cellId) {
      return i;
    }
  }
  return -1;
}

export function findCell(
  model: INotebookModel,
  cellId: string
): ICellModel | null {
  const index = indexOf(model, cellId);
  return index >= 0 ? model.cells.get(index) : null;
}

/**
 * Insert a code cell at `index` and return its model. A cell whose code the
 * view wrote keeps the key of that code (./handedit.ts).
 */
export function insertCodeCell(
  model: INotebookModel,
  index: number,
  source: string,
  meta: IEpiCellMeta
): ICodeCellModel {
  const kept: IEpiCellMeta =
    meta.written_by === 'agent' && !meta.view_code_key
      ? { ...meta, view_code_key: codeKey(source) }
      : meta;
  model.sharedModel.insertCell(index, {
    cell_type: 'code',
    source,
    metadata: { [METADATA_KEY]: kept as PartialJSONObject }
  });
  return model.cells.get(index) as ICodeCellModel;
}

export function deleteCell(model: INotebookModel, cellId: string): void {
  const index = indexOf(model, cellId);
  if (index >= 0) {
    model.sharedModel.deleteCell(index);
  }
}

export type OutputKind =
  | 'plot'
  | 'chart'
  | 'widget'
  | 'image'
  | 'table'
  | 'log'
  | 'text'
  | 'error'
  | 'progress';

/** A live widget: a tqdm bar from tqdm.auto, an ipywidgets control, an ipympl figure. */
export const WIDGET_MIME = 'application/vnd.jupyter.widget-view+json';

/** Charts that a library's own renderer draws, as the notebook draws them. */
export const CHART_MIMES = [
  'application/vnd.plotly.v1+json',
  'application/vnd.vegalite.v5+json',
  'application/vnd.vegalite.v4+json',
  'application/vnd.vega.v5+json'
];

export function outputKind(output: IOutputModel): OutputKind {
  if (output.type === 'error') {
    return 'error';
  }
  const data = output.data;
  if (data[PROGRESS_MIME]) {
    return 'progress';
  }
  if (data[PLOT_MIME]) {
    return 'plot';
  }
  if (data[WIDGET_MIME]) {
    // A widget with a picture of itself is a figure, as from ipympl; the
    // others are controls and bars.
    return typeof data['image/png'] === 'string' ? 'chart' : 'widget';
  }
  if (CHART_MIMES.some(mime => data[mime])) {
    return 'chart';
  }
  if (
    typeof data['image/png'] === 'string' ||
    typeof data['image/jpeg'] === 'string' ||
    typeof data['image/svg+xml'] === 'string'
  ) {
    return 'image';
  }
  const html = typeof data['text/html'] === 'string' ? data['text/html'] : '';
  if (/<table/i.test(html)) {
    return 'table';
  }
  // A figure in HTML: ninejs and Bokeh draw in an iframe, an SVG or a script.
  if (/<(iframe|svg|canvas|script)\b/i.test(html)) {
    return 'chart';
  }
  if (output.type === 'stream') {
    return 'log';
  }
  return 'text';
}

export function outputsOf(cell: ICellModel): IOutputModel[] {
  if (cell.type !== 'code') {
    return [];
  }
  const outputs = (cell as ICodeCellModel).outputs;
  const list: IOutputModel[] = [];
  for (let i = 0; i < outputs.length; i++) {
    list.push(outputs.get(i));
  }
  return list;
}

/**
 * A line diff: each line of the result is kept, removed or added.
 */
export function lineDiff(
  before: string,
  after: string
): { kind: ' ' | '-' | '+'; text: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: { kind: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: ' ', text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: '-', text: a[i++] });
    } else {
      lines.push({ kind: '+', text: b[j++] });
    }
  }
  while (i < a.length) {
    lines.push({ kind: '-', text: a[i++] });
  }
  while (j < b.length) {
    lines.push({ kind: '+', text: b[j++] });
  }
  return lines;
}

/**
 * The text of a markdown cell under its heading: all of it when the cell
 * does not start with a heading, and '' for a heading alone.
 */
export function noteBody(source: string): string {
  const lines = source.split('\n');
  const first = lines.findIndex(line => line.trim());
  if (first >= 0 && /^#{1,6}\s/.test(lines[first].trim())) {
    return lines
      .slice(first + 1)
      .join('\n')
      .trim();
  }
  return source.trim();
}

/**
 * The first line of a cell's source without leading `#` characters. With the
 * language of a code cell, a comment in that language gives its text: the
 * SAS comment `* Load the visits;` gives "Load the visits".
 */
export function firstLine(
  source: string,
  language: ILanguage | null = null
): string {
  const line = source
    .split('\n')
    .map(text => text.trim())
    .find(text => text.length > 0);
  if (!line) {
    return '';
  }
  const text = language?.commentText(line) ?? line.replace(/^#+/, '').trim();
  return text.slice(0, 100);
}
