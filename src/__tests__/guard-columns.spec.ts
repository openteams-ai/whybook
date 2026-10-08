/**
 * What the view tells the privacy guard of each column: its range and its
 * tag, so that the rules tell a table of statistics from a person (design
 * iteration 1.96, whybook/server/guard/rules.py, Domain).
 */
import './fakes/quiet';

import { guardColumn } from '../model/guard';
import type { IColumn, IVariable } from '../tokens';
import { benchModel } from './fakes/bench-fake';

const column = (label: string, extra: Partial<IColumn>): IColumn => ({
  name: `nhefs['${label}']`,
  label,
  parent: 'nhefs',
  kind: 'numeric',
  tag: 'int',
  ...extra
});

const AGE = column('age', { min: 25, max: 74, unique: 49 });
const INCOME = column('income', { tag: 'num', min: 11, max: 22 });
const SEX = column('sex', { kind: 'binary', min: 0, max: 1 });
const VISIT = column('visit_date', {
  kind: 'datetime',
  tag: 'date',
  min: '1971-01-04',
  max: '1975-12-30'
});
const STAGE = column('stage', {
  kind: 'categorical',
  tag: 'ord',
  levels: ['I', 'II', 'III', 'IV']
});

describe('guardColumn', () => {
  it('gives the range and the tag of a column of numbers', () => {
    expect(guardColumn(AGE)).toEqual({
      name: 'age',
      levels: undefined,
      tag: 'int',
      min: 25,
      max: 74
    });
    expect(guardColumn(INCOME)).toMatchObject({ tag: 'num', min: 11, max: 22 });
  });

  it('gives the levels of a column of words, and no range of dates', () => {
    expect(guardColumn(STAGE)).toEqual({
      name: 'stage',
      levels: ['I', 'II', 'III', 'IV'],
      tag: 'ord'
    });
    const visit = guardColumn(VISIT);
    expect(visit).toEqual({
      name: 'visit_date',
      levels: undefined,
      tag: 'date'
    });
    expect(JSON.stringify(visit)).toBe('{"name":"visit_date","tag":"date"}');
  });
});

describe('the guard object of a view', () => {
  it('sends each column of the frames that the kernel lists, with its range', () => {
    const { model } = benchModel([{ id: 'c1', source: 'nhefs.head()' }]);
    const frame: IVariable = {
      name: 'nhefs',
      label: 'nhefs',
      kind: 'dataframe',
      rows: 1629,
      columns: [AGE, SEX, INCOME, VISIT, STAGE]
    };
    (model.sessionContext as any).session = { kernel: {} };
    // What the kernel listed last.
    (model.bridge as any)._snapshot = { variables: [frame], packages: {} };
    const body = (model as any)._guardBody() as {
      dataset: { columns: Record<string, unknown>[] };
    };
    expect(JSON.parse(JSON.stringify(body.dataset.columns))).toEqual([
      { name: 'age', tag: 'int', min: 25, max: 74 },
      { name: 'sex', tag: 'int', min: 0, max: 1 },
      { name: 'income', tag: 'num', min: 11, max: 22 },
      { name: 'visit_date', tag: 'date' },
      { name: 'stage', levels: ['I', 'II', 'III', 'IV'], tag: 'ord' }
    ]);
  });
});
