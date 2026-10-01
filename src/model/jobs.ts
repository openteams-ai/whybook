import type { ISessionContext } from '@jupyterlab/apputils';
import type { ICodeCellModel } from '@jupyterlab/cells';
import { OutputArea } from '@jupyterlab/outputarea';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { Kernel } from '@jupyterlab/services';
import { KernelMessage } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

import { PROGRESS_MIME } from '../tokens';
import { subshellConnection } from './kernel';
import { noSubshells } from './languages';
import { RunProgress } from './progress';

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface IJob {
  id: string;
  cellId: string;
  label: string;
  text: string;
  /** Index of the subshell slot, or null for the main shell. */
  slot: number | null;
  status: JobStatus;
  progress: number | null;
  stage: string | null;
  /** The progress is read from a bar in the cell's outputs: tqdm or a widget. */
  outputBar: boolean;
  error: string | null;
  started: number | null;
  finished: number | null;
}

export interface IRunResult {
  ok: boolean;
  error?: string;
}

/**
 * Runs cells in the main shell or in kernel subshells, and tracks them as jobs.
 *
 * Subshells share the kernel's namespace, so branches read the same frames
 * without copying them. At most `capacity` subshells run at once; the main
 * shell counts as one busy slot while it runs. Later jobs wait in a queue.
 * Progress reported with `whybook.progress` updates the job instead of being
 * written to the cell's outputs. A tqdm bar or a progress widget also
 * updates the job, and stays in the outputs. In a kernel without subshells
 * the branches run in the main shell, one after another.
 */
export class JobManager implements IDisposable {
  constructor(options: JobManager.IOptions) {
    this._sessionContext = options.sessionContext;
    this._rendermime = options.rendermime;
    this._prepare = options.prepare ?? null;
    this.capacity = options.capacity ?? 8;
    this._sessionContext.kernelChanged.connect(this._onKernelChanged, this);
    this._sessionContext.statusChanged.connect((_, status) => {
      if (
        status === 'restarting' ||
        status === 'autorestarting' ||
        status === 'dead'
      ) {
        this._reset();
      }
      this._changed.emit();
    }, this);
    this._readSubshells();
  }

  capacity: number;

  /** How long, in milliseconds, a finished job stays listed. */
  linger = 60000;

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * Whether branches run in parallel, each in a subshell: false in a kernel
   * without subshells, or with subshells that the view does not use (SAS),
   * where they run one after another in the main shell, and null before the
   * kernel's info reply arrives.
   */
  get parallel(): boolean | null {
    return this._parallel;
  }

  /** Why branches run one after another in the main shell, when they do. */
  get serialReason(): string | null {
    return this._serialReason;
  }

  get jobs(): IJob[] {
    return [...this._jobs.values()];
  }

  jobFor(cellId: string): IJob | null {
    const jobs = this.jobs.filter(job => job.cellId === cellId);
    return jobs[jobs.length - 1] ?? null;
  }

  /**
   * Busy slots: the main shell when the kernel is busy, and running subshell jobs.
   */
  get busy(): number {
    const main =
      this._sessionContext.session?.kernel?.status === 'busy' ||
      this._mainRunning > 0
        ? 1
        : 0;
    return (
      main +
      this.jobs.filter(job => job.status === 'running' && job.slot !== null)
        .length
    );
  }

  get queued(): number {
    return this.jobs.filter(job => job.status === 'queued').length;
  }

  get free(): number {
    return Math.max(0, this.capacity - this.busy);
  }

