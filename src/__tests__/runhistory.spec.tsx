/**
 * The history of a notebook's agents' runs (design iteration 1.73,
 * src/model/runs.ts). The notebook keeps each run that ended with what its
 * strip shows: the steps, the answer, the follow-ups, the model, the cost
 * and how it ended. The Exploration panel lists the runs, the newest first,
 * and draws a closed run's strip again; a cell that a run wrote leads to
 * its run. The record outlives the strip and the notebook's closing, and a
 * notebook saved before keeps opening as it did.
 */
import './fakes/quiet';

import * as React from 'react';

import type { IAgentEvent, IAgentRun } from '../model/agent';
import type { IStrip } from '../model/epimodel';
import {
  AgentRuns,
  KEPT,
  historyOf,
  historyRows,
  pastRun,
  runWhen
} from '../model/runs';
import type { IAgentRunRecord } from '../tokens';
import { AgentRunView } from '../ui/agent';
import { CellDetails } from '../ui/details';
import { DocumentView } from '../ui/document';
import { RunsHistory } from '../ui/runs';
import type { IBench } from './fakes/bench-fake';
import { benchModel } from './fakes/bench-fake';
import { button, mount, settle, step } from './fakes/bench-render';

const QUESTION = 'Does the arm effect hold without the short diaries?';
const ANSWER =
  'Yes: without the short diaries the arm effect is -0.8 [3], as in [2].';

const CELLS = [
  { id: 'a', source: 'import pandas as pd', count: 1 },
  { id: 'b', source: 'diary = pd.read_csv("diary.csv")', count: 2 }
];

