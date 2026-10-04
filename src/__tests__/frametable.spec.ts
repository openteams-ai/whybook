import type { IFrameInfo, IOutputPlace, IReadTable } from '../model/frametable';
import {
  frameColumn,
  parseChain,
  readHtml,
  resolveTable,
  shownExpression,
  statements
} from '../model/frametable';

/*
 * The HTML below is what pandas 3.0 writes for these frames, with the style
 * block and the white space between tags left out.
 */

/** `df.head(2)` */
const HEAD =
  '<div><table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th><th>patient_id</th><th>arm</th><th>age</th><th>pain</th></tr></thead><tbody><tr><th>0</th><td>P1</td><td>A</td><td>34</td><td>3.1</td></tr><tr><th>1</th><td>P2</td><td>B</td><td>51</td><td>5.2</td></tr></tbody></table></div>';

/** `df.set_index("patient_id").head(2)`: the name of the index under the headers. */
const NAMED =
  '<div><table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th><th>arm</th><th>age</th><th>pain</th></tr><tr><th>patient_id</th><th></th><th></th><th></th></tr></thead><tbody><tr><th>P1</th><td>A</td><td>34</td><td>3.1</td></tr><tr><th>P2</th><td>B</td><td>51</td><td>5.2</td></tr></tbody></table></div>';

/** `df.groupby(["arm", df.age > 40])["pain"].mean().to_frame()`: a label over two rows. */
const TWO_LEVELS =
  '<div><table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th><th></th><th>pain</th></tr><tr><th>arm</th><th>age</th><th></th></tr></thead><tbody><tr><th rowspan="2" valign="top">A</th><th>False</th><td>3.10</td></tr><tr><th>True</th><td>4.00</td></tr><tr><th>B</th><th>True</th><td>5.75</td></tr></tbody></table></div>';

/** `df.groupby("arm")[["pain"]].agg(["mean", "std"])`: a header over two columns. */
const AGG =
  '<div><table border="1" class="dataframe"><thead><tr><th></th><th colspan="2" halign="left">pain</th></tr><tr><th></th><th>mean</th><th>std</th></tr><tr><th>arm</th><th></th><th></th></tr></thead><tbody><tr><th>A</th><td>3.55</td><td>0.636396</td></tr><tr><th>B</th><td>5.75</td><td>0.777817</td></tr></tbody></table></div>';

/** A frame of 100 rows and 30 columns, cut to 4 rows and 6 columns. */
const CUT =
  '<div><table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th><th>c0</th><th>c1</th><th>c2</th><th>...</th><th>c27</th><th>c28</th><th>c29</th></tr></thead><tbody><tr><th>0</th><td>0</td><td>1</td><td>2</td><td>...</td><td>27</td><td>28</td><td>29</td></tr><tr><th>1</th><td>30</td><td>31</td><td>32</td><td>...</td><td>57</td><td>58</td><td>59</td></tr><tr><th>...</th><td>...</td><td>...</td><td>...</td><td>...</td><td>...</td><td>...</td><td>...</td></tr><tr><th>98</th><td>2940</td><td>2941</td><td>2942</td><td>...</td><td>2967</td><td>2968</td><td>2969</td></tr><tr><th>99</th><td>2970</td><td>2971</td><td>2972</td><td>...</td><td>2997</td><td>2998</td><td>2999</td></tr></tbody></table><p>100 rows × 30 columns</p></div>';

/** `df.head(2).style`: a Styler writes no `dataframe` class. */
const STYLER =
  '<style type="text/css"></style><table id="T_aa60e"><thead><tr><th class="blank level0" >&nbsp;</th><th id="T_aa60e_level0_col0" class="col_heading level0 col0" >patient_id</th><th id="T_aa60e_level0_col1" class="col_heading level0 col1" >arm</th></tr></thead><tbody><tr><th id="T_aa60e_level0_row0" class="row_heading level0 row0" >0</th><td id="T_aa60e_row0_col0" class="data row0 col0" >P1</td><td id="T_aa60e_row0_col1" class="data row0 col1" >A</td></tr></tbody></table>';

