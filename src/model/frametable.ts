/**
 * Tables of data frames in outputs: what their headers and row labels are,
 * and which frame of the kernel a table shows.
 *
 * A reader reads the HTML that one library writes, and gives the same
 * IReadTable for any library: pandas and polars have one each. Both write
 * `<table class="dataframe">`. pandas starts each row of the body with the
 * labels of its index in `<th>`. polars writes no index: a `shape:` line
 * above the table, a row of dtypes under its header, and `<td>` cells only,
 * so the first cell of a row picks the row, and a row is its place in the
 * frame. A pandas Styler writes `<th class="col_heading level0">` without
 * the `dataframe` class, and both readers leave it alone.
 */

export interface ITableColumn {
  /**
   * The header of each level, top first: ['pain'], or ['pain', 'mean'] under
   * a header that spans two columns.
   */
  path: string[];
  /** Its place among the columns the table shows, from 0. */
  position: number;
}

export interface ITableRow {
  /**
   * The label of each level of the index, outer first: ['P3'], ['A', 'True'].
   * polars writes no index: its one label is the row's place in the frame
   * the table shows, from 0, after the rows the table leaves out.
   */
  labels: string[];
  /** Its place among the rows of the table's body, from 0. */
  position: number;
  /**
   * polars: the text of each cell, by the place of its column, as polars
   * writes it: `"A"` in double quotes, `null`, `true`, `0.333333`.
   */
  cells?: string[];
}

/** What a header or a row label picks when it is clicked. */
export type TableTarget =
  | {
      kind: 'header';
      /** The headers down to this one: ['pain'] for a header over two columns. */
      path: string[];
      /** The places of the columns under it; none for the name of the index. */
      columns: number[];
      /** The name of a level of the index, which pandas writes under the headers. */
      index?: boolean;
    }
  | {
      kind: 'row';
      /** The labels down to this one: ['A'] for a label that spans two rows. */
      labels: string[];
      /** The places of the rows it labels. */
      rows: number[];
    };

export interface IReadTable {
  /** The library that wrote the table. */
  library: string;
  columns: ITableColumn[];
  rows: ITableRow[];
  /** The names of the levels of the index, '' where a level has none. */
  index: string[];
  /** Whether the table leaves out rows or columns, as a row or column of '...'. */
  cut: { rows: boolean; columns: boolean };
  /** The size of the frame: from the line pandas writes under a cut table, else as shown. */
  size: { rows: number; columns: number };
  /** What each header cell and each row label picks. */
  targets: Map<Element, TableTarget>;
  /** The row of the body that each `<tr>` shows. */
  rowOf: Map<Element, number>;
  /** The cells of the body in each column, by the column's place. */
  columnCells: Map<number, Element[]>;
  /** polars: the dtype of each column, by its place (`i64`, `str`), when shown. */
  dtypes?: string[];
}

export interface ITableReader {
  library: string;
  /** The table read, or null when the library did not write it. */
  read(table: HTMLTableElement): IReadTable | null;
}

/** What pandas writes in place of the rows and columns it leaves out. */
const CUT = '...';

// pandas writes the full size in a paragraph under a table that it cuts.
const DIMENSIONS = /^\s*(\d[\d,]*) rows × (\d[\d,]*) columns\s*$/;

type Grid = (HTMLTableCellElement | undefined)[][];

function text(cell: Element | undefined): string {
  return (cell?.textContent ?? '').trim();
}

function span(cell: Element, name: 'colspan' | 'rowspan'): number {
  const value = parseInt(cell.getAttribute(name) ?? '1', 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** The cell at each row and column of a table section, with the spans laid out. */
function layout(rows: HTMLTableRowElement[]): Grid {
  const grid: Grid = rows.map(() => []);
  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of Array.from(row.cells)) {
      while (grid[r][c]) {
        c++;
      }
      const across = span(cell, 'colspan');
      const down = span(cell, 'rowspan');
      for (let dr = 0; dr < down && r + dr < rows.length; dr++) {
        for (let dc = 0; dc < across; dc++) {
          grid[r + dr][c + dc] = cell;
        }
      }
      c += across;
    }
  });
  return grid;
}

/** The headers of a column without the empty levels at its end. */
function trimPath(path: string[]): string[] {
  const end = path.length - [...path].reverse().findIndex(label => label);
  return end > path.length ? [] : path.slice(0, end);
}

function footerSize(
  table: HTMLTableElement
): { rows: number; columns: number } | null {
  const paragraphs = table.parentElement
    ? Array.from(table.parentElement.children).filter(
        child => child.tagName === 'P'
      )
    : [];
  for (const paragraph of paragraphs) {
    const match = DIMENSIONS.exec(paragraph.textContent ?? '');
    if (match) {
      const count = (value: string) => parseInt(value.replace(/,/g, ''), 10);
      return { rows: count(match[1]), columns: count(match[2]) };
    }
  }
  return null;
}

/**
 * pandas: `<table class="dataframe">`, the column headers in `<thead>`, each
 * row of the body started by the labels of its index in `<th>`. A header of
 * a MultiIndex spans its columns, and a label of a MultiIndex spans its
 * rows. Under the headers, a row holds the names of the index levels when
 * the index has a name.
 */
