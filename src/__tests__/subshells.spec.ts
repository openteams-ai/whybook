/**
 * The connections of the view to subshells (src/model/kernel.ts), and the
 * branches that wait for them (src/model/jobs.ts), with a kernel that does
 * not answer: the galata failure where a branch stayed queued for a minute
 * after ipykernel 7.3 left the first request of its new connection unread.
 * No kernel starts.
 */
import './fakes/quiet';

import type { ISessionContext } from '@jupyterlab/apputils';
import type { ICodeCellModel } from '@jupyterlab/cells';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { Kernel } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';

import { JobManager } from '../model/jobs';
import { SUBSHELL_WAIT_MS, WAKE_MS, subshellConnection } from '../model/kernel';

/**
 * A new connection to the kernel, as the view reads one. It opens after a
 * tick and sends its kernel info request with the subshell id it has then.
 * A request to the main shell waits for the cell that runs there, and gets
 * no reply here. One to a subshell gets its reply 50 ms after the kernel
 * reads it: at once, or, when the kernel left it unread, once `read` runs.
 */
class FakeConnection {
  constructor(unread: boolean) {
    this.info = new Promise(resolve => {
      this._reply = () => {
        this.supportsSubshells = true;
        resolve({ language_info: { name: 'python' } });
      };
    });
    setTimeout(() => {
      this.connectionStatus = 'connected';
      this.connectionStatusChanged.emit('connected');
      this.askedIn = this.subshellId;
      if (this.subshellId !== null) {
        this.unread = true;
        if (!unread) {
          this.read();
        }
      }
    }, 0);
  }

  subshellId: string | null = null;
  supportsSubshells = false;
  connectionStatus: Kernel.ConnectionStatus = 'connecting';
  readonly connectionStatusChanged = new Signal<
    FakeConnection,
    Kernel.ConnectionStatus
  >(this);
  readonly info: Promise<unknown>;
  /** The subshell that its kernel info request went to, once it went. */
  askedIn: string | null | undefined = undefined;
  disposed = false;

  /** The kernel reads its request to the subshell, if it has not yet. */
  read(): void {
    if (this.unread) {
      this.unread = false;
      setTimeout(this._reply, 50);
    }
  }

  dispose(): void {
    // As JupyterLab's: a connection bound to a subshell deletes it, which
    // it can ask only once its kernel info reply came.
    if (this.subshellId !== null && !this.supportsSubshells) {
      throw new Error('Kernel subshells are not supported');
    }
    this.disposed = true;
  }

  private unread = false;
  private _reply: () => void = () => undefined;
}

/**
 * A Python kernel with subshells whose main shell runs a long cell, and the
 * notebook's connection to it. With `unread`, the kernel leaves the first
 * request of each new connection unread, as ipykernel 7.3 can
 * (ipython/ipykernel#1554). With `wakes`, a request that the notebook's
 * connection sends gets the kernel to read it; without it, the kernel reads
 * nothing more. Without `creates`, the kernel creates the subshell when the
 * test says so. Without `idle`, the notebook's connection gets the reply to
 * its request for a subshell and not the idle status after it, as in galata
 * after a restart.
 */
function fakeKernel(
  options: {
    unread?: boolean;
    wakes?: boolean;
    creates?: boolean;
    idle?: boolean;
  } = {}
) {
  const { unread = false, wakes = true, creates = true, idle = true } = options;
  const created: string[] = [];
  const deleted: string[] = [];
  const clones: FakeConnection[] = [];
  let woken = 0;
  let lateCreate = (): void => undefined;
  const clone = (): FakeConnection => {
    const connection = new FakeConnection(unread);
    clones.push(connection);
    return connection;
  };
  const kernel = {
    id: 'kernel-1',
    status: 'busy',
    connectionStatus: 'connected',
    supportsSubshells: true,
    info: Promise.resolve({ language_info: { name: 'python' } }),
    requestKernelInfo() {
      woken++;
      if (wakes) {
        clones.forEach(connection => connection.read());
      }
      // It goes to the main shell, which runs the cell.
      return new Promise(() => undefined);
    },
    requestCreateSubshell() {
      const id = `s${created.length + 1}`;
      created.push(id);
      const reply = { content: { status: 'ok', subshell_id: id } };
      let done: (reply: unknown) => void = () => undefined;
      const future = {
        onReply: (msg: unknown): void => undefined,
        done: new Promise(resolve => {
          done = resolve;
        })
      };
      const answer = () => {
        future.onReply(reply);
        if (idle) {
          done(reply);
        }
      };
      if (creates) {
        setTimeout(answer, 0);
      } else {
        lateCreate = answer;
      }
      return future;
    },
    requestDeleteSubshell(content: { subshell_id: string }) {
      deleted.push(content.subshell_id);
      return { done: Promise.resolve({ content: { status: 'ok' } }) };
    },
    clone
  } as unknown as Kernel.IKernelConnection;
  return {
    kernel,
    created,
    deleted,
    clones,
    woken: () => woken,
    lateCreate: () => lateCreate()
  };
}