/** A statsmodels coefficient table. */
const SIMPLETABLE =
  '<table class="simpletable"><tr><td></td><th>coef</th><th>std err</th></tr><tr><th>Intercept</th><td>    0.2294</td><td>    0.169</td></tr><tr><th>x</th><td>    1.6156</td><td>    0.206</td></tr></table>';

/** `df.head(2).to_html(index=False)`: pandas without its index. */
const NO_INDEX =
  '<table border="1" class="dataframe">\n  <thead>\n    <tr style="text-align: right;">\n      <th>patient_id</th>\n      <th>arm</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>P1</td>\n      <td>A</td>\n    </tr>\n    <tr>\n      <td>P2</td>\n      <td>B</td>\n    </tr>\n  </tbody>\n</table>';

/*
 * The HTML below is what polars 1.44.2 writes, as `_repr_html_()` gives it:
 * no index, a `shape:` line above the table, a row of dtypes under its
 * header, and strings in double quotes.
 */

/** `df` */
const POLARS =
  '<div><style>\n.dataframe > thead > tr,\n.dataframe > tbody > tr {\n  text-align: right;\n  white-space: pre-wrap;\n}\n</style>\n<small>shape: (2, 4)</small><table border="1" class="dataframe"><thead><tr><th>patient_id</th><th>arm</th><th>age</th><th>pain</th></tr><tr><td>str</td><td>str</td><td>i64</td><td>f64</td></tr></thead><tbody><tr><td>&quot;P1&quot;</td><td>&quot;A&quot;</td><td>34</td><td>3.1</td></tr><tr><td>&quot;P2&quot;</td><td>&quot;B&quot;</td><td>51</td><td>5.2</td></tr></tbody></table></div>';

/** A frame of 100 rows and 30 columns, with `pl.Config(tbl_rows=4, tbl_cols=6)` */
const POLARS_CUT =
  '<div><style>\n.dataframe > thead > tr,\n.dataframe > tbody > tr {\n  text-align: right;\n  white-space: pre-wrap;\n}\n</style>\n<small>shape: (100, 30)</small><table border="1" class="dataframe"><thead><tr><th>c0</th><th>c1</th><th>c2</th><th>&hellip;</th><th>c27</th><th>c28</th><th>c29</th></tr><tr><td>i64</td><td>i64</td><td>i64</td><td>&hellip;</td><td>i64</td><td>i64</td><td>i64</td></tr></thead><tbody><tr><td>0</td><td>1</td><td>2</td><td>&hellip;</td><td>27</td><td>28</td><td>29</td></tr><tr><td>30</td><td>31</td><td>32</td><td>&hellip;</td><td>57</td><td>58</td><td>59</td></tr><tr><td>&hellip;</td><td>&hellip;</td><td>&hellip;</td><td>&hellip;</td><td>&hellip;</td><td>&hellip;</td><td>&hellip;</td></tr><tr><td>2940</td><td>2941</td><td>2942</td><td>&hellip;</td><td>2967</td><td>2968</td><td>2969</td></tr><tr><td>2970</td><td>2971</td><td>2972</td><td>&hellip;</td><td>2997</td><td>2998</td><td>2999</td></tr></tbody></table></div>';

/** `df.group_by("arm", maintain_order=True).agg(pl.col("pain").mean())` */
const POLARS_GROUPS =
  '<div><style>\n.dataframe > thead > tr,\n.dataframe > tbody > tr {\n  text-align: right;\n  white-space: pre-wrap;\n}\n</style>\n<small>shape: (2, 2)</small><table border="1" class="dataframe"><thead><tr><th>arm</th><th>pain</th></tr><tr><td>str</td><td>f64</td></tr></thead><tbody><tr><td>&quot;A&quot;</td><td>3.55</td></tr><tr><td>&quot;B&quot;</td><td>5.2</td></tr></tbody></table></div>';

/** `df` with `pl.Config(tbl_hide_column_data_types=True)` */
const POLARS_NO_DTYPES =
  '<div><style>\n.dataframe > thead > tr,\n.dataframe > tbody > tr {\n  text-align: right;\n  white-space: pre-wrap;\n}\n</style>\n<small>shape: (2, 4)</small><table border="1" class="dataframe"><thead><tr><th>patient_id</th><th>arm</th><th>age</th><th>pain</th></tr></thead><tbody><tr><td>&quot;P1&quot;</td><td>&quot;A&quot;</td><td>34</td><td>3.1</td></tr><tr><td>&quot;P2&quot;</td><td>&quot;B&quot;</td><td>51</td><td>5.2</td></tr></tbody></table></div>';

