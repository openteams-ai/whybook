/**
 * Undo of an answer, and "Remove its cells and files" of an agent's run
 * (src/model/epimodel.ts), after the analyst changed what the answer wrote:
 * the view asks first, and keeps the analyst's work until they choose.
 */
import './fakes/quiet';

import { Notification } from '@jupyterlab/apputils';
import * as React from 'react';
import { createRoot } from 'react-dom/client';

import type { IAgentRun } from '../model/agent';
import { UndoAsk } from '../ui/undoask';
import { fakeModel, settle, sources } from './fakes/model-fake';

const act: (callback: () => Promise<void> | void) => Promise<void> = (
  React as any
).act;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function answerable(cells: Parameters<typeof fakeModel>[0]) {
  const { nb, model } = fakeModel(cells);
  model.jobs = { run: async () => ({ ok: true }) };
  model.runCell = jest.fn(async () => undefined);
  return { nb, model };
}

const option = (placement: Record<string, unknown>, code: string) => ({
  id: 'q1',
  text: 'Plot pain against week',
  type: 'descriptive',
  origin: 'template',
  probability: 0.5,
  reasons: [],
  placement,
  code
});

const PLOT = 'plot = whybook.scatter(weekly, x="week", y="pain")';
const FIT = 'fit = smf.ols("pain ~ week", data=weekly).fit()';
const EDIT = 'fit = smf.ols("pain ~ week + il6", data=weekly).fit()';

describe('Undo of an answer', () => {
  const after = { kind: 'new', cell: 'c1', label: 'new cell after [1]' };
  const edit = { kind: 'edit', cell: 'c1', label: 'edit [1] in place' };

  it('removes the added cell at once while it holds what the answer wrote', async () => {
    const { nb, model } = answerable([{ id: 'c1', count: 1 }]);
    await model.apply(option(after, PLOT), after);
    expect(model.strips.get('c1').status).toBe('done');
    model.undo('c1');
    expect(sources(nb)).toEqual(['x_c1 = 1']);
    expect(model.strips.has('c1')).toBe(false);
  });

  it('asks first when the analyst typed in the added cell, and keeps it on Keep', async () => {
    const { nb, model } = answerable([{ id: 'c1', count: 1 }]);
    await model.apply(option(after, PLOT), after);
    const added = nb.cells.get(1);
    added.sharedModel.setSource(`${PLOT}\nslope = fit_slope(weekly)`);
    model.undo('c1');
    // The cell stays, and the strip asks.
    expect(sources(nb)).toEqual([
      'x_c1 = 1',
      `${PLOT}\nslope = fit_slope(weekly)`
    ]);
    expect(model.strips.get('c1').undoAsk).toEqual(['the new cell']);
    model.dismissUndo('c1');
    expect(model.strips.get('c1').undoAsk).toBeNull();
    expect(nb.cells.length).toBe(2);
  });

  it('removes the changed cell on Undo anyway', async () => {
    const { nb, model } = answerable([{ id: 'c1', count: 1 }]);
    await model.apply(option(after, PLOT), after);
    nb.cells.get(1).sharedModel.setSource('typed by the analyst');
    model.undo('c1');
    model.undo('c1', true);
    expect(sources(nb)).toEqual(['x_c1 = 1']);
    expect(model.strips.has('c1')).toBe(false);
  });

  it('asks first when the analyst edited the edited cell afterwards', async () => {
    const { nb, model } = answerable([{ id: 'c1', count: 1, source: FIT }]);
    await model.apply(option(edit, EDIT), edit);
    const cell = nb.cells.get(0);
    expect(cell.sharedModel.getSource()).toBe(EDIT);
    cell.sharedModel.setSource(`${EDIT}\nfit.summary()`);
    model.undo('c1');
    expect(sources(nb)).toEqual([`${EDIT}\nfit.summary()`]);
    expect(model.strips.get('c1').undoAsk).toEqual(['[1]']);
    expect(model.runCell).not.toHaveBeenCalled();
    model.undo('c1', true);
    expect(sources(nb)).toEqual([FIT]);
    expect(model.runCell).toHaveBeenCalledWith('c1');
  });

  it('puts the code back at once while the edited cell holds what the answer wrote', async () => {
    const { nb, model } = answerable([{ id: 'c1', count: 1, source: FIT }]);
    await model.apply(option(edit, EDIT), edit);
    model.undo('c1');
    expect(sources(nb)).toEqual([FIT]);
  });
});

