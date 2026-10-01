import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { barFilter, barTest, barsText, identifier } from '../model/bars';
import type { IPlotPayload } from '../tokens';
import { EpiPlot, barsAcross } from '../ui/plot';

function bars(values: [string, number][]): IPlotPayload {
  return {
    version: 1,
    kind: 'bars',
    title: 'Arm B × month, by analysis',
    x: { field: 'analysis', label: 'analysis' },
    y: { field: 'estimate', label: 'estimate' },
    source: {
      frame: 'effects',
      x: 'analysis',
      y: 'estimate',
      by: null,
      rows: values.length
    },
    select: 'x',
    bars: values.map(([x, y]) => ({ x, y, n: 1 }))
  };
}

/** The height and width of each bar the plot draws. */
function drawn(markup: string): { width: number; height: number }[] {
  const rects = [...markup.matchAll(/<rect ([^>]*)>/g)].filter(
    match => !match[1].includes('jp-Epi-brush')
  );
  return rects.map(match => ({
    width: Number(/width="([^"]+)"/.exec(match[1])![1]),
    height: Number(/height="([^"]+)"/.exec(match[1])![1])
  }));
}

describe('bar plot', () => {
  const effects = bars([
    ['Mixed model', -0.3183],
    ['Without site east', -0.3688],
    ['MIN_DAYS = 7', -0.3273]
  ]);

  it('draws bars below zero', () => {
    const markup = renderToStaticMarkup(
      <EpiPlot payload={effects} width={260} height={143} />
    );
    const sizes = drawn(markup);
    expect(sizes).toHaveLength(3);
    // Long labels lay the bars across: their length is the width.
    expect(barsAcross(effects)).toBe(true);
    expect(sizes.every(size => size.width > 20 && size.height > 5)).toBe(true);
  });

  it('stands bars with short labels, above and below zero', () => {
    const arms = bars([
      ['A', 0.49],
      ['B', -0.2]
    ]);
    expect(barsAcross(arms)).toBe(false);
    const sizes = drawn(
      renderToStaticMarkup(<EpiPlot payload={arms} width={260} height={143} />)
    );
    expect(sizes.every(size => size.height > 5)).toBe(true);
  });
});

describe('barFilter', () => {
  it('compares with the value the label stands for', () => {
    expect(barFilter('diary', 'month', ['3'], 'int')).toBe(
      'diary["month"] == 3'
    );
    expect(barFilter('diary', 'arm', ['A', 'B'], 'cat')).toBe(
      'diary["arm"].isin(["A", "B"])'
    );
    expect(barFilter('diary', 'flag', ['True'], 'bool')).toBe(
      'diary["flag"] == True'
    );
  });

  it('compares as text when the column is not known', () => {
    expect(barFilter('diary', 'arm', ['A'], null)).toBe(
      'diary["arm"].astype(str) == "A"'
    );
  });
});

describe('barTest', () => {
  it('tests one mean per unit when the frame has the unit', () => {
    const test = barTest({
      frame: 'took_analgesic',
      x: 'treatment_arm',
      y: 'took',
      values: ['A'],
      tag: 'cat',
      unit: 'patient_id',
      picked: barsText('treatment_arm', ['A']),
      others: barsText('treatment_arm', ['B'])
    });
    expect(test.text).toBe(
      'Is treatment_arm A different from treatment_arm B by more than chance?'
    );
    expect(test.effect).toBe('Welch t-test on per-patient means');
    expect(test.code).toContain(
      '_rows = took_analgesic.assign(_picked=took_analgesic["treatment_arm"] == "A")'
    );
    expect(test.code.split('\n').pop()).toBe('took_A_vs_rest');
  });

  it('writes each name as a Python string, and keeps a line break in the comment', () => {
    const test = barTest({
      frame: 'diary',
      x: 'arm "x"',
      y: 'pain\nscore',
      values: ['A'],
      tag: 'cat',
      unit: 'patient"s_id',
      picked: barsText('arm "x"', ['A\nB']),
      others: 'the other bars'
    });
    const lines = test.code.split('\n');
    expect(lines.slice(0, 2)).toEqual([
      '# Is arm "x" A',
      '# B different from the other bars by more than chance?'
    ]);
    expect(lines).toContain(
      '_means = _rows.groupby(["patient\\"s_id", "_picked"], observed=True)["pain\\nscore"].mean().reset_index()'
    );
    expect(lines).toContain(
      '    {"patient\\"ss": [len(_a), len(_b)], "mean pain\\nscore": [_a.mean(), _b.mean()]},'
    );
    expect(lines).toContain(
      '    index=["arm \\"x\\" A\\nB", "the other bars"],'
    );
    expect(lines).toContain(
      'print("Welch t-test on per-patient\\"s means:", f"t = {_test.statistic:.2f}, p = {_test.pvalue:.3g}")'
    );
  });
});

describe('identifier', () => {
  it('makes a Python name', () => {
    expect(identifier('sel_analysis_MIN_DAYS = 7')).toBe(
      'sel_analysis_MIN_DAYS_7'
    );
    expect(identifier('3 bars')).toBe('_3_bars');
  });
});
