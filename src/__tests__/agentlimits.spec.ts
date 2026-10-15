/**
 * The limits of an agent's answer and of the branches that run at once: the
 * analyst's limit of cells goes with an agent's request only when it is set,
 * and as many branches run at once as the server has processors, unless the
 * analyst sets another number. The other branches wait for a free one.
 */
import type { ISessionContext } from '@jupyterlab/apputils';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Signal } from '@lumino/signaling';

import { JobManager } from '../model/jobs';
import { fakeModel, settle, until } from './fakes/model-fake';

/** A view model over one cell that ran, whose agent's route records each request's body and answers at once. */
function view() {
  const { nb, model } = fakeModel([
    { id: 'load', source: 'visits = load()', count: 1 }
  ]);
  model.jobs = { run: async () => ({ ok: true }) };
  model.bridge.hasRun = () => true;
  model._refresher = { invoke: () => Promise.resolve() };
  model.aiReady = () => true;
  model.runCell = jest.fn(async () => undefined);
  const bodies: Record<string, unknown>[] = [];
  model.api = {
    agent: async (
      body: Record<string, unknown>,
      onEvent: (event: unknown) => void
    ): Promise<void> => {
      bodies.push(body);
      onEvent({ type: 'started', run: 'r1', keep_local: false });
      onEvent({ type: 'result', answer: 'Done.', cells: [], follow_up: [] });
    },
    agentResult: async () => undefined
  };
  return { nb, model, bodies };
}

/** A question that needs AI, about the cell, whose answer goes to a new cell: an agent's. */
const QUESTION = {
  id: 'q:arm',
  text: 'Does pain differ by arm?',
  type: 'association',
  origin: 'claude',
  probability: null,
  reasons: [],
  placement: { kind: 'new', cell: 'load', label: 'a new cell after [1]' },
  code: null
};

describe("the analyst's limit of cells for one answer", () => {
  it('goes with the request when the analyst sets one, and not otherwise', async () => {
    const { model, bodies } = view();
    await model.apply(QUESTION);
    await until(() => bodies.length === 1);
    expect(bodies[0]).not.toHaveProperty('max_cells');
    model.settings.agentMaxCells = 10;
    await model.apply({ ...QUESTION, id: 'q:arm2' });
    await until(() => bodies.length === 2);
    expect(bodies[1].max_cells).toBe(10);
  });

  it("leaves a rewrite in another kernel to the server's guard, which takes a cell for each step", async () => {
    const { model, bodies } = view();
    model.settings.agentMaxCells = 4;
    model._agentContext = async () => ({ compare: { kernel: 'ir' } });
    model._kernelAsked = {
      get: () => ({ name: 'ir', displayName: 'R', label: 'R' })
    };
    await model.apply({
      ...QUESTION,
      id: 'q:r',
      text: 'Would I get the same results in R?'
    });
    await until(() => bodies.length === 1);
    expect(bodies[0]).not.toHaveProperty('max_cells');
  });
});

describe('the branches that run at once', () => {
  it("follow the server's processors unless the analyst sets a number, and are at least 2", async () => {
    const { model } = view();
    model.cellTitles.titleAll = () => undefined;
    model._findDefaults = () => undefined;
    model.jobs = { capacity: 8 };
    model.settings.capacity = 0;
    model.api = { status: async () => ({ cpu_count: 6 }) };
    model.refreshStatus();
    await settle();
    expect(model.jobs.capacity).toBe(6);
    model.settings.capacity = 3;
    expect(model._capacity()).toBe(3);
    model.settings.capacity = 0;
    model.status = { cpu_count: 1 };
    expect(model._capacity()).toBe(2);
    // Without the server's number, the browser's.
    model.status = null;
    expect(model._capacity()).toBe(
      Math.max(2, navigator.hardwareConcurrency || 8)
    );
  });

  it('let the branches that wait try again when the capacity grows', () => {
    const sessionContext = {
      session: null,
      kernelChanged: new Signal({}),
      statusChanged: new Signal({})
    } as unknown as ISessionContext;
    const jobs = new JobManager({
      sessionContext,
      rendermime: {} as unknown as IRenderMimeRegistry,
      capacity: 4
    });
    const woken: string[] = [];
    (jobs as any)._waiting.push(
      () => woken.push('a'),
      () => woken.push('b')
    );
    jobs.capacity = 2;
    expect(woken).toEqual([]);
    jobs.capacity = 6;
    expect(woken).toEqual(['a', 'b']);
    expect((jobs as any)._waiting).toHaveLength(0);
    jobs.dispose();
  });
});
