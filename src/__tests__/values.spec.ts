import { escapeRegExp, valueText } from '../model/values';
import type { IColumn, IVariable } from '../tokens';
import { columnMeta, shapeOf } from '../ui/variables';

describe('valueText', () => {
  it("drops numpy's wrapper and cuts a long number", () => {
    expect(valueText('np.float64(-0.4131654135338354)')).toBe('-0.41317');
    expect(valueText('np.float64(1234.56789)')).toBe('1234.568');
    expect(valueText('0.000123456789')).toBe('0.00012346');
    expect(valueText('np.int64(14)')).toBe('14');
    expect(valueText('np.True_')).toBe('True');
    expect(valueText('1e-07')).toBe('1e-7');
  });

  it('leaves whole numbers, strings and other values as Python prints them', () => {
    expect(valueText('14')).toBe('14');
    expect(valueText("'pain_score'")).toBe("'pain_score'");
    expect(valueText('None')).toBe('None');
    expect(valueText('[1, 2, 3]')).toBe('[1, 2, 3]');
  });
});

describe('escapeRegExp', () => {
  it('matches a name literally', () => {
    expect(new RegExp(escapeRegExp('a.b(c)')).test('a.b(c)')).toBe(true);
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false);
  });
});

describe('shapeOf', () => {
  // A string longer than the list shows: the kernel lists its length, which
  // read "59 items" (critique 4, the app).
  it('gives the length of a long string in characters', () => {
    const variable: IVariable = {
      name: 'DB_HOST',
      label: 'DB_HOST',
      kind: 'other',
      type: 'builtins.str',
      length: 59
    };
    expect(shapeOf(variable)).toBe('59 characters');
    expect(shapeOf({ ...variable, length: 1 })).toBe('1 character');
  });

  it('gives the length of a list in items, one item for one', () => {
    const variable: IVariable = {
      name: 'estimates',
      label: 'estimates',
      kind: 'other',
      type: 'builtins.list',
      length: 40
    };
    expect(shapeOf(variable)).toBe('40 items');
    expect(shapeOf({ ...variable, length: 1 })).toBe('1 item');
    expect(shapeOf({ ...variable, length: 12345 })).toBe('12,345 items');
  });
});

describe('columnMeta', () => {
  const column = (
    min: number,
    max: number,
    tag: 'num' | 'int' = 'num'
  ): IColumn => ({
    name: 'visits.dose_mg',
    label: 'dose_mg',
    parent: 'visits',
    kind: 'numeric',
    tag,
    rows: 320,
    missing: 0,
    min,
    max
  });

  // The kernel lists six significant figures; Contents showed them all, cut
  // to "0.00100525–0.0…" (critique 4, the app).
  it('writes the range of a column as values in text, with three significant figures', () => {
    expect(columnMeta(column(0.00100525, 0.00899545))).toBe('0.00101–0.009');
    expect(columnMeta(column(2.35714, 9.3))).toBe('2.36–9.3');
  });

  it('writes a range of whole numbers whole, grouped', () => {
    expect(columnMeta(column(1, 194, 'int'))).toBe('1–194');
    expect(columnMeta(column(0, 129058, 'int'))).toBe('0–129,058');
  });
});
