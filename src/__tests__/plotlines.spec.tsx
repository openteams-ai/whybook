/**
 * A thin line per unit under the mean of a ribbon (design iteration 1.75):
 * `whybook.ribbon(visits, x="week", y="analgesic_dose_mg", units="patient_id")`
 * draws each patient's doses over the weeks, and the axes hold them.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { IPlotPayload } from '../tokens';
import { EpiPlot } from '../ui/plot';

function trajectory(lines: IPlotPayload['lines']): IPlotPayload {
  return {
    version: 1,
    kind: 'ribbon',
    title: 'analgesic_dose_mg by week: the mean, and a line per patient_id',
    x: { field: 'week', label: 'week' },
    y: { field: 'analgesic_dose_mg', label: 'analgesic_dose_mg' },
    source: {
      frame: 'visits',
      x: 'week',
      y: 'analgesic_dose_mg',
      by: null,
      rows: 7
    },
    select: 'x',
    series: [
      {
        name: 'all',
        points: [
          { x: 0, y: 200, lo: 190, hi: 210, n: 3 },
          { x: 5, y: 210, lo: 195, hi: 225, n: 2 },
          { x: 10, y: 205, lo: 185, hi: 225, n: 2 }
        ]
      }
    ],
    lines,
    lines_of: { field: 'patient_id', shown: 2, total: 2 }
  };
}

/** The ticks of the y axis, from the bottom up. */
function yTicks(markup: string): string[] {
  return [
    ...markup.matchAll(
      /<g transform="translate\(0,[^)]*\)"><line[^>]*><\/line><text[^>]*>([^<]*)<\/text><\/g>/g
    )
  ].map(match => match[1]);
}

describe('the lines of the units of a ribbon', () => {
  const lines = [
    {
      name: 'P001',
      points: [
        { x: 0, y: 50 },
        { x: 5, y: 100 }
      ]
    },
    {
      name: 'P002',
      points: [
        { x: 0, y: 350 },
        { x: 10, y: 400 }
      ]
    }
  ];

  it('draws a thin line per unit, under the band of the mean', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={trajectory(lines)} width={400} height={220} />
    );
    const units = [
      ...markup.matchAll(/<path class="jp-Epi-plot-unitline" d="([^"]*)"/g)
    ].map(match => match[1]);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatch(/^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/);
    expect(markup.indexOf('jp-Epi-plot-unitline')).toBeLessThan(
      markup.indexOf('<polygon')
    );
  });

  it('stretches the axis to the highest and the lowest unit', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={trajectory(lines)} width={400} height={220} />
    );
    const ticks = yTicks(markup).map(Number);
    expect(Math.min(...ticks)).toBeLessThanOrEqual(100);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(350);
    const alone = yTicks(
      renderToStaticMarkup(
        <EpiPlot payload={trajectory(undefined)} width={400} height={220} />
      )
    ).map(Number);
    expect(Math.max(...alone)).toBeLessThan(250);
  });
});