export const PANDAS: ITableReader = {
  library: 'pandas',
  read(table) {
    if (!table.classList.contains('dataframe')) {
      return null;
    }
    const head = table.tHead;
    const body = table.tBodies[0];
    if (!head || !body || !body.rows.length) {
      return null;
    }
    const bodyRows = Array.from(body.rows);
    const bodyGrid = layout(bodyRows);
    // The index: the header cells that start each row of the body.
    const levels = Math.max(
      ...bodyGrid.map(row => {
        let count = 0;
        while (row[count]?.tagName === 'TH') {
          count++;
        }
        return count;
      })
    );
    if (levels === 0) {
      // pandas writes the index; polars and `to_html(index=False)` do not.
      return null;
    }
    const width = Math.max(...bodyGrid.map(row => row.length)) - levels;
    const headGrid = layout(Array.from(head.rows));
    const levelRows: Grid = [];
    let names: Grid[number] = [];
    for (const row of headGrid) {
      const data = Array.from({ length: width }, (_, p) =>
        text(row[levels + p])
      );
      const lead = Array.from({ length: levels }, (_, l) => text(row[l]));
      if (data.every(label => !label) && lead.some(label => label)) {
        names = row.slice(0, levels);
      } else {
        levelRows.push(row);
      }
    }
    if (!levelRows.length) {
      return null;
    }
    const targets = new Map<Element, TableTarget>();
    const columns: ITableColumn[] = [];
    let cutColumns = false;
    for (let p = 0; p < width; p++) {
      const path = levelRows.map(row => text(row[levels + p]));
      if (path.every(label => label === CUT)) {
        cutColumns = true;
        continue;
      }
      columns.push({ path: trimPath(path), position: p });
    }
    const shown = new Set(columns.map(column => column.position));
    levelRows.forEach((row, level) => {
      for (let p = 0; p < width; p++) {
        const cell = row[levels + p];
        const label = text(cell);
        if (!cell || targets.has(cell) || !label || label === CUT) {
          continue;
        }
        const under: number[] = [];
        for (let q = p; q < width && row[levels + q] === cell; q++) {
          if (shown.has(q)) {
            under.push(q);
          }
        }
        targets.set(cell, {
          kind: 'header',
          path: trimPath(
            levelRows.slice(0, level + 1).map(each => text(each[levels + p]))
          ),
          columns: under
        });
      }
    });
    const index = Array.from({ length: levels }, (_, l) => text(names[l]));
    names.forEach(cell => {
      const label = text(cell);
      if (cell && label && !targets.has(cell)) {
        targets.set(cell, {
          kind: 'header',
          path: [label],
          columns: [],
          index: true
        });
      }
    });
    const rows: ITableRow[] = [];
    const rowOf = new Map<Element, number>();
    let cutRows = false;
    bodyGrid.forEach((row, r) => {
      const labels = Array.from({ length: levels }, (_, l) => text(row[l]));
      if (labels.every(label => label === CUT)) {
        cutRows = true;
        return;
      }
      rowOf.set(bodyRows[r], r);
      rows.push({ labels, position: r });
    });
    for (const row of rows) {
      for (let l = 0; l < levels; l++) {
        const cell = bodyGrid[row.position][l];
        if (!cell || targets.has(cell) || !row.labels[l]) {
          continue;
        }
        targets.set(cell, {
          kind: 'row',
          labels: row.labels.slice(0, l + 1),
          rows: rows
            .filter(other => bodyGrid[other.position][l] === cell)
            .map(other => other.position)
        });
      }
    }
    const columnCells = new Map<number, Element[]>();
    for (const column of columns) {
      columnCells.set(
        column.position,
        rows
          .map(row => bodyGrid[row.position][levels + column.position])
          .filter((cell): cell is HTMLTableCellElement => !!cell)
      );
    }
    return {
      library: 'pandas',
      columns,
      rows,
      index,
      cut: { rows: cutRows, columns: cutColumns },
      size: footerSize(table) ?? {
        rows: rows.length,
        columns: columns.length
      },
      targets,
      rowOf,
      columnCells
    };
  }
};

/** What polars writes in place of the rows and columns it leaves out. */
const POLARS_CUT = '\u2026';

// polars writes the size above the table: `shape: (1_000, 3)`, or `(5,)` for a Series.
const POLARS_SHAPE = /^\s*shape: \((\d[\d_]*),\s*(\d[\d_]*)?\)\s*$/;

/** The size in a `shape:` line of polars, or null for any other text. */
export function polarsShape(
  line: string
): { rows: number; columns: number } | null {
  const match = POLARS_SHAPE.exec(line);
  if (!match) {
    return null;
  }
  const count = (value: string) => parseInt(value.replace(/_/g, ''), 10);
  return {
    rows: count(match[1]),
    columns: match[2] === undefined ? 1 : count(match[2])
  };
}

/** The text of a cell of polars: it writes runs of spaces as non-breaking ones. */
function polarsText(cell: Element | undefined): string {
  return text(cell).replace(/\u00a0/g, ' ');
}

/**
 * polars: a `<small>shape: (rows, columns)</small>` line just before
 * `<table class="dataframe">`, a row of `<th>` names in `<thead>`, then a row
 * of `<td>` dtypes, and `<td>` cells only in the body. A table it cuts has a
 * column and a row of `…`: the rows above the `…` row are the first rows of
 * the frame, and those under it the last. Any other layout, such as a table
 * whose names or `shape:` line polars was told to hide, is left alone.
 */
