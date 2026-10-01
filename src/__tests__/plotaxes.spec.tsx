/**
 * What the axes, the tooltips and the Contents of a model read: numbers with
 * the digits that tell them apart, and dates as dates (src/ui/plot.tsx,
 * src/ui/variables.tsx).
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { IPlotPayload } from '../tokens';
import { EpiPlot } from '../ui/plot';
import { ContentsSection } from '../ui/variables';

const signal = { connect: () => undefined, disconnect: () => undefined };

function barsOf(values: number[]): IPlotPayload {
  return {
    version: 1,
    kind: 'bars',
    title: 'Mean incidence by site',
    x: { field: 'site', label: 'site' },
    y: { field: 'incidence', label: 'incidence' },
    source: { frame: 'sites', x: 'site', y: 'incidence', by: null, rows: 40 },
    select: 'x',
    bars: values.map((y, index) => ({ x: 'ABCD'[index], y, n: 10 }))
  };
}

/** The labels of the ticks of a vertical axis, from the bottom up. */
function yTicks(markup: string): string[] {
  return [
    ...markup.matchAll(
      /<g transform="translate\(0,[^)]*\)"><line[^>]*><\/line><text[^>]*>([^<]*)<\/text><\/g>/g
    )
  ].map(match => match[1]);
}

/** The labels of the ticks of the x axis of a line, points or bins. */
function xTicks(markup: string): string[] {
  return [
    ...markup.matchAll(
      /<text x="[^"]*" y="[^"]*" text-anchor="(?:start|middle|end)">([^<]*)<\/text>/g
    )
  ].map(match => match[1]);
}

function axisLabel(markup: string): string {
  return /<text class="jp-Epi-axis-label"[^>]*>([^<]*)<\/text>/.exec(
    markup
  )![1];
}

describe('the ticks and tooltips of a plot', () => {
  it('gives each tick of a plot of small values its own label', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot
        payload={barsOf([0.002, 0.004, 0.006, 0.008])}
        width={400}
        height={220}
      />
    );
    expect(yTicks(markup)).toEqual(['0', '0.002', '0.004', '0.006', '0.008']);
  });

  it('writes the height of a small bar in its tooltip', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot
        payload={barsOf([0.002, 0.004, 0.006, 0.008])}
        width={400}
        height={220}
      />
    );
    const titles = [
      ...markup.matchAll(/<rect[^>]*><title>([^<]*)<\/title>/g)
    ].map(match => match[1]);
    expect(titles[0]).toBe('A: 0.002 · 10 rows');
  });

  it('gives each tick of an axis of years with months its own label', () => {
    const payload: IPlotPayload = {
      version: 1,
      kind: 'ribbon',
      title: 'pain by year',
      x: { field: 'year', label: 'year' },
      y: { field: 'pain', label: 'pain' },
      source: { frame: 'diary', x: 'year', y: 'pain', by: null, rows: 130 },
      select: 'x',
      series: [
        {
          name: 'all',
          points: Array.from({ length: 13 }, (_, month) => ({
            x: 2020 + month / 12,
            y: 4 + month / 10,
            lo: 3,
            hi: 6,
            n: 10
          }))
        }
      ]
    };
    const markup = renderToStaticMarkup(
      <EpiPlot payload={payload} width={400} height={220} />
    );
    expect(xTicks(markup)).toEqual([
      '2020',
      '2020.2',
      '2020.4',
      '2020.6',
      '2020.8',
      '2021'
    ]);
  });

  it('writes a power of ten that tiny ticks share by the axis label', () => {
    // Concentrations of 0.1 to 0.9 micromolar, in mol/L.
    const payload: IPlotPayload = {
      version: 1,
      kind: 'hist',
      title: 'Distribution of conc_M',
      x: { field: 'conc_M', label: 'conc_M' },
      y: null,
      source: { frame: 'assay', x: 'conc_M', y: null, by: null, rows: 50 },
      select: 'x',
      bins: [
        { x0: 1e-7, x1: 3e-7, n: 12 },
        { x0: 3e-7, x1: 5e-7, n: 13 },
        { x0: 5e-7, x1: 7e-7, n: 12 },
        { x0: 7e-7, x1: 9e-7, n: 13 }
      ]
    };
    const markup = renderToStaticMarkup(
      <EpiPlot payload={payload} width={400} height={220} />
    );
    expect(xTicks(markup)).toEqual(['2', '4', '6', '8']);
    expect(axisLabel(markup)).toBe('conc_M (×10⁻⁷)');
  });
});