/** `df` with `pl.Config(tbl_hide_dataframe_shape=True)` */
const POLARS_NO_SHAPE =
  '<div><style>\n.dataframe > thead > tr,\n.dataframe > tbody > tr {\n  text-align: right;\n  white-space: pre-wrap;\n}\n</style>\n<table border="1" class="dataframe"><thead><tr><th>patient_id</th><th>arm</th><th>age</th><th>pain</th></tr><tr><td>str</td><td>str</td><td>i64</td><td>f64</td></tr></thead><tbody><tr><td>&quot;P1&quot;</td><td>&quot;A&quot;</td><td>34</td><td>3.1</td></tr><tr><td>&quot;P2&quot;</td><td>&quot;B&quot;</td><td>51</td><td>5.2</td></tr></tbody></table></div>';

/** `df` with `pl.Config(tbl_hide_column_names=True)` */
const POLARS_NO_NAMES =
  '<div><style>\n.dataframe > thead > tr,\n.dataframe > tbody > tr {\n  text-align: right;\n  white-space: pre-wrap;\n}\n</style>\n<small>shape: (2, 4)</small><table border="1" class="dataframe"><thead><tr><td>str</td><td>str</td><td>i64</td><td>f64</td></tr></thead><tbody><tr><td>&quot;P1&quot;</td><td>&quot;A&quot;</td><td>34</td><td>3.1</td></tr><tr><td>&quot;P2&quot;</td><td>&quot;B&quot;</td><td>51</td><td>5.2</td></tr></tbody></table></div>';

/** `df["pain"]` */
const POLARS_SERIES =
  '<div><style>\n.dataframe > thead > tr,\n.dataframe > tbody > tr {\n  text-align: right;\n  white-space: pre-wrap;\n}\n</style>\n<small>shape: (2,)</small><table border="1" class="dataframe"><thead><tr><th>pain</th></tr><tr><td>f64</td></tr></thead><tbody><tr><td>3.1</td></tr><tr><td>5.2</td></tr></tbody></table></div>';

/** Strings with a run of spaces, and one polars cuts after 30 characters */
const POLARS_TEXT =
  '<div><style>\n.dataframe > thead > tr,\n.dataframe > tbody > tr {\n  text-align: right;\n  white-space: pre-wrap;\n}\n</style>\n<small>shape: (2, 2)</small><table border="1" class="dataframe"><thead><tr><th>note</th><th>n</th></tr><tr><td>str</td><td>i64</td></tr></thead><tbody><tr><td>&quot;two&nbsp;&nbsp;spaces&quot;</td><td>1</td></tr><tr><td>&quot;xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\u2026</td><td>2</td></tr></tbody></table></div>';

function read(html: string): IReadTable {
  const table = readHtml(html);
  if (!table) {
    throw new Error('the table was not read');
  }
  return table;
}

/** What each clickable cell picks, by its text. */
function targets(table: IReadTable): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  for (const [cell, target] of table.targets) {
    found[`${cell.tagName} ${cell.textContent}`] = target;
  }
  return found;
}

