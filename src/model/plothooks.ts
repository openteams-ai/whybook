import type { ISessionContext } from '@jupyterlab/apputils';
import type { Kernel, KernelMessage } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';

import type { KernelBridge } from './kernel';
import { languageOf } from './languages';

/**
 * What became of one library's hook in the kernel: on; waiting for the
 * library to be imported; skipped, when it could not register; or failed,
 * when it raised while an output was displayed and removed itself.
 */
export interface IPlotHook {
  state: 'on' | 'waiting' | 'skipped' | 'failed';
  reason: string | null;
}

export interface IPlotHooksReport {
  version: number;
  hooks: Record<string, IPlotHook>;
}

/** How long a cell waits for the hooks before it runs without them. */
const WAIT_MS = 5000;

/**
 * How long after a kernel starts or restarts the view waits for JupyterLab
 * to show a status for it. JupyterLab takes no status from the kernel info
 * requests that follow a start, so a kernel shows as starting or unknown
 * until another request: with ipywidgets that is the comm of its widget
 * manager, which comes within a second of the start. Two seconds leave it
 * that time.
 */
export const STATUS_WAIT_MS = 2000;

/**
 * The kernel's plot hooks (whybook/server/kernel_code/plot_hooks.py): they
 * add to the outputs of plotting libraries what the view needs to ask about
 * them, such as the Axes of a matplotlib figure. The view installs them once
 * in each Python kernel, through the bridge, when the first execution
 * starts: the job manager waits for them before it runs a cell, so the first
 * figure of a cell the view runs has them too, and the input of a cell that
 * another client runs starts the install. A kernel that ran nothing gets no
 * request. A kernel of another language gets none.
 *
 * The one exception: a kernel that still has no status in JupyterLab
 * `STATUS_WAIT_MS` after it started or restarted gets the hooks then, since
 * the request gives it a status, and the first cell needs the hooks anyway.
 * A kernel of a language without hooks gets an empty silent request.
 */
export class PlotHooks implements IDisposable {
  constructor(bridge: KernelBridge, sessionContext: ISessionContext) {
    this._bridge = bridge;
    this._sessionContext = sessionContext;
    sessionContext.kernelChanged.connect(this._onKernelChanged, this);
    sessionContext.statusChanged.connect(this._onStatus, this);
    sessionContext.iopubMessage.connect(this._onIOPub, this);
    if (sessionContext.session?.kernel) {
      this._waitForStatus();
    }
  }

  /** What the kernel reported for each library, or null before it did. */
  get report(): IPlotHooksReport | null {
    return this._report;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Install the hooks in the current kernel, once. Resolves with the
   * kernel's report, or with null when the kernel takes no hooks, fails, or
   * does not answer in time; it never rejects.
   */
  ready(wait = WAIT_MS): Promise<IPlotHooksReport | null> {
    const kernel = this._sessionContext.session?.kernel ?? null;
    if (!kernel || this._isDisposed) {
      return Promise.resolve(null);
    }
    if (!this._installing || this._kernel !== kernel) {
      this._kernel = kernel;
      this._installing = this._install(kernel);
    }
    let timer = 0;
    return Promise.race([
      this._installing,
      new Promise<null>(resolve => {
        timer = window.setTimeout(() => resolve(null), wait);
      })
    ]).finally(() => window.clearTimeout(timer));
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    window.clearTimeout(this._statusTimer);
    this._sessionContext.kernelChanged.disconnect(this._onKernelChanged, this);
    this._sessionContext.statusChanged.disconnect(this._onStatus, this);
    this._sessionContext.iopubMessage.disconnect(this._onIOPub, this);
  }

  private async _install(
    kernel: Kernel.IKernelConnection
  ): Promise<IPlotHooksReport | null> {
    try {
      const info = await kernel.info;
      if (!languageOf(info.language_info?.name)?.snippets.plot_hooks) {
        return null;
      }
      const report = await this._bridge.run<IPlotHooksReport>('plot_hooks', {});
      if (kernel === this._kernel) {
        this._report = report;
      }
      const off = Object.entries(report.hooks ?? {}).filter(
        ([, hook]) => hook.state === 'skipped' || hook.state === 'failed'
      );
      if (off.length) {
        console.info(
          'Some plot hooks are off; their outputs show as the library ships them:',
          Object.fromEntries(off)
        );
      }
      return report;
    } catch (error) {
      console.warn('Whybook could not install its plot hooks', error);
      if (kernel === this._kernel) {
        // The next cell tries again.
        this._installing = null;
      }
      return null;
    }
  }

  private _onStatus(
    sender: ISessionContext,
    status: ISessionContext.KernelDisplayStatus
  ): void {
    if (
      status === 'restarting' ||
      status === 'autorestarting' ||
      status === 'dead'
    ) {
      // A restarted kernel comes back without the hooks.
      this._reset();
    } else if (status === 'unknown' || status === 'starting') {
      this._waitForStatus();
    } else {
      window.clearTimeout(this._statusTimer);
    }
  }

  private _onKernelChanged(): void {
    this._reset();
  }

  /** The input of an execution, from any client: the kernel runs code now. */
  private _onIOPub(sender: ISessionContext, msg: KernelMessage.IMessage): void {
    if (msg.header.msg_type === 'execute_input' && !this._installing) {
      void this.ready();
    }
  }

  /**
   * Give the kernel a status if it still has none in JupyterLab
   * `STATUS_WAIT_MS` after the last status it showed was starting or
   * unknown, and nothing else gave it one.
   */
  private _waitForStatus(): void {
    window.clearTimeout(this._statusTimer);
    this._statusTimer = window.setTimeout(
      () => void this._giveStatus(),
      STATUS_WAIT_MS
    );
  }

  /**
   * Send a kernel with no status a request, which gives it one: the plot
   * hooks, which the first cell needs anyway, or in a language without them
   * an empty silent request.
   */
  private async _giveStatus(): Promise<void> {
    if (!this._statusless()) {
      return;
    }
    if (!this._installing && (await this.ready())) {
      return;
    }
    if (this._statusless()) {
      await this._bridge.execute('', true).catch(() => undefined);
    }
  }

  private _statusless(): boolean {
    const kernel = this._sessionContext.session?.kernel;
    return (
      !this._isDisposed &&
      kernel?.connectionStatus === 'connected' &&
      (kernel.status === 'unknown' || kernel.status === 'starting')
    );
  }

  private _reset(): void {
    window.clearTimeout(this._statusTimer);
    this._installing = null;
    this._kernel = null;
    this._report = null;
  }

  private _bridge: KernelBridge;
  private _sessionContext: ISessionContext;
  private _kernel: Kernel.IKernelConnection | null = null;
  private _installing: Promise<IPlotHooksReport | null> | null = null;
  private _report: IPlotHooksReport | null = null;
  private _statusTimer = 0;
  private _isDisposed = false;
}
