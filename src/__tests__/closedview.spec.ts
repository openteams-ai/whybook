/**
 * A Whybook view that closes while an agent's run goes on (dispose in
 * src/model/epimodel.ts). The notebook's model and its kernel stay while the
 * notebook is open in another view, and the run goes on there. Once the
 * notebook closes, no view can run the run's tool calls, and the run stops
 * at once: the server would otherwise wait 30 minutes for each call.
 */
import { Debouncer } from '@lumino/polling';
import { Signal } from '@lumino/signaling';

import type { IAgentEvent } from '../model/agent';
import { fakeModel, settle, sources, until } from './fakes/model-fake';

/** A model with the parts that dispose() reaches, which record it. */
function closable(cells = [{ id: 'a', count: 1 }]) {
  const { nb, model } = fakeModel(cells);
  const disposed: string[] = [];
  const part = (name: string, extra: Record<string, unknown> = {}) => ({
    ...extra,
    dispose: () => disposed.push(name)
  });
  model.context.disposed = new Signal(model.context);
  model._refresher = new Debouncer(() => model._refreshNow(), 0);
  const refresher = model._refresher.dispose.bind(model._refresher);
  model._refresher.dispose = () => {
    disposed.push('refresher');
    refresher();
  };
  Object.assign(model, {
    _refreshPolicy: part('policy', { changed: () => undefined }),
    _nextDebouncer: part('next'),
    tableNotes: part('tableNotes'),
    cellTitles: part('cellTitles', { flush: () => undefined }),
    signIns: part('signIns'),
    plotHooks: part('plotHooks', { ready: async () => null }),
    jobs: part('jobs', { run: async () => ({ ok: true }) }),
    _contentsManager: null
  });
  model.bridge.dispose = () => disposed.push('bridge');
  model.aiReady = () => true;
  return { nb, model, disposed };
}

/** Start an agent's run for a question about cell a, as the strip does. */
async function started(model: any) {
  const posted: Record<string, unknown>[] = [];
  const run: {
    signal: AbortSignal | null;
    deliver: (event: IAgentEvent | Record<string, unknown>) => void;
    finish: () => void;
  } = { signal: null, deliver: () => undefined, finish: () => undefined };
  model.api = {
    agent: (
      _body: unknown,
      onEvent: (event: unknown) => void,
      signal: AbortSignal
    ) => {
      run.signal = signal;
      run.deliver = onEvent;
      return new Promise<void>((resolve, reject) => {
        run.finish = resolve;
        signal.addEventListener('abort', () =>
          reject(new DOMException('The request was aborted', 'AbortError'))
        );
      });
    },
    agentResult: async (body: Record<string, unknown>) => {
      posted.push(body);
    },
    agentStop: jest.fn(async () => undefined)
  };
  const strip = { cellId: 'a', status: 'writing', text: 'Why?' };
  const ending = model._agent(
    {
      id: 'q1',
      text: 'Why is pain higher on Mondays?',
      type: 'association',
      origin: 'user',
      probability: null,
      reasons: [],
      placement: null,
      code: null
    },
    { kind: 'new', cell: 'a', label: 'new cell after [1]' },
    model.cell('a'),
    strip,
    null,
    async () => undefined
  );
  await settle();
  run.deliver({ type: 'started', run: 'r1', keep_local: false });
  await settle();
  return { run, posted, ending };
}

const TOOL = {
  type: 'tool',
  run: 'r1',
  call: 'call-1',
  name: 'run_cell',
  input: { code: 'y = 2', title: 'A step', why: '' }
};

describe('a Whybook view that closes while the notebook stays open', () => {
  it('keeps the run going, and runs its tool calls in the notebook', async () => {
    const { nb, model, disposed } = closable();
    const { run, posted, ending } = await started(model);
    model.dispose();
    expect(run.signal!.aborted).toBe(false);
    // What the run's tool calls use stays until the run ends.
    expect(disposed).not.toContain('jobs');
    run.deliver(TOOL);
    await until(() => posted.length > 0);
    expect(sources(nb)).toEqual(['x_a = 1', 'y = 2']);
    expect(posted).toEqual([
      expect.objectContaining({
        run: 'r1',
        call: 'call-1',
        result: expect.objectContaining({ status: 'ok', title: 'A step' })
      })
    ]);
    run.deliver({
      type: 'result',
      answer: 'Mondays follow weekends.',
      cells: []
    });
    await settle();
    run.finish();
    await ending;
    expect(disposed).toEqual(
      expect.arrayContaining(['refresher', 'plotHooks', 'bridge', 'jobs'])
    );
    // The notebook keeps the run, as it does when the view stays open.
    expect((nb.getMetadata('whybook') as any).agent_runs.r1.state).toBe('done');
  });

  it('stops receiving the changes of cells after it closed', () => {
    const { nb, model } = closable([{ id: 'a' }, { id: 'b' }] as any);
    model._watchCells();
    model.dispose();
    let calls = 0;
    model._onCellChanged = () => {
      calls += 1;
    };
    nb.sharedModel.insertCell(2, { cell_type: 'code', source: '' });
    nb.sharedModel.getCell(2).setSource('y = 2');
    expect(calls).toBe(0);
  });

  it('disposes everything at once when no run goes on', () => {
    const { model, disposed } = closable();
    model.dispose();
    expect(disposed).toEqual(
      expect.arrayContaining([
        'refresher',
        'policy',
        'next',
        'tableNotes',
        'cellTitles',
        'signIns',
        'plotHooks',
        'bridge',
        'jobs'
      ])
    );
  });
});

describe('a notebook that closes while its run goes on', () => {
  it('stops the run at once when the last view of the notebook closes', async () => {
    const { nb, model, disposed } = closable();
    const { run, posted, ending } = await started(model);
    model.dispose();
    model.context.isDisposed = true;
    model.context.disposed.emit(undefined);
    expect(model.api.agentStop).toHaveBeenCalledWith('r1');
    expect(run.signal!.aborted).toBe(true);
    // A tool call that was on its way does not run.
    run.deliver(TOOL);
    await ending;
    expect(nb.cells.length).toBe(1);
    expect(posted).toEqual([]);
    expect(disposed).toContain('jobs');
  });

  it('stops the run when a tool call comes and the notebook is gone', async () => {
    const { nb, model } = closable();
    const { run, posted, ending } = await started(model);
    // The notebook closed without its signal reaching this model.
    model.context.isDisposed = true;
    run.deliver(TOOL);
    await ending;
    expect(model.api.agentStop).toHaveBeenCalledWith('r1');
    expect(run.signal!.aborted).toBe(true);
    expect(nb.cells.length).toBe(1);
    expect(posted).toEqual([]);
  });
});
