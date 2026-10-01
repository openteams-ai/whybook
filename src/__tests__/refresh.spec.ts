import { Signal } from '@lumino/signaling';

import { KernelBridge } from '../model/kernel';
import { PlotHooks, STATUS_WAIT_MS } from '../model/plothooks';
import {
  BACKOFF_FACTOR,
  BACKOFF_MAX_MS,
  IN_USE_DELAY_MS,
  RefreshPolicy
} from '../model/refresh';

/**
 * A policy whose refreshes are counted. `inUse` is read at each decision,
 * as the view's is; a refresh calls `refreshing()` as the view's does.
 */
function policy(inUse: { value: boolean }) {
  const sent: number[] = [];
  const refreshes = new RefreshPolicy({
    refresh: () => {
      sent.push(Date.now());
      refreshes.refreshing();
      return Promise.resolve();
    },
    inUse: () => inUse.value
  });
  return { refreshes, sent };
}

/** The session context that the bridge and the plot hooks listen to. */
function fakeSession(kernel: Record<string, unknown> | null) {
  const context: any = {
    session: kernel ? { kernel } : null
  };
  context.kernelChanged = new Signal<any, any>(context);
  context.statusChanged = new Signal<any, any>(context);
  context.iopubMessage = new Signal<any, any>(context);
  return context;
}

function pythonKernel(status = 'idle') {
  return {
    status,
    connectionStatus: 'connected',
    info: Promise.resolve({ language_info: { name: 'python' } })
  };
}

/** An iopub message of the kernel, as JupyterLab passes it on. */
function iopub(type: string, parent: string, content: unknown = {}) {
  return {
    channel: 'iopub',
    header: { msg_type: type, msg_id: `${type}-${parent}` },
    parent_header: { msg_type: 'execute_request', msg_id: parent },
    metadata: {},
    content
  };
}