describe('readTable', () => {
  it('reads the headers and the row labels of a pandas frame', () => {
    const table = read(HEAD);
    expect(table.library).toBe('pandas');
    expect(table.columns.map(column => column.path)).toEqual([
      ['patient_id'],
      ['arm'],
      ['age'],
      ['pain']
    ]);
    expect(table.rows).toEqual([
      { labels: ['0'], position: 0 },
      { labels: ['1'], position: 1 }
    ]);
    expect(table.index).toEqual(['']);
    expect(table.size).toEqual({ rows: 2, columns: 4 });
    expect(targets(table)).toMatchObject({
      'TH pain': { kind: 'header', path: ['pain'], columns: [3] },
      'TH 1': { kind: 'row', labels: ['1'], rows: [1] }
    });
  });

  it('reads the name of the index, and makes it a header', () => {
    const table = read(NAMED);
    expect(table.index).toEqual(['patient_id']);
    expect(table.columns.map(column => column.path[0])).toEqual([
      'arm',
      'age',
      'pain'
    ]);
    expect(table.rows.map(row => row.labels)).toEqual([['P1'], ['P2']]);
    expect(targets(table)['TH patient_id']).toEqual({
      kind: 'header',
      path: ['patient_id'],
      columns: [],
      index: true
    });
  });

  it('reads an index of two levels, where a label spans rows', () => {
    const table = read(TWO_LEVELS);
    expect(table.index).toEqual(['arm', 'age']);
    expect(table.rows.map(row => row.labels)).toEqual([
      ['A', 'False'],
      ['A', 'True'],
      ['B', 'True']
    ]);
    const picked = targets(table);
    // The outer label picks both of its rows.
    expect(picked['TH A']).toEqual({
      kind: 'row',
      labels: ['A'],
      rows: [0, 1]
    });
    expect(picked['TH False']).toEqual({
      kind: 'row',
      labels: ['A', 'False'],
      rows: [0]
    });
  });

  it('reads columns of two levels, where a header spans columns', () => {
    const table = read(AGG);
    expect(table.columns.map(column => column.path)).toEqual([
      ['pain', 'mean'],
      ['pain', 'std']
    ]);
    expect(table.index).toEqual(['arm']);
    const picked = targets(table);
    expect(picked['TH pain']).toEqual({
      kind: 'header',
      path: ['pain'],
      columns: [0, 1]
    });
    expect(picked['TH std']).toEqual({
      kind: 'header',
      path: ['pain', 'std'],
      columns: [1]
    });
  });

  it('leaves out the rows and columns pandas cuts, and reads the size under the table', () => {
    const table = read(CUT);
    expect(table.cut).toEqual({ rows: true, columns: true });
    expect(table.columns.map(column => column.path[0])).toEqual([
      'c0',
      'c1',
      'c2',
      'c27',
      'c28',
      'c29'
    ]);
    expect(table.rows.map(row => row.labels[0])).toEqual([
      '0',
      '1',
      '98',
      '99'
    ]);
    expect(table.size).toEqual({ rows: 100, columns: 30 });
    expect(Object.keys(targets(table))).not.toContain('TH ...');
  });

  it('reads the headers of a polars frame, and each row by its place', () => {
    const table = read(POLARS);
    expect(table.library).toBe('polars');
    expect(table.columns).toEqual([
      { path: ['patient_id'], position: 0 },
      { path: ['arm'], position: 1 },
      { path: ['age'], position: 2 },
      { path: ['pain'], position: 3 }
    ]);
    expect(table.dtypes).toEqual(['str', 'str', 'i64', 'f64']);
    expect(table.index).toEqual([]);
    expect(table.rows).toEqual([
      {
        labels: ['0'],
        position: 0,
        cells: ['"P1"', '"A"', '34', '3.1']
      },
      {
        labels: ['1'],
        position: 1,
        cells: ['"P2"', '"B"', '51', '5.2']
      }
    ]);
    expect(table.size).toEqual({ rows: 2, columns: 4 });
    // The dtypes are not headers; the first cell of a row picks the row.
    expect(targets(table)).toEqual({
      'TH patient_id': { kind: 'header', path: ['patient_id'], columns: [0] },
      'TH arm': { kind: 'header', path: ['arm'], columns: [1] },
      'TH age': { kind: 'header', path: ['age'], columns: [2] },
      'TH pain': { kind: 'header', path: ['pain'], columns: [3] },
      'TD "P1"': { kind: 'row', labels: ['0'], rows: [0] },
      'TD "P2"': { kind: 'row', labels: ['1'], rows: [1] }
    });
  });

  it('gives the rows under the cut of a polars table their places at the end of the frame', () => {
    const table = read(POLARS_CUT);
    expect(table.cut).toEqual({ rows: true, columns: true });
    expect(table.columns.map(column => column.path[0])).toEqual([
      'c0',
      'c1',
      'c2',
      'c27',
      'c28',
      'c29'
    ]);
    expect(table.rows.map(row => row.labels[0])).toEqual([
      '0',
      '1',
      '98',
      '99'
    ]);
    expect(table.rows.map(row => row.position)).toEqual([0, 1, 3, 4]);
    expect(table.size).toEqual({ rows: 100, columns: 30 });
    expect(Object.keys(targets(table))).not.toContain('TH \u2026');
  });

  it('reads a polars table without its dtypes, a Series, and text with runs of spaces', () => {
    expect(read(POLARS_NO_DTYPES).dtypes).toEqual([]);
    expect(read(POLARS_NO_DTYPES).rows[1].labels).toEqual(['1']);
    const series = read(POLARS_SERIES);
    expect(series.columns.map(column => column.path)).toEqual([['pain']]);
    expect(series.size).toEqual({ rows: 2, columns: 1 });
    // polars writes a run of spaces as non-breaking ones, and cuts long strings.
    expect(read(POLARS_TEXT).rows.map(row => row.cells![0])).toEqual([
      '"two  spaces"',
      `"${'x'.repeat(30)}\u2026`
    ]);
    expect(read(POLARS_GROUPS).rows.map(row => row.cells)).toEqual([
      ['"A"', '3.55'],
      ['"B"', '5.2']
    ]);
  });

  it('leaves tables that are not pandas or polars frames alone', () => {
    expect(readHtml(STYLER)).toBeNull();
    expect(readHtml(SIMPLETABLE)).toBeNull();
    expect(readHtml(NO_INDEX)).toBeNull();
    // polars told to hide the size or the names writes a layout the reader
    // does not take for polars.
    expect(readHtml(POLARS_NO_SHAPE)).toBeNull();
    expect(readHtml(POLARS_NO_NAMES)).toBeNull();
    // A size that does not match the table.
    expect(
      readHtml(POLARS.replace('shape: (2, 4)', 'shape: (3, 4)'))
    ).toBeNull();
  });
});