describe('the Contents of a fitted model', () => {
  it('shows a small coefficient and its interval with the same decimals', () => {
    // A blood pressure model with age in days: 0.0042 mmHg per day.
    const model: any = {
      selected: 'fit',
      changed: signal,
      variable: () => ({
        name: 'fit',
        label: 'fit',
        kind: 'model',
        model_class: 'OLS',
        formula: 'bp ~ age_days',
        terms: [
          { term: 'Intercept', coef: 101.2, lo: 98.1, hi: 104.3, p: 1e-12 },
          { term: 'age_days', coef: 0.0042, lo: 0.0021, hi: 0.0063, p: 0.031 }
        ]
      }),
      variableCells: () => ({ made: [], imported: [], used: [] })
    };
    const markup = renderToStaticMarkup(<ContentsSection model={model} />);
    const body = /<tbody>([\s\S]*)<\/tbody>/.exec(markup)![1];
    const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row =>
      [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map(cell => cell[1])
    );
    expect(rows).toEqual([
      ['Intercept', '101.2', '98.1, 104.3', '&lt; 0.001'],
      ['age_days', '0.0042', '0.0021, 0.0063', '0.03']
    ]);
  });
});

const at = (text: string) => Date.parse(`${text}Z`);

/**
 * The payloads that whybook.ribbon and whybook.scatter write for a column of
 * dates (whybook/plots.py): each date as milliseconds since 1970.
 */
const DAYS = [
  at('2024-01-01T00:00:00'),
  at('2024-01-02T00:00:00'),
  at('2024-01-03T00:00:00')
];

const dateRibbon: IPlotPayload = {
  version: 1,
  kind: 'ribbon',
  title: 'pain by day',
  x: { field: 'day', label: 'day', type: 'date' },
  y: { field: 'pain', label: 'pain' },
  source: { frame: 'diary', x: 'day', y: 'pain', by: null, rows: 6 },
  select: 'x',
  series: [
    {
      name: 'all',
      points: DAYS.map((x, index) => ({
        x,
        y: 3.5 + index,
        lo: 2.5 + index,
        hi: 4.5 + index,
        n: 2
      }))
    }
  ]
};

const dateScatter: IPlotPayload = {
  version: 1,
  kind: 'scatter',
  title: 'pain by day',
  x: { field: 'day', label: 'day', type: 'date' },
  y: { field: 'pain', label: 'pain' },
  source: { frame: 'diary', x: 'day', y: 'pain', by: null, rows: 6 },
  select: 'xy',
  points: DAYS.flatMap((x, index) => [
    { x, y: 3 + index, g: null, i: 2 * index },
    { x, y: 4 + index, g: null, i: 2 * index + 1 }
  ])
};

