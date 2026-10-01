/**
 * The means of a bar plot and the axes of a trajectory (design iteration 1.85).
 * Pain step 27: the bars of the arms averaged rows, with no interval, and
 * the F test of the same arms averaged patients. Pain step 10: the
 * trajectory of pain named its x axis and not its y axis.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { IPlotPayload } from '../tokens';
import { EpiPlot } from '../ui/plot';

const ARMS: IPlotPayload = {
  version: 1,
  kind: 'bars',
  title: 'Mean pain by treatment_arm, one mean per patient',
  x: { field: 'treatment_arm', label: 'treatment_arm' },
  y: { field: 'pain', label: 'pain' },
  source: {
    frame: 'diary_patients',
    x: 'treatment_arm',
    y: 'pain',
    by: null,
    rows: 36941
  },
  select: 'x',
  unit: 'patient',
  bars: [
    { x: 'A', y: 3.626, n: 159, lo: 3.38, hi: 3.87 },
    { x: 'B', y: 2.002, n: 159, lo: 1.77, hi: 2.24 }
  ]
};

const TRAJECTORY: IPlotPayload = {
  version: 1,
  kind: 'ribbon',
  title: 'pain by week: the mean, and a line for 40 of 318 patient_id',
  x: { field: 'week', label: 'week' },
  y: { field: 'pain', label: 'pain' },
  source: {
    frame: 'diary_patients',
    x: 'week',
    y: 'pain',
    by: null,
    rows: 36941
  },
  select: 'x',
  series: [
    {
      name: 'all',
      points: [
        { x: 1, y: 5, lo: 4.8, hi: 5.2, n: 2000 },
        { x: 2, y: 4.6, lo: 4.4, hi: 4.8, n: 1980 }
      ]
    }
  ]
};

describe('the bars of one mean per unit', () => {
  it('draws the 95% interval of each mean, and counts units', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={ARMS} width={400} height={220} />
    );
    const intervals = markup.match(/class="jp-Epi-bar-interval"/g) ?? [];
    expect(intervals).toHaveLength(2);
    expect(markup).toContain(
      '<title>A: 3.63, 95% interval 3.38 to 3.87 · 159 patients</title>'
    );
  });

  it('draws no interval for a bar of a count, which counts rows', () => {
    const counts: IPlotPayload = {
      ...ARMS,
      y: null,
      unit: undefined,
      bars: [{ x: 'A', y: 17218, n: 17218 }]
    };
    const markup = renderToStaticMarkup(
      <EpiPlot payload={counts} width={400} height={220} />
    );
    expect(markup).not.toContain('jp-Epi-bar-interval');
    expect(markup).toContain('· 17,218 rows</title>');
  });
});

describe('the title of the y axis', () => {
  it('names the y axis of a trajectory along its left edge', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={TRAJECTORY} width={500} height={240} />
    );
    expect(markup).toMatch(
      /<text class="jp-Epi-axis-title" transform="translate\(-44,[0-9.]+\) rotate\(-90\)" text-anchor="middle">pain<\/text>/
    );
  });

  it('names the value axis of standing bars, and draws no title in a thumbnail', () => {
    expect(
      renderToStaticMarkup(<EpiPlot payload={ARMS} width={400} height={220} />)
    ).toContain('rotate(-90)" text-anchor="middle">pain</text>');
    expect(
      renderToStaticMarkup(
        <EpiPlot payload={TRAJECTORY} width={120} height={60} thumbnail />
      )
    ).not.toContain('jp-Epi-axis-title');
  });
});
