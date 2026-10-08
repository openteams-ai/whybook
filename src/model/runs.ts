import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { INotebookModel } from '@jupyterlab/notebook';
import { Token } from '@lumino/coreutils';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

import type { IAgentRunRecord, IAgentStepRecord } from '../tokens';
import type { IAgentRun, IAgentStep } from './agent';
import type { EpiModel, IStrip } from './epimodel';

/**
 * The agents' runs of every open notebook, kept for the whole application:
 * design iteration 1.56. A run belongs to its notebook, not to the view that
 * asked its question. Every Whybook view of the notebook shows its strip, a
 * view opened again on the notebook finds it, and JupyterLab's Running panel
 * and the status bar list the runs that go on.
 *
 * The view model that started a run still runs its tool calls, also after
 * its view closed, while the notebook is open in another view; the run stops
 * when the notebook closes (EpiModel.dispose). A run leaves the list when
 * the analyst closes its strip or removes its cells, or when its notebook
 * closes.
 *
 * The notebook keeps each run that ended in its metadata, `whybook.agent_runs`,
 * with what its strip shows (design iteration 1.73, `historyOf`): the
 * Exploration panel lists the notebook's runs, and a run that left the list
 * comes back to it, with its strip drawn again (`pastRun`), from that list
 * or from a cell that it wrote.
 *
 * A run can make a second notebook and work in it (design iteration 1.69):
 * the list holds the run for both notebooks, so that the views of the
 * second show it too, and the Running panel lists it once.
 */
export interface IRunEntry {
  run: IAgentRun;
  /** The strip that shows the run: every view of the notebook draws this one. */
  strip: IStrip;
  /** The notebook's document, which every view of the notebook shares. */
  context: DocumentRegistry.IContext<INotebookModel>;
  /** The documents of the notebooks that the run made, where it works too. */
  others?: DocumentRegistry.IContext<INotebookModel>[];
  /** Stop the run, as the Stop of its strip does. */
  stop: () => void;
  /**
   * Remove the cells and files that the run added, the notebooks it made
   * among them, as "Remove its cells and files" of its strip does.
   */
  discard?: (anyway: boolean) => Promise<void>;
  /** The view model that runs the run's tool calls. */
  owner: object;
}

/**
 * What the plugin gives the views to make and open notebooks for an agent's
 * run, through JupyterLab's commands (design iteration 1.69).
 */
export interface INotebookHost {
  /**
   * Make an empty notebook at `path` with this kernel, open it in the
   * Whybook view in a tab after the view of `beside`, without taking the
   * focus, and give its view model once its kernel is ready.
   */
  create(options: {
    path: string;
    kernel: string;
    beside: string;
  }): Promise<EpiModel>;
  /**
   * Open the notebook at `path` in the Whybook view, and show this cell;
   * without `activate`, in a tab that does not take the focus.
   */
  show(path: string, cellId?: string | null, activate?: boolean): Promise<void>;
  /** The view model of an open Whybook view of the notebook, or null. */
  modelOf(path: string): EpiModel | null;
  /** Close every view of the notebook without saving, stop its kernel and delete the file. */
  remove(path: string): Promise<void>;
}

/** Whether a run goes on: it started, and it has not ended. */
export function isGoing(run: IAgentRun): boolean {
  return run.state === 'starting' || run.state === 'working';
}

/**
 * The cells of a step that are in the notebook still: those that the agent
 * did not remove after they failed (design iteration 1.103).
 */
export function keptCells(step: IAgentStep): string[] {
  const removed = step.removed;
  return removed?.length
    ? step.cells.filter(id => !removed.includes(id))
    : step.cells;
}

/** The number of cells that a run added so far, less those it removed after they failed. */
export function cellsSoFar(run: IAgentRun): number {
  return run.steps.reduce((sum, step) => sum + keptCells(step).length, 0);
}

/** How long a run has gone on, as the view says it: "41 s", "3 min 5 s". */
export function runTime(run: IAgentRun, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - run.started) / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/**
 * When a run ended, as the history of runs says it: the time for a run of
 * today, the day for one of this year, else the day and the year. An ISO
 * time that does not parse gives an empty text.
 */
export function runWhen(at: string, now: Date = new Date()): string {
  const date = new Date(at);
  if (isNaN(date.getTime())) {
    return '';
  }
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  });
}