describe('shownExpression', () => {
  const result = { type: 'execute_result', display: -1, displays: 0 };

  it('finds the last line of a cell', () => {
    expect(
      shownExpression('import pandas as pd\ndf = load()\ndf.head()', result)
    ).toBe('df.head()');
    expect(shownExpression('df = load()', result)).toBeNull();
    expect(shownExpression('a = 1; df.tail(3)', result)).toBe('df.tail(3)');
    expect(shownExpression('x += 1', result)).toBeNull();
    expect(shownExpression('df.a == 3', result)).toBe('df.a == 3');
  });

  it('reads a chain that spans lines, with comments and strings', () => {
    const source = [
      'summary = (',
      '    df.groupby("arm")  # one row per arm',
      ')',
      '(df',
      '  .query("pain > 3  # not a comment")',
      '  .head())'
    ].join('\n');
    expect(shownExpression(source, result)).toBe(
      '(df\n  .query("pain > 3  # not a comment")\n  .head())'
    );
  });

  it('shows nothing for a line inside a block or a magic', () => {
    expect(
      shownExpression('for part in parts:\n    part.head()', result)
    ).toBeNull();
    expect(shownExpression('%%time\ndf.head()', result)).toBeNull();
  });

  it('finds the argument of each display() call, in order', () => {
    const source = 'display(a.head())\nprint("x")\ndisplay(b, raw=False)';
    expect(
      shownExpression(source, { type: 'display_data', display: 1, displays: 2 })
    ).toBe('b');
    // One call in a loop shows several tables: the code does not say which.
    expect(
      shownExpression('for p in parts:\n    display(p)', {
        type: 'display_data',
        display: 0,
        displays: 3
      })
    ).toBeNull();
  });

  it('splits statements at newlines and semicolons outside brackets', () => {
    expect(
      statements('a = [1,\n  2]; b = 3\n  # note\nc').map(s => s.text)
    ).toEqual(['a = [1,\n  2]', 'b = 3', 'c']);
  });
});

describe('parseChain', () => {
  it('reads attributes, calls and subscripts on a name', () => {
    expect(parseChain('df.groupby("arm")[["age", "pain"]].mean()')).toEqual({
      base: 'df',
      steps: [
        { name: 'groupby', args: '"arm"', subscript: null },
        { name: null, args: null, subscript: '["age", "pain"]' },
        { name: 'mean', args: '', subscript: null }
      ]
    });
    expect(parseChain('df.T')).toEqual({
      base: 'df',
      steps: [{ name: 'T', args: null, subscript: null }]
    });
  });

  it('gives nothing for other expressions', () => {
    expect(parseChain('df.a + 1')).toBeNull();
    expect(parseChain('"text".upper()')).toBeNull();
  });
});

