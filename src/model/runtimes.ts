/**
 * How long each cell took in its last run, for the check-up's question
 * "What makes it slow?" (design iteration 1.67). The view reads the times
 * from the kernel's messages, for the runs that it sees.
 */
import type { ISessionContext } from '@jupyterlab/apputils';
import type { ICellModel } from '@jupyterlab/cells';
import type { KernelMessage } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

/** The last run of a code that the view saw. */
export interface IRunTime {
  /** From the kernel's input message to its idle status, by the kernel's clock. */
  seconds: number;
  /** The execution count of the run, or null when the kernel gave none. */
  count: number | null;
  /** When the run ended, in milliseconds since 1970. */
  at: number;
  /** Whether the run ended without an error. */
  ok: boolean;
}

/** A run that the kernel started and has not finished. */
interface IRunning {
  code: string;
  count: number | null;
  start: number;
  ok: boolean;
}

/**
 * The time of a message by the kernel's clock: its header's date, or the
 * time it came when the kernel gave no date.
 */
function dateOf(message: KernelMessage.IMessage): number {
  const time = Date.parse(String(message.header.date ?? ''));
  return Number.isFinite(time) ? time : Date.now();
}

/**
 * The run times of the cells that the view sees run. A run starts with its
 * execute_input message and ends with the idle status of the same request,
 * each dated by the kernel. The kernel publishes both to every client, so
 * the runs of JupyterLab's notebook view and of another browser count too.
 * The view's own silent requests publish no input and do not count. The
 * last run of each code is kept. The code of each execution count is kept
 * until the kernel restarts, when the counts start again.
 */
export class RunTimes implements IDisposable {
  constructor(sessionContext: ISessionContext) {
    this._sessionContext = sessionContext;
    sessionContext.iopubMessage.connect(this._onMessage, this);
    sessionContext.statusChanged.connect(this._onStatus, this);
    sessionContext.kernelChanged.connect(this._onKernel, this);
  }

  /** Emits when a run ends. */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** The last run of this code that the view saw, or null. */
  timeOf(code: string): IRunTime | null {
    return this._byCode.get(code) ?? null;
  }

  /**
   * The code that ran with this execution count in the current kernel, or
   * null when the view did not see that run.
   */
  codeOf(count: number): string | null {
    return this._byCount.get(count) ?? null;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._sessionContext.iopubMessage.disconnect(this._onMessage, this);
    this._sessionContext.statusChanged.disconnect(this._onStatus, this);
    this._sessionContext.kernelChanged.disconnect(this._onKernel, this);
    Signal.clearData(this);
  }

  private _onMessage(
    sender: ISessionContext,
    message: KernelMessage.IMessage
  ): void {
    const parent = (message.parent_header as Partial<KernelMessage.IHeader>)
      ?.msg_id;
    if (!parent) {
      return;
    }
    const type = message.header.msg_type;
    if (type === 'execute_input') {
      const content =
        message.content as KernelMessage.IExecuteInputMsg['content'];
      this._running.set(parent, {
        code: content.code,
        count:
          typeof content.execution_count === 'number'
            ? content.execution_count
            : null,
        start: dateOf(message),
        ok: true
      });
      return;
    }
    const running = this._running.get(parent);
    if (!running) {
      return;
    }
    if (type === 'error') {
      running.ok = false;
      return;
    }
    if (
      type === 'status' &&
      (message.content as KernelMessage.IStatusMsg['content'])
        .execution_state === 'idle'
    ) {
      this._running.delete(parent);
      const end = dateOf(message);
      this._byCode.set(running.code, {
        seconds: Math.max(0, (end - running.start) / 1000),
        count: running.count,
        at: end,
        ok: running.ok
      });
      if (running.count !== null) {
        this._byCount.set(running.count, running.code);
      }
      this._changed.emit();
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
      this._restarted();
    }
  }

  private _onKernel(): void {
    this._restarted();
  }

  /** A new kernel counts from 1 again: the codes of the old counts go. */
  private _restarted(): void {
    this._running.clear();
    this._byCount.clear();
  }

  private _sessionContext: ISessionContext;
  private _running = new Map<string, IRunning>();
  private _byCode = new Map<string, IRunTime>();
  private _byCount = new Map<number, string>();
  private _isDisposed = false;
  private _changed = new Signal<this, void>(this);
}

/**
 * The seconds of a cell's last run as JupyterLab keeps them in the cell's
 * metadata with its setting recordTiming, off by default: from the kernel's
 * input message to its reply. Null without them.
 */
export function recordedSeconds(cell: ICellModel): number | null {
  const execution = cell.getMetadata('execution') as
    Record<string, unknown> | undefined;
  const start = Date.parse(String(execution?.['iopub.execute_input'] ?? ''));
  const end = Date.parse(String(execution?.['shell.execute_reply'] ?? ''));
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? (end - start) / 1000
    : null;
}
