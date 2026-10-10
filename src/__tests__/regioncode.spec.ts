/**
 * The code and the words of a region brushed in a plot (src/model/epimodel.ts):
 * the rows that Keep selection keeps, the names that the code writes, and the
 * bounds that the questions show.
 */
import './fakes/quiet';

import type { IRegionAsk } from '../model/epimodel';
import { regionWhere } from '../model/epimodel';
import { pyComment } from '../model/pycode';
import type { IOption } from '../tokens';
import { fakeModel } from './fakes/model-fake';

function regionAsk(options: {
  x?: string;
  x0: number;
  x1: number;
  y?: string;
  ys?: [number, number];
  by?: string;
}): IRegionAsk {
  const x = options.x ?? 'p';
  const y = options.y ?? null;
  return {
    kind: 'region',
    id: 1,
    anchor: null,
    loading: false,
    error: null,
    cellId: 'c1',
    plot: {
      version: 1,
      kind: 'scatter',
      title: 'p against week',
      x: { field: x, label: x },
      y: { field: y ?? 'week', label: y ?? 'week' },
      source: { frame: 'df', x, y, by: options.by ?? null, rows: 5 }
    },
    x0: options.x0,
    x1: options.x1,
    values: null,
    y: options.ys ?? null,
    summary: { rows: 3, total_rows: 5, where: '', groups: [], seen: '' },
    options: []
  } as unknown as IRegionAsk;
}

/** The option that Keep selection applies. */
function kept(ask: IRegionAsk): IOption {
  const { model } = fakeModel([{ id: 'c1', count: 1 }]);
  const applied: IOption[] = [];
  model.apply = async (option: IOption) => {
    applied.push(option);
  };
  model.select = () => undefined;
  model.keepSelection(ask);
  return applied[0];
}

describe('Keep selection', () => {
  it('keeps the rows between the bounds that were brushed', () => {
    // df.p = [0.001, 0.002, 0.003, 0.004, 0.02]: the summary counted 3 rows.
    const option = kept(regionAsk({ x0: 0.0012, x1: 0.0048 }));
    expect(option.code!.split('\n')[0]).toBe(
      'sel_p0_0012_0_0048 = df[df["p"].between(0.0012, 0.0048)].copy()'
    );
    expect(option.text).toBe(
      'Keep 0.0012 <= p <= 0.0048 of df as sel_p0_0012_0_0048'
    );
  });

  it('writes the bounds at full precision, and shows them rounded', () => {
    const option = kept(regionAsk({ x0: 0.00123456789, x1: 2.3456789 }));
    expect(option.code).toContain('df["p"].between(0.00123456789, 2.3456789)');
    expect(option.text).toBe(
      'Keep 0.00123 <= p <= 2.35 of df as sel_p0_00123_2_35'
    );
  });

  it('writes a column name with a quote or a line break as a Python string', () => {
    const x = 'height "cm"\n(measured)';
    const option = kept(
      regionAsk({ x, x0: 150, x1: 170, y: 'weight', ys: [40.5, 90] })
    );
    const [keep, attrs] = option.code!.split('\n');
    expect(keep).toBe(
      'sel_height__cm___measured_150_170_weight40_5_90 = ' +
        'df[df["height \\"cm\\"\\n(measured)"].between(150, 170) & df["weight"].between(40.5, 90)].copy()'
    );
    expect(attrs).toBe(
      'sel_height__cm___measured_150_170_weight40_5_90.attrs["whybook"] = ' +
        '{"selection": {"of": "df", "where": "150 <= height \\"cm\\"\\n(measured) <= 170 and 40.5 <= weight <= 90"}}'
    );
    expect(option.code!.split('\n')).toHaveLength(3);
  });
});

