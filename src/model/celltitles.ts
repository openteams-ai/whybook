import type { ICellModel } from '@jupyterlab/cells';
import type { INotebookModel } from '@jupyterlab/notebook';

import type { IEpiCellMeta, ITitleNote } from '../tokens';
import type { Api } from './api';
import { isRemote } from './models';
import { cellMeta, setCellMeta } from './notebook';
import { fingerprint } from './tables';
import { noteFor, withNote, writtenBy } from './writtenby';

/** How long a cell waits after the analyst's last key before a model titles it. */
export const TITLE_PAUSE = 3000;

/**
 * The cells of one background request, and the pause after it, by the kind
 * of model: the remote model titles 8 cells in one call, and a local model
 * works through them one at a time in the Jupyter server, where every other
 * request waits for it. One request goes at a time, so that the questions
 * the analyst asks meanwhile are not held up.
 */
export const BACKGROUND = {
  remote: { cells: 8, pause: 2000 },
  local: { cells: 1, pause: 500 }
};

/** How long after a notebook opens its first-line titles start, and how often a busy view is checked again. */
export const BACKGROUND_START = 3000;
export const BACKGROUND_RETRY = 1500;

/** The key of a title: the code it is for. */
export function titleKey(source: string): string {
  return fingerprint(source.trim());
}

/**
 * The title to show: the chosen model's, or the newest while that model
 * writes its own. After an edit it stays until the title of the new code
 * comes, so that the card does not fall back to its first line while the
 * analyst types, and the model reads it as the title to keep if it fits.
 */
export function titleNote(
  meta: IEpiCellMeta,
  choice: string
): ITitleNote | null {
  return noteFor(meta.title_note, choice).note;
}

/**
 * Whether a model may give the cell a title: its title is its first line, the
 * agent's, or a model's. The question that an answer came from, and a title
 * that a person wrote in the metadata, as the demos have, stay: small local
 * models rename a title that still fits after a small edit.
 */
export function titledByModel(meta: IEpiCellMeta): boolean {
  return !meta.question && (!meta.title || meta.written_by === 'agent');
}

/** The modules that the title of an import cell names before "and N more". */
const IMPORTS_NAMED = 4;

/**
 * The title of a cell that only imports, from the modules it names:
 * "Imports: whybook, pandas, statsmodels and prep". Null for a cell with any
 * other code; comments and magics do not count. No model titles such a
 * cell: Ministral 3 3B titled the import cell of the demo "Mixed model fit
 * for pain trajectory", from its import of statsmodels.
 */
export function importsTitle(source: string): string | null {
  const lines = source
    // A parenthesised list of names, and a backslash, continue the line.
    .replace(/\([^)]*\)/g, '()')
    .replace(/\\\n/g, ' ')
    .split(/[\n;]/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('%'));
  if (!lines.length) {
    return null;
  }
  const modules: string[] = [];
  for (const line of lines) {
    const from = /^from\s+\.*([\w.]*)\s+import\s+(.*)$/.exec(line);
    const plain = /^import\s+(.+)$/.exec(line);
    if (!from && !plain) {
      return null;
    }
    // "from . import tools" names the modules that it imports.
    const names = from
      ? from[1]
        ? [from[1]]
        : from[2].split(',')
      : plain![1].split(',');
    for (const name of names) {
      const top = name.trim().split(/[\s.]/)[0];
      if (/^\w+$/.test(top) && top !== '__future__' && !modules.includes(top)) {
        modules.push(top);
      }
    }
  }
  if (!modules.length) {
    return 'Imports';
  }
  const shown = modules.slice(0, IMPORTS_NAMED);
  const more = modules.length - shown.length;
  const items = more > 0 ? [...shown, `${more} more`] : shown;
  const list =
    items.length > 1
      ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
      : items[0];
  return `Imports: ${list}`;
}

/**
 * Titles for code cells whose title is their first line, which often reads
 * "import pandas as pd". A pause of TITLE_PAUSE after the analyst's last key
 * in the view's editor, or a run of the cell, asks the model chosen for
 * labels and captions for a title at once, with the title the cell shows,
 * which the model may keep. When a notebook opens, the cells that still
 * have their first line as a title are titled in the background, a few at a
 * time (BACKGROUND). The title is kept in the cell's metadata with the
 * fingerprint of its code, so that the same code is titled once. A cell
 * that only imports is titled by importsTitle, and no model is asked.
 */
export class CellTitles {
  constructor(options: CellTitles.IOptions) {
    this._api = options.api;
    this._notebook = options.notebook;
    this._enabled = options.enabled;
    this._model = options.model;
    this._shown = options.shown;
    this._changed = options.changed;
    this._busy = options.busy ?? (() => false);
  }

  /** 'pending' while a model titles the cell, 'failed' after an error. */
  state(cellId: string): 'pending' | 'failed' | null {
    return this._states.get(cellId) ?? null;
  }

