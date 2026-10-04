import type { ITableSource } from '../model/frametable';
import { readHtml } from '../model/frametable';
import type { ITableRowsSummary } from '../model/tableask';
import {
  listed,
  polarsLabel,
  polarsPicks,
  rowOptions,
  rowsWords
} from '../model/tableask';

describe('rowsWords', () => {
  it('names rows by their labels, or by the column that labels them', () => {
    expect(rowsWords([''], [['3']])).toBe('row 3');
    expect(rowsWords([''], [['0'], ['1']])).toBe('rows 0 and 1');
    expect(rowsWords(['arm'], [['A'], ['B']])).toBe(
      'the rows where arm is A or B'
    );
    expect(rowsWords(['arm', 'week'], [['A', '2']])).toBe(
      'the rows where arm is A and week is 2'
    );
    expect(
      rowsWords(
        ['arm', 'week'],
        [
          ['A', '2'],
          ['B', '1']
        ]
      )
    ).toBe('2 picked rows');
  });

  it('shortens a long list', () => {
    expect(listed(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c and 3 more');
  });

  it('shows a polars label without its quotes', () => {
    expect(polarsLabel('"A"')).toBe('A');
    expect(polarsLabel('"abc\u2026')).toBe('abc\u2026');
    expect(polarsLabel('null')).toBe('null');
    expect(polarsLabel('3')).toBe('3');
  });
});

describe('rowOptions', () => {
  const summary: ITableRowsSummary = {
    rows: 2,
    total_rows: 5,
    where: 'index in 0 and 1',
    mask: 'df.index.isin([0, 1])',
    differences: [
      { column: 'pain', kind: 'number', inside: 4.1, outside: 5, gap: -0.6 }
    ],
    seen: 'Compared with the other 3 rows: mean pain 4.1 against 5.'
  };
  const input = {
    frame: 'df',
    summary,
    words: 'rows 0 and 1',
    keys: [],
    cellId: 'c1',
    cellLabel: '[2]',
    scipy: true,
    missingValues: false,
    unit: null
  };

  it('offers what sets the rows apart, a test on the column that differs most, and why', () => {
    const options = rowOptions(input);
    expect(options.map(option => option.text)).toEqual([
      'What sets rows 0 and 1 apart from the other rows of df?',
      'Is pain different in rows 0 and 1 by more than chance?',
      'Why do rows 0 and 1 differ from the other rows of df?'
    ]);
    expect(options[0].code).toContain('_rows = df.index.isin([0, 1])');
    expect(options[0].placement).toEqual({
      kind: 'new',
      cell: 'c1',
      label: 'new cell after [2]'
    });
    // The question the AI answers has no code.
    expect(options[2].code).toBeNull();
  });

  it('asks about missing values only when the frame has some', () => {
    const texts = rowOptions({ ...input, missingValues: true }).map(
      option => option.text
    );
    expect(texts).toContain('Are values missing more often in rows 0 and 1?');
  });

  it('leaves the columns that label the rows out of the comparison', () => {
    const [apart] = rowOptions({ ...input, keys: ['arm'] });
    expect(apart.code).toContain(
      '_numbers = df.select_dtypes("number").drop(columns=["arm"], errors="ignore")'
    );
  });

  it('tests the means of each unit when the frame has the unit', () => {
    const test = rowOptions({
      ...input,
      unit: 'patient_id',
      summary: { ...summary, units: 2 }
    })[1];
    expect(test.code).toContain(
      '.groupby(["patient_id", "_picked"], observed=True)["pain"].mean()'
    );
  });

  it('writes polars code for a polars frame, with the mask the kernel wrote', () => {
    const polars: ITableRowsSummary = {
      ...summary,
      where: 'rows 0 and 1',
      mask: 'pl.int_range(pl.len()).is_in([0, 1])',
      positions: true,
      library: 'polars'
    };
    const options = rowOptions({
      ...input,
      summary: polars,
      missingValues: true
    });
    expect(options.map(option => option.text)).toEqual([
      'What sets rows 0 and 1 apart from the other rows of df?',
      'Are values missing more often in rows 0 and 1?',
      'Is pain different in rows 0 and 1 by more than chance?',
      'Why do rows 0 and 1 differ from the other rows of df?'
    ]);
    for (const option of options.slice(0, 3)) {
      expect(option.code).toContain('import polars as pl');
      expect(option.code).toContain(
        '_rows = pl.int_range(pl.len()).is_in([0, 1])'
      );
      expect(option.code).not.toContain('pd.');
    }
    expect(options[0].code).toContain(
      'df.filter(~_rows).select(_columns).mean()'
    );
    expect(options[2].code).toContain(
      '_a = df.filter(_rows)["pain"].drop_nulls()'
    );
    // The keys stay out of the comparison, and the unit's means are tested.
    const [apart] = rowOptions({
      ...input,
      summary: polars,
      keys: ['arm']
    });
    expect(apart.code).toContain(
      '_columns = df.select(cs.numeric() - cs.by_name("arm", require_all=False)).columns'
    );
    const test = rowOptions({
      ...input,
      summary: { ...polars, units: 2 },
      unit: 'patient_id'
    })[1];
    expect(test.code).toContain(
      '_means = df.group_by("patient_id", _rows.alias("_picked")).agg(pl.col("pain").mean())'
    );
    // Without a number column, polars has nothing to compare.
    expect(
      rowOptions({ ...input, summary: polars, numbers: false }).map(
        option => option.text
      )
    ).not.toContain('What sets rows 0 and 1 apart from the other rows of df?');
  });

  it('offers no template without code for the rows, and nothing when every row is picked', () => {
    const noMask = rowOptions({
      ...input,
      summary: { ...summary, mask: null }
    });
    expect(noMask.map(option => option.code)).toEqual([null]);
    expect(rowOptions({ ...input, summary: { ...summary, rows: 5 } })).toEqual(
      []
    );
  });

  it('writes each name as a Python string, and keeps a line break in the comment', () => {
    const options = rowOptions({
      ...input,
      words: 'the rows where site is "east"\nor west',
      keys: ['site "x"'],
      unit: 'patient"s_id',
      summary: {
        ...summary,
        units: 2,
        differences: [{ ...summary.differences[0], column: 'pain\nscore' }]
      }
    });
    const [apart, test] = options
      .slice(0, 2)
      .map(option => option.code!.split('\n'));
    expect(apart.slice(0, 2)).toEqual([
      '# What sets the rows where site is "east"',
      '# or west apart from the other rows of df?'
    ]);
    expect(apart).toContain(
      '_numbers = df.select_dtypes("number").drop(columns=["site \\"x\\""], errors="ignore")'
    );
    expect(test).toContain(
      '    {"patient\\"ss": [len(_a), len(_b)], "mean pain\\nscore": [_a.mean(), _b.mean()]},'
    );
    expect(test).toContain(
      'print("Welch t-test on per-patient\\"s means:", f"t = {_test.statistic:.2f}, p = {_test.pvalue:.3g}")'
    );
  });
});

describe('polarsPicks', () => {
  // What polars 1.44.2 writes for `df.with_row_index().group_by("arm").agg(pl.col("index").first())`, style block left out.
  const table = readHtml(
    '<div><small>shape: (2, 2)</small><table border="1" class="dataframe"><thead><tr><th>arm</th><th>index</th></tr><tr><td>str</td><td>u32</td></tr></thead><tbody><tr><td>&quot;A&quot;</td><td>0</td></tr><tr><td>&quot;B&quot;</td><td>1</td></tr></tbody></table></div>'
  )!;
  const source: ITableSource = {
    frame: 'df',
    rows: 'groups',
    headers: 'columns',
    keys: ['arm'],
    expression: null,
    by: 'code',
    reason: ''
  };

  it('finds a group by the values of its keys, as the table writes them', () => {
    expect(polarsPicks(table, source, [1])).toEqual({
      labels: [['"B"']],
      places: false,
      cells: []
    });
  });

  it('finds a row by its place, or by a column that holds its place', () => {
    // With what each row shows, for the kernel to check that the frame
    // still holds it at that place.
    expect(
      polarsPicks(table, { ...source, rows: 'rows', keys: [] }, [0, 1])
    ).toEqual({
      labels: [['0'], ['1']],
      places: true,
      cells: [
        { arm: '"A"', index: '0' },
        { arm: '"B"', index: '1' }
      ]
    });
    expect(
      polarsPicks(
        table,
        { ...source, rows: 'rows', keys: [], place: 'index' },
        [1]
      )
    ).toEqual({
      labels: [['1']],
      places: true,
      cells: [{ arm: '"B"', index: '1' }]
    });
  });

  it('says so when the table does not show a key', () => {
    expect(polarsPicks(table, { ...source, keys: ['week'] }, [0])).toBe(
      'The table does not show week, which Whybook needs to find these rows in df. Keep the table as a variable to ask about its own rows.'
    );
  });
});
