/**
 * "Leave out these rows" on the quick look of a number (design iteration
 * 1.85). Before, the quick look of kwh_import showed "lowest 0 ×5" and
 * "highest 999.9 ×4", and only a model could leave those rows out.
 */
import * as React from 'react';

import type * as nbformat from '@jupyterlab/nbformat';

import type { IExtremes } from '../model/leaveout';
import {
  cleanName,
  extremesOf,
  leaveOutCode,
  ruleText
} from '../model/leaveout';
import { RightPanel } from '../ui/exploration';
import type { IBenchCell } from './fakes/bench-fake';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

/** The ends of the readings, as `whybook.summary` gives them for the float32 column. */
const READINGS: IExtremes = {
  frame: 'readings',
  column: 'kwh_import',
  rows: 129058,
  lowest: [
    { value: '0.0', rows: 5 },
    { value: '2.116', rows: 1 },
    { value: '2.202', rows: 1 }
  ],
  highest: [
    { value: '999.9', rows: 4 },
    { value: '171.214', rows: 1 },
    { value: '169.195', rows: 1 }
  ]
};

function summaryOutput(extremes: unknown): nbformat.IOutput {
  return {
    output_type: 'execute_result',
    execution_count: null,
    data: { 'text/plain': 'the table' },
    metadata: { whybook: { extremes } } as any
  };
}

describe('the ends of a quick look', () => {
  it('reads the ends from the metadata of the output, and nothing that is not a number', () => {
    expect(
      extremesOf([
        { output_type: 'stream', name: 'stdout', text: '…' },
        summaryOutput(READINGS)
      ])
    ).toEqual(READINGS);
    expect(extremesOf([summaryOutput({ ...READINGS, frame: 'a; b' })])).toBe(
      null
    );
    expect(
      extremesOf([
        summaryOutput({
          ...READINGS,
          highest: [{ value: '__import__("os")', rows: 1 }]
        })
      ])
    ).toBe(null);
    expect(
      extremesOf([
        summaryOutput({
          ...READINGS,
          highest: [{ value: 'float("inf")', rows: 2 }],
          lowest: [{ value: '-2.5e-07', rows: 1 }]
        })
      ])?.highest
    ).toEqual([{ value: 'float("inf")', rows: 2 }]);
  });

  it('writes a clean frame from the picked ends, names the rule and prints the rows that went', () => {
    const both = leaveOutCode(READINGS, { low: 0, high: 0 }, 'readings_clean');
    expect(both.text).toBe(
      'Leave out the rows of readings where kwh_import is 0 or less, or 999.9 or more'
    );
    expect(both.code).toBe(
      [
        '# Leave out the rows of readings where kwh_import is 0 or less, or 999.9 or more',
        '_kwh_import_left_out = (readings["kwh_import"] <= 0.0) | (readings["kwh_import"] >= 999.9)',
        'readings_clean = readings[~_kwh_import_left_out].copy()',
        'print(f"Left out {_kwh_import_left_out.sum():,} of {len(readings):,} rows,", "where kwh_import is 0 or less, or 999.9 or more.")',
        'del _kwh_import_left_out'
      ].join('\n')
    );
    // A cut further in takes every value before it.
    expect(ruleText(READINGS, { low: 1, high: null })).toBe(
      'kwh_import is 2.116 or less'
    );
    expect(
      leaveOutCode(READINGS, { low: null, high: 2 }, 'readings_clean').code
    ).toContain('_kwh_import_left_out = (readings["kwh_import"] >= 169.195)');
    expect(cleanName('readings', new Set(['readings_clean']))).toBe(
      'readings_clean_2'
    );
  });
});

const CELLS: IBenchCell[] = [
  {
    id: 'a',
    source: 'readings = pd.read_parquet("readings.parquet")',
    count: 1
  }
];

describe('"Leave out these rows" under the quick look', () => {
  it('shows the ends with their rows, and writes the cell of the picked ones', async () => {
    const { model } = benchModel(CELLS);
    model.preview = {
      title: 'Summarise kwh_import: distribution and missingness',
      code: 'whybook.summary(readings, "kwh_import")',
      status: 'done',
      stage: null,
      elapsed: null,
      started: 1,
      thinking: null,
      outputs: [summaryOutput(READINGS)],
      error: null,
      option: {
        id: 'quick',
        text: 'Summarise kwh_import: distribution and missingness',
        type: 'descriptive',
        origin: 'template',
        variables: ["readings['kwh_import']"],
        probability: null,
        reasons: [],
        placement: null,
        code: null
      }
    };
    const apply = jest.spyOn(model, 'apply').mockResolvedValue(undefined);
    const select = jest
      .spyOn(model, 'select')
      .mockImplementation(() => undefined);
    const view = await mount(<RightPanel model={model} width={270} />);
    await settle();
    const button = () =>
      Array.from(
        view.host.querySelectorAll<HTMLButtonElement>('.jp-Epi-preview button')
      );
    const open = button().find(b => b.textContent === 'Leave out these rows')!;
    await step(() => open.click());
    const labels = Array.from(
      view.host.querySelectorAll('.jp-Epi-leaveout label')
    ).map(label => label.textContent);
    const write = () => button().find(b => b.textContent === 'Write the cell')!;
    const before = write().disabled;
    const radios = Array.from(
      view.host.querySelectorAll<HTMLInputElement>('.jp-Epi-leaveout input')
    );
    // The lowest: keep all, 0, 2.116 and 2.202; the highest: keep all, 999.9 ...
    await step(() => radios[1].click());
    await step(() => radios[5].click());
    const rule = view.host.querySelector('.jp-Epi-leaveout-rule')?.textContent;
    await step(() => write().click());
    await settle();
    await view.unmount();
    const [option, place] = apply.mock.calls[0];
    model.dispose();
    expect(labels).toEqual([
      'keep all',
      '0 or less, 5 rows',
      '2.116 or less, 6 rows',
      '2.202 or less, 7 rows',
      'keep all',
      '999.9 or more, 4 rows',
      '171.214 or more, 5 rows',
      '169.195 or more, 6 rows'
    ]);
    expect(before).toBe(true);
    expect(rule).toBe('9 rows go: kwh_import is 0 or less, or 999.9 or more.');
    expect(option.text).toBe(
      'Leave out the rows of readings where kwh_import is 0 or less, or 999.9 or more'
    );
    expect(option.code).toContain(
      'readings_clean = readings[~_kwh_import_left_out].copy()'
    );
    expect(place).toMatchObject({ kind: 'new', cell: 'a' });
    expect(model.preview).toBe(null);
    expect(select).toHaveBeenCalledWith('readings_clean');
  });
});