/** The messages of one execution: its input, unless it is silent, and its end. */
function execution(context: any, id: string, silent: boolean): void {
  context.iopubMessage.emit(iopub('status', id, { execution_state: 'busy' }));
  if (!silent) {
    context.iopubMessage.emit(
      iopub('execute_input', id, { code: 'x = 1', execution_count: 1 })
    );
  }
  context.iopubMessage.emit(iopub('status', id, { execution_state: 'idle' }));
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('RefreshPolicy', () => {
  it('sends nothing while the kernel runs nothing, whether the notebook is in use or not', () => {
    const inUse = { value: true };
    const { refreshes, sent } = policy(inUse);
    refreshes.used();
    jest.advanceTimersByTime(BACKOFF_MAX_MS);
    inUse.value = false;
    refreshes.used();
    jest.advanceTimersByTime(BACKOFF_MAX_MS);
    expect(sent).toHaveLength(0);
    expect(refreshes.due).toBe(false);
  });

  it('refreshes at once after an execution while the notebook is in use, and the view waits its delay', () => {
    const { refreshes, sent } = policy({ value: true });
    refreshes.changed();
    expect(sent).toHaveLength(1);
    refreshes.changed();
    refreshes.changed();
    expect(sent).toHaveLength(3);
    expect(refreshes.due).toBe(false);
  });

  it('spaces the refreshes of a notebook out of use by a gap that doubles up to five minutes', () => {
    const { refreshes, sent } = policy({ value: false });
    const start = Date.now();
    // The first refresh is not held back.
    refreshes.changed();
    expect(sent).toEqual([start]);
    // The kernel runs code every 100 ms for twenty minutes.
    for (let t = 0; t < 20 * 60 * 1000; t += 100) {
      jest.advanceTimersByTime(100);
      refreshes.changed();
    }
    const gaps = sent.slice(1).map((time, i) => time - sent[i]);
    const first = IN_USE_DELAY_MS * BACKOFF_FACTOR;
    expect(gaps.slice(0, 9)).toEqual(
      [1, 2, 4, 8, 16, 32, 64, 128, 256].map(
        times =>
          // Each gap ends at the next execution, 100 ms at most after it.
          Math.ceil((first * times) / 100) * 100
      )
    );
    // From the tenth refresh on, one every five minutes.
    expect(gaps.slice(9)).toEqual([BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    expect(sent).toHaveLength(12);
  });

  it('sends a refresh that waited as soon as the notebook comes into use, and starts the gap again', () => {
    const inUse = { value: false };
    const { refreshes, sent } = policy(inUse);
    refreshes.changed();
    refreshes.changed();
    expect(sent).toHaveLength(1);
    expect(refreshes.due).toBe(true);
    jest.advanceTimersByTime(100);
    inUse.value = true;
    refreshes.used();
    expect(sent).toHaveLength(2);
    expect(refreshes.gap).toBe(IN_USE_DELAY_MS);
    // Shown again with nothing run meanwhile: nothing is sent.
    refreshes.used();
    expect(sent).toHaveLength(2);
  });

  it('drops a refresh that waited when the kernel restarts, and sends none after', () => {
    const { refreshes, sent } = policy({ value: false });
    refreshes.changed();
    refreshes.changed();
    refreshes.cancel();
    jest.advanceTimersByTime(BACKOFF_MAX_MS);
    expect(sent).toHaveLength(1);
    expect(refreshes.due).toBe(false);
  });

  it('counts a refresh that code asked for, so that a waiting one does not follow it', () => {
    const { refreshes, sent } = policy({ value: false });
    refreshes.changed();
    refreshes.changed();
    // An agent's step asks for the variables now.
    refreshes.refreshing();
    jest.advanceTimersByTime(BACKOFF_MAX_MS);
    expect(sent).toHaveLength(1);
  });
});

describe('KernelBridge', () => {
  it('counts an execution that shows its input, from any client, and not a silent one', () => {
    const context = fakeSession(pythonKernel());
    const bridge = new KernelBridge(context);
    const changes: string[] = [];
    bridge.changed.connect((_, change) => changes.push(change));
    // A cell that another client runs.
    execution(context, 'cell', false);
    expect(changes).toEqual(['executed']);
    // The listing of another Whybook view on the same kernel is silent:
    // counting it made two views refresh each other without end.
    execution(context, 'other-view', true);
    expect(changes).toEqual(['executed']);
    bridge.dispose();
  });

  it("does not count an execution of its own that shows its input, such as a preview's", () => {
    const context = fakeSession(pythonKernel());
    const bridge = new KernelBridge(context);
    const changes: string[] = [];
    bridge.changed.connect((_, change) => changes.push(change));
    bridge.remember('preview');
    execution(context, 'preview', false);
    expect(changes).toEqual([]);
    bridge.dispose();
  });

  it('knows a kernel that it saw start or restart held nothing, and not one it connected to', () => {
    const context = fakeSession(null);
    const bridge = new KernelBridge(context);
    // A new session: the context says it starts one, then its kernel comes.
    context.kernelChanged.emit({
      name: 'kernel',
      oldValue: null,
      newValue: null
    });
    context.statusChanged.emit('starting');
    const kernel = pythonKernel('unknown');
    context.session = { kernel };
    context.kernelChanged.emit({
      name: 'kernel',
      oldValue: null,
      newValue: kernel
    });
    expect(bridge.watchedStart).toBe(true);
    expect(bridge.startedEmpty).toBe(true);

    // Another kernel for the same session, which may be one that ran before.
    context.statusChanged.emit('starting');
    const other = pythonKernel();
    context.session = { kernel: other };
    context.kernelChanged.emit({
      name: 'kernel',
      oldValue: kernel,
      newValue: other
    });
    expect(bridge.watchedStart).toBe(false);
    expect(bridge.startedEmpty).toBe(false);

    // A restart empties the kernel.
    context.statusChanged.emit('restarting');
    expect(bridge.watchedStart).toBe(true);
    bridge.dispose();
  });

  it('does not know what a kernel that ran before it connected holds', () => {
    const context = fakeSession(null);
    const bridge = new KernelBridge(context);
    // A session that exists: the context connects to it, with no start.
    const kernel = pythonKernel();
    context.session = { kernel };
    context.kernelChanged.emit({
      name: 'kernel',
      oldValue: null,
      newValue: kernel
    });
    expect(bridge.watchedStart).toBe(false);
    bridge.dispose();
  });
});

describe('PlotHooks', () => {
  function setup(status = 'idle', language = 'python') {
    const kernel = {
      ...pythonKernel(status),
      info: Promise.resolve({ language_info: { name: language } })
    };
    const context = fakeSession(kernel);
    const bridge = {
      run: jest.fn().mockResolvedValue({ version: 1, hooks: {} }),
      execute: jest.fn().mockResolvedValue({ outputs: [], error: null })
    };
    const hooks = new PlotHooks(bridge as any, context);
    return { bridge, context, hooks, kernel };
  }

  it('installs nothing in a kernel that runs nothing, and installs once when the first execution starts', async () => {
    const { bridge, context, hooks } = setup();
    jest.advanceTimersByTime(STATUS_WAIT_MS * 5);
    await Promise.resolve();
    expect(bridge.run).not.toHaveBeenCalled();
    context.iopubMessage.emit(
      iopub('execute_input', 'cell', { code: 'x = 1', execution_count: 1 })
    );
    await jest.runAllTimersAsync();
    expect(bridge.run).toHaveBeenCalledTimes(1);
    expect(bridge.run).toHaveBeenCalledWith('plot_hooks', {});
    context.iopubMessage.emit(
      iopub('execute_input', 'next', { code: 'y = 2', execution_count: 2 })
    );
    await jest.runAllTimersAsync();
    expect(bridge.run).toHaveBeenCalledTimes(1);
    hooks.dispose();
  });

  it('installs the hooks in a kernel that still has no status two seconds after it started', async () => {
    const { bridge, context, hooks, kernel } = setup('unknown');
    context.statusChanged.emit('unknown');
    jest.advanceTimersByTime(STATUS_WAIT_MS - 1);
    expect(bridge.run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await jest.runAllTimersAsync();
    expect(bridge.run).toHaveBeenCalledTimes(1);
    hooks.dispose();

    // A kernel that another request made idle in time gets none.
    const second = setup('unknown');
    second.context.statusChanged.emit('unknown');
    jest.advanceTimersByTime(STATUS_WAIT_MS / 2);
    second.kernel.status = 'idle';
    second.context.statusChanged.emit('idle');
    await jest.runAllTimersAsync();
    expect(second.bridge.run).not.toHaveBeenCalled();
    second.hooks.dispose();
    expect(kernel.status).toBe('unknown');
  });

  it('sends an empty silent request to a kernel of another language that has no status', async () => {
    const { bridge, context, hooks } = setup('unknown', 'r');
    context.statusChanged.emit('unknown');
    await jest.advanceTimersByTimeAsync(STATUS_WAIT_MS);
    await jest.runAllTimersAsync();
    expect(bridge.run).not.toHaveBeenCalled();
    expect(bridge.execute).toHaveBeenCalledWith('', true);
    hooks.dispose();
  });
});
