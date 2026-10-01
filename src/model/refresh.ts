import type { IDisposable } from '@lumino/disposable';

/**
 * How long after an execution a refresh goes out while the notebook is in
 * use. The cells of Run all end within milliseconds of each other, and one
 * refresh follows the last of them. It is the delay that the view had
 * before this policy, and shorter than the second after which the analyst
 * waits for the variables of a cell that just ran.
 */
export const IN_USE_DELAY_MS = 300;

/**
 * While the notebook is not in use, the least time between two refreshes
 * starts at the in-use delay and doubles with each refresh: a kernel that
 * another client keeps busy is listed 0.6 s, 1.2 s, 2.4 s and so on after
 * the refresh before, so that the longer the notebook stays out of use, the
 * less often the view reads its kernel.
 */
export const BACKOFF_FACTOR = 2;

/**
 * The longest time between two refreshes while the notebook is not in use.
 * With a kernel that runs code all the time, the gap reaches it at the
 * tenth refresh, five minutes after the notebook went out of use; from then
 * on such a kernel costs 12 refreshes an hour, and the variables that the
 * notebook keeps in its metadata are at most five minutes behind the kernel
 * when it is saved.
 */
export const BACKOFF_MAX_MS = 5 * 60 * 1000;

/**
 * With no pointer or key event in the view for this long, the notebook is
 * not in use although it shows: the analyst works in another window, or has
 * left. Three minutes is longer than the reading of an output or the
 * thinking over of a question, which are use.
 */
export const IDLE_AFTER_MS = 3 * 60 * 1000;

/**
 * A refresh shows the progress circle only after this long. Its two
 * programs took 220 ms on a notebook of three cells, and 680 to 1,090 ms on
 * the pain diary demo after Run all, with 6 of the machine's 8 cores busy
 * (28 September 2026). A circle shown for 220 ms is a flash; one that stays
 * past a second marks a kernel that is slow to answer.
 */
export const SPINNER_DELAY_MS = 1000;

/**
 * When the view reads the kernel's variables and the analysis of its cells
 * again. A refresh is due after an execution in the kernel, from any
 * client, and once for a kernel that ran before the view connected to it;
 * a kernel that runs nothing gets no request. While the notebook is in use,
 * a due refresh goes out at once, and the view's own `IN_USE_DELAY_MS` waits
 * for the last of a run of executions. While it is not, a due refresh waits
 * until the time since the last refresh reaches a gap that doubles with
 * each refresh, up to `BACKOFF_MAX_MS`. When the notebook comes into use
 * again, a due refresh goes out at once, and the gap starts again.
 */
export class RefreshPolicy implements IDisposable {
  constructor(options: RefreshPolicy.IOptions) {
    this._refresh = options.refresh;
    this._inUse = options.inUse;
    this._now = options.now ?? (() => Date.now());
  }

  /** Whether the kernel ran code since the last refresh. */
  get due(): boolean {
    return this._due;
  }

  /**
   * The least time, in milliseconds, between the last refresh and the next
   * one while the notebook is not in use.
   */
  get gap(): number {
    return this._gap;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * The kernel may hold what the view has not listed: code ran in it since
   * the last refresh, or it ran code before the view connected to it.
   */
  changed(): void {
    this._due = true;
    this._schedule();
  }

  /**
   * The notebook came into use: it was shown, or used after a pause. A due
   * refresh goes out now, and the gap starts again.
   */
  used(): void {
    this._gap = IN_USE_DELAY_MS;
    this._schedule();
  }

  /**
   * A refresh starts, whether this policy sent it or code that needs the
   * variables asked for it: nothing is due until the kernel runs code again.
   */
  refreshing(): void {
    this._due = false;
    this._clearTimer();
    this._last = this._now();
    if (!this._inUse()) {
      this._gap = Math.min(this._gap * BACKOFF_FACTOR, BACKOFF_MAX_MS);
    }
  }

  /** Nothing is due: the kernel restarted, or the notebook has no kernel. */
  cancel(): void {
    this._due = false;
    this._clearTimer();
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._clearTimer();
  }

  private _schedule(): void {
    if (!this._due || this._isDisposed) {
      return;
    }
    const wait = this._inUse()
      ? 0
      : Math.max(0, this._last + this._gap - this._now());
    this._clearTimer();
    if (wait === 0) {
      this._send();
      return;
    }
    this._timer = setTimeout(() => {
      this._timer = null;
      this._send();
    }, wait);
  }

  private _send(): void {
    if (!this._due || this._isDisposed) {
      return;
    }
    this._refresh().catch(error => {
      console.warn('Could not refresh from the kernel', error);
    });
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _refresh: () => Promise<void>;
  private _inUse: () => boolean;
  private _now: () => number;
  private _due = false;
  // Before the first refresh, nothing holds one back.
  private _last = -Infinity;
  private _gap = IN_USE_DELAY_MS;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _isDisposed = false;
}

export namespace RefreshPolicy {
  export interface IOptions {
    /**
     * Send a refresh. It waits `IN_USE_DELAY_MS` for more executions, and
     * calls `refreshing()` when it starts.
     */
    refresh: () => Promise<void>;
    /** Whether the notebook is in use: it shows, and the analyst used it lately. */
    inUse: () => boolean;
    /** The clock, in milliseconds. */
    now?: () => number;
  }
}