/**
 * The most that the notebook keeps of each text of a run, in characters,
 * and the most follow-up questions. The agent's answer is at most three
 * sentences by its prompt; the cut guards the file against a longer one.
 */
export const KEPT = { answer: 2000, text: 300, error: 500, followUps: 5 };

/** The tools of a run's steps, as IAgentStep names them. */
const TOOLS: readonly IAgentStep['tool'][] = [
  'run_cell',
  'explore',
  'write_file',
  'new_notebook',
  'share_frames',
  'compare'
];

function cut(text: string, most: number): string {
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
}

/** The errors of a step's cells as a record keeps them, without what is not a list of texts. */
function keptFailures(value: unknown): Record<string, string[]> {
  const kept: Record<string, string[]> = {};
  if (!value || typeof value !== 'object') {
    return kept;
  }
  for (const [id, errors] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(errors)) {
      kept[id] = errors.filter(
        (error): error is string => typeof error === 'string'
      );
    }
  }
  return kept;
}

/**
 * What the notebook keeps of a run besides who wrote it and what it cost,
 * so that its strip shows again from the history of runs (design iteration
 * 1.73): the question's cell, the steps with their words and cells, the
 * answer, the follow-ups, the notebooks it made and how it ended. The
 * agent's words between steps, the code of each step and the results that
 * went back to the model stay out: the cells hold the code.
 */
export function historyOf(run: IAgentRun): Partial<IAgentRunRecord> {
  const steps = run.steps.map((step): IAgentStepRecord => ({
    tool: step.tool,
    title: cut(step.title, KEPT.text),
    ...(step.why ? { why: cut(step.why, KEPT.text) } : {}),
    cells: [...step.cells],
    ...(step.notebook ? { notebook: step.notebook } : {}),
    ...(step.file
      ? {
          file: {
            path: step.file.path,
            name: step.file.name,
            lines: step.file.lines
          }
        }
      : {}),
    // A step that went on when the run stopped did not end.
    state: step.state === 'done' ? 'done' : 'error',
    ...(step.error
      ? { error: cut(step.error, KEPT.error) }
      : step.state === 'running'
        ? { error: 'The run stopped before this step ended.' }
        : {}),
    // The errors that the agent fixed in place, or removed the cell after.
    ...(step.failures && Object.keys(step.failures).length
      ? {
          failures: Object.fromEntries(
            Object.entries(step.failures).map(([id, errors]) => [
              id,
              errors.map(error => cut(error, KEPT.text))
            ])
          )
        }
      : {}),
    ...(step.removed?.length ? { removed: [...step.removed] } : {})
  }));
  const refs = run.answerRefs ?? {};
  return {
    started: new Date(run.started).toISOString(),
    anchor: run.anchor,
    ...(run.by?.choice ? { choice: run.by.choice } : {}),
    steps,
    answer: run.answer ? cut(run.answer, KEPT.answer) : null,
    ...(Object.keys(refs).length ? { answer_refs: { ...refs } } : {}),
    follow_up: run.followUp
      .slice(0, KEPT.followUps)
      .map(item => cut(item, KEPT.text)),
    ...(run.notebooks?.length
      ? {
          notebooks: run.notebooks.map(notebook => ({
            path: notebook.path,
            kernel: notebook.kernel,
            display_name: notebook.displayName,
            label: notebook.label
          }))
        }
      : {}),
    keep_local: run.keepLocal,
    ...(run.capped ? { capped: { ...run.capped } } : {}),
    ...(run.error ? { error: cut(run.error, KEPT.error) } : {})
  };
}

/**
 * A run as the notebook keeps it, to draw its strip again. A record of an
 * older version has no steps: its cells show as one step, with
 * no answer. The caller sets the strip's cell.
 */
