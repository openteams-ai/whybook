/**
 * The outcomes and the units of an analysis, inferred by the rules and kept
 * as a model named them (src/model/inferred.ts, design iteration 1.64), the
 * setting "Questions from a model" (src/model/rulesfirst.ts), and the order
 * of a list with a model's questions in it.
 */
import { inOrder } from '../model/epimodel';
import {
  chipText,
  contextOf,
  fitTargets,
  formulaOutcome,
  groupsOf,
  inferredLists,
  rulesOutcomes,
  rulesUnits,
  withModel,
  withPick
} from '../model/inferred';
import { asksModel, readModelQuestions } from '../model/rulesfirst';
import type { IOption, IVariable } from '../tokens';

function option(id: string, extra: Partial<IOption> = {}): IOption {
  return {
    id,
    text: `Question ${id}`,
    type: 'descriptive',
    origin: 'template',
    probability: 0.5,
    reasons: [],
    placement: null,
    ...extra
  };
}

/** Three frames of a new notebook: one row per home, per home and day, and per region and day. */
const FRAMES: IVariable[] = [
  {
    name: 'homes',
    label: 'homes',
    kind: 'dataframe',
    rows: 360,
    columns: [
      {
        name: 'homes["home_id"]',
        label: 'home_id',
        parent: 'homes',
        kind: 'id',
        tag: 'id',
        unique: 360
      },
      {
        name: 'homes["floor_area_m2"]',
        label: 'floor_area_m2',
        parent: 'homes',
        kind: 'numeric',
        tag: 'int',
        unique: 117
      }
    ]
  },
  {
    name: 'meter_readings',
    label: 'meter_readings',
    kind: 'dataframe',
    rows: 129058,
    columns: [
      {
        name: 'r["home_id"]',
        label: 'home_id',
        parent: 'meter_readings',
        kind: 'id',
        tag: 'id',
        unique: 360
      },
      {
        name: 'r["kwh_import"]',
        label: 'kwh_import',
        parent: 'meter_readings',
        kind: 'numeric',
        tag: 'num',
        unique: 38386
      },
      {
        name: 'r["kwh_peak"]',
        label: 'kwh_peak',
        parent: 'meter_readings',
        kind: 'numeric',
        tag: 'num',
        unique: 20000
      }
    ]
  },
  {
    name: 'weather',
    label: 'weather',
    kind: 'dataframe',
    rows: 1460,
    columns: [
      {
        name: 'w["region"]',
        label: 'region',
        parent: 'weather',
        kind: 'categorical',
        tag: 'cat',
        unique: 4
      },
      {
        name: 'w["mean_temp_c"]',
        label: 'mean_temp_c',
        parent: 'weather',
        kind: 'numeric',
        tag: 'num',
        unique: 300
      }
    ]
  }
];

