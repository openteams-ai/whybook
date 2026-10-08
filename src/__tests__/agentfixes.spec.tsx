/**
 * An agent fixes a failed cell in place, and never leaves one: design
 * iteration 1.103. run_cell with `fix` rewrites the cell that failed, which
 * runs again where it is; remove_cell deletes it; and the run's card says
 * what became of it, "fixed after TypeError", so that no error is hidden.
 * No kernel runs: the cell's run is faked, with its count and its outputs.
 */
import './fakes/quiet';

import * as React from 'react';
import type { ICodeCellModel } from '@jupyterlab/cells';

import type { IAgentEvent, IAgentRun, IAgentStep } from '../model/agent';
import { runStatus, stepNotes } from '../model/agent';
import type { IStrip } from '../model/epimodel';
import { editedByHand } from '../model/handedit';
import { cellMeta } from '../model/notebook';
import { AgentRuns, historyOf, pastRun } from '../model/runs';
import type { IAgentRunRecord } from '../tokens';
import { AgentRunView } from '../ui/agent';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

const QUESTION = 'Does the effect of qsmk differ by sex?';
const TYPE_ERROR =
  'TypeError: only 0-dimensional arrays can be converted to Python scalars';
const FAILING = 'fit = smf.ols("y ~ qsmk * sex", d).fit()\nfloat(fit.params)';
const FIXED = 'fit = smf.ols("y ~ qsmk * sex", d).fit()\nfit.params.round(2)';

const CELLS = [
  { id: 'a', source: 'import pandas as pd', count: 1 },
  { id: 'b', source: 'd = pd.read_csv("nhefs.csv")', count: 2 }
];

function stripOf(): IStrip {
  return {
    cellId: 'b',
    question: { id: 'q1', text: QUESTION, type: 'causal' },
    guess: null,
    text: QUESTION,
    action: 'New cell after [2]',
    placement: { kind: 'new', cell: 'b', label: 'new cell after [2]' },
    status: 'writing',
    stage: null,
    elapsed: null,
    started: Date.now(),
    thinking: null,
    before: null,
    after: null,
    insertedId: null,
    error: null,
    showDiff: false
  };
}

/**
 * Start an agent's run about cell `b`, with a stream that the test feeds.
 * A cell runs at once with the kernel's next count: code that calls float()
 * fails with a TypeError, as cell [22] of the NHEFS take did, and other
 * code shows a number.
 */
async function startRun(model: any) {
  const posted: Record<string, any>[] = [];
  const stream = {
    deliver: (_event: IAgentEvent | Record<string, unknown>) => undefined,
    finish: () => undefined
  } as {
    deliver: (event: IAgentEvent | Record<string, unknown>) => void;
    finish: () => void;
  };
  let count = 2;
  model.aiReady = () => true;
  model.refresh = async () => undefined;
  model._run = async (cell: ICodeCellModel) => {
    count += 1;
    cell.outputs.clear();
    cell.executionCount = count;
    if (cell.sharedModel.getSource().includes('float(')) {
      cell.outputs.add({
        output_type: 'error',
        ename: 'TypeError',
        evalue: TYPE_ERROR.slice('TypeError: '.length),
        traceback: []
      });
      return { ok: false, error: TYPE_ERROR };
    }
    cell.outputs.add({
      output_type: 'execute_result',
      data: { 'text/plain': 'qsmk:sex   -0.43' },
      metadata: {},
      execution_count: count
    });
    return { ok: true, error: null };
  };
  model.api = {
    agent: (
      _body: unknown,
      onEvent: (event: unknown) => void,
      signal: AbortSignal
    ) =>
      new Promise<void>((resolve, reject) => {
        stream.deliver = onEvent;
        stream.finish = resolve;
        signal.addEventListener('abort', () =>
          reject(new DOMException('The request was aborted', 'AbortError'))
        );
      }),
    agentResult: async (body: Record<string, unknown>) => {
      posted.push(body);
    },
    agentStop: jest.fn(async () => undefined)
  };
  const strip = stripOf();
  model.strips.set('b', strip);
  const ending = model._agent(
    {
      id: 'q1',
      text: QUESTION,
      type: 'causal',
      origin: 'user',
      probability: null,
      reasons: [],
      placement: null,
      code: null
    },
    strip.placement,
    model.cell('b'),
    strip,
    null,
    async () => undefined
  );
  await settle();
  stream.deliver({ type: 'started', run: 'r1', keep_local: false });
  await settle();
  /** Send a tool call, and wait for the view to post what came out. */
  const tool = async (call: string, name: string, input: object) => {
    const before = posted.length;
    stream.deliver({ type: 'tool', run: 'r1', call, name, input });
    for (let i = 0; i < 50 && posted.length === before; i++) {
      await settle(10);
    }
    return posted[before]?.result;
  };
  const end = async (answer: string) => {
    stream.deliver({ type: 'result', answer, cells: [], model: 'test' });
    await settle();
    stream.finish();
    await ending;
  };
  return { tool, end, run: strip.agent as IAgentRun };
}