  /**
   * Title in the background every code cell whose title is its first line,
   * in the order of the notebook, BACKGROUND_START after it opens.
   */
  titleAll(): void {
    if (!this._enabled()) {
      return;
    }
    const cells = this._notebook().cells;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells.get(i);
      if (this._needs(cell) && !this._queue.includes(cell.id)) {
        this._queue.push(cell.id);
      }
    }
    if (this._queue.length && this._pumpTimer === null && !this._inFlight) {
      this._pumpTimer = window.setTimeout(() => this._pump(), BACKGROUND_START);
    }
  }

  /** The analyst typed in the cell's editor: a model titles it after a pause. */
  edited(cellId: string): void {
    const timer = this._timers.get(cellId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    this._timers.set(
      cellId,
      window.setTimeout(() => {
        this._timers.delete(cellId);
        this._request(cellId);
      }, TITLE_PAUSE)
    );
  }

  /** The cell runs: a title that waits for the pause is asked for now. */
  flush(cellId: string): void {
    const timer = this._timers.get(cellId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this._timers.delete(cellId);
      this._request(cellId);
    }
  }

  dispose(): void {
    for (const timer of this._timers.values()) {
      window.clearTimeout(timer);
    }
    this._timers.clear();
    if (this._pumpTimer !== null) {
      window.clearTimeout(this._pumpTimer);
      this._pumpTimer = null;
    }
    this._queue = [];
    this._abort.abort();
  }

  /** Whether a model should title the cell: it does more than import, its title is a first line, and no title of the chosen model fits its code. */
  private _needs(cell: ICellModel): boolean {
    const source = cell.sharedModel.getSource();
    if (cell.type !== 'code' || !source.trim() || importsTitle(source)) {
      return false;
    }
    const meta = cellMeta(cell);
    if (!titledByModel(meta)) {
      return false;
    }
    const key = titleKey(source);
    const state = this._states.get(cell.id);
    if (state === 'pending' || this._failed.get(cell.id) === key) {
      return false;
    }
    return noteFor(meta.title_note, this._model(), note => note.key === key)
      .ask;
  }

  /** Send the next background request, when none is on its way and the analyst waits for nothing. */
  private _pump(): void {
    this._pumpTimer = null;
    if (this._inFlight || !this._queue.length) {
      return;
    }
    if (!this._enabled()) {
      this._queue = [];
      return;
    }
    if (this._busy()) {
      this._pumpTimer = window.setTimeout(() => this._pump(), BACKGROUND_RETRY);
      return;
    }
    const kind = isRemote(this._model()) ? 'remote' : 'local';
    const batch: ICellModel[] = [];
    while (this._queue.length && batch.length < BACKGROUND[kind].cells) {
      const cell = this._find(this._queue.shift()!);
      if (cell && this._needs(cell)) {
        batch.push(cell);
      }
    }
    if (!batch.length) {
      this._pump();
      return;
    }
    this._inFlight = true;
    void this._send(batch).then(() => {
      this._inFlight = false;
      if (this._queue.length) {
        this._pumpTimer = window.setTimeout(
          () => this._pump(),
          BACKGROUND[kind].pause
        );
      }
    });
  }

  private _request(cellId: string): void {
    const cell = this._find(cellId);
    if (!cell || !this._enabled() || !this._needs(cell)) {
      return;
    }
    this._queue = this._queue.filter(id => id !== cellId);
    void this._send([cell]);
  }

  /** Ask the chosen model for the titles of the cells, and keep each with the code it is for. */
  private _send(cells: ICellModel[]): Promise<void> {
    const choice = this._model();
    const keys = new Map(
      cells.map(cell => [cell.id, titleKey(cell.sharedModel.getSource())])
    );
    const stored = new Set<string>();
    for (const cell of cells) {
      this._states.set(cell.id, 'pending');
    }
    this._changed();
    return this._api
      .titleCells(
        {
          model: choice,
          cells: cells.map(cell => ({
            id: cell.id,
            code: cell.sharedModel.getSource(),
            title: this._shown(cell.id)
          }))
        },
        event => {
          if (event.type !== 'result') {
            return;
          }
          for (const note of (event.cells ?? []) as {
            id: string;
            title: string;
          }[]) {
            const cell = cells.find(item => item.id === note.id);
            if (!cell || !note.title) {
              continue;
            }
            setCellMeta(cell, {
              title_note: withNote(cellMeta(cell).title_note, {
                title: note.title,
                key: keys.get(cell.id)!,
                by: writtenBy(choice, event.model, event.file)
              })
            });
            stored.add(cell.id);
          }
        },
        this._abort.signal
      )
      .catch(error => {
        if (!this._abort.signal.aborted) {
          console.warn('Could not title the cells', error);
        }
      })
      .then(() => {
        for (const cell of cells) {
          if (stored.has(cell.id)) {
            this._states.delete(cell.id);
            this._failed.delete(cell.id);
          } else {
            // Not asked again for the same code in this session.
            this._states.set(cell.id, 'failed');
            this._failed.set(cell.id, keys.get(cell.id)!);
          }
        }
        this._changed();
      });
  }

  private _find(cellId: string): ICellModel | null {
    const cells = this._notebook().cells;
    for (let i = 0; i < cells.length; i++) {
      if (cells.get(i).id === cellId) {
        return cells.get(i);
      }
    }
    return null;
  }

  private _api: Api;
  private _notebook: () => INotebookModel;
  private _enabled: () => boolean;
  private _model: () => string;
  private _shown: (cellId: string) => string;
  private _changed: () => void;
  private _busy: () => boolean;
  private _abort = new AbortController();
  private _states = new Map<string, 'pending' | 'failed'>();
  /** The fingerprint of the code that a model failed to title, by cell. */
  private _failed = new Map<string, string>();
  private _timers = new Map<string, number>();
  private _queue: string[] = [];
  private _pumpTimer: number | null = null;
  private _inFlight = false;
}

export namespace CellTitles {
  export interface IOptions {
    api: Api;
    notebook: () => INotebookModel;
    /** Whether a model may be asked: the server can run it, and the settings allow it. */
    enabled: () => boolean;
    /** Which model: 'remote', or the id of a local model. */
    model: () => string;
    /** The title the cell shows now, which the model keeps when it still fits. */
    shown: (cellId: string) => string;
    /** Called when a request starts or ends, so the view updates. */
    changed: () => void;
    /** Whether the analyst waits for a model's answer: background titles wait too. */
    busy?: () => boolean;
  }
}
