import type { INotebookModel } from '@jupyterlab/notebook';
import type { IOutputModel } from '@jupyterlab/rendermime';

import type { ITableNote, IWrittenBy } from '../tokens';
import type { Api } from './api';
import {
  cellMeta,
  findCell,
  outputKind,
  outputsOf,
  setCellMeta
} from './notebook';
import { htmlOf, tableInfo, tableKey, tableText } from './tables';
import { noteFor, withNote, writtenBy } from './writtenby';

/** Tiles that appear together go to the model in one request. */
const BATCH_DELAY = 400;
const BATCH_SIZE = 8;

interface IRequest {
  cellId: string;
  key: string;
  code: string;
  text: string;
  rows: number | null;
  columns: number | null;
}

/**
 * A model's labels for the tables that the bench shows as tiles. They are
 * asked for in batches and kept in the metadata of each cell, under a hash
 * of the output, so the next time the notebook opens they show at once.
 * Each set of labels records the model that wrote it. After a switch of
 * models, the newest labels show while the chosen model writes its own, and
 * each model's labels are kept, so a switch back shows them at once.
 */
export class TableNotes {
  constructor(options: TableNotes.IOptions) {
    this._api = options.api;
    this._notebook = options.notebook;
    this._enabled = options.enabled;
    this._model = options.model;
    this._changed = options.changed;
  }

  /** The labels of a table output to show for the model chosen now, or null. */
  note(cellId: string, key: string): ITableNote | null {
    return this._pick(cellId, key).note;
  }

  /** 'pending' while a model describes the table, 'failed' after an error. */
  state(key: string): 'pending' | 'failed' | null {
    return this._states.get(key) ?? null;
  }

  /** How many tables wait for their labels. */
  get pending(): number {
    return Array.from(this._states.values()).filter(
      state => state === 'pending'
    ).length;
  }

  /** Ask for the labels of a table, unless they are stored or on their way. */
  request(cellId: string, output: IOutputModel): void {
    const key = tableKey(output);
    const cell = findCell(this._notebook(), cellId);
    // Another model gets its own try at the tables the last one failed on.
    const model = this._model();
    if (model !== this._lastModel) {
      this._lastModel = model;
      for (const [failed, state] of this._states) {
        if (state === 'failed') {
          this._states.delete(failed);
        }
      }
    }
    if (
      !cell ||
      !this._enabled() ||
      this._states.has(key) ||
      !this._pick(cellId, key).ask
    ) {
      return;
    }
    const info = tableInfo(htmlOf(output));
    this._states.set(key, 'pending');
    this._queue.push({
      cellId,
      key,
      code: cell.sharedModel.getSource(),
      text: tableText(output),
      rows: info.rows,
      columns: info.columns
    });
    this._schedule();
    this._changed();
  }

  dispose(): void {
    if (this._timer !== null) {
      window.clearTimeout(this._timer);
      this._timer = null;
    }
    this._queue = [];
    this._abort.abort();
  }

  private _schedule(): void {
    if (this._timer === null && !this._busy) {
      this._timer = window.setTimeout(() => void this._flush(), BATCH_DELAY);
    }
  }

  private async _flush(): Promise<void> {
    this._timer = null;
    const batch = this._queue.splice(0, BATCH_SIZE);
    if (!batch.length) {
      return;
    }
    this._busy = true;
    const stored = new Set<string>();
    const choice = this._model();
    try {
      await this._api.describeTables(
        {
          model: choice,
          // The cell of each table goes along, for the cost of the call
          // (Api.onCall); the server reads the rest.
          tables: batch.map(request => ({
            id: request.key,
            cell: request.cellId,
            code: request.code,
            text: request.text,
            rows: request.rows,
            columns: request.columns
          }))
        },
        event => {
          if (event.type !== 'result') {
            return;
          }
          const notes = (event.tables ?? []) as (ITableNote & { id: string })[];
          const by = writtenBy(choice, event.model, event.file);
          for (const note of notes) {
            const request = batch.find(item => item.key === note.id);
            if (request && this._store(request.cellId, note, by)) {
              stored.add(note.id);
            }
          }
        },
        this._abort.signal
      );
    } catch (error) {
      if (!this._abort.signal.aborted) {
        console.warn('Could not describe the tables', error);
      }
    }
    for (const request of batch) {
      if (stored.has(request.key)) {
        this._states.delete(request.key);
      } else {
        // Not asked again in this session: a failure costs one request.
        this._states.set(request.key, 'failed');
      }
    }
    this._busy = false;
    this._changed();
    if (this._queue.length) {
      this._schedule();
    }
  }

  /** The labels to show for the model chosen now, and whether to ask it. */
  private _pick(
    cellId: string,
    key: string
  ): { note: ITableNote | null; ask: boolean } {
    const cell = findCell(this._notebook(), cellId);
    return noteFor(cell ? cellMeta(cell).tables?.[key] : null, this._model());
  }

  /** Keep the labels with the cell, dropping those of outputs it no longer has. */
  private _store(
    cellId: string,
    note: ITableNote & { id: string },
    by: IWrittenBy
  ): boolean {
    const cell = findCell(this._notebook(), cellId);
    if (!cell) {
      return false;
    }
    const live = new Set(
      outputsOf(cell)
        .filter(output => outputKind(output) === 'table')
        .map(tableKey)
    );
    if (!live.has(note.id)) {
      return false;
    }
    const tables: NonNullable<ReturnType<typeof cellMeta>['tables']> = {};
    const kept = cellMeta(cell).tables ?? {};
    const all = {
      ...kept,
      [note.id]: withNote(kept[note.id], {
        description: note.description,
        headline: note.headline,
        by
      })
    };
    for (const [key, value] of Object.entries(all)) {
      if (live.has(key)) {
        tables[key] = value;
      }
    }
    setCellMeta(cell, { tables });
    return true;
  }

  private _api: Api;
  private _notebook: () => INotebookModel;
  private _enabled: () => boolean;
  private _model: () => string;
  private _lastModel: string | null = null;
  private _changed: () => void;
  private _states = new Map<string, 'pending' | 'failed'>();
  private _queue: IRequest[] = [];
  private _timer: number | null = null;
  private _busy = false;
  private _abort = new AbortController();
}

export namespace TableNotes {
  export interface IOptions {
    api: Api;
    notebook: () => INotebookModel;
    /** Whether a model may be asked: the server can run it, and the settings allow it. */
    enabled: () => boolean;
    /** Which model: 'remote', or the id of a local model. */
    model: () => string;
    /** Called when a request starts or ends, so the view updates. */
    changed: () => void;
  }
}