/** A run that added cell `a1` and wrote helpers.py, as `_agentTool` keeps it. */
function agentRun(previous: string | null = null): IAgentRun {
  return {
    id: 'r1',
    stripId: 'c1',
    question: 'How does pain change by week?',
    anchor: 'c1',
    state: 'done',
    steps: [
      {
        call: 'call-1',
        tool: 'run_cell',
        title: 'Weekly means',
        why: '',
        cells: ['a1'],
        code: { a1: 'weekly = diary.resample("W").mean()' },
        state: 'done',
        error: null
      },
      {
        call: 'call-2',
        tool: 'write_file',
        title: 'Wrote helpers.py',
        why: '',
        cells: [],
        file: {
          path: 'helpers.py',
          name: 'helpers.py',
          lines: 3,
          content: AGENT_FILE,
          previous,
          previousRecord: previous === null ? null : EARLIER
        },
        state: 'done',
        error: null
      }
    ],
    notes: [],
    thinking: null,
    answer: null,
    answerCells: [],
    followUp: [],
    by: null,
    costUsd: null,
    error: null,
    started: 0,
    keepLocal: false
  };
}

const AGENT_FILE =
  '# Written by AI\ndef weekly(d):\n    return d.resample("W").mean()\n';
const EARLIER = {
  generated_by: {
    agent: 'claude-code',
    model: 'm',
    at: '2026-09-26T10:00:00Z'
  },
  run: 'r0'
};
const LATER = {
  generated_by: {
    agent: 'claude-code',
    model: 'm',
    at: '2026-09-27T10:00:00Z'
  },
  run: 'r1'
};

/** A model whose run r1 added cell a1 and wrote helpers.py on this disk. */
function withRun(disk: Map<string, string>, previous: string | null = null) {
  const { nb, model } = fakeModel(
    [
      { id: 'c1', count: 1 },
      { id: 'a1', count: 2, source: 'weekly = diary.resample("W").mean()' }
    ],
    { files: { 'helpers.py': LATER }, agent_runs: { r1: { state: 'done' } } }
  );
  model._contentsManager = {
    get: async (path: string) => {
      if (!disk.has(path)) {
        throw new Error('404: not found');
      }
      return { content: disk.get(path) };
    },
    save: async (path: string, options: { content: string }) => {
      disk.set(path, options.content);
      return {};
    },
    delete: async (path: string) => void disk.delete(path)
  };
  model.api = { agentStop: async () => undefined };
  const run = agentRun(previous);
  model.agentRuns = [run];
  const notices: any[] = [];
  jest
    .spyOn(Notification, 'emit')
    .mockImplementation((_text: unknown, _type: unknown, options: any) => {
      notices.push(options);
      return 'notice';
    });
  jest.spyOn(Notification, 'dismiss').mockImplementation(() => undefined);
  return { nb, model, run, notices };
}

