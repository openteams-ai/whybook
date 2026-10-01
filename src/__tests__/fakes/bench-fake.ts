/**
 * A view model made by its own constructor over a real JupyterLab notebook
 * model, for the tests of the bench, the map and the Code view: no kernel
 * starts, and each request to the server fails at once.
 */
import type * as nbformat from '@jupyterlab/nbformat';
import { NotebookModel } from '@jupyterlab/notebook';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ServerConnection } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';

import { EpiModel, EpiSettings } from '../../model/epimodel';
import type { AgentRuns } from '../../model/runs';

// A notebook model built in a test reads each cell's Yjs map once before the
// map joins the notebook's document, and Yjs warns about it. The view does
// not do this.
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  const text = String(args[0] ?? '');
  if (
    !text.startsWith('Invalid access: Add Yjs type to a document') &&
    !text.startsWith('[yjs#509] Not same Y.Doc')
  ) {
    warn(...args);
  }
};

export interface IBenchCell {
  id: string;
  source?: string;
  type?: 'code' | 'markdown';
  count?: number | null;
  /** The cell's `whybook` metadata. */
  meta?: Record<string, unknown>;
  outputs?: nbformat.IOutput[];
}

/** The notebook of these cells, as its file holds it. */
export function notebookOf(cells: IBenchCell[]): nbformat.INotebookContent {
  return {
    cells: cells.map(cell =>
      cell.type === 'markdown'
        ? {
            cell_type: 'markdown',
            id: cell.id,
            source: cell.source ?? '',
            metadata: cell.meta ? { whybook: cell.meta } : {}
          }
        : {
            cell_type: 'code',
            id: cell.id,
            source: cell.source ?? `x_${cell.id} = 1`,
            metadata: cell.meta ? { whybook: cell.meta } : {},
            execution_count: cell.count ?? null,
            outputs: cell.outputs ?? []
          }
    ) as nbformat.ICell[],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  };
}

/** A registry that draws no output, for views whose outputs a test does not read. */
export const NO_OUTPUTS = {
  preferredMimeType: () => undefined
} as unknown as IRenderMimeRegistry;

export interface IBench {
  nb: NotebookModel;
  model: EpiModel;
  /** The notebook's document: a test marks it as loading or loaded. */
  context: { isReady: boolean; path: string };
}

/**
 * A view model of a notebook with these cells, or with the content of a
 * notebook file.
 */
export function benchModel(
  cells: IBenchCell[] | nbformat.INotebookContent,
  options: {
    rendermime?: IRenderMimeRegistry;
    path?: string;
    /** The file is still loading. */
    loading?: boolean;
    /** The agents' runs that the views of the notebook share. */
    runs?: AgentRuns;
    /** Another view of the same notebook: the new model shares its document. */
    view?: IBench;
  } = {}
): IBench {
  const serverSettings = ServerConnection.makeSettings({
    baseUrl: 'http://localhost:1/',
    // A request fails without leaving the test.
    fetch: () => Promise.reject(new Error('no server in the tests of views'))
  });
  if (options.view) {
    const { nb, context } = options.view;
    const model = new EpiModel({
      context: context as any,
      rendermime: options.rendermime ?? NO_OUTPUTS,
      serverSettings,
      settings: new EpiSettings(),
      runs: options.runs
    });
    return { nb, model, context };
  }
  const nb = new NotebookModel();
  nb.fromJSON(Array.isArray(cells) ? notebookOf(cells) : cells);
  const signal = () => new Signal<unknown, unknown>({});
  const sessionContext = {
    session: null,
    kernelChanged: signal(),
    statusChanged: signal(),
    iopubMessage: signal(),
    connectionStatusChanged: signal(),
    propertyChanged: signal(),
    unhandledMessage: signal(),
    kernelDisplayStatus: 'idle',
    isReady: false,
    // No kernel starts.
    ready: new Promise<void>(() => undefined)
  };
  const context = {
    model: nb,
    path: options.path ?? 'study/pain.ipynb',
    isReady: !options.loading,
    ready: options.loading
      ? new Promise<void>(() => undefined)
      : Promise.resolve(),
    sessionContext,
    disposed: signal(),
    isDisposed: false
  };
  const model = new EpiModel({
    context: context as any,
    rendermime: options.rendermime ?? NO_OUTPUTS,
    serverSettings,
    settings: new EpiSettings(),
    runs: options.runs
  });
  return { nb, model, context };
}

/** Change the code of a cell as a key typed in its editor does. */
export function typeKey(nb: NotebookModel, cellId: string, key = 'y'): void {
  for (let i = 0; i < nb.cells.length; i++) {
    const cell = nb.cells.get(i);
    if (cell.id === cellId) {
      cell.sharedModel.updateSource(0, 0, key);
      return;
    }
  }
  throw new Error(`no cell ${cellId}`);
}