const RUN_CELL = {
  title: 'Test the interaction by sex',
  code: FAILING,
  why: 'compare the effect in women and men'
};

/** The text of the run's card, as the analyst reads it. */
async function cardText(model: any, run: IAgentRun) {
  const view = await mount(
    <AgentRunView model={model} run={run} place="card" />
  );
  const steps = Array.from(
    view.host.querySelectorAll('.jp-Epi-agentrun-steps li')
  ).map(item => ({
    state: item.className,
    cells: Array.from(item.querySelectorAll('.jp-Epi-agentrun-cell')).map(
      cell => cell.textContent
    ),
    notes: Array.from(item.querySelectorAll('.jp-Epi-agentrun-fixed')).map(
      note => [note.textContent, note.getAttribute('title')]
    ),
    error: item.querySelector('.jp-Epi-agentrun-error')?.textContent ?? null
  }));
  const status = view.host.querySelector(
    '.jp-Epi-agentrun-status'
  )?.textContent;
  await view.unmount();
  return { steps, status };
}

describe('an agent fixes a failed cell in place', () => {
  it('rewrites the cell that failed: one cell, where it was, with the new code and a new label', async () => {
    const runs = new AgentRuns();
    const { model, nb } = benchModel(CELLS, { runs });
    const { tool, end, run } = await startRun(model);
    const failed = await tool('c1', 'run_cell', RUN_CELL);
    expect(failed).toMatchObject({
      status: 'error',
      cell: '[3]',
      error: TYPE_ERROR
    });
    const id = run.steps[0].cells[0];
    expect(nb.cells.length).toBe(3);

    const fixed = await tool('c2', 'run_cell', {
      ...RUN_CELL,
      title: 'Fix the scalar conversion',
      code: FIXED,
      fix: '[3]'
    });
    expect(fixed).toMatchObject({ status: 'ok', cell: '[4]', fixed: '[3]' });
    // One cell, the same one, in its place, with the fix's code.
    expect(nb.cells.length).toBe(3);
    expect(nb.cells.get(2).id).toBe(id);
    expect(nb.cells.get(2).sharedModel.getSource()).toBe(FIXED);
    expect(model.cell(id)?.label).toBe('[4]');
    // It keeps its title, and its step: no new step for the fix.
    expect(model.cell(id)?.title).toBe(RUN_CELL.title);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({
      state: 'done',
      error: null,
      cells: [id],
      failures: { [id]: [TYPE_ERROR] }
    });
    // The agent's code, not the analyst's: Remove does not ask about it.
    expect(
      editedByHand(
        cellMeta(nb.cells.get(2)),
        nb.cells.get(2).sharedModel.getSource()
      )
    ).toBe(false);
    expect(run.steps[0].code?.[id]).toBe(FIXED);

    await end('No difference by sex ([4]).');
    // The card says what happened, and links the cell by its label now.
    const card = await cardText(model, run);
    expect(card.status).toBe('Answered with 1 cell');
    expect(card.steps).toEqual([
      {
        state: 'jp-mod-done',
        cells: ['[4]'],
        notes: [['fixed after TypeError', TYPE_ERROR]],
        error: null
      }
    ]);
    model.dispose();
  });

  it('says that a fix failed again, and removes a cell that the agent cannot fix', async () => {
    const runs = new AgentRuns();
    const { model, nb } = benchModel(CELLS, { runs });
    const { tool, end, run } = await startRun(model);
    await tool('c1', 'run_cell', RUN_CELL);
    const id = run.steps[0].cells[0];
    const again = await tool('c2', 'run_cell', { ...RUN_CELL, fix: '[3]' });
    expect(again).toMatchObject({ status: 'error', cell: '[4]', fixed: '[3]' });
    let card = await cardText(model, run);
    expect(card.steps[0].notes).toEqual([
      ['tried again after TypeError', TYPE_ERROR]
    ]);
    expect(card.steps[0].error).toBe(TYPE_ERROR);

    const removed = await tool('c3', 'remove_cell', {
      cell: '[4]',
      why: 'the model cannot take a float of the params'
    });
    expect(removed).toEqual({ status: 'ok', cell: '[4]', removed: true });
    expect(nb.cells.length).toBe(2);
    expect(run.steps[0].removed).toEqual([id]);
    await end('The interaction model did not run, so no estimate by sex.');
    card = await cardText(model, run);
    // The step stays, without a link to a cell that is not there: its note
    // names both errors, and their messages are in its tooltip.
    expect(card.status).toBe('Answered with 0 cells');
    expect(card.steps).toEqual([
      {
        state: 'jp-mod-error',
        cells: [],
        notes: [
          [
            'removed after TypeError, then TypeError',
            `${TYPE_ERROR}\n${TYPE_ERROR}`
          ]
        ],
        error: null
      }
    ]);
    model.dispose();
  });

  it('tells the server when the cell is no longer a failed cell of the run', async () => {
    const runs = new AgentRuns();
    const { model } = benchModel(CELLS, { runs });
    const { tool, run } = await startRun(model);
    await tool('c1', 'run_cell', RUN_CELL);
    // The analyst deletes the cell while the run goes on.
    model.deleteCell(run.steps[0].cells[0]);
    const fix = await tool('c2', 'run_cell', {
      ...RUN_CELL,
      code: FIXED,
      fix: '[3]'
    });
    expect(fix).toMatchObject({ status: 'refused', failed: false });
    const removal = await tool('c3', 'remove_cell', { cell: '[3]' });
    expect(removal).toMatchObject({ status: 'ok', failed: false });
    model.dispose();
  });
});