describe('the questions about a region', () => {
  it('writes the names of the dropout check as Python strings', () => {
    const { model } = fakeModel([{ id: 'c1', count: 1 }]);
    const ask = regionAsk({ x: 'week\n1', x0: 0.0012, x1: 2.5, by: 'arm "A"' });
    const [dropout] = model._regionOptions(ask, 'patient id') as IOption[];
    const lines = dropout.code!.split('\n');
    // The line break of the name stays inside the comment.
    expect(lines.slice(0, 2)).toEqual([
      '# Who is still in df for week',
      '# 1 0.0012 to 2.5, by arm "A"?'
    ]);
    expect(lines).toContain('_before = df[df["week\\n1"] < 0.0012]');
    expect(lines).toContain(
      '    "patient ids before": _before.groupby("arm \\"A\\"", observed=True)["patient id"].nunique(),'
    );
    expect(lines).toContain(
      'logging_by_arm__A_["still in"] = (logging_by_arm__A_["patient ids inside"] / logging_by_arm__A_["patient ids before"]).round(3)'
    );
  });

  it('names the rows at full precision in what the model reads', () => {
    const { model } = fakeModel([{ id: 'c1', count: 1 }]);
    model.bridge.snapshot = { variables: [], packages: {} };
    const ask = regionAsk({ x0: 0.00123456789, x1: 0.0048 });
    const body = model._solveBody(
      { id: 'q', text: 'Why?', type: 'causal' },
      { kind: 'new', cell: 'c1', label: '' },
      null,
      ask
    );
    expect(body.about).toBe(
      'the rows of df where 0.00123456789 <= p <= 0.0048, picked in the plot "p against week"'
    );
  });
});

describe('the rows picked, in what the model reads', () => {
  // A question about 65 rows picked on a histogram was answered about all
  // 1,629 rows of the frame (design iteration 1.95): the model gets the mask
  // of the rows, as Keep selection writes it.
  function bodyFor(ask: IRegionAsk, type: string | null, language?: string) {
    const { model } = fakeModel([{ id: 'c1', count: 1 }]);
    model.bridge.snapshot = { variables: [], packages: {} };
    if (language) {
      model.bridge.languageName = language;
    }
    model.variable = (name: string) =>
      name === 'df'
        ? {
            name,
            label: name,
            kind: 'dataframe',
            type,
            columns: [{ label: 'p', kind: 'categorical', tag: 'cat' }]
          }
        : null;
    return model._solveBody(
      { id: 'q', text: 'How many of them quit?', type: 'descriptive' },
      { kind: 'new', cell: 'c1', label: '' },
      null,
      ask
    );
  }

  it('sends the mask of a range brushed in a plot of a pandas frame', () => {
    const body = bodyFor(
      regionAsk({ x0: 15.604805330000012, x1: 48.53838568000002 }),
      'pandas.core.frame.DataFrame'
    );
    expect(body.rows).toEqual({
      frame: 'df',
      mask: 'df["p"].between(15.604805330000012, 48.53838568000002)'
    });
  });

  it('sends the mask of the bars picked', () => {
    const ask = { ...regionAsk({ x0: 0, x1: 0 }), values: ['A', 'B'] };
    expect(
      bodyFor(ask as IRegionAsk, 'pandas.core.frame.DataFrame').rows
    ).toEqual({ frame: 'df', mask: 'df["p"].isin(["A", "B"])' });
  });

  it('sends no mask for a polars frame, or for a kernel of another language', () => {
    const ask = regionAsk({ x0: 1, x1: 2 });
    expect(bodyFor(ask, 'polars.dataframe.frame.DataFrame').rows).toBeNull();
    expect(
      bodyFor(ask, 'pandas.core.frame.DataFrame', 'R').rows
    ).toBeUndefined();
  });
});

describe('regionWhere', () => {
  it('says which rows a region keeps, rounded for reading', () => {
    expect(regionWhere(regionAsk({ x0: 0.0012, x1: 0.0048 }))).toBe(
      '0.0012 <= p <= 0.0048'
    );
    expect(regionWhere(regionAsk({ x0: 5, x1: 9.125 }))).toBe('5 <= p <= 9.13');
    // What a model reads: the bounds as brushed.
    expect(regionWhere(regionAsk({ x0: 5, x1: 9.125 }), true)).toBe(
      '5 <= p <= 9.125'
    );
  });
});

describe('pyComment', () => {
  it('keeps each line of a text in the comment', () => {
    expect(pyComment('Is arm A\nhigher?')).toBe('# Is arm A\n# higher?');
    expect(pyComment('a\r\nb\rc')).toBe('# a\n# b\n# c');
    // Python reads no null byte in its source.
    expect(pyComment('x\u0000y')).toBe('# x y');
  });
});
