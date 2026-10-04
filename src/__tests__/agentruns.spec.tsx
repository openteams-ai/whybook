/**
 * An agent's run that goes on after its Whybook view closes (design
 * iteration 1.56, src/model/runs.ts). The run belongs to its notebook: every
 * view of the notebook shows its strip, a view opened again finds it,
 * JupyterLab's Running panel lists it with Stop, and a status bar item
 * counts the runs that go on.
 */
import './fakes/quiet';

import * as React from 'react';
import { NotebookModel } from '@jupyterlab/notebook';
import { Signal } from '@lumino/signaling';

import type { IAgentEvent, IAgentRun } from '../model/agent';
import type { IStrip } from '../model/epimodel';
import type { IRunEntry } from '../model/runs';
import { AgentRuns, runTime } from '../model/runs';
import { DocumentView } from '../ui/document';
import { RunsSection, RunsStatus, runItem, runsTitle } from '../ui/runs';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

const QUESTION = 'Does the arm effect hold without the short diaries?';

const CELLS = [
  { id: 'a', source: 'import pandas as pd', count: 1 },
  { id: 'b', source: 'diary = pd.read_csv("diary.csv")', count: 2 }
];

/** A strip as the view makes it for a question about cell `a`. */
function stripOf(cellId = 'a'): IStrip {
  return {
    cellId,
    question: { id: 'q1', text: QUESTION, type: 'causal' },
    guess: null,
    text: QUESTION,
    action: 'New cell after [1]',
    placement: { kind: 'new', cell: cellId, label: 'new cell after [1]' },
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
 * Start an agent's run in a view, as the strip of a question does, with a
 * stream that the test feeds. A tool call runs its cell at once.
 */
async function startRun(model: any) {
  const posted: Record<string, unknown>[] = [];
  const stream: {
    signal: AbortSignal | null;
    deliver: (event: IAgentEvent | Record<string, unknown>) => void;
    finish: () => void;
  } = { signal: null, deliver: () => undefined, finish: () => undefined };
  model.aiReady = () => true;
  model._run = async () => ({ ok: true, error: null });
  model.refresh = async () => undefined;
  model.api = {
    agent: (
      _body: unknown,
      onEvent: (event: unknown) => void,
      signal: AbortSignal
    ) => {
      stream.signal = signal;
      stream.deliver = onEvent;
      return new Promise<void>((resolve, reject) => {
        stream.finish = resolve;
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
  const strip = stripOf();
  model.strips.set('a', strip);
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
    model.cell('a'),
    strip,
    null,
    async () => undefined
  );
  await settle();
  stream.deliver({ type: 'started', run: 'r1', keep_local: false });
  await settle();
  return { stream, posted, ending, strip, run: strip.agent as IAgentRun };
}

const TOOL = {
  type: 'tool',
  run: 'r1',
  call: 'c1',
  name: 'run_cell',
  input: {
    code: 'weeks = diary.groupby("patient_id").size()',
    title: 'Diary weeks per patient',
    why: ''
  }
};

describe('the list of runs', () => {
  function entryOf(nb: NotebookModel, path = 'study/pain.ipynb') {
    const disposed = new Signal<unknown, void>({});
    const run = {
      id: 'r1',
      stripId: 'a',
      question: QUESTION,
      anchor: 'a',
      state: 'working',
      steps: [],
      notes: [],
      thinking: null,
      answer: null,
      answerCells: [],
      followUp: [],
      by: null,
      costUsd: null,
      error: null,
      started: Date.now() - 41000,
      keepLocal: false
    } as IAgentRun;
    const entry: IRunEntry = {
      run,
      strip: stripOf(),
      context: { path, model: nb, disposed, isDisposed: false } as any,
      stop: jest.fn(),
      owner: {}
    };
    return { entry, disposed, run };
  }

  it('keeps the runs of each notebook, and lets them go when it closes', async () => {
    const runs = new AgentRuns();
    const one = new NotebookModel();
    const two = new NotebookModel();
    const first = entryOf(one);
    const second = entryOf(two, 'other.ipynb');
    let changes = 0;
    runs.changed.connect(() => changes++);
    runs.add(first.entry);
    runs.add(second.entry);
    // Once for the changes of a moment.
    await settle();
    expect(changes).toBe(1);
    expect(runs.of(one)).toEqual([first.entry]);
    expect(runs.going()).toEqual([first.entry, second.entry]);
    runs.stop(first.run);
    expect(first.entry.stop).toHaveBeenCalled();
    // The first notebook closes in every view.
    (first.entry.context as any).isDisposed = true;
    first.disposed.emit();
    await settle();
    expect(runs.all).toEqual([second.entry]);
    expect(changes).toBe(2);
    second.run.state = 'done';
    expect(runs.going()).toEqual([]);
    runs.remove(second.run);
    expect(runs.all).toEqual([]);
  });

  it('says how long a run has gone on', () => {
    const run = { started: 0 } as IAgentRun;
    expect(runTime(run, 41000)).toBe('41 s');
    expect(runTime(run, 185000)).toBe('3 min 5 s');
    expect(runTime(run, 120000)).toBe('2 min');
  });
});

describe('a run whose view closes while its notebook stays open', () => {
  it('shows its strip in a view opened again on the notebook', async () => {
    const runs = new AgentRuns();
    const first = benchModel(CELLS, { runs });
    const { stream, posted, run, strip } = await startRun(first.model);
    // The analyst closes the view; the notebook stays open elsewhere.
    first.model.dispose();
    const again = benchModel([], { runs, view: first });
    expect(again.model.strips.get('a')).toBe(strip);
    expect(again.model.agentRuns).toEqual([run]);
    // The view that started the run still runs its tool calls: its cell
    // shows in the notebook, and the new view draws the step.
    stream.deliver(TOOL);
    for (let i = 0; i < 50 && !posted.length; i++) {
      await settle(10);
    }
    expect(posted).toHaveLength(1);
    expect(again.model.agentRunAt('a')?.steps).toHaveLength(1);
    expect(again.model.cells().map(cell => cell.id)).toHaveLength(3);
    // Stop in the new view stops the run where it runs.
    again.model.stopAgent(run);
    expect((first.model.api as any).agentStop).toHaveBeenCalledWith('r1');
    expect(run.state).toBe('stopped');
    again.model.dispose();
  });

  it('closes the strip in every view of the notebook', async () => {
    const runs = new AgentRuns();
    const first = benchModel(CELLS, { runs });
    const second = benchModel([], { runs, view: first });
    const { stream, run, ending } = await startRun(first.model);
    await settle();
    expect(second.model.agentRuns).toEqual([run]);
    stream.deliver({ type: 'result', answer: 'Yes.', cells: [] });
    await settle();
    stream.finish();
    await ending;
    second.model.dismissAgent(run);
    await settle();
    expect(first.model.strips.has('a')).toBe(false);
    expect(first.model.agentRuns).toEqual([]);
    expect(runs.all).toEqual([]);
    first.model.dispose();
    second.model.dispose();
  });

  it('brings the strip into sight when the Running panel opens the view on it', async () => {
    const scrolled: Element[] = [];
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const runs = new AgentRuns();
    const first = benchModel(CELLS, { runs });
    const { run } = await startRun(first.model);
    first.model.dispose();
    const again = benchModel([], { runs, view: first });
    const view = await mount(
      <DocumentView
        model={again.model}
        editorServices={null}
        openFile={() => undefined}
        isVisible={() => true}
      />
    );
    again.model.showRun(run);
    await settle();
    const shown = view.host.querySelector('[data-strip-id="a"]');
    const found = {
      strip: !!shown,
      scrolled: !!shown && scrolled.includes(shown),
      taken: again.model.stripToShow
    };
    await view.unmount();
    Element.prototype.scrollIntoView = scrollIntoView;
    again.model.dispose();
    expect(found).toEqual({ strip: true, scrolled: true, taken: null });
  });
});

describe("the Running panel's section and the status bar item", () => {
  function listed() {
    const runs = new AgentRuns();
    const nb = new NotebookModel();
    const run = {
      id: 'r1',
      stripId: 'a',
      question: QUESTION,
      anchor: 'a',
      state: 'working',
      steps: [
        {
          call: 'c1',
          tool: 'run_cell',
          title: 'Diary weeks',
          why: '',
          cells: ['c7'],
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
      started: 1000,
      keepLocal: false
    } as IAgentRun;
    const entry: IRunEntry = {
      run,
      strip: stripOf(),
      context: {
        path: 'pain_diary/pain_diary_cohort.ipynb',
        model: nb,
        isDisposed: false
      } as any,
      stop: jest.fn(),
      owner: {}
    };
    runs.add(entry);
    return { runs, run, entry };
  }

  it('lists a run with its notebook, its cells so far, the time and its question', async () => {
    const { runs, run, entry } = listed();
    const item = runItem(entry, runs, 42000);
    const label = item.label() as React.ReactElement;
    expect(label.props.children).toBe('pain_diary_cohort.ipynb');
    expect(item.detail?.()).toBe('1 cell · 41 s');
    expect(item.labelTitle?.()).toBe(
      `An agent answers "${QUESTION}" in pain_diary/pain_diary_cohort.ipynb: 1 cell so far. Click to open the run in Whybook.`
    );
    expect(item.children?.map(child => child.label())).toEqual([QUESTION]);
    // Stop, as the strip's Stop does.
    item.shutdown?.();
    expect(entry.stop).toHaveBeenCalledTimes(1);
    // A click on the notebook or on the question opens the Whybook view on
    // the run's strip. A click on the notebook does not reach the panel,
    // which would fold the question away.
    const opened: IAgentRun[] = [];
    runs.opener = async found => {
      opened.push(found.run);
    };
    const click = { stopPropagation: jest.fn() };
    label.props.onClick(click);
    item.children?.[0].open?.();
    await settle();
    expect(opened).toEqual([run, run]);
    expect(click.stopPropagation).toHaveBeenCalled();
  });

  it('lists only the runs that go on, and stops them all', async () => {
    const { runs, run, entry } = listed();
    const section = new RunsSection(runs);
    let changes = 0;
    section.runningChanged.connect(() => changes++);
    expect(section.name).toBe('Agent runs');
    expect(section.running()).toHaveLength(1);
    section.shutdownAll();
    expect(entry.stop).toHaveBeenCalledTimes(1);
    run.state = 'stopped';
    runs.touch();
    await settle();
    expect(changes).toBeGreaterThan(0);
    expect(section.running()).toEqual([]);
  });

  it('counts the runs in the status bar, and opens the Running panel on a click', () => {
    const { runs } = listed();
    expect(runsTitle(runs)).toBe(
      'An agent works in pain_diary_cohort.ipynb: 1 cell so far. Click to open the Running panel, which lists the runs with Stop.'
    );
    const open = jest.fn();
    const item = new RunsStatus(runs, open);
    item.node.click();
    expect(open).toHaveBeenCalledTimes(1);
    item.dispose();
  });
});
