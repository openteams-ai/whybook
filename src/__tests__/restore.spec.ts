import './fakes/quiet';

import type { Signal } from '@lumino/signaling';

import type { KernelBridge } from '../model/kernel';
import type { IStoredVariable } from '../model/restore';
import {
  KEPT_COLUMNS,
  analysisFor,
  listing,
  storedAnalysis,
  storedVariable,
  toStore
} from '../model/restore';
import { namesIn } from '../model/names';
import type { ICellAnalysis, IVariable } from '../tokens';
import { benchModel } from './fakes/bench-fake';

function frame(name: string, columns: number): IVariable {
  const labels = Array.from({ length: columns }, (_, i) => `c${i}`);
  return {
    name,
    label: name,
    kind: 'dataframe',
    rows: 10,
    n_columns: columns,
    fingerprint: 'abc',
    columns: labels.map(label => ({
      name: `${name}['${label}']`,
      label,
      parent: name,
      kind: 'numeric',
      tag: 'num',
      rows: 10
    })),
    groups: [{ label: 'all', columns: labels }]
  };
}

const constant: IVariable = {
  name: 'MIN_DAYS',
  label: 'MIN_DAYS',
  kind: 'constant',
  value: '14'
};

describe('storedVariable', () => {
  it('keeps the first columns of a wide frame and the size of its groups', () => {
    const kept = storedVariable(frame('olink', 4813), 'load');
    expect(kept.cell).toBe('load');
    expect(kept.columns).toHaveLength(KEPT_COLUMNS);
    expect(kept.n_columns).toBe(4813);
    expect(kept.groups).toEqual([
      {
        label: 'all',
        columns: kept.columns!.map(column => column.label),
        total: 4813
      }
    ]);
    // What the kernel marks and what reading adds back are not kept.
    expect(kept.fingerprint).toBeUndefined();
    expect(kept.columns![0]).not.toHaveProperty('name');
    expect(kept.columns![0]).not.toHaveProperty('parent');
  });
});

describe('listing', () => {
  const stored = [
    storedVariable(constant, 'imports'),
    storedVariable(frame('diary', 3), 'reshape'),
    storedVariable(frame('weekly', 2), 'weekly')
  ];

  it('shows every kept variable as stale without a kernel', () => {
    const shown = listing(null, stored, () => false);
    expect(shown.map(v => [v.name, v.stale])).toEqual([
      ['MIN_DAYS', true],
      ['diary', true],
      ['weekly', true]
    ]);
    // Read back like a kernel listing: columns know their frame again.
    expect(shown[1].columns![0].name).toBe("diary['c0']");
  });

  it('takes the kernel over the kept list, in the kept order', () => {
    const kernel = [frame('weekly', 2), constant, frame('fresh', 1)];
    const shown = listing(kernel, stored, () => false);
    expect(shown.map(v => [v.name, !!v.stale])).toEqual([
      ['MIN_DAYS', false],
      ['diary', true],
      ['weekly', false],
      ['fresh', false]
    ]);
  });

  it('drops a kept variable once its cell ran and did not make it', () => {
    const shown = listing([constant], stored, cell => cell === 'reshape');
    expect(shown.map(v => v.name)).toEqual(['MIN_DAYS', 'weekly']);
  });

  it('drops a kept variable that no cell makes once the kernel lists its variables without it', () => {
    // A listing taken while a branch's bootstrap ran kept its temporaries,
    // which the branch then deleted: "13 from the last run, not in the
    // kernel", in the middle of a session.
    const temporary = storedVariable(frame('boot_sample', 2), null);
    const kept = [...stored, temporary];
    expect(
      listing(null, kept, () => false).map(v => [v.name, v.stale])
    ).toContainEqual(['boot_sample', true]);
    const shown = listing([constant], kept, () => false);
    expect(shown.map(v => v.name)).not.toContain('boot_sample');
    expect(shown.filter(v => v.stale).map(v => v.name)).toEqual([
      'diary',
      'weekly'
    ]);
  });
});

describe('toStore', () => {
  it('keeps what the view shows, and reports no change as null', () => {
    const stored = [storedVariable(frame('diary', 3), 'reshape')];
    const shown = listing([constant], stored, () => false);
    const next = toStore(shown, stored, name =>
      name === 'MIN_DAYS' ? 'imports' : null
    );
    expect(next!.map(v => [v.name, v.cell])).toEqual([
      ['diary', 'reshape'],
      ['MIN_DAYS', 'imports']
    ]);
    expect(
      toStore(
        listing(null, next!, () => false),
        next!,
        () => null
      )
    ).toBe(null);
  });
});

describe('the view model keeps the cell that makes each variable', () => {
  it('gives the variables of the first listing their cell when the analysis comes', () => {
    // A view that started the kernel reads it first after a run, and the
    // listing comes before the kernel's analysis of the cells.
    const source = 'import pandas as pd\ndf = pd.DataFrame({"c0": [1, 2]})';
    const { nb, model } = benchModel([{ id: 'make', source, count: 1 }]);
    (model.sessionContext as any).session = { kernel: {} };
    (model.bridge as any)._snapshot = {
      variables: [frame('df', 1)],
      packages: {}
    };
    const changed = model.bridge.changed as Signal<KernelBridge, string>;
    const kept = () =>
      ((nb.getMetadata('whybook') as any)?.variables ?? []).map(
        (variable: IStoredVariable) => [variable.name, variable.cell]
      );
    changed.emit('variables');
    expect(kept()).toEqual([['df', null]]);
    jest.spyOn(model.bridge, 'freshAnalysis').mockReturnValue({
      defs: ['pd', 'df'],
      uses: ['pd'],
      formulas: [],
      columns: {},
      decisions: [],
      attachments: []
    });
    changed.emit('analysis');
    // Without the cell, the first listing after a restart drops df. With
    // it, df shows stale until its cell runs again.
    expect(kept()).toEqual([['df', 'make']]);
    model.dispose();
  });
});

describe('analysisFor', () => {
  const analysis: ICellAnalysis = {
    defs: ['weekly'],
    uses: ['diary'],
    formulas: [],
    columns: {},
    decisions: [],
    attachments: []
  };

  it('gives the kept analysis back for the same source only', () => {
    const kept = storedAnalysis(analysis, 'weekly = diary.groupby("week")');
    expect(analysisFor(kept, 'weekly = diary.groupby("week")')).toEqual(
      analysis
    );
    expect(analysisFor(kept, 'weekly = diary')).toBeNull();
    expect(analysisFor(undefined, 'x')).toBeNull();
  });

  it('leaves out a piece of a formula that a notebook kept, and keeps a whole one', () => {
    // [35] of the survey video builds its formula from a string and a join.
    const source =
      "formula = 'sad_or_hopeless ~ frequent_use + ' + ' + '.join(covariates)";
    const kept = storedAnalysis(
      {
        ...analysis,
        formulas: ['sad_or_hopeless ~ frequent_use + ', '~month']
      },
      source
    );
    expect(analysisFor(kept, source)?.formulas).toEqual(['~month']);
  });
});

describe('namesIn', () => {
  it('finds a variable the code reads, and not an attribute of that name', () => {
    const source =
      'term = "x"\neffects = pd.DataFrame([row for row in min_days_sweep.itertuples()])';
    expect(namesIn(source, 'min_days_sweep')).toBe(true);
    expect(namesIn('fit.p + 1', 'p')).toBe(false);
    expect(namesIn('p_value = 1', 'p')).toBe(false);
    expect(namesIn('print(p)', 'p')).toBe(true);
    expect(namesIn('fit_no_east.params[term]', 'fit_no_east')).toBe(true);
  });
});