/** What a promise settled to by now: its value, its error, or 'pending'. */
function settled<T>(promise: Promise<T>) {
  const state: { value?: T; error?: unknown; pending: boolean } = {
    pending: true
  };
  promise.then(
    value => {
      state.value = value;
      state.pending = false;
    },
    error => {
      state.error = error;
      state.pending = false;
    }
  );
  return state;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('subshellConnection', () => {
  it('opens a subshell while a cell runs in the main shell', async () => {
    const { kernel, created, clones, woken } = fakeKernel();
    const result = settled(subshellConnection(kernel));
    await jest.advanceTimersByTimeAsync(100);
    // A connection that asks for its kernel info in the main shell waits
    // there for the cell.
    expect(result.pending).toBe(false);
    expect(result.value).toBe(clones[0]);
    expect(clones[0].askedIn).toBe('s1');
    expect(clones[0].subshellId).toBe('s1');
    expect(created).toEqual(['s1']);
    expect(woken()).toBe(0);
  });

  it('takes the reply to its request for a subshell without the idle status after it', async () => {
    const { kernel, clones } = fakeKernel({ idle: false });
    const result = settled(subshellConnection(kernel));
    await jest.advanceTimersByTimeAsync(100);
    // Before, the view waited for the idle status too, and in galata after a
    // restart the Variables section read the kernel without end.
    expect(result.pending).toBe(false);
    expect(result.value).toBe(clones[0]);
    expect(clones[0].subshellId).toBe('s1');
  });

  it('sends a request from the notebook when the kernel leaves the first request of the new connection unread', async () => {
    const { kernel, created, deleted, clones, woken } = fakeKernel({
      unread: true
    });
    const result = settled(subshellConnection(kernel));
    await jest.advanceTimersByTimeAsync(WAKE_MS - 100);
    expect(result.pending).toBe(true);
    expect(woken()).toBe(0);
    await jest.advanceTimersByTimeAsync(300);
    expect(woken()).toBe(1);
    expect(result.pending).toBe(false);
    expect(result.value).toBe(clones[0]);
    // The same connection: another one would bring another request of
    // jupyter_server, and the same risk.
    expect(clones).toHaveLength(1);
    expect(created).toEqual(['s1']);
    expect(deleted).toEqual([]);
  });

  it('gives up with the reason, and deletes the subshell, when the kernel does not answer', async () => {
    const { kernel, deleted, clones, woken } = fakeKernel({
      unread: true,
      wakes: false
    });
    const result = settled(subshellConnection(kernel));
    await jest.advanceTimersByTimeAsync(SUBSHELL_WAIT_MS - 100);
    expect(result.pending).toBe(true);
    await jest.advanceTimersByTimeAsync(200);
    expect(String(result.error)).toBe(
      'Error: The kernel did not answer a new connection to a subshell in 15 s'
    );
    // After 1, 3 and 7 s.
    expect(woken()).toBe(3);
    expect(clones).toHaveLength(1);
    expect(clones[0].disposed).toBe(true);
    expect(deleted).toEqual(['s1']);
  });

  it('says so when the kernel does not create the subshell, and deletes one that comes later', async () => {
    const { kernel, deleted, clones, lateCreate } = fakeKernel({
      creates: false
    });
    const result = settled(subshellConnection(kernel));
    await jest.advanceTimersByTimeAsync(SUBSHELL_WAIT_MS + 100);
    expect(String(result.error)).toBe(
      'Error: The kernel did not create a subshell in 15 s'
    );
    expect(clones).toHaveLength(0);
    lateCreate();
    await jest.advanceTimersByTimeAsync(0);
    expect(deleted).toEqual(['s1']);
  });
});

describe('a branch whose subshell does not open', () => {
  it('ends with the reason, instead of waiting in the queue', async () => {
    const { kernel } = fakeKernel({ unread: true, wakes: false });
    const sessionContext = {
      session: { kernel },
      kernelChanged: new Signal({}),
      statusChanged: new Signal({})
    } as unknown as ISessionContext;
    const jobs = new JobManager({
      sessionContext,
      rendermime: {} as unknown as IRenderMimeRegistry
    });
    const cell = { id: 'cell-1' } as unknown as ICodeCellModel;
    const result = settled(
      jobs.run(cell, { label: '[1b]', text: 'What if', subshell: true })
    );
    await jest.advanceTimersByTimeAsync(SUBSHELL_WAIT_MS - 100);
    expect(jobs.jobFor('cell-1')?.status).toBe('queued');
    await jest.advanceTimersByTimeAsync(200);
    // Without SUBSHELL_WAIT_MS, the job stays queued and the run never ends.
    expect(result.value).toEqual({
      ok: false,
      error:
        'Error: The kernel did not answer a new connection to a subshell in 15 s'
    });
    expect(jobs.jobFor('cell-1')?.status).toBe('error');
    expect(jobs.queued).toBe(0);
    jobs.dispose();
  });
});
