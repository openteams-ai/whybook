/**
 * The type on each cell of an agent's run. A cell shows the type of its own
 * step, from its title, its step's why and its code, by the rules that type
 * a typed question; the cell that holds the answer shows the question's
 * type once the run ends. The Exploration panel counts the question once,
 * by its type, whatever its cells show. No kernel runs: a cell's run is
 * faked, with its count and its outputs.
 */
import './fakes/quiet';

import * as React from 'react';
import type { ICodeCellModel } from '@jupyterlab/cells';

import type { IAgentEvent, IAgentRun } from '../model/agent';
import { cellType } from '../model/agent';
import type { IStrip } from '../model/epimodel';
import { AgentRuns } from '../model/runs';
import { DocumentView } from '../ui/document';
import { ExplorationPanel } from '../ui/exploration';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

const QUESTION = 'Before anyone quit, how did quitters and continuers differ?';

const CELLS = [
  {
    id: 'a',
    source: 'import pandas as pd\nimport statsmodels.formula.api as smf',
    count: 1
  },
  {
    id: 'b',
    source:
      'nhefs = pd.read_csv("nhefs.csv")\ncodebook = pd.read_csv("nhefs_codebook.csv")',
    count: 2
  }
];

/**
 * Start an agent's run about cell `b`, with a stream that the test feeds.
 * The question's type is association, as its words give. A cell runs at
 * once with the kernel's next count: code that calls float() fails, and
 * other code shows a number.
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
        evalue: 'cannot convert the series to float',
        traceback: []
      });
      return {
        ok: false,
        error: 'TypeError: cannot convert the series to float'
      };
    }
    cell.outputs.add({
      output_type: 'execute_result',
      data: { 'text/plain': '3.4' },
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
  const strip: IStrip = {
    cellId: 'b',
    question: { id: 'q1', text: QUESTION, type: 'association' },
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
  model.strips.set('b', strip);
  const ending = model._agent(
    {
      id: 'q1',
      text: QUESTION,
      type: 'association',
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
  const end = async (answer: string, cells: string[]) => {
    stream.deliver({ type: 'result', answer, cells, model: 'test' });
    await settle();
    stream.finish();
    await ending;
  };
  return { tool, end, run: strip.agent as IAgentRun };
}

/** The type that each cell of the run shows, by the cell's title. */
function typesOf(model: any, run: IAgentRun): Record<string, string> {
  return Object.fromEntries(
    run.steps
      .flatMap(step => step.cells)
      .map(id => model.cell(id))
      .map((cell: any) => [cell.title, cellType(cell.meta)])
  );
}

describe('the type on each cell of an agent’s run', () => {
  it('shows the type of each step, and the type of the question on the cell that holds the answer', async () => {
    const runs = new AgentRuns();
    const { model } = benchModel(CELLS, { runs });
    const { tool, end, run } = await startRun(model);
    await tool('c1', 'run_cell', {
      title: 'Find baseline variables',
      why: 'Locate the variables that the codebook says were measured at baseline.',
      code: 'codebook[codebook.description.str.contains("baseline")]'
    });
    await tool('c2', 'run_cell', {
      title: 'Test quadratic adjustment terms',
      why: 'See whether squared terms change the estimate.',
      code: 'fit_sq = smf.ols("wt82_71 ~ qsmk + age + I(age ** 2)", nhefs).fit()\nfit_sq.params.round(2)'
    });
    await tool('c3', 'run_cell', {
      title: 'Baseline means of quitters and continuers',
      why: '',
      code: 'nhefs.groupby("qsmk")[["age", "smokeyrs"]].mean().round(1)'
    });
    // While the run works, each cell shows what its own step does.
    expect(typesOf(model, run)).toEqual({
      'Find baseline variables': 'descriptive',
      'Test quadratic adjustment terms': 'model',
      'Baseline means of quitters and continuers': 'descriptive'
    });

    await end('Quitters were older at baseline ([5]).', ['[5]']);
    expect(typesOf(model, run)).toEqual({
      'Find baseline variables': 'descriptive',
      'Test quadratic adjustment terms': 'model',
      'Baseline means of quitters and continuers': 'association'
    });
    // The cells keep the question, which the Exploration panel counts.
    for (const id of run.steps.flatMap(step => step.cells)) {
      expect(model.cell(id)?.meta.question).toMatchObject({
        id: 'q1',
        type: 'association'
      });
    }

    // The bench draws the badges.
    const view = await mount(
      <DocumentView
        model={model}
        editorServices={null}
        openFile={() => undefined}
        isVisible={() => true}
      />
    );
    await settle();
    const badges = Array.from(
      view.host.querySelectorAll('.jp-Epi-cell-head .jp-Epi-type')
    ).map(badge => badge.textContent);
    await view.unmount();
    expect(badges).toEqual(['Descriptive', 'Model check', 'Association']);

    // The Exploration panel counts one question, of the question's type.
    const panel = await mount(<ExplorationPanel model={model} />);
    await settle();
    const asked = panel.host.querySelector(
      '.jp-Epi-block-head .jp-Epi-big'
    )?.textContent;
    const counts = Object.fromEntries(
      Array.from(panel.host.querySelectorAll('.jp-Epi-typebar')).map(bar => [
        bar.querySelector('.jp-Epi-type')?.textContent,
        bar.querySelector('.jp-Epi-typebar-count')?.textContent
      ])
    );
    await panel.unmount();
    expect(asked).toBe('1');
    expect(counts).toEqual({
      Association: '1',
      Causal: '0',
      'Data quality': '0',
      'Model check': '0',
      Descriptive: '0'
    });
    model.dispose();
  });

  it('reads the type of a cell that the agent fixed from its new code', async () => {
    const runs = new AgentRuns();
    const { model } = benchModel(CELLS, { runs });
    const { tool, end, run } = await startRun(model);
    const failed = await tool('c1', 'run_cell', {
      title: 'Weight change by quitting',
      why: '',
      code: 'float(nhefs.wt82_71)'
    });
    expect(failed).toMatchObject({ status: 'error', cell: '[3]' });
    expect(typesOf(model, run)).toEqual({
      'Weight change by quitting': 'descriptive'
    });
    const fixed = await tool('c2', 'run_cell', {
      title: 'Weight change by quitting',
      code: 'fit_q = smf.ols("wt82_71 ~ qsmk", nhefs).fit()\nfit_q.params.round(2)',
      fix: '[3]'
    });
    expect(fixed).toMatchObject({ status: 'ok', fixed: '[3]' });
    expect(typesOf(model, run)).toEqual({
      'Weight change by quitting': 'model'
    });
    // An answer that names no cell of the run leaves each cell its type.
    await end('Quitters gained more weight.', []);
    expect(typesOf(model, run)).toEqual({
      'Weight change by quitting': 'model'
    });
    model.dispose();
  });
});
