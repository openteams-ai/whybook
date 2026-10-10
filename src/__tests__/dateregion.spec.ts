/**
 * A range picked on a date axis (src/model/epimodel.ts): the question shows
 * its bounds as dates, and the code compares the column with
 * pd.Timestamp(...) bounds, as region_summary.py counted its rows
 * (whybook/server/tests/test_notebook_helpers.py runs the same code).
 */
// The fake first: it quiets the warnings that loading the view model gives.
import { fakeModel } from './fakes/model-fake';
import type { IRegionAsk } from '../model/epimodel';
import { regionWhere } from '../model/epimodel';
import type { IOption, IPlotAxis } from '../tokens';
import { askTitle } from '../ui/variables';

const at = (text: string) => Date.parse(`${text}Z`);

function dateAsk(axis: Partial<IPlotAxis> = {}): IRegionAsk {
  return {
    kind: 'region',
    id: 1,
    anchor: null,
    loading: false,
    error: null,
    cellId: 'c1',
    plot: {
      version: 1,
      kind: 'ribbon',
      title: 'pain by day',
      x: { field: 'day', label: 'day', type: 'date', ...axis },
      y: { field: 'pain', label: 'pain' },
      source: { frame: 'diary', x: 'day', y: 'pain', by: null, rows: 5 },
      select: 'x'
    },
    x0: at('2024-01-02T00:00:00'),
    x1: at('2024-01-03T00:00:00'),
    values: null,
    y: null,
    summary: { rows: 3, total_rows: 5, where: '', groups: [], seen: '' },
    options: []
  };
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

describe('a range picked on a date axis', () => {
  it('shows its bounds as dates', () => {
    expect(regionWhere(dateAsk())).toBe('2024-01-02 <= day <= 2024-01-03');
  });

  it('keeps its rows with timestamps in the code', () => {
    const option = kept(dateAsk());
    expect(option.code!.split('\n').slice(0, 3)).toEqual([
      'import pandas as pd',
      '',
      'sel_day2024_01_02_2024_01_03 = diary[diary["day"].between(pd.Timestamp("2024-01-02"), pd.Timestamp("2024-01-03"))].copy()'
    ]);
    expect(option.text).toBe(
      'Keep 2024-01-02 <= day <= 2024-01-03 of diary as sel_day2024_01_02_2024_01_03'
    );
  });

  it('writes the time zone of the dates, and parses dates held as Python objects', () => {
    expect(kept(dateAsk({ tz: 'Europe/Warsaw' })).code).toContain(
      'diary["day"].between(pd.Timestamp("2024-01-02", tz="Europe/Warsaw"), pd.Timestamp("2024-01-03", tz="Europe/Warsaw"))'
    );
    expect(kept(dateAsk({ objects: true })).code).toContain(
      'pd.to_datetime(diary["day"]).between(pd.Timestamp("2024-01-02"), pd.Timestamp("2024-01-03"))'
    );
  });
});

describe('a box drawn over daily dates', () => {
  // A box's bounds are where the pointer was, to the millisecond: the text
  // read "2024-03-12 12:29:35.342", and the kept variable's name had 83
  // characters (critique 4, the app).
  const DAY = 24 * 60 * 60 * 1000;

  function brushed(y: [number, number] | null = null): IRegionAsk {
    const ask = dateAsk();
    ask.plot = {
      ...ask.plot,
      kind: y ? 'scatter' : 'ribbon',
      select: y ? 'xy' : 'x',
      source: { ...ask.plot.source, y: y ? 'dose_mg' : 'pain' },
      y: y ? { field: 'dose_mg', label: 'dose_mg' } : ask.plot.y,
      series: y
        ? undefined
        : [
            {
              name: 'all',
              points: Array.from({ length: 31 }, (_, day) => ({
                x: at('2024-03-01T00:00:00') + day * DAY,
                y: 5,
                lo: 4,
                hi: 6,
                n: 3
              }))
            }
          ],
      points: y
        ? Array.from({ length: 31 }, (_, day) => ({
            x: at('2024-03-01T00:00:00') + day * DAY,
            y: 0.001 + day * 0.0002,
            g: null,
            i: day
          }))
        : undefined
    };
    ask.x0 = at('2024-03-12T12:29:35.342');
    ask.x1 = at('2024-03-31T14:08:13.151');
    ask.y = y;
    return ask;
  }

  it('reads its bounds in days: the first and the last day that it holds', () => {
    expect(regionWhere(brushed())).toBe('2024-03-13 <= day <= 2024-03-31');
  });

  it('heads its questions with the days that it holds', () => {
    const { model } = fakeModel([{ id: 'c1', count: 1 }]);
    model.ask = brushed();
    expect(askTitle(model)).toBe('day 2024-03-13 to 2024-03-31');
    model.ask = brushed([0.00469917816775469, 0.007449049900505685]);
    expect(askTitle(model)).toBe(
      'day 2024-03-13 to 2024-03-31, dose_mg 0.0047 to 0.00745'
    );
  });

  it('gives a model the bounds as brushed', () => {
    expect(regionWhere(brushed(), true)).toBe(
      '2024-03-12 12:29:35.342 <= day <= 2024-03-31 14:08:13.151'
    );
  });

  it('keeps a short name, and the bounds as brushed in its code', () => {
    const option = kept(brushed());
    const name = /^(\S+) = /.exec(option.code!.split('\n')[2])![1];
    expect(name).toBe('sel_day2024_03_13_2024_03_31');
    expect(option.code).toContain(
      'diary["day"].between(pd.Timestamp("2024-03-12 12:29:35.342"), pd.Timestamp("2024-03-31 14:08:13.151"))'
    );
  });

  it('keeps a name without the time of the pointer for a box on two axes', () => {
    const option = kept(brushed([0.00469917816775469, 0.007449049900505685]));
    const name = /^(\S+) = /.exec(option.code!.split('\n')[2])![1];
    expect(name).toBe('sel_day2024_03_13_2024_03_31_dose_mg0_0047_0_00745');
  });
});
