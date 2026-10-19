/**
 * A column whose key in its frame is not a string: the column 0 of
 * `pd.DataFrame(array)`, which the kernel lists with the label "0" and the
 * key 0. The server gets the key of each such column of a frame, and the
 * cell that leaves out rows of a quick look names the column by its key.
 */
import { prepareVariable } from '../model/kernel';
import type { IVariable } from '../tokens';
import { benchModel } from './fakes/bench-fake';

const X: IVariable = {
  name: 'X',
  label: 'X',
  kind: 'dataframe',
  type: 'pandas.DataFrame',
  rows: 30,
  n_columns: 2,
  columns: [
    { name: '', label: '0', parent: '', kind: 'numeric', tag: 'num', key: 0 },
    { name: '', label: 'age', parent: '', kind: 'numeric', tag: 'int' }
  ]
};

/** A view of a notebook whose kernel lists X. */
function modelWithX() {
  const { model } = benchModel([
    { id: 'load', source: 'X = pd.DataFrame(array)', count: 1 }
  ]);
  (model.sessionContext as any).session = { kernel: {} };
  (model.bridge as any)._snapshot = {
    variables: [prepareVariable(X)],
    packages: {}
  };
  return model;
}

describe('a column whose key in its frame is not a string', () => {
  it('goes to the server with its key, beside the tags of the columns', () => {
    const model = modelWithX();
    expect((model.serverContext().frames as any).X).toEqual({
      rows: 30,
      columns: { 0: 'num', age: 'int' },
      keys: { 0: 0 }
    });
    model.dispose();
  });

  it('is named by its key in the cell that leaves out rows of its quick look', async () => {
    const model = modelWithX();
    model.preview = {
      title: 'Summarise 0: distribution and missingness',
      code: 'whybook.summary(X, 0)',
      status: 'done',
      stage: null,
      elapsed: null,
      started: 1,
      thinking: null,
      outputs: [],
      error: null,
      option: {
        id: 'quick',
        text: 'Summarise 0: distribution and missingness',
        type: 'descriptive',
        origin: 'template',
        variables: ['X[0]'],
        probability: null,
        reasons: [],
        placement: null,
        code: null
      }
    };
    const apply = jest.spyOn(model, 'apply').mockResolvedValue(undefined);
    jest.spyOn(model, 'select').mockImplementation(() => undefined);
    await model.leaveOutRows(
      {
        frame: 'X',
        column: '0',
        rows: 30,
        lowest: [{ value: '-2.5', rows: 1 }],
        highest: [{ value: '2.5', rows: 1 }]
      },
      { low: 0, high: null }
    );
    const code = apply.mock.calls[0][0].code!;
    model.dispose();
    expect(code).toContain('\n__0_left_out = (X[0] <= -2.5)\n');
    expect(code).toContain('\nX_clean = X[~__0_left_out].copy()\n');
  });
});
