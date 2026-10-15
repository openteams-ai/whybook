/**
 * The type and the place of a question typed in a "Your own question" box,
 * from the model chosen for user questions. A decision model, local or
 * remote, reads every question, and its type comes before the keywords'.
 * Another local model reads a question only when no keyword matches. The
 * place of a decision model is a suggestion under the box, and only when the
 * first words give no place.
 */
import './fakes/quiet';

import type { IServerStatus, ISortedQuestion } from '../model/api';
import { DEFAULT_MODELS } from '../model/models';
import { requestAPI, streamAPI } from '../request';
import type { IPlacement } from '../tokens';
import { benchModel } from './fakes/bench-fake';
import { settle } from './fakes/bench-render';

jest.mock('../request', () => ({
  requestAPI: jest.fn(),
  streamAPI: jest.fn()
}));

const request = requestAPI as jest.Mock;
const stream = streamAPI as jest.Mock;

const LOCAL = {
  kind: 'local' as const,
  note: '',
  repo: null,
  available: true,
  reason: null,
  downloadable: false
};

const STATUS: IServerStatus = {
  ranker: 'heuristic',
  claude_available: false,
  describe_tables: true,
  remote_model: null,
  local_models: [
    {
      ...LOCAL,
      id: 'gemma-4-e2b',
      label: 'Gemma 4 E2B',
      tier: 'recommended',
      size_mb: 2841
    },
    {
      ...LOCAL,
      id: 'jevk5-4b',
      label: 'JevK5 v0.3 (4B)',
      tier: 'decision',
      size_mb: 2709,
      tasks: ['typed', 'ranking'],
      decision: true
    }
  ],
  decision_models: {
    'solar-decide': {
      label: 'Solar Decide by Upstage',
      available: true,
      reason: null
    }
  }
};

const PLACES: IPlacement[] = [
  { kind: 'new', cell: 'a', label: 'new cell after [1]' },
  { kind: 'edit', cell: 'a', label: 'edit [1] in place' },
  { kind: 'branch', cell: 'a', label: 'branch of [1] · runs in parallel' },
  { kind: 'preview', cell: null, label: 'a preview in the sidebar' }
];

const SOURCE = 'pain = pd.read_csv("pain.csv")';

/** The bodies of the requests to sort a question, in order. */
let asked: Record<string, unknown>[] = [];
/** What the server answers to a request to sort a question. */
let answer: ISortedQuestion;

beforeEach(() => {
  asked = [];
  request.mockReset();
  request.mockImplementation(
    async (route: string, _settings: unknown, init?: RequestInit) => {
      if (route === 'status') {
        return STATUS;
      }
      if (route === 'questions/sort') {
        asked.push(JSON.parse(String(init?.body)));
        return answer;
      }
      return {};
    }
  );
  stream.mockReset();
  stream.mockResolvedValue(undefined);
});

/** A view model of one cell, with the server's status read, and this model for user questions. */
async function viewWith(typed: string) {
  const { model } = benchModel([{ id: 'a', source: SOURCE }]);
  await settle();
  model.settings.models = { ...DEFAULT_MODELS, typed };
  return model;
}