describe('a plot with dates on x', () => {
  it('draws the line of a ribbon, and writes its ticks as days', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={dateRibbon} width={400} height={220} />
    );
    const path = /<path d="([^"]*)"/.exec(markup)![1];
    expect(path).not.toContain('NaN');
    expect(xTicks(markup)).toEqual(['Jan 1', 'Jan 2', 'Jan 3']);
    expect(axisLabel(markup)).toBe('day (2024)');
  });

  it('keeps the label of the last tick inside the plot', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={dateRibbon} width={400} height={220} />
    );
    const anchors = [
      ...markup.matchAll(
        /<text x="[^"]*" y="[^"]*" text-anchor="([a-z]+)">([^<]*)<\/text>/g
      )
    ].map(match => [match[2], match[1]]);
    // Centred at the right edge, "Jan 3" would pass the plot's margin.
    expect(anchors).toEqual([
      ['Jan 1', 'middle'],
      ['Jan 2', 'middle'],
      ['Jan 3', 'end']
    ]);
  });

  it('draws the points of a scatter plot at their days', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={dateScatter} width={400} height={220} />
    );
    const cx = [...markup.matchAll(/<circle cx="([^"]*)"/g)].map(match =>
      Number(match[1])
    );
    expect(cx).toHaveLength(6);
    expect(cx.every(Number.isFinite)).toBe(true);
    // Two points a day, the days in order across the plot.
    expect(cx[0]).toBe(cx[1]);
    expect(cx[2]).toBeGreaterThan(cx[0]);
    expect(xTicks(markup)).toEqual(['Jan 1', 'Jan 2', 'Jan 3']);
  });

  it('writes the times of one day by the hour, and the day by the axis label', () => {
    const hours = [6, 9, 12, 15].map(hour =>
      at(`2024-03-05T${String(hour).padStart(2, '0')}:00:00`)
    );
    const payload: IPlotPayload = {
      ...dateScatter,
      points: hours.map((x, i) => ({ x, y: i, g: null, i }))
    };
    const markup = renderToStaticMarkup(
      <EpiPlot payload={payload} width={400} height={220} />
    );
    expect(xTicks(markup)).toEqual([
      '06:00',
      '08:00',
      '10:00',
      '12:00',
      '14:00'
    ]);
    expect(axisLabel(markup)).toBe('day (Mar 5 2024)');
  });
});

describe('the legend of a scatter', () => {
  // The legend measures its names after layout, which the server renderer
  // of these tests does not run: it warns, and the names stay 70 px apart.
  let quiet: jest.SpyInstance;
  beforeEach(() => {
    const error = console.error;
    quiet = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).includes('useLayoutEffect does nothing')) {
          error(...args);
        }
      });
  });
  afterEach(() => quiet.mockRestore());

  /** Residuals of two arms, the first point in arm B. */
  function residuals(groups?: string[]): IPlotPayload {
    return {
      version: 1,
      kind: 'scatter',
      title: 'Residuals against fitted values',
      x: { field: 'fitted', label: 'fitted' },
      y: { field: 'residual', label: 'residual' },
      source: {
        frame: 'model_data',
        x: 'fitted',
        y: 'residual',
        by: 'treatment_arm',
        rows: 4
      },
      select: 'xy',
      ...(groups ? { groups } : {}),
      points: [
        { x: 1, y: 0.5, g: 'B', i: 0 },
        { x: 2, y: -0.5, g: 'A', i: 1 },
        { x: 3, y: 0.2, g: 'B', i: 2 },
        { x: 4, y: -0.1, g: 'A', i: 3 }
      ]
    };
  }

  /** The names that a plot's legend shows, in its order. */
  function legend(markup: string): string[] {
    const start = markup.indexOf('class="jp-Epi-legend"');
    if (start < 0) {
      return [];
    }
    return [...markup.slice(start).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(
      match => match[1]
    );
  }

  /** The fill of each point, in the order of the points. */
  function fills(markup: string): string[] {
    return [...markup.matchAll(/<circle[^>]*style="fill:([^"]*)"/g)].map(
      match => match[1]
    );
  }

  it('names the group of each colour, in the order of the lines of a ribbon', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={residuals(['A', 'B'])} width={400} height={220} />
    );
    expect(legend(markup)).toEqual(['A', 'B']);
    // A takes the first colour, as the line of A does in a ribbon, though
    // the first point is in B.
    expect(fills(markup).slice(0, 2)).toEqual([
      'var(--jp-warn-color1)',
      'var(--jp-brand-color1)'
    ]);
  });

  it('names the groups of a scatter drawn before the payload listed them', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={residuals()} width={400} height={220} />
    );
    expect(legend(markup)).toEqual(['B', 'A']);
  });

  it('draws no legend for points of one group', () => {
    const payload = residuals();
    payload.source.by = null;
    payload.points = payload.points!.map(point => ({ ...point, g: null }));
    const markup = renderToStaticMarkup(
      <EpiPlot payload={payload} width={400} height={220} />
    );
    expect(legend(markup)).toEqual([]);
  });
});