/** A strip as the view makes it for a question about cell `b`. */
function stripOf(cellId = 'b'): IStrip {
  return {
    cellId,
    question: { id: 'q1', text: QUESTION, type: 'causal' },
    guess: null,
    text: QUESTION,
    action: 'New cell after [2]',
    placement: { kind: 'new', cell: cellId, label: 'new cell after [2]' },
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
 * Run an agent in a view, as a question about [2] does, with a stream that
 * the test feeds: one cell, then the answer.
 */
async function answered(bench: IBench) {
  const model = bench.model as any;
  const stream: {
    deliver: (event: IAgentEvent | Record<string, unknown>) => void;
    finish: () => void;
  } = { deliver: () => undefined, finish: () => undefined };
  const posted: unknown[] = [];
  model.aiReady = () => true;
  // The kernel runs the cell: it gets its count, and its label.
  model._run = async (cell: { executionCount: number | null }) => {
    cell.executionCount = 3;
    return { ok: true, error: null };
  };
  model.refresh = async () => undefined;
  model._listed = async () => undefined;
  model.api = {
    agent: (
      _body: unknown,
      onEvent: (event: unknown) => void,
      signal: AbortSignal
    ) => {
      stream.deliver = onEvent;
      return new Promise<void>((resolve, reject) => {
        stream.finish = resolve;
        signal.addEventListener('abort', () =>
          reject(new DOMException('The request was aborted', 'AbortError'))
        );
      });
    },
    agentResult: async (body: unknown) => {
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
  stream.deliver({
    type: 'tool',
    run: 'r1',
    call: 'c1',
    name: 'run_cell',
    input: {
      code: 'long = diary[diary.weeks >= 12]\nlong.groupby("arm").pain.mean()',
      title: 'Mean pain by arm, 12 weeks or more',
      why: 'leave out the short diaries'
    }
  });
  for (let i = 0; i < 50 && !posted.length; i++) {
    await settle(10);
  }
  stream.deliver({
    type: 'result',
    answer: ANSWER,
    cells: ['[3]'],
    follow_up: ['causal: Does it hold at each site?'],
    model: 'claude-opus-5-5',
    provider: 'anthropic',
    cost_usd: 0.05,
    elapsed: 12
  });
  await settle();
  stream.finish();
  await ending;
  await settle();
  const run = strip.agent as IAgentRun;
  return { model, run, strip };
}

function recordOf(bench: IBench, id = 'r1'): IAgentRunRecord {
  return (bench.nb.getMetadata('whybook') as any).agent_runs[id];
}

describe('what the notebook keeps of a run', () => {
  it('keeps the steps, the answer and the follow-ups, cut to their limits', () => {
    const run = {
      ...pastRun('r1', {
        question: QUESTION,
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        cost_usd: 0.05,
        cells: ['c7'],
        files: [],
        state: 'stopped',
        at: '2026-09-30T10:00:00.000Z'
      }),
      answer: 'x'.repeat(3000),
      followUp: ['a', 'b', 'c', 'd', 'e', 'f'],
      anchor: 'b'
    };
    run.steps = [
      {
        call: 'c1',
        tool: 'run_cell',
        title: 'Mean pain',
        why: 'compare',
        cells: ['c7'],
        state: 'running',
        error: null
      }
    ];
    const kept = historyOf(run);
    expect(kept.anchor).toBe('b');
    expect(kept.answer).toHaveLength(KEPT.answer);
    expect(kept.answer?.endsWith('…')).toBe(true);
    expect(kept.follow_up).toEqual(['a', 'b', 'c', 'd', 'e']);
    // A step that went on when the run stopped did not end.
    expect(kept.steps).toEqual([
      {
        tool: 'run_cell',
        title: 'Mean pain',
        why: 'compare',
        cells: ['c7'],
        state: 'error',
        error: 'The run stopped before this step ended.'
      }
    ]);
  });

  it('draws a record from before 30 September 2026 as one step of its cells, with no answer', () => {
    const run = pastRun('old', {
      question: QUESTION,
      provider: 'claude',
      model: null,
      cost_usd: 0.03,
      cells: ['c7', 'c8'],
      files: [],
      state: 'done',
      at: '2026-09-27T10:00:00.000Z'
    });
    expect(run.steps.map(item => item.cells)).toEqual([['c7', 'c8']]);
    expect(run.answer).toBeNull();
    expect(run.past).toEqual({ at: '2026-09-27T10:00:00.000Z', full: false });
    expect(run.by).toMatchObject({ choice: 'remote', model: null });
  });

  it('lists the runs that go on first, then the newest, each once', () => {
    const record = (at: string): IAgentRunRecord => ({
      question: at,
      provider: null,
      model: null,
      cost_usd: null,
      cells: [],
      files: [],
      state: 'done',
      at
    });
    const shown = pastRun('r2', record('2026-09-30T09:00:00.000Z'));
    const going = {
      ...pastRun('r4', record('2026-09-30T11:00:00.000Z')),
      past: null,
      id: null,
      question: 'going',
      state: 'working'
    } as IAgentRun;
    const rows = historyRows(
      {
        r1: record('2026-09-29T09:00:00.000Z'),
        r2: record('2026-09-30T09:00:00.000Z'),
        r3: record('2026-09-30T10:00:00.000Z')
      },
      [shown, going]
    );
    expect(rows.map(row => row.id ?? row.question)).toEqual([
      'going',
      'r3',
      'r2',
      'r1'
    ]);
    expect(rows[2].live).toBe(shown);
  });

  it('says when a run ended: the time today, the day this year, else the year too', () => {
    const now = new Date(2026, 8, 30, 15, 0);
    expect(runWhen(new Date(2026, 8, 30, 14, 5).toISOString(), now)).toBe(
      new Date(2026, 8, 30, 14, 5).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      })
    );
    expect(runWhen(new Date(2026, 8, 27).toISOString(), now)).not.toMatch(
      /2026/
    );
    expect(runWhen(new Date(2025, 8, 27).toISOString(), now)).toMatch(/2025/);
    expect(runWhen('not a date', now)).toBe('');
  });
});

describe('the history of runs in the view', () => {
  it('keeps the steps and the answer of a run that ends, with its cost and its model', async () => {
    const runs = new AgentRuns();
    const bench = benchModel(CELLS, { runs });
    const { model, run } = await answered(bench);
    const record = recordOf(bench);
    const added = run.steps[0].cells[0];
    expect(record).toMatchObject({
      question: QUESTION,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      cost_usd: 0.05,
      cells: [added],
      state: 'done',
      anchor: 'b',
      answer: ANSWER,
      follow_up: ['causal: Does it hold at each site?'],
      keep_local: false,
      steps: [
        {
          tool: 'run_cell',
          title: 'Mean pain by arm, 12 weeks or more',
          why: 'leave out the short diaries',
          cells: [added],
          state: 'done'
        }
      ]
    });
    // The labels that the answer names, by the cells they named then.
    expect(record.answer_refs).toEqual({ '[3]': added, '[2]': 'b' });
    expect(Date.parse(record.started!)).toBeLessThanOrEqual(
      Date.parse(record.at)
    );
    model.dispose();
  });

  it('lists a closed run, and draws its strip again where it was, in every view', async () => {
    const runs = new AgentRuns();
    const bench = benchModel(CELLS, { runs });
    const other = benchModel([], { runs, view: bench });
    const { model, run } = await answered(bench);
    const added = run.steps[0].cells[0];
    model.dismissAgent(run);
    await settle();
    expect(model.strips.has('b')).toBe(false);
    expect(runs.all).toEqual([]);
    // The run left the list of runs, and the notebook keeps it.
    const rows = model.runHistory();
    expect(rows.map((row: { id: string }) => row.id)).toEqual(['r1']);
    expect(rows[0].live).toBeNull();

    await model.openRun('r1');
    await settle();
    const again = model.strips.get('b');
    expect(again?.agent).toMatchObject({
      id: 'r1',
      question: QUESTION,
      state: 'done',
      answer: ANSWER,
      followUp: ['causal: Does it hold at each site?'],
      past: { full: true }
    });
    expect(again?.agent?.steps[0].cells).toEqual([added]);
    expect(model.stripToShow).toBe('b');
    expect(model.stripIfHidden).toBe(false);
    // The other view of the notebook shows it too, and its × closes it in both.
    expect(other.model.strips.get('b')?.agent).toBe(again?.agent);
    other.model.dismissAgent(again!.agent!);
    await settle();
    expect(model.strips.has('b')).toBe(false);
    // The history still lists it, once.
    expect(model.runHistory()).toHaveLength(1);
    model.dispose();
    other.model.dispose();
  });

  it("shows a closed run's strip with its steps, its answer and when it ended, and no Remove", async () => {
    const runs = new AgentRuns();
    const bench = benchModel(CELLS, { runs });
    const { model, run } = await answered(bench);
    model.dismissAgent(run);
    await model.openRun('r1');
    const again = model.strips.get('b').agent as IAgentRun;
    const view = await mount(
      <AgentRunView model={model} run={again} place="strip" />
    );
    const text = view.host.textContent ?? '';
    const found = {
      status: view.host.querySelector('.jp-Epi-agentrun-status')?.textContent,
      step: view.host.querySelector('.jp-Epi-agentrun-title')?.textContent,
      answer: text.includes('without the short diaries the arm effect'),
      followUp: text.includes('Does it hold at each site?'),
      remove: text.includes('Remove its cells')
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      status: `Answered with 1 cell · ${runWhen(recordOf(bench).at)}`,
      step: 'Mean pain by arm, 12 weeks or more',
      answer: true,
      followUp: true,
      remove: false
    });
  });

  it('outlives the notebook: a notebook opened again from its file lists the run and draws its strip', async () => {
    const runs = new AgentRuns();
    const bench = benchModel(CELLS, { runs });
    const { model, run } = await answered(bench);
    const added = run.steps[0].cells[0];
    const saved = bench.nb.toJSON() as any;
    model.dispose();
    // The notebook closed, and opens again in a new JupyterLab.
    const opened = benchModel(saved, { runs: new AgentRuns() });
    await settle();
    const rows = opened.model.runHistory();
    expect(rows.map(row => [row.id, row.question, row.state])).toEqual([
      ['r1', QUESTION, 'done']
    ]);
    // A cell that the run wrote leads to its run.
    expect(opened.model.runOf(added)).toBe('r1');
    expect(opened.model.runOf('a')).toBeNull();
    await opened.model.openRun('r1');
    expect(opened.model.strips.get('b')?.agent?.answer).toBe(ANSWER);
    opened.model.dispose();
  });

  it('lists the runs in the Exploration panel, folded, and a click on one shows its strip', async () => {
    const scrolled: Element[] = [];
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const runs = new AgentRuns();
    const bench = benchModel(CELLS, { runs });
    const { model, run } = await answered(bench);
    model.dismissAgent(run);
    const doc = await mount(
      <DocumentView
        model={model}
        editorServices={null}
        openFile={() => undefined}
        isVisible={() => true}
      />
    );
    const panel = await mount(<RunsHistory model={model} />);
    try {
      const head = panel.host.querySelector('.jp-Epi-runhistory-head')!;
      expect(head.textContent).toBe('Agent runs1');
      expect(head.getAttribute('aria-expanded')).toBe('false');
      expect(panel.host.querySelector('.jp-Epi-runhistory-row')).toBeNull();
      await step(() => (head as HTMLButtonElement).click());
      const row = panel.host.querySelector('.jp-Epi-runhistory-row')!;
      expect(row.textContent).toContain(QUESTION);
      expect(row.textContent).toContain('Answered with 1 cell');
      expect(row.querySelector('.jp-Epi-runhistory-cell')?.textContent).toBe(
        '[3]'
      );
      expect(doc.host.querySelector('[data-strip-id="b"]')).toBeNull();
      await step(() => button(panel.host, QUESTION).click());
      await settle();
      const strip = doc.host.querySelector('[data-strip-id="b"]');
      expect(strip?.textContent).toContain(ANSWER.slice(0, 20));
      expect(scrolled).toContain(strip);
      expect(strip?.classList.contains('jp-mod-flash')).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
      await panel.unmount();
      await doc.unmount();
      model.dispose();
    }
  });

  it('leads from a cell that a run wrote to its run, in Cell details', async () => {
    const runs = new AgentRuns();
    const bench = benchModel(CELLS, { runs });
    const { model, run } = await answered(bench);
    const added = run.steps[0].cells[0];
    model.dismissAgent(run);
    model.setCurrentCell(added);
    const details = await mount(
      <CellDetails model={model} width={260} editorServices={null} />
    );
    try {
      const link = details.host.querySelector('.jp-Epi-details-run');
      expect(link?.textContent).toBe(
        `In the agent's run for "${QUESTION}". Show the agent's run`
      );
      await step(() => button(details.host, "Show the agent's run").click());
      await settle();
      expect(model.strips.get('b')?.agent?.id).toBe('r1');
      // The analyst's own cell has no run.
      model.setCurrentCell('a');
      await settle();
      expect(details.host.querySelector('.jp-Epi-details-run')).toBeNull();
    } finally {
      await details.unmount();
      model.dispose();
    }
  });

  it('opens a notebook saved before as it did, and lists its runs without steps', async () => {
    const meta = {
      agent_runs: {
        old: {
          question: QUESTION,
          provider: 'claude',
          model: null,
          cost_usd: 0.03,
          cells: ['c'],
          files: [],
          state: 'done',
          at: '2026-09-27T10:00:00.000Z'
        }
      }
    };
    const content = {
      cells: [
        ...CELLS.map(cell => ({
          cell_type: 'code',
          id: cell.id,
          source: cell.source,
          metadata: {},
          execution_count: cell.count,
          outputs: []
        })),
        {
          cell_type: 'code',
          id: 'c',
          source: 'diary.pain.mean()',
          metadata: {
            whybook: { written_by: 'agent', agent: { run: 'old', step: 1 } }
          },
          execution_count: 3,
          outputs: []
        }
      ],
      metadata: { whybook: meta },
      nbformat: 4,
      nbformat_minor: 5
    };
    const opened = benchModel(content as any, { runs: new AgentRuns() });
    await settle();
    // Opening changes nothing in the notebook's metadata.
    expect(opened.nb.getMetadata('whybook')).toEqual(meta);
    expect(opened.model.runHistory().map(row => row.id)).toEqual(['old']);
    expect(opened.model.runOf('c')).toBe('old');
    await opened.model.openRun('old');
    // No cell was about the question: the strip goes with the run's cell.
    const run = opened.model.strips.get('c')?.agent;
    expect(run?.past).toEqual({ at: '2026-09-27T10:00:00.000Z', full: false });
    expect(run?.steps[0].cells).toEqual(['c']);
    const view = await mount(
      <AgentRunView model={opened.model} run={run!} place="strip" />
    );
    const note = view.host.querySelector('.jp-Epi-agentrun-kept')?.textContent;
    await view.unmount();
    opened.model.dispose();
    expect(note).toBe(
      'The notebook kept the cells of this run, not its steps or its answer: it ran before the view kept them.'
    );
  });

  it('opens a run of a notebook that the run made in the notebook where it was asked', async () => {
    const runs = new AgentRuns();
    // The first notebook, where the question was asked, keeps the run.
    const first = benchModel(CELLS, { runs, path: 'study/pain.ipynb' });
    first.nb.setMetadata('whybook', {
      agent_runs: {
        r1: {
          question: 'Would I get the same results in R?',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          cost_usd: 0.41,
          cells: [],
          files: [],
          state: 'done',
          at: '2026-09-30T10:00:00.000Z',
          steps: []
        }
      }
    });
    // The R notebook that the run made keeps it with where it was asked.
    const made = benchModel([{ id: 'r', source: 'mean(1:3)', count: 1 }], {
      runs,
      path: 'study/pain.R.ipynb'
    });
    made.nb.setMetadata('whybook', {
      agent_runs: {
        r1: {
          question: 'Would I get the same results in R?',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          cost_usd: 0.41,
          cells: ['r'],
          files: [],
          state: 'done',
          at: '2026-09-30T10:00:00.000Z',
          steps: [],
          asked_in: 'study/pain.ipynb'
        }
      }
    });
    const shown: string[] = [];
    runs.host = {
      create: jest.fn(),
      show: jest.fn(async (path: string) => {
        shown.push(path);
      }),
      modelOf: (path: string) =>
        path === 'study/pain.ipynb' ? first.model : null,
      remove: jest.fn()
    };
    expect(made.model.runHistory()[0].record?.asked_in).toBe(
      'study/pain.ipynb'
    );
    await made.model.openRun('r1');
    expect(shown).toEqual(['study/pain.ipynb']);
    // The strip shows in the first notebook, at its end: no cell of it is
    // the run's, and none is here.
    expect(made.model.agentRuns).toEqual([]);
    const run = first.model.agentRuns[0];
    expect(run?.question).toBe('Would I get the same results in R?');
    expect(run?.stripId.startsWith('end:')).toBe(true);
    expect(first.model.strips.get(run!.stripId)?.agent).toBe(run);
    first.model.dispose();
    made.model.dispose();
  });

  it('keeps what it kept before, and shows no history, with the setting off', async () => {
    const runs = new AgentRuns();
    runs.history = false;
    const bench = benchModel(CELLS, { runs });
    const { model, run } = await answered(bench);
    const added = run.steps[0].cells[0];
    expect(Object.keys(recordOf(bench)).sort()).toEqual([
      'at',
      'cells',
      'cost_usd',
      'files',
      'model',
      'provider',
      'question',
      'seconds',
      'state'
    ]);
    model.setCurrentCell(added);
    const details = await mount(
      <CellDetails model={model} width={260} editorServices={null} />
    );
    const link = details.host.querySelector('.jp-Epi-details-run');
    await details.unmount();
    model.dispose();
    expect(link).toBeNull();
  });
});