export const POLARS: ITableReader = {
  library: 'polars',
  read(table) {
    if (!table.classList.contains('dataframe')) {
      return null;
    }
    const line = table.previousElementSibling;
    const shape =
      line?.tagName === 'SMALL' ? polarsShape(line.textContent ?? '') : null;
    const head = table.tHead;
    const body = table.tBodies[0];
    if (!shape || !head || !body || !body.rows.length) {
      return null;
    }
    const headRows = Array.from(head.rows);
    const tagsOf = (row: HTMLTableRowElement) =>
      new Set(Array.from(row.cells).map(cell => cell.tagName));
    const names = headRows[0];
    const types = headRows[1];
    if (
      !names ||
      headRows.length > 2 ||
      !names.cells.length ||
      [...tagsOf(names)].join() !== 'TH' ||
      (types && [...tagsOf(types)].join() !== 'TD')
    ) {
      return null;
    }
    const width = names.cells.length;
    const bodyRows = Array.from(body.rows);
    const plain = (row: HTMLTableRowElement) =>
      row.cells.length === width &&
      Array.from(row.cells).every(
        cell =>
          cell.tagName === 'TD' &&
          span(cell, 'colspan') === 1 &&
          span(cell, 'rowspan') === 1
      );
    if ((types && types.cells.length !== width) || !bodyRows.every(plain)) {
      return null;
    }
    const targets = new Map<Element, TableTarget>();
    const columns: ITableColumn[] = [];
    let cutColumns = false;
    for (let p = 0; p < width; p++) {
      const label = text(names.cells[p]);
      if (label === POLARS_CUT) {
        cutColumns = true;
        continue;
      }
      columns.push({ path: [label], position: p });
      targets.set(names.cells[p], {
        kind: 'header',
        path: [label],
        columns: [p]
      });
    }
    if (!columns.length || text(names.cells[0]) === POLARS_CUT) {
      return null;
    }
    const cutRow = bodyRows.findIndex(row =>
      Array.from(row.cells).every(cell => text(cell) === POLARS_CUT)
    );
    const shown = bodyRows.length - (cutRow >= 0 ? 1 : 0);
    // The size must agree with what the table shows, or it is not polars'.
    if (
      (cutRow >= 0 ? shown >= shape.rows : shown !== shape.rows) ||
      (cutColumns
        ? columns.length >= shape.columns
        : columns.length !== shape.columns)
    ) {
      return null;
    }
    const rows: ITableRow[] = [];
    const rowOf = new Map<Element, number>();
    bodyRows.forEach((row, r) => {
      if (r === cutRow) {
        return;
      }
      // Under the `…` row, the last rows of the frame.
      const place =
        cutRow >= 0 && r > cutRow ? shape.rows - (bodyRows.length - r) : r;
      const labels = [String(place)];
      rows.push({
        labels,
        position: r,
        cells: Array.from(row.cells).map(cell => polarsText(cell))
      });
      rowOf.set(row, r);
      targets.set(row.cells[0], { kind: 'row', labels, rows: [r] });
    });
    const columnCells = new Map<number, Element[]>();
    for (const column of columns) {
      columnCells.set(
        column.position,
        rows.map(row => bodyRows[row.position].cells[column.position])
      );
    }
    return {
      library: 'polars',
      columns,
      rows,
      index: [],
      cut: { rows: cutRow >= 0, columns: cutColumns },
      size: shape,
      targets,
      rowOf,
      columnCells,
      dtypes: types ? Array.from(types.cells).map(cell => text(cell)) : []
    };
  }
};

/** The readers, tried in turn. */
export const TABLE_READERS: ITableReader[] = [PANDAS, POLARS];

/** The table read by the first reader that knows it, or null. */
export function readTable(table: HTMLTableElement): IReadTable | null {
  for (const reader of TABLE_READERS) {
    const read = reader.read(table);
    if (read) {
      return read;
    }
  }
  return null;
}

/** The first table of some HTML, read; for tests and for outputs not in the page. */
export function readHtml(html: string): IReadTable | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  return table ? readTable(table as HTMLTableElement) : null;
}

/*
 * Which frame a table shows, from the code of its cell and the frames the
 * kernel holds.
 */

/** A frame of the kernel's variable listing. */
export interface IFrameInfo {
  name: string;
  columns: string[];
  rows: number | null;
  /** From the last run, as the notebook kept it: not in the kernel now. */
  stale?: boolean;
}

/**
 * What a row, or a header, of a table stands for: a row of the frame, a
 * group of its rows, a statistic, or one of its columns. Null when the view
 * cannot tell.
 */
export type TableAxis = 'rows' | 'groups' | 'statistics' | 'columns' | null;

export interface ITableSource {
  /** The frame in the kernel the table shows, or null when the view cannot tell. */
  frame: string | null;
  /** What a row of the table is. */
  rows: TableAxis;
  /** What a header of the table is. */
  headers: TableAxis;
  /**
   * The columns of the frame whose values label the rows, as after
   * `groupby` or `set_index`; empty when the frame's own index labels them,
   * or, in a polars table, when a row is the row at the same place in the
   * frame; null when the view cannot tell.
   */
  keys: string[] | null;
  /** The code that shows the table, when the view found it. */
  expression: string | null;
  /** How the view found the frame: from the code, or from the columns. */
  by: 'code' | 'columns' | null;
  /** One sentence: why the view cannot tell, or what it found. */
  reason: string;
  /**
   * polars: a column of the table that holds each row's place in the frame,
   * as `with_row_index()` adds it before a filter or a sort.
   */
  place?: string | null;
  /**
   * polars: whether the cells show the frame's own values, so that the
   * kernel can check that a row found by its place still holds them.
   */
  asIs?: boolean;
}

/** How an output came from its cell. */
export interface IOutputPlace {
  /** `execute_result` for the value of the last line, `display_data` for display(). */
  type: string;
  /** Its place among the cell's display_data outputs that hold a table, or -1. */
  display: number;
  /** How many display_data outputs of the cell hold a table. */
  displays: number;
  /** How many HTML tables the output holds. */
  tables: number;
}

