import type { INotebookModel } from '@jupyterlab/notebook';

import type { IFrameNote, IVariable } from '../tokens';
import type { Api } from './api';
import { notebookMeta, setNotebookMeta } from './notebook';
import { fingerprint } from './tables';
import { noteFor, withNote, writtenBy } from './writtenby';

/** The columns a model reads about a frame, at most. */
const MAX_COLUMNS = 60;

/**
 * The key of a frame's summary: its name and its columns. A frame whose
 * columns change gets a new summary.
 */
export function frameKey(variable: IVariable): string {
  const columns = (variable.columns ?? []).map(
    column => `${column.label}:${column.tag ?? ''}`
  );
  return fingerprint(
    `${variable.name}|${variable.n_columns ?? ''}|${columns.join(',')}`
  );
}

/**
 * A model's summary of each data frame that Contents shows: one sentence on
 * what one row is and what the frame holds. It is asked for when a frame is
 * selected, once, and kept in the notebook's metadata under the frame's name.
 */
export class FrameNotes {
  constructor(options: FrameNotes.IOptions) {
    this._api = options.api;
    this._notebook = options.notebook;
    this._enabled = options.enabled;
    this._model = options.model;
    this._changed = options.changed;
  }

  /**
   * The summary of a frame to show for the model chosen now, while its
   * columns are the same. After a switch of models, the newest summary shows
   * while the chosen model writes its own.
   */
  note(variable: IVariable): IFrameNote | null {
    return this._pick(variable).note;
  }

  private _pick(variable: IVariable): {
    note: IFrameNote | null;
    ask: boolean;
  } {
    const key = frameKey(variable);
    return noteFor(
      notebookMeta(this._notebook()).frames?.[variable.name],
      this._model(),
      note => note.key === key
    );
  }

  /** 'pending' while a model summarises the frame, 'failed' after an error. */
  state(variable: IVariable): 'pending' | 'failed' | null {
    return this._states.get(frameKey(variable)) ?? null;
  }

  /** Ask for the summary of a frame, unless it is kept or on its way. */
  request(variable: IVariable): void {
    const key = frameKey(variable);
    const model = this._model();
    if (model !== this._lastModel) {
      // Another model gets its own try at the frames the last one failed on.
      this._lastModel = model;
      this._states.clear();
    }
    if (
      !this._enabled() ||
      this._states.has(key) ||
      !this._pick(variable).ask
    ) {
      return;
    }
    this._states.set(key, 'pending');
    this._changed();
    const frame = {
      id: key,
      name: variable.name,
      rows: variable.rows ?? null,
      n_columns: variable.n_columns ?? variable.columns?.length ?? null,
      columns: (variable.columns ?? []).slice(0, MAX_COLUMNS).map(column => ({
        name: column.label,
        type: column.tag ?? ''
      }))
    };
    let stored = false;
    void this._api
      .describeFrames({ model, frames: [frame] }, event => {
        if (event.type !== 'result') {
          return;
        }
        const notes = (event.frames ?? []) as { id: string; summary: string }[];
        const found = notes.find(note => note.id === key && note.summary);
        if (found) {
          const frames = notebookMeta(this._notebook()).frames ?? {};
          setNotebookMeta(this._notebook(), {
            frames: {
              ...frames,
              [variable.name]: withNote(frames[variable.name], {
                summary: found.summary,
                key,
                by: writtenBy(model, event.model, event.file)
              })
            }
          });
          stored = true;
        }
      })
      .catch(error => console.warn('Could not summarise the frame', error))
      .then(() => {
        if (stored) {
          this._states.delete(key);
        } else {
          // Not asked again in this session: a failure costs one request.
          this._states.set(key, 'failed');
        }
        this._changed();
      });
  }

  private _api: Api;
  private _notebook: () => INotebookModel;
  private _enabled: () => boolean;
  private _model: () => string;
  private _changed: () => void;
  private _lastModel: string | null = null;
  private _states = new Map<string, 'pending' | 'failed'>();
}

export namespace FrameNotes {
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
