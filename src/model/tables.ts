import type { IOutputModel } from '@jupyterlab/rendermime';

import type { Detail } from '../tokens';
import { polarsShape } from './frametable';
import { PLACEHOLDER } from './logs';

/**
 * Table outputs in the bench: their size, and how much room they get.
 *
 * A table shows in full when it is small and fits, as a scaled-down
 * miniature while its text stays readable, and otherwise as a tile.
 */

export interface ITableInfo {
  /** Rows and columns of the data; null when the output holds several tables. */
  rows: number | null;
  columns: number | null;
  /** How many HTML tables the output holds. */
  tables: number;
  /**
   * Where the output writes the table's size itself: below the table, as
   * pandas does under a table that it cuts, or above it, as polars and R
   * do. Absent when the output does not write it.
   */
  sizeLine?: 'above' | 'below';
}

export type TableLevel = 'inline' | 'miniature' | 'tile';

/** A table this small shows in full, when it fits the width. */
export const INLINE_ROWS = 5;
export const INLINE_COLUMNS = 20;
/** A miniature does not shrink its text below this size, in pixels. */
export const READABLE_PX = 8;
/** A miniature is at most this tall; a longer table is cut. */
export const MINIATURE_HEIGHT = 180;
/** At the compact level, a miniature is at most this share of its full size. */
export const COMPACT_SCALE = 0.7;

// pandas writes the full size in a paragraph under a table that it cuts.
const DIMENSIONS = /^\s*(\d[\d,]*) rows × (\d[\d,]*) columns\s*$/;
// R writes the size in the table's caption: "A data.frame: 6 × 3", "A
// tibble: 291 × 5", "A matrix: 2 × 2 of type int".
const R_CAPTION = /^\s*An? [\w.]+: (\d[\d,]*) × (\d[\d,]*)/;

function count(value: string): number {
  return parseInt(value.replace(/,/g, ''), 10);
}

function text(value: unknown): string {
  return Array.isArray(value) ? value.join('') : String(value ?? '');
}

export function htmlOf(output: IOutputModel): string {
  return text(output.data['text/html']);
}

export function tableInfo(html: string): ITableInfo {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));
  if (tables.length !== 1) {
    return { rows: null, columns: null, tables: tables.length };
  }
  const footer = Array.from(doc.querySelectorAll('p'))
    .map(paragraph => DIMENSIONS.exec(paragraph.textContent ?? ''))
    .find(match => match !== null);
  if (footer) {
    return {
      rows: count(footer[1]),
      columns: count(footer[2]),
      tables: 1,
      sizeLine: 'below'
    };
  }
  // IRkernel draws the first and last rows of a long table, so the rows
  // drawn are not its size.
  const caption = R_CAPTION.exec(tables[0].caption?.textContent ?? '');
  if (caption) {
    return {
      rows: count(caption[1]),
      columns: count(caption[2]),
      tables: 1,
      sizeLine: 'above'
    };
  }
  // polars writes the size above the table, and a row of dtypes under its
  // header, in <td> cells that are not data.
  const line = tables[0].previousElementSibling;
  const shape =
    line?.tagName === 'SMALL' && tables[0].classList.contains('dataframe')
      ? polarsShape(line.textContent ?? '')
      : null;
  if (shape) {
    return { ...shape, tables: 1, sizeLine: 'above' };
  }
  // Header cells are <th>, and so is the index of a pandas frame.
  const rows = Array.from(tables[0].querySelectorAll('tr')).filter(row =>
    row.querySelector('td')
  );
  const columns = Math.max(
    0,
    ...rows.map(row => row.querySelectorAll('td').length)
  );
  return { rows: rows.length, columns, tables: 1 };
}

/**
 * Whether a miniature of the table shows the line in which the output
 * writes the table's size: the line above it always, and pandas' line
 * under it unless the miniature cuts the table off before it. The view
 * writes the size under the miniature only when it does not.
 */
export function showsSize(info: ITableInfo, clipped: boolean): boolean {
  return info.sizeLine === 'above' || (info.sizeLine === 'below' && !clipped);
}

/** The table as text, for Claude: the plain-text form when the output has one. */
export function tableText(output: IOutputModel): string {
  const plain = text(output.data['text/plain']);
  if (plain.trim() && !PLACEHOLDER.test(plain.trim())) {
    return plain;
  }
  const doc = new DOMParser().parseFromString(htmlOf(output), 'text/html');
  return Array.from(doc.querySelectorAll('tr'))
    .map(row =>
      Array.from(row.children)
        .map(cell => cell.textContent?.trim() ?? '')
        .join(' | ')
    )
    .join('\n');
}

/** A short hash of a text: FNV-1a, 32 bits, in hexadecimal. */
export function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The key of a table output in the cell metadata: it changes with the table. */
export function tableKey(output: IOutputModel): string {
  return fingerprint(htmlOf(output));
}

/**
 * How a table shows, given its size at full scale, the width it has and the
 * level of detail. The scale applies to a miniature; a tile keeps the table
 * hidden. At the compact level no table shows in full, and at the overview
 * level every table is a tile.
 */
export function tableLevel(
  info: ITableInfo,
  natural: { width: number; height: number; fontPx: number },
  available: number,
  detail: Detail = 'full'
): { level: TableLevel; scale: number } {
  const fits = Math.min(1, available / natural.width);
  const readable = READABLE_PX / natural.fontPx;
  if (detail === 'overview') {
    return { level: 'tile', scale: readable };
  }
  const small =
    info.rows !== null &&
    info.columns !== null &&
    info.rows <= INLINE_ROWS &&
    info.columns <= INLINE_COLUMNS;
  if (small && fits >= 1 && detail === 'full') {
    return { level: 'inline', scale: 1 };
  }
  if (fits < readable) {
    return { level: 'tile', scale: readable };
  }
  const largest = detail === 'compact' ? Math.max(readable, COMPACT_SCALE) : 1;
  return {
    level: 'miniature',
    scale: Math.max(
      readable,
      Math.min(fits, largest, MINIATURE_HEIGHT / natural.height)
    )
  };
}