/** A statement of a cell's code, with the indentation of its first line. */
interface IStatement {
  text: string;
  indent: number;
}

/**
 * The statements of a cell's code, nested ones too. A statement ends at a
 * newline or a semicolon outside brackets and strings; comments are left out.
 */
export function statements(source: string): IStatement[] {
  if (/^\s*%%/.test(source)) {
    // A cell magic: the rest of the cell is not Python.
    return [];
  }
  const found: IStatement[] = [];
  let current = '';
  let indent = 0;
  let atStart = true;
  // A statement after a semicolon has the indentation of its line.
  let sameLine = false;
  let depth = 0;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) {
      found.push({ text: trimmed, indent });
    }
    current = '';
    atStart = true;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (atStart) {
      if (/\s/.test(char)) {
        sameLine = sameLine && char !== '\n';
        continue;
      }
      if (!sameLine) {
        indent = i - (source.lastIndexOf('\n', i - 1) + 1);
      }
      sameLine = false;
      atStart = false;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      i--;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = stringEnd(source, i);
      current += source.slice(i, end);
      i = end - 1;
      continue;
    }
    if (char === '\\' && source[i + 1] === '\n') {
      current += ' ';
      i++;
      continue;
    }
    if ('([{'.includes(char)) {
      depth++;
    } else if (')]}'.includes(char)) {
      depth = Math.max(0, depth - 1);
    }
    if ((char === '\n' || char === ';') && depth === 0) {
      push();
      sameLine = char === ';';
      continue;
    }
    current += char;
  }
  push();
  return found;
}

/** The index after the string that starts at `start`, triple quotes included. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  const triple = source.startsWith(quote.repeat(3), start);
  const close = triple ? quote.repeat(3) : quote;
  let i = start + close.length;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source.startsWith(close, i)) {
      return i + close.length;
    }
    if (!triple && source[i] === '\n') {
      return i;
    }
    i++;
  }
  return source.length;
}

/** The index of the bracket that closes the one at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'") {
      i = stringEnd(text, i) - 1;
      continue;
    }
    if ('([{'.includes(char)) {
      depth++;
    } else if (')]}'.includes(char)) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** The parts of a text split at the commas outside brackets and strings. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'") {
      i = stringEnd(text, i) - 1;
      continue;
    }
    if ('([{'.includes(char)) {
      depth++;
    } else if (')]}'.includes(char)) {
      depth--;
    } else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) {
    parts.push(last);
  }
  return parts;
}

const STATEMENT_KEYWORDS =
  /^(def|class|if|elif|else|for|while|with|try|except|finally|import|from|return|del|pass|raise|assert|global|nonlocal|break|continue|async|yield|print)\b/;

/** Whether a statement is an expression whose value the cell would show. */
function isExpression(statement: string): boolean {
  if (STATEMENT_KEYWORDS.test(statement) || /^[%!@?]/.test(statement)) {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < statement.length; i++) {
    const char = statement[i];
    if (char === '"' || char === "'") {
      i = stringEnd(statement, i) - 1;
      continue;
    }
    if ('([{'.includes(char)) {
      depth++;
    } else if (')]}'.includes(char)) {
      depth--;
    } else if (depth === 0 && char === ':') {
      // An annotation, or the colon of a block.
      return false;
    } else if (depth === 0 && char === '=') {
      const before = statement[i - 1] ?? '';
      const after = statement[i + 1] ?? '';
      if (after === '=') {
        i++;
        continue;
      }
      if (!'=!<>'.includes(before)) {
        // An assignment, augmented ones included.
        return false;
      }
    }
  }
  return true;
}

/** The objects that `display(...)` calls in these statements show, in order. */
function displayed(found: IStatement[]): string[] {
  const shown: string[] = [];
  for (const statement of found) {
    const match = /^(?:IPython\.display\.)?display\s*\(/.exec(statement.text);
    if (!match) {
      continue;
    }
    const open = match[0].length - 1;
    const end = closing(statement.text, open);
    if (end < 0) {
      continue;
    }
    for (const argument of splitTop(statement.text.slice(open + 1, end))) {
      if (!/^\w+\s*=[^=]/.test(argument)) {
        shown.push(argument);
      }
    }
  }
  return shown;
}

/**
 * The code whose value an output shows: the cell's last line for the result
 * of the cell, or the argument of its display() call. Null when the code
 * does not say.
 */
export function shownExpression(
  source: string,
  output: Pick<IOutputPlace, 'type' | 'display' | 'displays'>
): string | null {
  const found = statements(source);
  if (output.type === 'execute_result') {
    const last = found[found.length - 1];
    return last && last.indent === 0 && isExpression(last.text)
      ? last.text
      : null;
  }
  if (output.type === 'display_data' && output.display >= 0) {
    const shown = displayed(found);
    return shown.length === output.displays
      ? (shown[output.display] ?? null)
      : null;
  }
  return null;
}

export interface IChainStep {
  /** The attribute or method, or null for a subscript. */
  name: string | null;
  /** The text between the parentheses of a call, or null when not called. */
  args: string | null;
  /** The text between the brackets of a subscript. */
  subscript: string | null;
}

/**
 * A chain of attributes, calls and subscripts on a name:
 * `df.groupby("arm")[["age"]].mean()`. Null for any other expression.
 */
export function parseChain(
  expression: string
): { base: string; steps: IChainStep[] } | null {
  let text = expression.trim();
  while (text.startsWith('(') && closing(text, 0) === text.length - 1) {
    text = text.slice(1, -1).trim();
  }
  const base = /^[A-Za-z_]\w*/.exec(text);
  if (!base) {
    return null;
  }
  const steps: IChainStep[] = [];
  let i = base[0].length;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) {
      i++;
    }
  };
  skip();
  while (i < text.length) {
    if (text[i] === '.') {
      i++;
      skip();
      const name = /^[A-Za-z_]\w*/.exec(text.slice(i));
      if (!name) {
        return null;
      }
      i += name[0].length;
      skip();
      let args: string | null = null;
      if (text[i] === '(') {
        const end = closing(text, i);
        if (end < 0) {
          return null;
        }
        args = text.slice(i + 1, end);
        i = end + 1;
      }
      steps.push({ name: name[0], args, subscript: null });
    } else if (text[i] === '[') {
      const end = closing(text, i);
      if (end < 0) {
        return null;
      }
      steps.push({ name: null, args: null, subscript: text.slice(i + 1, end) });
      i = end + 1;
    } else {
      return null;
    }
    skip();
  }
  return { base: base[0], steps };
}

