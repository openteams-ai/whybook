/**
 * One user question that lists alternatives, several branches (design
 * iteration 1.126): the model of More questions writes the question of each
 * branch, once per text, and the branches start side by side as the checked
 * options of a drop do. With them, three faults of the branches of a drop:
 * parallel branches need a cell, every checked row of a checklist shows, and
 * a branch keeps its own strip while another answer of its cell is written.
 */
import './fakes/quiet';

import type { IServerStatus } from '../model/api';
import { DEFAULT_MODELS } from '../model/models';
import { ownOption } from '../model/own';
import { requestAPI, streamAPI } from '../request';
import type { IPlacement } from '../tokens';
import { checklistRows } from '../ui/variables';
import { benchModel } from './fakes/bench-fake';
import { settle } from './fakes/bench-render';

jest.mock('../request', () => ({
  requestAPI: jest.fn(),
  streamAPI: jest.fn()
}));

const request = requestAPI as jest.Mock;
const stream = streamAPI as jest.Mock;

// A model is connected, so that a branch's cell waits for it to write.
const STATUS: IServerStatus = {
  ranker: 'heuristic',
  claude_available: true,
  claude: {
    available: true,
    cli: null,
    credential: 'OpenRouter',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5',
    label: 'OpenRouter: anthropic/claude-sonnet-5',
    local: false,
    priced: false,
    reason: null,
    setup: null
  },
  describe_tables: true,
  remote_model: 'OpenRouter: anthropic/claude-sonnet-5',
  local_models: [
    {
      id: 'gemma-4-e2b',
      label: 'Gemma 4 E2B',
      kind: 'local',
      tier: 'recommended',
      size_mb: 2841,
      note: '',
      repo: null,
      available: true,
      reason: null,
      downloadable: false
    }
  ]
};

const SOURCE = 'fit = smf.ols("pain ~ arm", data).fit()';
const QUESTION = 'What is the impact of adjusting for sleep_hours or mood?';
const BRANCHES = [
  'What is the impact of adjusting for sleep_hours?',
  'What is the impact of adjusting for mood?'
];

/** The bodies of the requests to split a question, in order. */
let splits: Record<string, unknown>[] = [];
let splitFails = false;

beforeEach(() => {
  splits = [];
  splitFails = false;
  request.mockReset();
  request.mockImplementation(
    async (route: string, _settings: unknown, init?: RequestInit) => {
      if (route === 'status') {
        return STATUS;
      }
      if (route === 'questions/split') {
        splits.push(JSON.parse(String(init?.body)));
        if (splitFails) {
          throw new Error('the model is down');
        }
        return { branches: BRANCHES, model: 'Gemma 4 E2B', elapsed: 1.2 };
      }
      if (route === 'dependencies') {
        // The cell needs no other cell first.
        return { cells: [], unresolved: [] };
      }
      return {};
    }
  );
  stream.mockReset();
  // A model that writes a cell never answers: the cells stay as placed.
  stream.mockImplementation(() => new Promise(() => undefined));
});

/** A view model of one code cell, about which a request is open, with a local model for More questions. */
async function view() {
  const { model, nb } = benchModel([{ id: 'a', source: SOURCE, count: 1 }]);
  await settle();
  model.settings.models = { ...DEFAULT_MODELS, questions: 'gemma-4-e2b' };
  model.ask = {
    kind: 'cells',
    id: 1,
    anchor: null,
    loading: false,
    error: null,
    cells: ['a'],
    options: []
  } as any;
  return { model, nb };
}

function place(model: any, kind: string): IPlacement {
  return model.ownPlaces().find((found: IPlacement) => found.kind === kind)!;
}

