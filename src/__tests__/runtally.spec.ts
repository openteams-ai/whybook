/**
 * The run that the toolbar's kernel status counts (src/model/runtally.ts),
 * and the model of the indicator that reads it (src/ui/runindicator.ts). No
 * kernel starts.
 */
import './fakes/quiet';

import type { ISessionContext } from '@jupyterlab/apputils';
import { Signal } from '@lumino/signaling';

import type { JobManager } from '../model/jobs';
import { RUN_GAP_MS, RunTally } from '../model/runtally';
import { RunIndicatorModel } from '../ui/runindicator';

beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
afterEach(() => jest.useRealTimers());

describe('RunTally', () => {
  it('keeps the cells sent one at a time in one run', () => {
    const tally = new RunTally(() => undefined);
    for (const id of ['a', 'b', 'c']) {
      tally.start(id);
      jest.advanceTimersByTime(2000);
      tally.finish(id);
      // The next cell starts after the view read the kernel again.
      jest.advanceTimersByTime(100);
    }
    expect(tally.running).toBe(true);
    expect(tally.run).toMatchObject({ total: 3, done: 3, finished: null });
    jest.advanceTimersByTime(RUN_GAP_MS);
    expect(tally.running).toBe(false);
    // The run ends when its last cell finished, not after the gap.
    expect(tally.run).toEqual({
      started: 1_000_000,
      finished: 1_000_000 + 2 * 2100 + 2000,
      total: 3,
      done: 3
    });
  });

  it('counts the cells that Run all plans from its first cell', () => {
    const tally = new RunTally(() => undefined);
    tally.plan(5);
    tally.start('a');
    expect(tally.run).toMatchObject({ total: 5, done: 0 });
    tally.finish('a');
    tally.start('b');
    expect(tally.run).toMatchObject({ total: 5, done: 1 });
  });

  it('adds the cells that Run all plans to a run going on', () => {
    const tally = new RunTally(() => undefined);
    tally.start('agent');
    tally.plan(3);
    expect(tally.run).toMatchObject({ total: 4, done: 0 });
  });

  it('counts branches that run together', () => {
    const tally = new RunTally(() => undefined);
    tally.start('a');
    tally.start('b');
    tally.finish('a');
    jest.advanceTimersByTime(RUN_GAP_MS * 2);
    expect(tally.running).toBe(true);
    expect(tally.run).toMatchObject({ total: 2, done: 1 });
    tally.finish('b');
    jest.advanceTimersByTime(RUN_GAP_MS);
    expect(tally.running).toBe(false);
  });

  it('starts a new run after a pause longer than the gap', () => {
    const tally = new RunTally(() => undefined);
    tally.start('a');
    tally.finish('a');
    jest.advanceTimersByTime(RUN_GAP_MS + 100);
    tally.start('b');
    expect(tally.run).toEqual({
      started: 1_000_000 + RUN_GAP_MS + 100,
      finished: null,
      total: 1,
      done: 0
    });
  });

  it('ends the run when the kernel restarts', () => {
    const tally = new RunTally(() => undefined);
    tally.start('a');
    jest.advanceTimersByTime(700);
    tally.reset();
    expect(tally.running).toBe(false);
    // A cell of the run that the restart stopped does not count as done.
    tally.finish('a');
    expect(tally.run).toMatchObject({ total: 1, done: 0 });
  });
});

describe('RunIndicatorModel', () => {
  function setup(status: ISessionContext.KernelDisplayStatus = 'idle') {
    const changed = new Signal<object, void>({});
    const tally = new RunTally(() => changed.emit());
    const jobs = { tally, changed } as unknown as JobManager;
    const sessionContext = {
      kernelDisplayStatus: status,
      statusChanged: new Signal({}),
      connectionStatusChanged: new Signal({})
    } as unknown as ISessionContext;
    const model = new RunIndicatorModel({}, sessionContext, jobs);
    return { tally, model, sessionContext };
  }

  it('shows a run as busy with the cells left, though the kernel says idle', () => {
    const { tally, model } = setup('idle');
    tally.plan(3);
    tally.start('a');
    tally.finish('a');
    tally.start('b');
    jest.advanceTimersByTime(4000);
    const state = model.executionState()!;
    expect(state.executionStatus).toBe('busy');
    expect(state.kernelStatus).toBe('busy');
    // "Executed 1/3 cells", "Elapsed time: 4 seconds".
    expect(state.scheduledCellNumber).toBe(3);
    expect(state.scheduledCell.size).toBe(2);
    expect(state.totalTime).toBe(4);
    model.dispose();
  });

  it('shows the kernel status and the last run once the run is over', () => {
    const { tally, model } = setup('idle');
    tally.start('a');
    jest.advanceTimersByTime(3000);
    tally.finish('a');
    jest.advanceTimersByTime(RUN_GAP_MS + 2000);
    const state = model.executionState()!;
    expect(state.executionStatus).toBe('idle');
    expect(state.kernelStatus).toBe('idle');
    // "Executed 1 cell", "Elapsed time: 3 seconds".
    expect(state.scheduledCellNumber).toBe(1);
    expect(state.totalTime).toBe(3);
    model.dispose();
  });

  it('shows a restart of the kernel, not the run', () => {
    const { tally, model } = setup('restarting');
    tally.start('a');
    expect(model.executionState()!.kernelStatus).toBe('restarting');
    model.dispose();
  });

  it('draws again each second while a run goes on, and stops after', () => {
    const { tally, model } = setup();
    let draws = 0;
    model.stateChanged.connect(() => draws++);
    tally.start('a');
    draws = 0;
    jest.advanceTimersByTime(3000);
    expect(draws).toBe(3);
    tally.finish('a');
    jest.advanceTimersByTime(RUN_GAP_MS);
    draws = 0;
    jest.advanceTimersByTime(3000);
    expect(draws).toBe(0);
    model.dispose();
  });
});