/** A string literal's value, or null for any other code. */
function stringLiteral(code: string): string | null {
  const match = /^[rRuU]?(['"])((?:\\.|(?!\1).)*)\1$/s.exec(code.trim());
  return match ? match[2].replace(/\\(.)/g, '$1') : null;
}

/** The strings of a literal string, or of a list or tuple of them; null otherwise. */
function stringList(code: string): string[] | null {
  const trimmed = code.trim();
  const single = stringLiteral(trimmed);
  if (single !== null) {
    return [single];
  }
  if (/^[[(]/.test(trimmed) && closing(trimmed, 0) === trimmed.length - 1) {
    const items = splitTop(trimmed.slice(1, -1)).map(stringLiteral);
    return items.length && items.every(item => item !== null)
      ? (items as string[])
      : null;
  }
  return null;
}

/** An argument of a call: by its keyword, else by its place among the positional ones. */
function argument(
  args: string,
  keyword: string,
  position: number
): string | null {
  const parts = splitTop(args);
  const named = parts.find(part =>
    new RegExp(`^${keyword}\\s*=[^=]`).test(part)
  );
  if (named) {
    return named.slice(named.indexOf('=') + 1).trim();
  }
  const positional = parts.filter(part => !/^\w+\s*=[^=]/.test(part));
  return positional[position] ?? null;
}

/** Methods that keep the rows of a frame, or some of them, with their labels. */
const KEEPS_ROWS = new Set([
  'head',
  'tail',
  'sample',
  'sort_values',
  'sort_index',
  'query',
  'dropna',
  'drop_duplicates',
  'nlargest',
  'nsmallest',
  'copy',
  'fillna',
  'astype',
  'round',
  'assign',
  'filter',
  'drop',
  'rename',
  'loc',
  'iloc',
  'where',
  'mask',
  'select_dtypes',
  'convert_dtypes',
  'infer_objects',
  'abs',
  'clip',
  'replace',
  'isna',
  'isnull',
  'notna',
  'notnull',
  'to_frame',
  'style'
]);

/** Methods of a frame that give one value per column: a series indexed by the columns. */
const REDUCTIONS = new Set([
  'sum',
  'mean',
  'median',
  'std',
  'var',
  'sem',
  'min',
  'max',
  'count',
  'nunique'
]);

/** Methods of a groupby that give one row per group. */
const AGGREGATES = new Set([
  'mean',
  'median',
  'sum',
  'count',
  'size',
  'std',
  'var',
  'sem',
  'min',
  'max',
  'first',
  'last',
  'nunique',
  'agg',
  'aggregate',
  'describe',
  'quantile',
  'prod',
  'any',
  'all',
  'value_counts'
]);

/** Methods of a groupby that give rows of the frame. */
const GROUP_ROWS = new Set(['head', 'tail', 'nth', 'filter', 'sample']);

/** Methods of a frame whose rows are statistics of its columns. */
const STATISTICS = new Set([
  'describe',
  'agg',
  'aggregate',
  'quantile',
  'mode'
]);

/** Methods of a frame whose rows and headers are both its columns. */
const MATRICES = new Set(['corr', 'cov']);

interface IWalk {
  rows: TableAxis;
  headers: TableAxis;
  keys: string[] | null;
  /** The keys of a groupby before its aggregation, or null outside one. */
  grouped: string[] | null | undefined;
  /** The column a subscript picked, when the chain holds a single column. */
  series: string | null;
}

/** What a table made by these steps from a frame shows. */
function walk(steps: IChainStep[]): IWalk {
  const state: IWalk = {
    rows: 'rows',
    headers: 'columns',
    keys: [],
    grouped: undefined,
    series: null
  };
  const unknown = () => {
    state.rows = null;
    state.keys = null;
  };
  for (const step of steps) {
    if (step.name === null) {
      // A subscript: columns picked, a mask, or a row of statistics.
      const single = stringLiteral(step.subscript ?? '');
      if (state.grouped === undefined && state.rows === 'rows' && single) {
        state.series = single;
      }
      continue;
    }
    const name = step.name;
    if (name === 'T' || name === 'transpose') {
      [state.rows, state.headers] = [state.headers, state.rows];
      state.keys = state.rows === 'rows' || state.rows === 'groups' ? [] : null;
      continue;
    }
    if (state.grouped !== undefined) {
      const keys = state.grouped;
      state.grouped = undefined;
      if (AGGREGATES.has(name)) {
        state.rows = 'groups';
        state.keys = keys;
        if (name === 'value_counts' || name === 'size') {
          state.headers = 'statistics';
        }
      } else if (GROUP_ROWS.has(name)) {
        state.rows = 'rows';
        state.keys = [];
      } else {
        unknown();
      }
      continue;
    }
    if (name === 'groupby' && state.rows === 'rows') {
      const by = step.args === null ? null : argument(step.args, 'by', 0);
      const keys = by === null ? null : stringList(by);
      // Without the keys in the index, the view cannot read the groups.
      const asIndex = !/as_index\s*=\s*False/.test(step.args ?? '');
      state.grouped = asIndex ? keys : null;
      continue;
    }
    if (name === 'value_counts' && state.series) {
      state.rows = 'groups';
      state.keys = [state.series];
      state.headers = 'statistics';
      state.series = null;
      continue;
    }
    if (name === 'pivot_table' && state.rows === 'rows') {
      const index = step.args === null ? null : argument(step.args, 'index', 1);
      state.rows = 'groups';
      state.keys = index === null ? null : stringList(index);
      // Headers made from the values of a column are not columns.
      const columns = step.args ? argument(step.args, 'columns', 2) : null;
      state.headers = columns === null ? 'columns' : null;
      continue;
    }
    if (name === 'set_index' && state.rows === 'rows') {
      const keys =
        step.args === null
          ? null
          : stringList(argument(step.args, 'keys', 0) ?? '');
      if (keys && !/append\s*=\s*True/.test(step.args ?? '')) {
        state.keys = keys;
      } else {
        unknown();
      }
      continue;
    }
    if (name === 'reset_index') {
      // The labels become places, which the view cannot map to the frame.
      unknown();
      continue;
    }
    if (MATRICES.has(name) && state.rows === 'rows' && !state.series) {
      state.rows = 'columns';
      state.headers = 'columns';
      state.keys = null;
      continue;
    }
    if (REDUCTIONS.has(name) && state.rows === 'rows' && !state.series) {
      // `df.isna().sum().to_frame()`: a row per column of the frame.
      state.rows = 'columns';
      state.headers = 'statistics';
      state.keys = null;
      continue;
    }
    if (STATISTICS.has(name) && state.rows === 'rows') {
      state.rows = 'statistics';
      state.keys = null;
      if (state.series) {
        state.series = null;
      }
      continue;
    }
    if (KEEPS_ROWS.has(name)) {
      continue;
    }
    unknown();
  }
  if (state.grouped !== undefined) {
    // A groupby shown before it aggregates is not a table.
    unknown();
  }
  return state;
}

/*
 * polars writes no row labels, so a row of its table is found by its place
 * in the frame, or by the values of the key columns of a group_by. The same
 * method names mean other things than in pandas: `filter` keeps some rows,
 * `mean()` gives one row, and the keys of a group_by stay columns.
 */

/** polars: methods that keep every row in its place, and change columns only. */
const POLARS_KEEPS = new Set([
  'select',
  'select_seq',
  'with_columns',
  'with_columns_seq',
  'rename',
  'drop',
  'cast',
  'fill_null',
  'fill_nan',
  'interpolate',
  'clone',
  'lazy',
  'collect',
  'to_frame',
  'alias',
  'round',
  'abs',
  'clip',
  'rechunk',
  'shrink_to_fit',
  'unnest',
  'to_dummies',
  'set_sorted'
]);

/**
 * polars: methods that keep some of the rows, or change their order. After
 * one, a row's place in the table is not its place in the frame; a group
 * keeps its keys.
 */
const POLARS_REORDERS = new Set([
  'filter',
  'remove',
  'sort',
  'sample',
  'tail',
  'slice',
  'unique',
  'drop_nulls',
  'drop_nans',
  'top_k',
  'bottom_k',
  'gather_every',
  'reverse'
]);

/** polars: methods of a group_by that give one row per group. */
const POLARS_AGGREGATES = new Set([
  'agg',
  'len',
  'count',
  'mean',
  'median',
  'sum',
  'min',
  'max',
  'first',
  'last',
  'n_unique',
  'quantile',
  'all'
]);

/** polars: methods of a frame that give one row of statistics of its columns. */
const POLARS_REDUCTIONS = new Set([
  'mean',
  'median',
  'sum',
  'min',
  'max',
  'std',
  'var',
  'quantile',
  'product',
  'null_count',
  'count',
  'describe'
]);

/** polars: methods that keep the values of the columns they keep. */
const POLARS_AS_IS = new Set([
  'drop',
  'lazy',
  'collect',
  'clone',
  'rechunk',
  'shrink_to_fit',
  'set_sorted'
]);

interface IPolarsWalk extends IWalk {
  /** A column of the table that holds each row's place in the frame. */
  place: string | null;
  /** Whether the cells show the frame's own values. */
  asIs: boolean;
  /** Whether the table shows every row of the frame, when a row is its place. */
  whole: boolean;
  /** The method after which a row's place in the table is not its place in the frame. */
  moved: string | null;
}

/** The keys of a polars group_by: its names, as strings or `pl.col()`; null for expressions. */
function polarsKeys(args: string | null): string[] | null {
  if (args === null) {
    return null;
  }
  const keys: string[] = [];
  for (const part of splitTop(args)) {
    if (/^\w+\s*=[^=]/.test(part)) {
      if (/^maintain_order\s*=/.test(part)) {
        continue;
      }
      // A key named by a keyword is an expression.
      return null;
    }
    const column = /^pl\.col\((.*)\)$/s.exec(part);
    const names = column
      ? splitTop(column[1]).map(stringLiteral)
      : [stringList(part)].flat();
    if (!names.length || names.some(name => name === null)) {
      return null;
    }
    keys.push(...(names as string[]));
  }
  return keys.length ? keys : null;
}

/** Whether these arguments change a column of these, beyond naming it. */
function changesKeys(args: string | null, keys: string[]): boolean {
  return splitTop(args ?? '').some(
    part =>
      stringList(part) === null &&
      keys.some(
        key =>
          part.includes(JSON.stringify(key)) ||
          part.includes(`'${key}'`) ||
          new RegExp(`^${key}\\s*=[^=]`).test(part)
      )
  );
}

/** What a polars table made by these steps from a frame shows. */
function walkPolars(steps: IChainStep[]): IPolarsWalk {
  const state: IPolarsWalk = {
    rows: 'rows',
    headers: 'columns',
    keys: [],
    grouped: undefined,
    series: null,
    place: null,
    asIs: true,
    whole: true,
    moved: null
  };
  const unknown = () => {
    state.rows = null;
    state.keys = null;
  };
  // A row found by its place: one step that moves rows loses it, unless a
  // column holds the places.
  const move = (step: string) => {
    if (state.rows === 'rows' && !state.place) {
      state.moved = state.moved ?? step;
      unknown();
    }
  };
  for (const step of steps) {
    if (state.rows === null && state.grouped === undefined) {
      break;
    }
    if (step.name === null) {
      // A subscript: a column, columns, or a slice of the rows.
      const subscript = step.subscript ?? '';
      const single = stringLiteral(subscript);
      if (single !== null || stringList(subscript)) {
        if (single !== null && state.rows === 'rows') {
          state.series = single;
        }
        continue;
      }
      if (/^\s*0?\s*:\s*\d*\s*$/.test(subscript)) {
        state.whole = false;
        continue;
      }
      move('a subscript');
      if (state.rows !== null) {
        unknown();
      }
      continue;
    }
    const name = step.name;
    if (state.grouped !== undefined) {
      const keys = state.grouped;
      state.grouped = undefined;
      if (POLARS_AGGREGATES.has(name)) {
        state.rows = 'groups';
        state.keys = keys;
        state.series = null;
      } else {
        // `group_by(...).head()` keeps rows of the frame, at other places.
        state.moved = `group_by().${name}()`;
        unknown();
      }
      continue;
    }
    if (state.rows === 'rows' && (name === 'group_by' || name === 'groupby')) {
      state.grouped = polarsKeys(step.args);
      continue;
    }
    if (name === 'with_row_index' && state.rows === 'rows') {
      // A column of places from 0, unless an offset shifts them.
      const args = step.args ?? '';
      const named = argument(args, 'name', 0);
      const column = named === null ? 'index' : stringLiteral(named);
      if (column !== null && argument(args, 'offset', 1) === null) {
        state.place = column;
      }
      continue;
    }
    if (name === 'get_column' && state.rows === 'rows') {
      state.series = stringLiteral(step.args ?? '');
      continue;
    }
    if (name === 'value_counts' && state.series && state.rows === 'rows') {
      state.rows = 'groups';
      state.keys = [state.series];
      state.headers = 'statistics';
      state.series = null;
      continue;
    }
    if (
      state.rows === 'rows' &&
      (name === 'describe' || (POLARS_REDUCTIONS.has(name) && !state.series))
    ) {
      // One row per statistic, under the frame's columns.
      state.rows = 'statistics';
      state.keys = null;
      state.series = null;
      continue;
    }
    if (name === 'corr' && state.rows === 'rows' && !state.series) {
      state.rows = 'columns';
      state.keys = null;
      continue;
    }
    if (name === 'pivot' && state.rows === 'rows') {
      const index =
        step.args === null ? null : argument(step.args, 'index', 99);
      state.rows = 'groups';
      state.keys = index === null ? null : stringList(index);
      // Its headers are values of a column.
      state.headers = null;
      continue;
    }
    if (POLARS_KEEPS.has(name)) {
      const named = splitTop(step.args ?? '').every(
        part => stringList(part) !== null
      );
      if (!POLARS_AS_IS.has(name) && !(name === 'select' && named)) {
        state.asIs = false;
      }
      // A group is found by its keys: code that changes a key loses it.
      if (
        state.rows === 'groups' &&
        state.keys &&
        name !== 'drop' &&
        changesKeys(step.args, state.keys)
      ) {
        unknown();
      }
      continue;
    }
    if (name === 'head' || name === 'limit') {
      state.whole = false;
      continue;
    }
    if (POLARS_REORDERS.has(name)) {
      if (state.rows === 'rows') {
        state.whole = false;
      }
      move(`${name}()`);
      continue;
    }
    unknown();
  }
  if (state.grouped !== undefined) {
    // A group_by shown before it aggregates is not a table.
    unknown();
  }
  return state;
}

function joinNames(names: string[]): string {
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : (names[0] ?? '');
}

/** What a polars table shows of the frame its code names. */
function polarsSource(
  read: IReadTable,
  frame: IFrameInfo,
  expression: string,
  state: IPolarsWalk
): ITableSource {
  const name = frame.name;
  const known = {
    frame: name,
    headers: state.headers,
    expression,
    by: 'code' as const
  };
  if (state.rows === 'rows' && !state.place && frame.rows !== null) {
    // A row is its place in the frame as it is now: the table holds all
    // its rows, or the first of them.
    const fits = state.whole
      ? read.size.rows === frame.rows
      : read.size.rows <= frame.rows;
    if (!fits) {
      return {
        ...known,
        rows: null,
        keys: null,
        reason: `The view cannot tell which rows of ${name} these are: the table has ${read.size.rows.toLocaleString('en-US')} rows, and ${name} has ${frame.rows.toLocaleString('en-US')} now.`
      };
    }
  }
  const reason =
    state.rows === 'rows'
      ? state.place
        ? `The table shows rows of ${name}, and ${state.place} holds their places in ${name}.`
        : `The table shows rows of ${name}, in their places.`
      : state.rows === 'groups'
        ? state.keys
          ? `The table shows groups of the rows of ${name}, by ${joinNames(state.keys)}.`
          : `The table shows groups of the rows of ${name}, made by code the view cannot read.`
        : state.rows === 'statistics'
          ? `The rows of this table are statistics of the columns of ${name}, not rows of ${name}.`
          : state.rows === 'columns'
            ? `Each row of this table is a column of ${name}.`
            : state.moved
              ? `The view cannot tell which rows of ${name} these are. A polars table has no row labels, and after ${state.moved} a row's place in the table is not its place in ${name}.`
              : `The view cannot tell which rows of ${name} these are: it does not read what ${expression} does to them.`;
  return {
    ...known,
    rows: state.rows,
    keys: state.rows === 'rows' || state.rows === 'groups' ? state.keys : null,
    reason,
    place: state.rows === 'rows' ? state.place : null,
    asIs: state.rows === 'rows' && state.asIs
  };
}

/**
 * Which frame of the kernel a table shows, and what its rows and headers
 * are. The code that shows the table decides first; without it, the frame
 * whose columns the table has.
 */
export function resolveTable(
  read: IReadTable,
  context: {
    source: string;
    output: IOutputPlace;
    frames: IFrameInfo[];
  }
): ITableSource {
  const { source, output, frames } = context;
  const expression =
    output.tables === 1 ? shownExpression(source, output) : null;
  const chain = expression ? parseChain(expression) : null;
  const byName = chain ? frames.find(frame => frame.name === chain.base) : null;
  if (chain && byName && read.library === 'polars') {
    return polarsSource(read, byName, expression!, walkPolars(chain.steps));
  }
  if (chain && byName) {
    const state = walk(chain.steps);
    const reason =
      state.rows === 'rows'
        ? `The table shows rows of ${byName.name}.`
        : state.rows === 'groups'
          ? state.keys
            ? `The table shows groups of the rows of ${byName.name}, by ${joinNames(state.keys)}.`
            : `The table shows groups of the rows of ${byName.name}, made by code the view cannot read.`
          : state.rows === 'statistics'
            ? `The rows of this table are statistics of the columns of ${byName.name}, not rows of ${byName.name}.`
            : state.rows === 'columns'
              ? `Each row of this table is a column of ${byName.name}.`
              : `The view cannot tell which rows of ${byName.name} these are: ${expression} changes their labels.`;
    return {
      frame: byName.name,
      rows: state.rows,
      headers: state.headers,
      keys:
        state.rows === 'rows' || state.rows === 'groups' ? state.keys : null,
      expression,
      by: 'code',
      reason
    };
  }
  // Without the code, the frame whose columns the table has.
  const labels = read.columns.map(column => column.path[0]).filter(Boolean);
  const having = labels.length
    ? frames.filter(frame =>
        labels.every(label => frame.columns.includes(label))
      )
    : [];
  const live = having.filter(frame => !frame.stale);
  const candidates = live.length ? live : having;
  const sized = candidates.filter(frame => frame.rows === read.size.rows);
  const found =
    candidates.length === 1
      ? candidates[0]
      : sized.length === 1
        ? sized[0]
        : null;
  if (found && read.library === 'polars') {
    // A row is its place, and without the code the places are not known.
    return {
      frame: found.name,
      rows: null,
      headers: 'columns',
      keys: null,
      expression,
      by: 'columns',
      reason: `The table has the columns of ${found.name}. A polars table has no row labels, and the view cannot tell which rows of ${found.name} it shows without the code that shows it.`
    };
  }
  if (found) {
    const named = read.index.filter(Boolean);
    const keys =
      named.length === read.index.length &&
      named.every(name => found.columns.includes(name))
        ? named
        : null;
    // The frame's own rows when the table has as many; rows labelled by
    // columns of the frame, as a groupby or set_index leaves them.
    const rows: TableAxis =
      keys !== null
        ? 'groups'
        : !named.length && found.rows === read.size.rows
          ? 'rows'
          : null;
    return {
      frame: found.name,
      rows,
      headers: 'columns',
      keys: rows === 'rows' ? [] : keys,
      expression,
      by: 'columns',
      reason:
        rows === null
          ? `The table has columns of ${found.name}, and the view cannot tell which of its rows it shows.`
          : `The table has the columns of ${found.name}.`
    };
  }
  const shown = expression ? `${expression} shows` : 'this output shows';
  return {
    frame: null,
    rows: null,
    headers: null,
    keys: null,
    expression,
    by: null,
    reason:
      output.tables > 1
        ? 'The view cannot tell which frame each of the tables of this output shows.'
        : candidates.length > 1
          ? `The view cannot tell which frame ${shown}: ${joinNames(candidates.map(frame => frame.name))} have its columns.`
          : `The view cannot tell which frame ${shown}: no frame in the kernel has its columns.`
  };
}

/**
 * The column of the frame that a header names: the first of its headers,
 * from the top, that is a column of the frame. Null when none is.
 */
export function frameColumn(path: string[], columns: string[]): string | null {
  return path.find(label => columns.includes(label)) ?? null;
}