describe('"Remove its cells and files" of an agent\'s run', () => {
  afterEach(() => jest.restoreAllMocks());

  it('removes at once what holds what the agent wrote', async () => {
    const disk = new Map([['helpers.py', AGENT_FILE]]);
    const { nb, model, run } = withRun(disk);
    await model.discardAgent(run);
    await settle();
    expect(sources(nb)).toEqual(['x_c1 = 1']);
    expect(disk.has('helpers.py')).toBe(false);
  });

  it('asks first when the analyst changed a cell or the module it added', async () => {
    const disk = new Map([
      ['helpers.py', AGENT_FILE.replace('.mean()', '.mean(numeric_only=True)')]
    ]);
    const { nb, model, run } = withRun(disk);
    nb.cells.get(1).sharedModel.setSource('weekly = diary.resample("W").sum()');
    await model.discardAgent(run);
    expect(run.removeAsk).toEqual(['[2]', 'helpers.py']);
    expect(nb.cells.length).toBe(2);
    expect(disk.has('helpers.py')).toBe(true);
    model.dismissRemove(run);
    expect(run.removeAsk).toBeNull();
  });

  it('gives back the module as the analyst left it, after Remove anyway and Undo', async () => {
    const edited = AGENT_FILE.replace('.mean()', '.mean(numeric_only=True)');
    const disk = new Map([['helpers.py', edited]]);
    const { nb, model, run, notices } = withRun(disk);
    await model.discardAgent(run, true);
    await settle();
    expect(disk.has('helpers.py')).toBe(false);
    // Undo, from the notice.
    notices[0].actions[0].callback();
    await settle();
    expect(disk.get('helpers.py')).toBe(edited);
    expect(sources(nb)).toEqual([
      'x_c1 = 1',
      'weekly = diary.resample("W").mean()'
    ]);
    const meta = nb.getMetadata('whybook') as any;
    expect(meta.files['helpers.py']).toEqual(LATER);
    expect(meta.agent_runs.r1).toEqual({ state: 'done' });
  });

  it("puts back the earlier run's record of a file that the run had rewritten", async () => {
    const disk = new Map([['helpers.py', AGENT_FILE]]);
    const { nb, model, run } = withRun(disk, 'r0 content\n');
    await model.discardAgent(run);
    await settle();
    expect(disk.get('helpers.py')).toBe('r0 content\n');
    const meta = nb.getMetadata('whybook') as any;
    expect(meta.agent_runs.r1).toBeUndefined();
    expect(meta.files['helpers.py']).toEqual(EARLIER);
  });
});

describe('UndoAsk', () => {
  async function mount(element: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(() => root.render(element));
    return {
      host,
      unmount: async () => {
        await act(() => root.unmount());
        host.remove();
      }
    };
  }

  it('takes the focus, and gives it back to Undo on Keep', async () => {
    const undo = document.createElement('button');
    document.body.appendChild(undo);
    const keep = jest.fn();
    const { host, unmount } = await mount(
      <UndoAsk
        changed={['[5]']}
        verb="Undo"
        back={{ current: undo }}
        cell={null}
        onConfirm={() => undefined}
        onKeep={keep}
      />
    );
    const question = host.querySelector('.jp-Epi-undoask') as HTMLElement;
    expect(question.textContent).toContain(
      'You changed [5] since this answer. Undo removes your changes too.'
    );
    expect(document.activeElement).toBe(question);
    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons.map(button => button.textContent)).toEqual([
      'Undo anyway',
      'Keep'
    ]);
    await act(() => buttons[1].click());
    expect(keep).toHaveBeenCalled();
    expect(document.activeElement).toBe(undo);
    await unmount();
    undo.remove();
  });

  it('gives the focus to the cell on Undo anyway, and keeps on Escape', async () => {
    const main = document.createElement('div');
    main.innerHTML =
      '<div class="jp-Epi-cell" data-cell-id="c1"><span>[1]</span><button>Ask</button></div>';
    document.body.appendChild(main);
    const confirm = jest.fn();
    const keep = jest.fn();
    const { host, unmount } = await mount(
      <UndoAsk
        changed={['[5]', 'helpers.py']}
        verb="Remove"
        back={{ current: null }}
        cell="c1"
        onConfirm={confirm}
        onKeep={keep}
      />
    );
    expect(host.textContent).toContain(
      'You changed [5] and helpers.py since this answer. Remove deletes your changes too.'
    );
    const question = host.querySelector('.jp-Epi-undoask') as HTMLElement;
    await act(() => {
      question.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(keep).toHaveBeenCalled();
    await act(() => (host.querySelector('button') as HTMLElement).click());
    expect(confirm).toHaveBeenCalled();
    expect(document.activeElement).toBe(main.querySelector('.jp-Epi-cell'));
    await unmount();
    main.remove();
  });
});