describe('what the run keeps of a cell that failed', () => {
  const step: IAgentStep = {
    call: 'c1',
    tool: 'run_cell',
    title: 'Test the interaction by sex',
    why: '',
    cells: ['x1'],
    state: 'done',
    error: null,
    failures: { x1: ['PatsyError: unrecognized token in constraint'] }
  };

  it('names each error in its order, and a branch by its label', () => {
    const cellOf = (id: string) =>
      id === 'x2'
        ? { label: '[5c]', failed: true }
        : { label: '[5b]', failed: false };
    expect(stepNotes(step, cellOf).map(note => [note.kind, note.text])).toEqual(
      [['fixed', 'fixed after PatsyError']]
    );
    expect(
      stepNotes({ ...step, state: 'running' }, cellOf).map(note => note.text)
    ).toEqual(['trying again after PatsyError']);
    const branches: IAgentStep = {
      ...step,
      tool: 'explore',
      cells: ['x1', 'x2'],
      state: 'error',
      failures: {
        x1: ['KeyError: wt82'],
        x2: ['NameError: name d is not defined', 'ValueError: shapes']
      }
    };
    expect(stepNotes(branches, cellOf).map(note => note.text)).toEqual([
      '[5b] fixed after KeyError',
      '[5c] tried again after NameError, then ValueError'
    ]);
  });

  it('keeps the errors and the cells removed in the notebook, and draws them again from there', () => {
    const run = {
      id: 'r1',
      stripId: 'b',
      question: QUESTION,
      anchor: 'b',
      state: 'done',
      steps: [
        step,
        {
          ...step,
          call: 'c2',
          cells: ['x2'],
          state: 'error',
          removed: ['x2'],
          failures: { x2: [TYPE_ERROR] }
        }
      ],
      notes: [],
      thinking: null,
      answer: 'No difference by sex.',
      answerCells: [],
      followUp: [],
      by: null,
      costUsd: 0.01,
      error: null,
      started: Date.now(),
      keepLocal: false
    } as IAgentRun;
    const kept = historyOf(run);
    expect(kept.steps?.map(item => [item.failures, item.removed])).toEqual([
      [{ x1: ['PatsyError: unrecognized token in constraint'] }, undefined],
      [{ x2: [TYPE_ERROR] }, ['x2']]
    ]);
    const again = pastRun('r1', {
      ...kept,
      question: QUESTION,
      state: 'done',
      at: new Date().toISOString(),
      cost_usd: 0.01,
      model: 'test'
    } as IAgentRunRecord);
    expect(again.steps.map(item => [item.failures, item.removed])).toEqual([
      [{ x1: ['PatsyError: unrecognized token in constraint'] }, undefined],
      [{ x2: [TYPE_ERROR] }, ['x2']]
    ]);
    // A removed cell is no cell of the answer.
    expect(runStatus(again)).toBe('Answered with 1 cell');
  });
});
