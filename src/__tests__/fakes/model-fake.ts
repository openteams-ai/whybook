/**
 * A view model over a real JupyterLab notebook model, with only the parts
 * that the methods under test reach: no kernel, no server and no widgets.
 * Its cells are read again at each call, as after any change.
 */
import './quiet';

import { NotebookModel } from '@jupyterlab/notebook';

import { EpiModel } from '../../model/epimodel';
import { DEFAULT_MODELS } from '../../model/models';

export interface IFakeCell {
  id: string;
  source?: string;
  count?: number | null;
  /** The cell's `whybook` metadata. */
  meta?: Record<string, unknown>;
  type?: 'code' | 'markdown';
}

/** A notebook model with these cells, and this `whybook` metadata. */
export function fakeNotebook(
  cells: IFakeCell[],
  notebookMeta: Record<string, unknown> = {}
): NotebookModel {
  const nb = new NotebookModel();
  nb.fromJSON({
    cells: cells.map(cell => ({
      cell_type: cell.type ?? 'code',
      id: cell.id,
      source: cell.source ?? `x_${cell.id} = 1`,
      metadata: cell.meta ? { whybook: cell.meta } : {},
      ...(cell.type === 'markdown'
        ? {}
        : { execution_count: cell.count ?? null, outputs: [] })
    })) as any,
    metadata: Object.keys(notebookMeta).length
      ? { whybook: notebookMeta as any }
      : {},
    nbformat: 4,
    nbformat_minor: 5
  });
  return nb;
}

/**
 * A view model without its constructor, over a notebook of these cells. The
 * test gives it the api, jobs and bridge calls that it needs.
 */
export function fakeModel(
  cells: IFakeCell[],
  notebookMeta: Record<string, unknown> = {}
): { nb: NotebookModel; model: any } {
  const nb = fakeNotebook(cells, notebookMeta);
  const model = Object.create(EpiModel.prototype);
  let version = 0;
  Object.assign(model, {
    context: {
      model: nb,
      path: 'n.ipynb',
      isReady: true,
      isDisposed: false,
      sessionContext: { session: null }
    },
    bridge: {
      analysis: () => null,
      freshAnalysis: () => null,
      hasRun: () => false,
      ranWithoutError: () => false,
      runCount: 0,
      snapshot: null
    },
    settings: {
      models: { ...DEFAULT_MODELS },
      interaction: 'drag',
      keepDataLocal: false,
      answers: 'agent',
      stripsClose: 'manual',
      requestRevealRight: () => undefined
    },
    status: null,
    strips: new Map(),
    parallel: new Map(),
    parallelEnded: new Map(),
    nextSteps: [],
    agentRuns: [],
    notices: [],
    touched: new Set(),
    codeOpen: new Set(),
    collapsed: new Set(),
    mode: 'wonder',
    _ran: new Set(),
    _sorted: new Map(),
    _agentAborts: new Map(),
    _variables: [],
    _variablesKey: '',
    _cells: null,
    _cellsVersion: -1,
    _cellsRuns: -1,
    _refreshPolicy: { changed: () => undefined, dispose: () => undefined },
    // The lists of questions that the pointer is on, and the refresh of Worth asking next.
    _pointed: new WeakSet(),
    _nextDebouncer: {
      invoke: () => Promise.resolve(),
      dispose: () => undefined
    },
    cellTitles: {
      edited: () => undefined,
      flush: () => undefined,
      titleAll: () => undefined,
      dispose: () => undefined
    },
    // _emit does nothing while a frame is pending.
    _frame: 1,
    _isDisposed: false,
    _closing: new Map()
  });
  // Every read is a new version, so the cells are read again each time.
  Object.defineProperty(model, '_version', {
    get: () => ++version,
    set: () => undefined,
    configurable: true
  });
  return { nb, model };
}

/** The ids of the notebook's cells, in order. */
export function ids(nb: NotebookModel): string[] {
  return Array.from(nb.cells).map(cell => cell.id);
}

/** The source of each cell, in order. */
export function sources(nb: NotebookModel): string[] {
  return Array.from(nb.cells).map(cell => cell.sharedModel.getSource());
}

/** Wait until the promises that are due now have settled. */
export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Wait until a condition holds, for at most a second. */
export async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
