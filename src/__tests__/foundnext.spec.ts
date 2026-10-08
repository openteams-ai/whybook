/**
 * "Worth asking next" asks about the library defaults that a model found
 * (design iteration 1.53) as soon as they are in. It was fetched again only
 * at the next change in the kernel, so the questions about the found
 * defaults waited for the analyst to run a cell (the report of the builder
 * of design iterations 1.91 and 1.92).
 */
import './fakes/quiet';

import type { Signal } from '@lumino/signaling';

import type { IFunctionPicks, ISignature } from '../model/founddefaults';
import type { KernelBridge } from '../model/kernel';
import type { ICellAnalysis } from '../tokens';
import { benchModel } from './fakes/bench-fake';

/** `totals = df.groupby("g")["v"].sum()`, as the kernel lists it. */
const GROUPBY: ISignature = {
  function: 'pandas.core.frame.DataFrame.groupby',
  name: 'DataFrame.groupby',
  module: 'pandas.core.frame',
  library: 'pandas',
  version: '3.0.6',
  params: [
    { name: 'sort', default: 'True' },
    { name: 'dropna', default: 'True' }
  ],
  calls: [{ line: 1, col: 12, target: 'df', defaulted: ['sort', 'dropna'] }]
};

const PICKS: IFunctionPicks = {
  picks: [
    {
      param: 'dropna',
      why: 'Rows whose key is missing are left out of the groups.'
    }
  ],
  by: { choice: 'remote', model: 'fake-model', at: '2026-10-07T09:00:00Z' }
};

const ANALYSIS: ICellAnalysis = {
  defs: ['totals'],
  uses: ['df'],
  formulas: [],
  columns: {},
  decisions: [],
  attachments: []
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * A view of one cell whose kernel analysis has come, with the server's
 * answer about the cell's function held until `answer` is called, and the
 * decisions that each request of "Worth asking next" sent with the cell.
 */
async function analysed() {
  const source = 'totals = df.groupby("g")["v"].sum()';
  const { model } = benchModel([{ id: 'g', source, count: 1 }]);
  (model.bridge as any)._snapshot = { variables: [], packages: {} };
  // The request of the fake for the status fails; then the server answers
  // one: the view asks for questions.
  await jest.advanceTimersByTimeAsync(100);
  (model as any).status = { claude_available: false };
  jest.spyOn(model.bridge, 'freshAnalysis').mockReturnValue(ANALYSIS);
  jest.spyOn(model.bridge, 'signaturesOf').mockReturnValue([GROUPBY]);
  let answer: (kept: unknown) => void = () => undefined;
  jest.spyOn(model.api, 'libraryDefaults').mockReturnValue(
    new Promise(resolve => {
      answer = resolve;
    }) as any
  );
  const next = jest
    .spyOn(model.api, 'next')
    .mockResolvedValue({ questions: [] } as any);
  const sent = () =>
    next.mock.calls.map(([body]: any[]) =>
      body.cells[0].decisions.map((decision: { name: string }) => decision.name)
    );
  // The kernel's analysis of the cell came: the list is asked for, and the
  // server is asked for the answers that it kept.
  (model.bridge.changed as Signal<KernelBridge, string>).emit('analysis');
  await jest.advanceTimersByTimeAsync(2000);
  return { model, answer, sent };
}

it('fetches Worth asking next again when the defaults that a model found come in', async () => {
  const { model, answer, sent } = await analysed();
  expect(sent()).toEqual([[]]);
  answer({
    answers: [
      {
        function: GROUPBY.function,
        library: GROUPBY.library,
        version: GROUPBY.version,
        picks: PICKS.picks,
        by: PICKS.by
      }
    ]
  });
  await jest.advanceTimersByTimeAsync(2000);
  // The cell shows the default, and the list is asked for again, with it.
  expect(sent()).toEqual([[], ['dropna']]);
  model.dispose();
});

it('does not fetch it again when the server kept no answer, and no default changed', async () => {
  const { model, answer, sent } = await analysed();
  answer({ answers: [] });
  await jest.advanceTimersByTimeAsync(2000);
  expect(sent()).toEqual([[]]);
  model.dispose();
});
