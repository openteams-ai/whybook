import type { EpiModel } from './epimodel';

/**
 * A hold on the requests that a model reads, for the screen "Three ways to
 * use models" (../welcome.ts). While the screen is open, each such request
 * waits until the analyst picks a way or decides later, so that the request
 * goes with the settings of that choice. Armed, the hold shows the screen at
 * the first such request, and that request waits for it too. Open, as it is
 * without the plugin, a request goes at once.
 */
export class ModelGate<View> {
  /**
   * Null when a request that a model reads may go now; else a promise that
   * resolves when it may. `view` is the view whose request waits.
   */
  wait(view: View): Promise<void> | null {
    if (this._held) {
      return this._held;
    }
    const first = this._first;
    if (first) {
      this._first = null;
      return this.hold(first(view));
    }
    return null;
  }

  /** Hold every request that a model reads until `until` settles. */
  hold(until: Promise<void>): Promise<void> {
    const held: Promise<void> = until
      .catch(() => undefined)
      .then(() => {
        if (this._held === held) {
          this._held = null;
        }
      });
    this._held = held;
    return held;
  }

  /**
   * Call `first` at the next request that a model reads, with the view that
   * asks, and hold that request and the others until it settles.
   */
  arm(first: (view: View) => Promise<void>): void {
    this._first = first;
  }

  /** Let the next request go without calling the function of `arm`. */
  disarm(): void {
    this._first = null;
  }

  /** Whether the next request that a model reads would call the function of `arm`. */
  get armed(): boolean {
    return this._first !== null;
  }

  private _held: Promise<void> | null = null;
  private _first: ((view: View) => Promise<void>) | null = null;
}

/** The one hold of the application, which the requests of every view wait on. */
export const modelGate = new ModelGate<EpiModel>();