export function pastRun(id: string, record: IAgentRunRecord): IAgentRun {
  const kept = Array.isArray(record.steps) ? record.steps : null;
  const steps: IAgentStep[] = kept
    ? kept.map((step, index) => ({
        call: `kept:${index}`,
        tool: TOOLS.includes(step.tool as IAgentStep['tool'])
          ? (step.tool as IAgentStep['tool'])
          : 'run_cell',
        title: step.title ?? '',
        why: step.why ?? '',
        cells: [...(step.cells ?? [])],
        ...(step.notebook ? { notebook: step.notebook } : {}),
        file: step.file
          ? {
              path: step.file.path,
              name: step.file.name,
              lines: step.file.lines,
              content: '',
              previous: null
            }
          : null,
        state: step.state === 'error' ? 'error' : 'done',
        error: step.error ?? null,
        ...(step.failures ? { failures: keptFailures(step.failures) } : {}),
        ...(Array.isArray(step.removed)
          ? { removed: step.removed.filter(id => typeof id === 'string') }
          : {})
      }))
    : (record.cells ?? []).length
      ? [
          {
            call: 'kept:0',
            tool: 'run_cell',
            title: '',
            why: '',
            cells: [...record.cells],
            state: 'done',
            error: null
          }
        ]
      : [];
  const started = Date.parse(record.started ?? '');
  const ended = Date.parse(record.at);
  return {
    id,
    stripId: '',
    question: record.question,
    anchor: record.anchor ?? null,
    state: record.state,
    steps,
    notes: [],
    thinking: null,
    answer: record.answer ?? null,
    answerCells: [],
    followUp: [...(record.follow_up ?? [])],
    by:
      record.model || record.provider
        ? {
            choice: record.choice ?? 'remote',
            model: record.model,
            at: record.at
          }
        : null,
    ...(record.answer_refs ? { answerRefs: { ...record.answer_refs } } : {}),
    costUsd: record.cost_usd,
    seconds: record.seconds ?? null,
    capped: record.capped ?? null,
    error: record.error ?? null,
    started: !isNaN(started)
      ? started
      : !isNaN(ended)
        ? ended - (record.seconds ?? 0) * 1000
        : 0,
    keepLocal: !!record.keep_local,
    ...(record.notebooks?.length
      ? {
          notebooks: record.notebooks.map(notebook => ({
            path: notebook.path,
            kernel: notebook.kernel,
            displayName: notebook.display_name,
            label: notebook.label,
            sandboxed: false,
            intro: null
          }))
        }
      : {}),
    past: { at: record.at, full: !!kept }
  };
}

/** One run of a notebook's history, as the Exploration panel lists it. */
export interface IHistoryRow {
  /** The run's id; null for a run that has not started on the server yet. */
  id: string | null;
  question: string;
  state: IAgentRun['state'];
  /** The run while its strip shows, or while it goes on. */
  live: IAgentRun | null;
  /** The notebook's record of the run, once it ended. */
  record: IAgentRunRecord | null;
  /** When it ended, or started for a run that goes on, in milliseconds. */
  at: number;
}

/**
 * A notebook's runs, the newest first: those that go on, then those that
 * the notebook keeps, whose strip may show too. A run whose record the
 * notebook holds is listed once.
 */
export function historyRows(
  records: Record<string, IAgentRunRecord> | undefined,
  live: readonly IAgentRun[]
): IHistoryRow[] {
  const rows: IHistoryRow[] = [];
  const kept = records ?? {};
  for (const run of live) {
    if (run.past || (run.id && run.id in kept)) {
      continue;
    }
    rows.push({
      id: run.id,
      question: run.question,
      state: run.state,
      live: run,
      record: null,
      at: run.started
    });
  }
  for (const [id, record] of Object.entries(kept)) {
    if (!record || typeof record.question !== 'string') {
      continue;
    }
    const at = Date.parse(record.at);
    rows.push({
      id,
      question: record.question,
      state: record.state,
      live: live.find(run => run.id === id) ?? null,
      record,
      at: isNaN(at) ? 0 : at
    });
  }
  // Runs that go on first, then the newest.
  const going = (row: IHistoryRow) => (row.live && isGoing(row.live) ? 1 : 0);
  return rows.sort((a, b) => going(b) - going(a) || b.at - a.at);
}

export class AgentRuns {
  /** Emitted once for the changes of a moment: a run started, changed or left the list. */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /** Every run of the list, the oldest first. */
  get all(): readonly IRunEntry[] {
    return this._entries;
  }

  /** The runs that go on, in every notebook, the oldest first. */
  going(): IRunEntry[] {
    return this._entries.filter(entry => isGoing(entry.run));
  }

  /**
   * The runs of one notebook, the oldest first: those asked in it, and those
   * that work in it as a notebook they made.
   */
  of(notebook: INotebookModel): IRunEntry[] {
    return this._entries.filter(
      entry =>
        entry.context.model === notebook ||
        !!entry.others?.some(other => other.model === notebook)
    );
  }

