/**
 * The cells of the run going on, for the kernel's status in the toolbar.
 *
 * A run starts with the first cell that the view runs while no run goes on,
 * and ends once its cells finished and no other cell started for
 * `RUN_GAP_MS`: the view sends the cells of Run all and of an agent's step
 * one at a time, so a run is not over between two of its cells. Run all says
 * how many cells it will start, so the count is right from its first cell.
 */
export const RUN_GAP_MS = 500;

export interface IRun {
  /** When its first cell started, in ms since the epoch. */
  started: number;
  /** When its last cell finished, once the run is over; null before. */
  finished: number | null;
  /** The cells it started, or the cells Run all said it would start, if more. */
  total: number;
  /** The cells that finished. */
  done: number;
}

export class RunTally {
  /** `changed` is called after each change to the run. */
  constructor(changed: () => void) {
    this._changed = changed;
  }

  /** The run going on, or the last one; null before the first. */
  get run(): IRun | null {
    if (!this._run) {
      return null;
    }
    const { started, finished, count, planned, done } = this._run;
    return { started, finished, total: Math.max(count, planned), done };
  }

  /** Whether a run goes on. */
  get running(): boolean {
    return !!this._run && this._run.finished === null;
  }

  /** The next `count` cells belong to one run, such as Run all's. */
  plan(count: number): void {
    if (this._run && this._run.finished === null) {
      this._run.planned = this._run.count + count;
      this._changed();
    } else {
      this._planned = count;
    }
  }

  /** A cell, of the job `id`, starts or waits for its turn. */
  start(id: string, now = Date.now()): void {
    this._stopGap();
    if (!this._run || this._run.finished !== null) {
      this._run = {
        started: now,
        finished: null,
        last: now,
        count: 0,
        planned: this._planned,
        done: 0,
        pending: new Set()
      };
      this._planned = 0;
    }
    this._run.pending.add(id);
    this._run.count++;
    this._changed();
  }

  /** The cell of the job `id` finished, or failed. */
  finish(id: string, now = Date.now()): void {
    const run = this._run;
    if (!run || run.finished !== null || !run.pending.delete(id)) {
      return;
    }
    run.done++;
    run.last = now;
    if (run.pending.size === 0) {
      this._stopGap();
      this._gap = setTimeout(() => {
        this._gap = null;
        run.finished = run.last;
        this._changed();
      }, RUN_GAP_MS);
    }
    this._changed();
  }

  /** The kernel restarted or died: no cell of the run will finish. */
  reset(): void {
    this._stopGap();
    if (this._run && this._run.finished === null) {
      this._run.finished = this._run.last;
    }
    this._planned = 0;
    this._changed();
  }

  dispose(): void {
    this._stopGap();
  }

  private _stopGap(): void {
    if (this._gap !== null) {
      clearTimeout(this._gap);
      this._gap = null;
    }
  }

  private _changed: () => void;
  private _gap: ReturnType<typeof setTimeout> | null = null;
  private _planned = 0;
  private _run: {
    started: number;
    finished: number | null;
    last: number;
    count: number;
    planned: number;
    done: number;
    pending: Set<string>;
  } | null = null;
}