describe('a user question, with a decision model', () => {
  it('asks a local decision model for every question, and takes its type before the keywords', async () => {
    const model = await viewWith('jevk5-4b');
    answer = {
      type: {
        choice: 'descriptive',
        probabilities: { descriptive: 0.7, quality: 0.3 }
      },
      place: { choice: 'branch', probabilities: { branch: 0.6, new: 0.4 } },
      model: 'JevK5 v0.3 (4B)',
      elapsed: 7.5,
      cost_usd: 0
    };
    const question = 'How many values of pain are missing?';
    // Until the model answers, the keywords give the type.
    expect(model.ownType(question)).toEqual({
      type: 'quality',
      by: null,
      probability: null
    });
    await model.sortOwn(question, PLACES);
    expect(asked).toEqual([
      {
        text: question,
        model: 'jevk5-4b',
        cell: SOURCE,
        places: ['new', 'edit', 'branch', 'preview']
      }
    ]);
    expect(model.ownType(question)).toEqual({
      type: 'descriptive',
      by: 'JevK5 v0.3 (4B)',
      probability: 0.7
    });
    // Its place is a suggestion under the box, as a remote decision model's is.
    expect(model.ownPlace(question, PLACES).suggestion).toEqual({
      place: PLACES[2],
      by: 'JevK5 v0.3 (4B)'
    });
    // A text is asked once.
    await model.sortOwn(question, PLACES);
    expect(asked).toHaveLength(1);
    model.dispose();
  });

  it('marks a question as read while its request is on its way, and not once the request fails', async () => {
    const model = await viewWith('jevk5-4b');
    let release: () => void = () => undefined;
    request.mockImplementation(async (route: string) => {
      if (route === 'questions/sort') {
        await new Promise<void>(resolve => {
          release = resolve;
        });
        throw new Error('the model is down');
      }
      return route === 'status' ? STATUS : {};
    });
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const question = 'What is the typical pain score at each site?';
    const sorting = model.sortOwn(question, PLACES);
    expect(model.ownSorting(question)).toBe(true);
    release();
    await sorting;
    expect(model.ownSorting(question)).toBe(false);
    warn.mockRestore();
    model.dispose();
  });

  it("asks a general local model about every question, and its type replaces the keywords'", async () => {
    const model = await viewWith('gemma-4-e2b');
    answer = {
      type: { choice: 'association', probabilities: { association: 0.6 } },
      place: null,
      model: 'Gemma 4 E2B'
    };
    const keyword = 'How many values of pain are missing?';
    // Until the model answers, the keywords give the type.
    expect(model.ownType(keyword).type).toBe('quality');
    await model.sortOwn(keyword, PLACES);
    const question = 'What is the typical pain score at each site?';
    await model.sortOwn(question, PLACES);
    expect(asked.map(body => body.text)).toEqual([keyword, question]);
    for (const text of [keyword, question]) {
      expect(model.ownType(text)).toEqual({
        type: 'association',
        by: 'Gemma 4 E2B',
        probability: 0.6
      });
    }
    model.dispose();
  });

  it("suggests a decision model's prediction of the place whenever it differs from the button, which the first words set", async () => {
    const model = await viewWith('decision:solar-decide');
    answer = {
      type: { choice: 'descriptive', probabilities: { descriptive: 0.9 } },
      place: { choice: 'branch', probabilities: { branch: 0.8, new: 0.2 } },
      model: 'Solar Decide by Upstage'
    };
    const question = 'What is the typical pain score at each site?';
    // Before the model answers, no suggestion: the first words give none.
    expect(model.ownPlace(question, PLACES).suggestion).toBeNull();
    await model.sortOwn(question, PLACES);
    expect(model.ownPlace(question, PLACES)).toEqual({
      place: PLACES[0],
      suggestion: { place: PLACES[2], by: 'Solar Decide by Upstage' }
    });
    // The first words set Edit on the button, and the model's branch is still offered.
    const edit = 'Add age to the table';
    await model.sortOwn(edit, PLACES);
    expect(model.ownPlace(edit, PLACES)).toEqual({
      place: PLACES[1],
      suggestion: { place: PLACES[2], by: 'Solar Decide by Upstage' }
    });
    // Words of a quick look suggest a preview until the model answers; then its prediction does.
    const look = 'Show the first rows';
    expect(model.ownPlace(look, PLACES)).toEqual({
      place: PLACES[0],
      suggestion: { place: PLACES[3], by: null }
    });
    await model.sortOwn(look, PLACES);
    expect(model.ownPlace(look, PLACES).suggestion).toEqual({
      place: PLACES[2],
      by: 'Solar Decide by Upstage'
    });
    // A prediction that the button already shows is no suggestion.
    answer = {
      ...answer,
      place: { choice: 'edit', probabilities: { edit: 0.9 } }
    };
    const again = 'Add sex to the table';
    await model.sortOwn(again, PLACES);
    expect(model.ownPlace(again, PLACES)).toEqual({
      place: PLACES[1],
      suggestion: null
    });
    model.dispose();
  });
});