describe('resolveTable', () => {
  const frames: IFrameInfo[] = [
    {
      name: 'df',
      columns: ['patient_id', 'arm', 'age', 'pain'],
      rows: 4
    },
    { name: 'visits', columns: ['patient_id', 'visit', 'crp'], rows: 12 }
  ];
  const result: IOutputPlace = {
    type: 'execute_result',
    display: -1,
    displays: 0,
    tables: 1
  };
  const resolve = (html: string, source: string, others = frames) =>
    resolveTable(read(html), { source, output: result, frames: others });

  it('finds the rows of a frame shown by name or cut by head()', () => {
    expect(resolve(HEAD, 'df.head(2)')).toMatchObject({
      frame: 'df',
      rows: 'rows',
      headers: 'columns',
      keys: [],
      by: 'code'
    });
    expect(
      resolve(HEAD, 'df[df["age"] > 30].sort_values("pain")')
    ).toMatchObject({ frame: 'df', rows: 'rows', keys: [] });
  });

  it('labels the rows by the columns of set_index and groupby', () => {
    expect(resolve(NAMED, 'df.set_index("patient_id").head(2)')).toMatchObject({
      frame: 'df',
      rows: 'rows',
      keys: ['patient_id']
    });
    expect(
      resolve(AGG, 'df.groupby("arm")[["pain"]].agg(["mean", "std"])')
    ).toMatchObject({ frame: 'df', rows: 'groups', keys: ['arm'] });
    // Groups made by an expression: the view cannot map them to rows.
    expect(
      resolve(
        TWO_LEVELS,
        'df.groupby(["arm", df.age > 40])["pain"].mean().to_frame()'
      )
    ).toMatchObject({ frame: 'df', rows: 'groups', keys: null });
  });

  it('tells statistics and columns from rows', () => {
    expect(resolve(HEAD, 'df.describe()')).toMatchObject({
      frame: 'df',
      rows: 'statistics',
      headers: 'columns'
    });
    expect(resolve(HEAD, 'df.describe().T')).toMatchObject({
      rows: 'columns',
      headers: 'statistics'
    });
    expect(resolve(HEAD, 'df.corr(numeric_only=True).round(2)')).toMatchObject({
      rows: 'columns',
      headers: 'columns'
    });
    expect(resolve(HEAD, 'df["arm"].value_counts().to_frame()')).toMatchObject({
      rows: 'groups',
      keys: ['arm'],
      headers: 'statistics'
    });
    expect(resolve(HEAD, 'df.sort_values("age").reset_index()')).toMatchObject({
      frame: 'df',
      rows: null,
      keys: null
    });
  });

  it('finds the frame by the columns when the code does not name one', () => {
    const concat = resolve(HEAD, 'pd.concat([a, b])');
    expect(concat).toMatchObject({ frame: 'df', by: 'columns', rows: null });
    expect(concat.reason).toContain('cannot tell which of its rows');
    // As many rows as the frame: its own rows.
    const all = resolve(HEAD, 'show(df)', [
      { name: 'df', columns: ['patient_id', 'arm', 'age', 'pain'], rows: 2 }
    ]);
    expect(all).toMatchObject({ frame: 'df', rows: 'rows', keys: [] });
  });

  it('says why it cannot tell', () => {
    const twice = resolve(HEAD, 'pd.concat([a, b])', [
      ...frames,
      { name: 'copy', columns: ['patient_id', 'arm', 'age', 'pain'], rows: 9 }
    ]);
    expect(twice.frame).toBeNull();
    expect(twice.reason).toBe(
      'Whybook cannot tell which frame pd.concat([a, b]) shows: df and copy have its columns.'
    );
    const none = resolve(HEAD, 'make()', [frames[1]]);
    expect(none.frame).toBeNull();
    expect(none.reason).toBe(
      'Whybook cannot tell which frame make() shows: no frame in the kernel has its columns.'
    );
  });

  describe('polars', () => {
    const polarsFrames: IFrameInfo[] = [
      {
        name: 'df',
        columns: ['patient_id', 'arm', 'age', 'pain'],
        rows: 2
      }
    ];
    const polars = (source: string, html = POLARS, others = polarsFrames) =>
      resolveTable(read(html), { source, output: result, frames: others });

    it('finds a row of a polars frame by its place while the code keeps the rows in place', () => {
      for (const source of [
        'df',
        'df.head()',
        'df.select("arm", "pain").head(2)',
        'df.with_columns(pl.col("pain") * 2)'
      ]) {
        expect(polars(source)).toMatchObject({
          frame: 'df',
          rows: 'rows',
          keys: [],
          by: 'code'
        });
      }
      // with_row_index() keeps each row's place in a column.
      expect(
        polars('df.with_row_index().filter(pl.col("age") > 40)')
      ).toMatchObject({ rows: 'rows', keys: [], place: 'index', asIs: true });
      // The kernel checks the cells of a row against the frame, unless the
      // code changes them.
      expect(polars('df.select("arm", "pain").head(2)').asIs).toBe(true);
      expect(polars('df.with_columns(pl.col("pain") * 2)').asIs).toBe(false);
    });

    it('says when a row of a polars table is no longer at its place', () => {
      for (const [source, method] of [
        ['df.filter(pl.col("age") > 40)', 'filter()'],
        ['df.sort("pain")', 'sort()'],
        ['df.sample(2)', 'sample()'],
        ['df.tail(2)', 'tail()'],
        ['df.head(5).unique()', 'unique()'],
        ['df.group_by("arm").head(1)', 'group_by().head()']
      ]) {
        const found = polars(source);
        expect(found).toMatchObject({ frame: 'df', rows: null, keys: null });
        expect(found.reason).toBe(
          `Whybook cannot tell which rows of df these are. A polars table has no row labels, and after ${method} a row's place in the table is not its place in df.`
        );
      }
      // The frame changed since the table was shown.
      expect(
        polars('df', POLARS, [{ ...polarsFrames[0], rows: 5 }]).reason
      ).toBe(
        'Whybook cannot tell which rows of df these are: the table has 2 rows, and df has 5 now.'
      );
      // Without the code, the view finds the frame for the headers, and no rows.
      expect(polars('pl.concat([a, b])')).toMatchObject({
        frame: 'df',
        by: 'columns',
        rows: null,
        headers: 'columns'
      });
    });

    it('finds the groups of a polars group_by by the values of its keys', () => {
      const grouped =
        'df.group_by("arm", maintain_order=True).agg(pl.col("pain").mean())';
      expect(polars(grouped, POLARS_GROUPS)).toMatchObject({
        frame: 'df',
        rows: 'groups',
        keys: ['arm'],
        headers: 'columns'
      });
      expect(
        polars('df.group_by(pl.col("arm")).len().sort("len")', POLARS_GROUPS)
      ).toMatchObject({ rows: 'groups', keys: ['arm'] });
      expect(
        polars(`${grouped}.filter(pl.col("pain") > 3)`, POLARS_GROUPS)
      ).toMatchObject({ rows: 'groups', keys: ['arm'] });
      // Keys that are expressions, or code that changes a key, lose the groups.
      expect(
        polars('df.group_by(pl.col("age") > 40).agg(pl.col("pain").mean())')
      ).toMatchObject({ rows: 'groups', keys: null });
      expect(
        polars(
          `${grouped}.with_columns(pl.col("arm").str.to_lowercase())`,
          POLARS_GROUPS
        )
      ).toMatchObject({ rows: null, keys: null });
      expect(polars('df["arm"].value_counts()')).toMatchObject({
        rows: 'groups',
        keys: ['arm'],
        headers: 'statistics'
      });
    });

    it('tells statistics and columns from rows in polars, where mean() is one row', () => {
      for (const source of ['df.mean()', 'df.describe()', 'df.null_count()']) {
        expect(polars(source)).toMatchObject({
          rows: 'statistics',
          headers: 'columns'
        });
      }
      expect(polars('df.select("age", "pain").corr()')).toMatchObject({
        rows: 'columns',
        headers: 'columns'
      });
    });
  });

  it('names the column of the frame under a header', () => {
    expect(frameColumn(['pain', 'mean'], frames[0].columns)).toBe('pain');
    expect(frameColumn(['n'], frames[0].columns)).toBeNull();
  });
});