describe('the rules that infer an outcome and a unit', () => {
  it('reads the column on the left side of a formula', () => {
    expect(formulaOutcome('pain_score ~ arm * week')).toBe('pain_score');
    expect(formulaOutcome('np.log(kwh_import) ~ hdd')).toBe('kwh_import');
    expect(formulaOutcome('Q("sleep hours") ~ age')).toBe('sleep hours');
    expect(formulaOutcome('~/data/visits.csv')).toBeNull();
    expect(formulaOutcome('no formula here')).toBeNull();
  });

  it('reads the target of a fit, as a subscript or an attribute of a frame', () => {
    expect(
      fitTargets('LinearRegression().fit(homes[cols], homes["price"])')
    ).toEqual(['price']);
    expect(
      fitTargets('model.fit(X_train, train.price)\nmodel.score(X, y)')
    ).toEqual(['price']);
    expect(fitTargets('model.fit(X, y)')).toEqual([]);
  });

  it('reads the groups of a mixed model', () => {
    expect(
      groupsOf('smf.mixedlm("y ~ x", data=d, groups="home_id").fit()')
    ).toEqual(['home_id']);
    expect(groupsOf('smf.mixedlm("y ~ x", d, groups=d["patient_id"])')).toEqual(
      ['patient_id']
    );
  });

  it('finds the outcome of a formula or of a fit in the cell that holds it, a column of a frame', () => {
    const cells = [
      { id: 'c1', source: 'x = 1', formulas: [] },
      {
        id: 'c5',
        source: 'y',
        formulas: ['kwh_import ~ mean_temp_c', 'nothing ~ x']
      },
      {
        id: 'c6',
        source: 'fit = model.fit(X, meter_readings["kwh_peak"])',
        formulas: []
      }
    ];
    expect(rulesOutcomes(cells, FRAMES)).toEqual([
      {
        column: 'kwh_import',
        frame: 'meter_readings',
        by: 'rules',
        cell: 'c5'
      },
      { column: 'kwh_peak', frame: 'meter_readings', by: 'rules', cell: 'c6' }
    ]);
  });

  it('finds a unit in an id column whose values repeat, first one that names each row of another frame', () => {
    expect(rulesUnits([], FRAMES)).toEqual([
      { column: 'home_id', frame: 'meter_readings', by: 'rules' }
    ]);
    const cells = [
      { id: 'c7', source: 'mixedlm(f, d, groups="home_id")', formulas: [] }
    ];
    expect(rulesUnits(cells, FRAMES)[0]).toEqual({
      column: 'home_id',
      frame: 'homes',
      by: 'rules',
      cell: 'c7'
    });
  });

  it("orders the analyst's pick, the rules and the model, each column once, and a value set by hand stands alone", () => {
    const cells = [{ id: 'c5', source: '', formulas: ['kwh_import ~ x'] }];
    const meta = {
      inferred: {
        outcomes: [
          { column: 'kwh_peak', by: 'model' as const },
          { column: 'kwh_import', by: 'model' as const },
          { column: 'floor_area_m2', by: 'analyst' as const }
        ]
      }
    };
    const lists = inferredLists(meta, cells, FRAMES);
    expect(lists.outcomes.map(entry => [entry.column, entry.by])).toEqual([
      ['floor_area_m2', 'analyst'],
      ['kwh_import', 'rules'],
      ['kwh_peak', 'model']
    ]);
    expect(contextOf(lists).outcome).toBe('floor_area_m2');
    const hand = inferredLists({ ...meta, outcome: 'pain' }, cells, FRAMES);
    expect(hand.outcomes).toEqual([]);
    expect(contextOf(hand)).toMatchObject({
      outcome: 'pain',
      outcomes: ['pain']
    });
  });

  it("keeps the model's latest lists, an empty list keeping the earlier, and the analyst's pick", () => {
    const by = { choice: 'remote', model: 'm', at: '2026-09-30T12:00:00Z' };
    const first = withModel(
      undefined,
      { outcomes: [{ column: 'a', frame: 'f', why: 'w' }], units: [] },
      by
    );
    const picked = withPick(first, 'outcome', { column: 'b' });
    const next = withModel(
      picked,
      { outcomes: [{ column: 'c', frame: 'f', why: '' }], units: [] },
      by
    );
    expect(next.outcomes!.map(entry => [entry.column, entry.by])).toEqual([
      ['b', 'analyst'],
      ['c', 'model']
    ]);
    expect(next.units).toEqual([]);
  });

  it('says where a chip comes from', () => {
    const label = (id: string) => (id === 'c5' ? '[5]' : null);
    expect(
      chipText(
        'outcome',
        { column: 'pain_score', by: 'rules', cell: 'c5' },
        label
      )
    ).toBe('outcome pain_score · inferred from [5]');
    expect(
      chipText(
        'unit',
        { column: 'home_id', by: 'rules', frame: 'meter_readings' },
        label
      )
    ).toBe('unit home_id · inferred from meter_readings');
    expect(
      chipText('outcome', { column: 'kwh_import', by: 'model' }, label)
    ).toBe('outcome kwh_import · inferred by AI');
    expect(
      chipText('outcome', { column: 'kwh_import', by: 'analyst' }, label)
    ).toBe('outcome kwh_import · chosen by you');
  });
});

describe('the setting "Questions from a model"', () => {
  it('asks always, when no template fits, or never', () => {
    const runs = [option('t1', { code: 'x' })];
    const needs = [option('t1')];
    expect(asksModel('always', runs)).toBe(true);
    expect(asksModel('no-template', runs)).toBe(false);
    expect(asksModel('no-template', needs)).toBe(true);
    expect(asksModel('never', needs)).toBe(false);
  });

  it('reads a saved switch of before as never when it was off', () => {
    expect(readModelQuestions('always', { aiWhenNoTemplate: false })).toBe(
      'never'
    );
    expect(readModelQuestions('always', { aiWhenNoTemplate: true })).toBe(
      'always'
    );
    expect(readModelQuestions('no-template', {})).toBe('no-template');
    expect(readModelQuestions('what', {})).toBe('always');
  });
});

describe('inOrder', () => {
  it('puts the questions in the order given, and those it lacks after, in their order', () => {
    const list = ['a', 'b', 'c', 'd'].map(id => option(id));
    expect(inOrder(list, ['c', 'a']).map(o => o.id)).toEqual([
      'c',
      'a',
      'b',
      'd'
    ]);
    expect(inOrder(list, null).map(o => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