describe('the branches of a user question', () => {
  it('asks the model of More questions for the question of each branch, once per text, with its cell', async () => {
    const { model } = await view();
    const places = model.ownPlaces();
    const asking = model.splitOwn(QUESTION, places);
    expect(model.ownSplit(QUESTION)).toEqual({
      branches: null,
      by: null,
      splitting: true,
      failed: false
    });
    await asking;
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({
      text: QUESTION,
      model: 'gemma-4-e2b',
      cell: SOURCE
    });
    expect(model.ownSplit(QUESTION)).toEqual({
      branches: BRANCHES,
      by: 'Gemma 4 E2B',
      splitting: false,
      failed: false
    });
    await model.splitOwn(QUESTION, places);
    expect(splits).toHaveLength(1);
    model.dispose();
  });

  it('marks a split that failed, so that the box asks the question as one', async () => {
    const { model } = await view();
    splitFails = true;
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    await model.splitOwn(QUESTION, model.ownPlaces());
    expect(model.ownSplit(QUESTION)).toEqual({
      branches: null,
      by: null,
      splitting: false,
      failed: true
    });
    warn.mockRestore();
    model.dispose();
  });

  it('starts a branch of the cell for each question, side by side, with the labels that the box showed', async () => {
    const { model } = await view();
    expect(model.branchLabels('a', 2)).toEqual(['[1b]', '[1c]']);
    void model.askOwn(QUESTION, 'request', { branches: BRANCHES });
    await settle();
    const added = model
      .cells()
      .filter((cell: any) => cell.branchOf === 'a')
      .map((cell: any) => [cell.meta.branch?.letter, cell.meta.title]);
    expect(added).toEqual([
      ['b', BRANCHES[0]],
      ['c', BRANCHES[1]]
    ]);
    expect(model.parallel.get('a')).toHaveLength(2);
    expect(model.ask).toBeNull();
    model.dispose();
  });

  it('adds the branches to the checklist of an Alt+drop, checked, and starts none', async () => {
    const { model } = await view();
    const item = { kind: 'variable', name: 'mood', label: 'mood' } as any;
    const checklist = {
      kind: 'drop',
      id: 2,
      anchor: null,
      loading: false,
      error: null,
      source: item,
      target: { cellId: 'a' },
      modifiers: { branch: false, parallel: true },
      result: { mode: 'parallel', options: [], placements: [] },
      checked: [],
      claudeStage: null
    } as any;
    model.ask = checklist;
    await model.askOwn(QUESTION, 'request', { branches: BRANCHES });
    expect(model.ask).toBe(checklist);
    expect(checklist.result.options.map((option: any) => option.text)).toEqual(
      BRANCHES
    );
    expect(checklist.checked).toEqual(
      checklist.result.options.map((option: any) => option.id)
    );
    expect(model.cells().filter((cell: any) => cell.branchOf)).toEqual([]);
    model.dispose();
  });
});

describe('the names that a question can list', () => {
  it("holds the kernel's variables and their columns, by the name that a question writes", async () => {
    const { model } = await view();
    model.variables = () =>
      [
        {
          name: 'diary',
          columns: [{ name: "diary['mood']", label: 'mood' }]
        }
      ] as any;
    expect(model.notebookNames().sort()).toEqual(
      ['diary', "diary['mood']", 'mood'].sort()
    );
    model.dispose();
  });
});

describe('the branches of a drop', () => {
  it('asks a drop onto a variable as one question: parallel branches need a cell', async () => {
    const { model } = await view();
    const item = { kind: 'variable', name: 'fit', label: 'fit' } as any;
    void model.askDrop(item, { item }, { branch: false, parallel: true }, null);
    expect((model.ask as any).modifiers.parallel).toBe(false);
    void model.askDrop(
      item,
      { cellId: 'a' },
      { branch: false, parallel: true },
      null
    );
    expect((model.ask as any).modifiers.parallel).toBe(true);
    model.dispose();
  });

  it('shows every checked row of a checklist, past the offered questions too', () => {
    const options = ['q1', 'q2', 'q3', 'q4'].map(id =>
      ownOption(id, null, 'descriptive')
    );
    const first = options.slice(0, 2);
    expect(
      checklistRows(first, options, [options[1].id, options[3].id]).map(
        option => option.text
      )
    ).toEqual(['q1', 'q2', 'q4']);
    expect(checklistRows(first, options, []).map(o => o.text)).toEqual([
      'q1',
      'q2'
    ]);
  });

  it('keeps the strip of each branch while another answer of the cell is written', async () => {
    const { model } = await view();
    const branch = place(model, 'branch');
    void model.apply(ownOption('Try a log scale', branch), branch);
    void model.apply(ownOption('Try a square root', branch), branch);
    await settle();
    const texts = Array.from(model.strips.values()).map(
      (strip: any) => strip.text
    );
    expect(texts.sort()).toEqual(['Try a log scale', 'Try a square root']);
    model.dispose();
  });
});