  /**
   * The running job that started first, for the status bar.
   */
  get longest(): IJob | null {
    const running = this.jobs.filter(job => job.status === 'running');
    running.sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
    return running[0] ?? null;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Run a code cell. With `subshell`, the cell runs in its own subshell
   * and does not wait for the main shell.
   */
  async run(
    cell: ICodeCellModel,
    options: { label: string; text: string; subshell: boolean }
  ): Promise<IRunResult> {
    const kernel = this._sessionContext.session?.kernel;
    if (!kernel) {
      return { ok: false, error: 'The notebook has no kernel' };
    }
    const job: IJob = {
      id: `${cell.id}:${Date.now()}`,
      cellId: cell.id,
      label: options.label,
      text: options.text,
      slot: null,
      status: 'queued',
      progress: null,
      stage: null,
      outputBar: false,
      error: null,
      started: null,
      finished: null
    };
    this._jobs.set(job.id, job);
    this._changed.emit();
    let connection: Kernel.IKernelConnection = kernel;
    let slot: number | null = null;
    try {
      // What the kernel needs before a cell runs, such as the plot hooks.
      await this._prepare?.();
      if (options.subshell && kernel.supportsSubshells !== false) {
        const acquired = await this._acquire(kernel);
        if (acquired) {
          [connection, slot] = acquired;
        }
      }
    } catch (error) {
      // The kernel did not open a subshell for the cell: the cell does not
      // run, and its job says why instead of waiting in the queue.
      job.status = 'error';
      job.error = String(error);
      job.finished = Date.now();
      this._changed.emit();
      this._forget(job);
      return { ok: false, error: job.error };
    }
    // A branch without a subshell waits for the branches before it, and its
    // error does not stop the cells queued behind it in the main shell.
    const inMain = options.subshell && slot === null;
    const endTurn = inMain ? await this._mainTurn() : null;
    job.slot = slot;
    job.status = 'running';
    job.started = Date.now();
    if (slot === null) {
      this._mainRunning++;
    }
    this._changed.emit();
    try {
      const result = await this._execute(connection, cell, job, !inMain);
      job.status = result.ok ? 'done' : 'error';
      job.error = result.error ?? null;
      if (result.ok) {
        job.progress = 1;
      }
      return result;
    } catch (error) {
      job.status = 'error';
      job.error = String(error);
      return { ok: false, error: String(error) };
    } finally {
      job.finished = Date.now();
      if (slot === null) {
        this._mainRunning--;
      } else {
        this._release(slot);
      }
      endTurn?.();
      this._changed.emit();
      this._forget(job);
    }
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._reset();
    Signal.clearData(this);
  }

  private async _execute(
    connection: Kernel.IKernelConnection,
    cell: ICodeCellModel,
    job: IJob,
    stopOnError: boolean
  ): Promise<IRunResult> {
    // The finally block below disposes the area, which the rule does not see:
    // it reads a try statement as a branch.
    // eslint-disable-next-line jupyter/require-disposable-ownership
    const area = new OutputArea({
      model: cell.outputs,
      rendermime: this._rendermime
    });
    // Running a cell trusts its outputs, as it does in the notebook: widgets
    // and charts with scripts draw only for trusted outputs.
    cell.trusted = true;
    try {
      const future = connection.requestExecute(
        { code: cell.sharedModel.getSource(), stop_on_error: stopOnError },
        false,
        { cellId: cell.id }
      );
      // Setting the future clears the outputs and routes the kernel's messages into the cell.
      area.future = future;
      const toOutputs = future.onIOPub;
      // The bars of the libraries the cell uses, until whybook.progress reports.
      const bars = new RunProgress();
      let reported = false;
      future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
        if (
          (KernelMessage.isDisplayDataMsg(msg) ||
            KernelMessage.isUpdateDisplayDataMsg(msg)) &&
          msg.content.data?.[PROGRESS_MIME]
        ) {
          // What whybook.progress displays: the kernel's code writes it.
          const report = msg.content.data[PROGRESS_MIME] as {
            fraction?: unknown;
            stage?: string | null;
          };
          job.progress =
            typeof report.fraction === 'number'
              ? report.fraction
              : job.progress;
          job.stage = report.stage ?? job.stage;
          job.outputBar = false;
          reported = true;
          this._changed.emit();
          return;
        }
        const bar = reported ? null : bars.read(msg);
        if (bar) {
          job.progress = bar.fraction ?? job.progress;
          job.stage = bar.stage ?? job.stage;
          job.outputBar = true;
          this._changed.emit();
        }
        return toOutputs.call(future, msg);
      };
      cell.executionCount = null;
      const reply = await future.done;
      cell.executionCount = reply?.content.execution_count ?? null;
      if (reply?.content.status === 'error') {
        const content = reply.content;
        const error = [
          `${content.ename}: ${content.evalue}`,
          ...content.traceback
        ]
          .join('\n')
          // Remove the colours from the traceback.
          // eslint-disable-next-line no-control-regex
          .replace(/\x1b\[[0-9;]*m/g, '');
        return { ok: false, error };
      }
      return { ok: reply?.content.status === 'ok' };
    } finally {
      area.dispose();
    }
  }

  private async _acquire(
    kernel: Kernel.IKernelConnection
  ): Promise<[Kernel.IKernelConnection, number] | null> {
    // One slot of the capacity stays with the main shell.
    for (;;) {
      const idle = this._slots.findIndex(slot => !slot.busy);
      if (idle >= 0) {
        this._slots[idle].busy = true;
        return [this._slots[idle].connection, idle];
      }
      if (this._slots.length + this._opening < Math.max(1, this.capacity - 1)) {
        // A slot joins the list once its connection is open, so that the
        // index of every slot stays the same when an opening fails.
        const slots = this._slots;
        this._opening++;
        let connection: Kernel.IKernelConnection | null = null;
        try {
          connection = await subshellConnection(kernel);
        } finally {
          this._opening--;
          if (!connection) {
            // The capacity that this opening held is free again.
            this._waiting.shift()?.();
          }
        }
        if (!connection) {
          return null;
        }
        if (slots !== this._slots) {
          // The kernel restarted or changed while the connection opened.
          connection.dispose();
          return null;
        }
        this._slots.push({ connection, busy: true });
        return [connection, this._slots.length - 1];
      }
      await new Promise<void>(resolve => this._waiting.push(resolve));
    }
  }

  private _release(slot: number): void {
    const entry = this._slots[slot];
    if (entry) {
      entry.busy = false;
    }
    const next = this._waiting.shift();
    next?.();
  }

  /**
   * Wait for the branches before this one that run in the main shell. The
   * function it returns ends this branch's turn.
   */
  private async _mainTurn(): Promise<() => void> {
    const before = this._mainBranches;
    let end!: () => void;
    this._mainBranches = new Promise<void>(resolve => (end = resolve));
    await before;
    return end;
  }

  /** A finished job stays listed for `linger` milliseconds, then goes. */
  private _forget(job: IJob): void {
    setTimeout(() => {
      this._jobs.delete(job.id);
      this._changed.emit();
    }, this.linger);
  }

  private _onKernelChanged(): void {
    this._reset();
    this._readSubshells();
  }

  /** Read from the kernel's info reply whether it has subshells that the view uses. */
  private _readSubshells(): void {
    this._parallel = null;
    this._serialReason = null;
    const kernel = this._sessionContext.session?.kernel;
    if (!kernel) {
      return;
    }
    kernel.info.then(
      info => {
        if (kernel === this._sessionContext.session?.kernel) {
          this._serialReason = noSubshells(
            kernel.supportsSubshells,
            info.language_info?.name
          );
          this._parallel = this._serialReason === null;
          this._changed.emit();
        }
      },
      () => undefined
    );
  }

  private _reset(): void {
    for (const slot of this._slots) {
      slot.connection.dispose();
    }
    this._slots = [];
    for (const resolve of this._waiting.splice(0)) {
      resolve();
    }
    this._mainRunning = 0;
    this._mainBranches = Promise.resolve();
  }

  private _sessionContext: ISessionContext;
  private _rendermime: IRenderMimeRegistry;
  private _prepare: (() => Promise<unknown>) | null;
  private _jobs = new Map<string, IJob>();
  private _slots: {
    connection: Kernel.IKernelConnection;
    busy: boolean;
  }[] = [];
  // The connections to new subshells that open now.
  private _opening = 0;
  private _waiting: (() => void)[] = [];
  private _mainRunning = 0;
  // The end of the last branch that runs in the main shell.
  private _mainBranches: Promise<void> = Promise.resolve();
  private _parallel: boolean | null = null;
  private _serialReason: string | null = null;
  private _isDisposed = false;
  private _changed = new Signal<this, void>(this);
}

export namespace JobManager {
  export interface IOptions {
    sessionContext: ISessionContext;
    rendermime: IRenderMimeRegistry;
    capacity?: number;
    /** Awaited before each cell runs; it must not reject. */
    prepare?: () => Promise<unknown>;
  }
}