  /**
   * A run made a notebook and works in it: the views of that notebook show
   * the run too. The run stays on the list when that notebook closes.
   */
  join(
    run: IAgentRun,
    context: DocumentRegistry.IContext<INotebookModel>
  ): void {
    const entry = this.entry(run);
    if (!entry || entry.others?.includes(context)) {
      return;
    }
    entry.others = [...(entry.others ?? []), context];
    if (!this._watched.has(context)) {
      this._watched.add(context);
      context.disposed?.connect(this._onClosed, this);
    }
    this.touch();
  }

  /** The entry of a run, or null when the list does not hold it. */
  entry(run: IAgentRun): IRunEntry | null {
    return this._entries.find(entry => entry.run === run) ?? null;
  }

  /**
   * Add a run that a view started. The list lets go of the notebook's runs
   * when the notebook closes.
   */
  add(entry: IRunEntry): void {
    if (this.entry(entry.run)) {
      return;
    }
    this._entries = [...this._entries, entry];
    const context = entry.context;
    if (!this._watched.has(context)) {
      this._watched.add(context);
      context.disposed?.connect(this._onClosed, this);
    }
    this.touch();
  }

  /** Take a run off the list: its strip closed, or its cells were removed. */
  remove(run: IAgentRun): void {
    const kept = this._entries.filter(entry => entry.run !== run);
    if (kept.length !== this._entries.length) {
      this._entries = kept;
      this.touch();
    }
  }

  /** Stop a run, as the Stop of its strip does; its cells stay. */
  stop(run: IAgentRun): void {
    this.entry(run)?.stop();
  }

  /**
   * Opens the Whybook view of a run's notebook, on the run's strip. The
   * plugin that makes the views sets it.
   */
  opener: ((entry: IRunEntry) => Promise<void>) | null = null;

  /**
   * Makes, opens and removes the notebooks that a run works in besides its
   * own. The plugin that makes the views sets it; without it, a run makes
   * no notebook.
   */
  host: INotebookHost | null = null;

  /**
   * The setting "History of agents' runs" (design iteration 1.73), on by
   * default: the notebook keeps each run's steps and answer, the
   * Exploration panel lists the notebook's runs, and a cell that a run
   * wrote leads to its run. Off, the notebook keeps what it kept before.
   */
  get history(): boolean {
    return this._history;
  }

  set history(on: boolean) {
    if (on !== this._history) {
      this._history = on;
      this.touch();
    }
  }

  /** Open the Whybook view of a run's notebook, on the run's strip. */
  async open(run: IAgentRun): Promise<void> {
    const entry = this.entry(run);
    if (entry && this.opener) {
      await this.opener(entry);
    }
  }

  /**
   * A run changed: its state, its steps or its strip. The views of its
   * notebook draw it again, once for all the changes until the next task.
   */
  touch(): void {
    if (this._pending) {
      return;
    }
    this._pending = true;
    void Promise.resolve().then(() => {
      this._pending = false;
      this._changed.emit();
    });
  }

  /**
   * A notebook closed in every view: its runs stopped, and leave the list.
   * A notebook that a run made only leaves its entry.
   */
  private _onClosed(): void {
    for (const context of [...this._watched]) {
      if (context.isDisposed) {
        this._watched.delete(context);
      }
    }
    const kept = this._entries.filter(entry => !entry.context.isDisposed);
    let changed = kept.length !== this._entries.length;
    for (const entry of kept) {
      const open = entry.others?.filter(other => !other.isDisposed);
      if (open && open.length !== entry.others?.length) {
        entry.others = open;
        changed = true;
      }
    }
    if (changed) {
      this._entries = kept;
      this.touch();
    }
  }

  private _entries: IRunEntry[] = [];
  private _watched = new Set<DocumentRegistry.IContext<INotebookModel>>();
  private _history = true;
  private _pending = false;
  private _changed = new Signal<this, void>(this);
}

/**
 * The agents' runs of every notebook: the Whybook views of a notebook share
 * its runs through it, and JupyterLab's Running panel lists them.
 */
export const IAgentRuns = new Token<AgentRuns>(
  'whybook:IAgentRuns',
  "The agents' runs of every open notebook, which its Whybook views, the Running panel and the status bar share."
);
