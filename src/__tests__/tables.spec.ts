import {
  COMPACT_SCALE,
  INLINE_ROWS,
  fingerprint,
  tableInfo,
  tableLevel,
  tableText
} from '../model/tables';

/** A table as pandas writes it: an index column of <th>, values in <td>. */
function frameHtml(rows: number, columns: number, footer = ''): string {
  const head = Array.from({ length: columns }, (_, i) => `<th>c${i}</th>`);
  const body = Array.from(
    { length: rows },
    (_, r) =>
      `<tr><th>${r}</th>${Array.from({ length: columns }, (_, c) => `<td>${r * c}</td>`).join('')}</tr>`
  );
  return (
    '<div><table border="1" class="dataframe">' +
    `<thead><tr style="text-align: right;"><th></th>${head.join('')}</tr></thead>` +
    `<tbody>${body.join('')}</tbody></table>${footer}</div>`
  );
}

describe('tableInfo', () => {
  it('counts the rows and columns of a small frame', () => {
    expect(tableInfo(frameHtml(5, 10))).toEqual({
      rows: 5,
      columns: 10,
      tables: 1
    });
  });

  it('reads the size pandas writes under a table it cuts', () => {
    const html = frameHtml(10, 12, '<p>1428 rows × 12 columns</p>');
    expect(tableInfo(html)).toEqual({ rows: 1428, columns: 12, tables: 1 });
  });

  it('gives no size to an output with several tables', () => {
    expect(tableInfo(frameHtml(2, 2) + frameHtml(3, 3))).toEqual({
      rows: null,
      columns: null,
      tables: 2
    });
  });

  it('reads the size polars writes above a table, and not its row of dtypes', () => {
    // What polars 1.44.2 writes for a frame of 5 rows, style block left out.
    const five =
      '<div><small>shape: (5, 2)</small><table border="1" class="dataframe"><thead><tr><th>arm</th><th>pain</th></tr><tr><td>str</td><td>f64</td></tr></thead><tbody><tr><td>&quot;A&quot;</td><td>3.1</td></tr><tr><td>&quot;B&quot;</td><td>7.2</td></tr><tr><td>&quot;B&quot;</td><td>6.9</td></tr><tr><td>&quot;A&quot;</td><td>3.3</td></tr><tr><td>&quot;A&quot;</td><td>2.8</td></tr></tbody></table></div>';
    expect(tableInfo(five)).toEqual({ rows: 5, columns: 2, tables: 1 });
    expect(
      tableInfo(five.replace('shape: (5, 2)', 'shape: (1_000_000, 2)'))
    ).toEqual({ rows: 1000000, columns: 2, tables: 1 });
    // Five rows fit in full, as the same pandas frame does.
    expect(
      tableLevel(tableInfo(five), { width: 200, height: 150, fontPx: 13 }, 600)
        .level
    ).toBe('inline');
  });
});

describe('tableLevel', () => {
  const small = { rows: INLINE_ROWS, columns: 10, tables: 1 };
  const coefficients = { rows: 8, columns: 6, tables: 1 };
  // 13 px text shrinks to 8 px at most: a scale of 8/13.
  const readable = 8 / 13;

  it('shows a small table in full when it fits', () => {
    const natural = { width: 700, height: 170, fontPx: 13 };
    expect(tableLevel(small, natural, 900)).toEqual({
      level: 'inline',
      scale: 1
    });
  });

  it('shrinks a small table that is too wide, while it stays readable', () => {
    const natural = { width: 700, height: 170, fontPx: 13 };
    expect(tableLevel(small, natural, 600)).toEqual({
      level: 'miniature',
      scale: 600 / 700
    });
    expect(tableLevel(small, natural, 300)).toEqual({
      level: 'tile',
      scale: readable
    });
  });

  it('shrinks a table with more rows to the height of a miniature', () => {
    const natural = { width: 500, height: 260, fontPx: 13 };
    expect(tableLevel(coefficients, natural, 900)).toEqual({
      level: 'miniature',
      scale: 180 / 260
    });
  });

  it('cuts a long table at the smallest readable scale', () => {
    const natural = { width: 500, height: 1700, fontPx: 13 };
    const long = { rows: 1428, columns: 6, tables: 1 };
    expect(tableLevel(long, natural, 900)).toEqual({
      level: 'miniature',
      scale: readable
    });
  });

  it('never shows several tables in full', () => {
    const natural = { width: 300, height: 120, fontPx: 13 };
    const several = { rows: null, columns: null, tables: 2 };
    expect(tableLevel(several, natural, 900).level).toBe('miniature');
  });

  it('shows no table in full at the compact level, and only tiles in the overview', () => {
    const natural = { width: 700, height: 170, fontPx: 13 };
    // A small table that fits shrinks to 70%: its 13 px text reads at 9.1 px.
    expect(tableLevel(small, natural, 900, 'compact')).toEqual({
      level: 'miniature',
      scale: COMPACT_SCALE
    });
    // A narrower card shrinks it to its width, while the text stays readable.
    expect(tableLevel(small, natural, 450, 'compact')).toEqual({
      level: 'miniature',
      scale: 450 / 700
    });
    expect(tableLevel(small, natural, 400, 'compact').level).toBe('tile');
    expect(tableLevel(small, natural, 900, 'overview')).toEqual({
      level: 'tile',
      scale: readable
    });
    // The full level is the default.
    expect(tableLevel(small, natural, 900, 'full')).toEqual(
      tableLevel(small, natural, 900)
    );
  });
});

describe('fingerprint', () => {
  it('is FNV-1a over the text', () => {
    expect(fingerprint('')).toBe('811c9dc5');
    expect(fingerprint('a')).toBe('e40c292c');
  });

  it('matches the hash make_later.py writes into the demo notebook', () => {
    // Both hash UTF-16 code units, so labels written in Python are found.
    expect(fingerprint('4,812 rows × 7 columns')).toBe('ff4cf3fa');
    expect(fingerprint('naïve 📈 plot')).toBe('0d3911b4');
  });

  it('changes with the table', () => {
    expect(fingerprint(frameHtml(5, 10))).not.toBe(
      fingerprint(frameHtml(5, 11))
    );
  });
});

describe('tableText', () => {
  it('prefers the plain text of the output', () => {
    const output = {
      data: { 'text/plain': ['   a  b\n', '0  1  2'], 'text/html': '<table/>' }
    };
    expect(tableText(output as any)).toBe('   a  b\n0  1  2');
  });

  it('reads the cells of the HTML table without plain text', () => {
    const output = { data: { 'text/html': frameHtml(1, 2) } };
    expect(tableText(output as any)).toBe(' | c0 | c1\n0 | 0 | 0');
  });

  it('reads the HTML table when the plain text only names the object', () => {
    // 90 of 2,472 tables in public notebooks save such a placeholder.
    for (const plain of [
      '<IPython.core.display.HTML object>',
      "<class 'statsmodels.iolib.table.SimpleTable'>",
      '<statsmodels.iolib.summary.Summary object at 0x7f3a2c1b9e50>'
    ]) {
      const output = {
        data: { 'text/plain': plain, 'text/html': frameHtml(1, 2) }
      };
      expect(tableText(output as any)).toBe(' | c0 | c1\n0 | 0 | 0');
    }
  });
});
