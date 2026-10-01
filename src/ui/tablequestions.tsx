import type { IOutputModel } from '@jupyterlab/rendermime';
import * as React from 'react';

import type { EpiModel } from '../model/epimodel';
import type { IReadTable, TableTarget } from '../model/frametable';
import { readTable } from '../model/frametable';
import { outputsOf } from '../model/notebook';
import { runnableFirst } from '../model/questionorder';
import type { ITableAsk } from '../model/tableask';
import {
  askTableHeaders,
  askTableRows,
  frameItem,
  keepTableRows,
  picksOf
} from '../model/tableask';
import type { IAnchor } from '../tokens';
import { OptionRow, OptionRows, aiOffReason, anchorOf } from './common';

/*
 * Questions from a table of a data frame, as the bench and the cell details
 * show it. A click on a header asks about that column; Shift+click or
 * Ctrl+click on a second header asks about both. A click on a row label, a
 * drag across row labels, or Shift+click from one to another asks about
 * those rows; Ctrl+click adds a row or takes it out. A drag that starts in
 * the text of a cell selects the text, as anywhere else. polars writes no
 * row labels: the first cell of each row acts as its label.
 *
 * From the keyboard, a table is one Tab stop, on the header or label that
 * had the focus last. The left and right arrows move along a row of the
 * table, the up and down arrows to the header or label of the row above or
 * below, Home and End to the first and the last, and Enter or Space asks as
 * a click does, with Shift as Shift+click.
 */

const HEADER_TITLE =
  'Ask about this column. Shift+click another header to ask about both.';
const ROW_TITLE =
  'Ask about this row. Drag across row labels, or Shift+click another, to ask about several.';

type HeaderTarget = Extract<TableTarget, { kind: 'header' }>;
type RowTarget = Extract<TableTarget, { kind: 'row' }>;

interface IHit {
  cell: HTMLElement;
  table: HTMLTableElement;
  read: IReadTable;
  target: TableTarget;
}

interface IKeys {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Whether the notebook's kernel runs Python, the language of the questions' code. */
function runsPython(model: EpiModel): boolean {
  const info = model.notebook.getMetadata('language_info') as
    { name?: string } | undefined;
  const spec = model.notebook.getMetadata('kernelspec') as
    { language?: string } | undefined;
  // A notebook model starts with `language_info.name` empty.
  return (info?.name || spec?.language || 'python').toLowerCase() === 'python';
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

export interface ITableQuestionsOptions {
  model: EpiModel;
  cellId: string;
  output: IOutputModel;
  /** The output's place in its cell; without it, found among the cell's outputs. */
  index?: number;
  /** Off for a table shown as a miniature, which a click opens. */
  enabled?: boolean;
  /** Open the questions to the left of the table, as beside a right-hand panel. */
  opensLeft?: boolean;
}

/**
 * Make the headers and row labels of the tables of data frames in `host`
 * ask questions. Tables that no reader knows, such as a model summary or a
 * styled table, stay as they are.
 */
export function useTableQuestions(
  host: React.RefObject<HTMLElement>,
  options: ITableQuestionsOptions
): void {
  const {
    model,
    cellId,
    output,
    index,
    enabled = true,
    opensLeft = false
  } = options;
  React.useEffect(() => {
    const node = host.current;
    if (!node || !enabled || !runsPython(model)) {
      return;
    }
    const reads = new WeakMap<Element, IReadTable | null>();
    const tables = () =>
      Array.from(node.querySelectorAll('table')) as HTMLTableElement[];
    const readOf = (table: HTMLTableElement): IReadTable | null => {
      if (!reads.has(table)) {
        reads.set(table, readTable(table));
      }
      return reads.get(table) ?? null;
    };
    const place = (table: HTMLTableElement) => {
      const cell = model.cell(cellId);
      return {
        cellId,
        output: index ?? (cell ? outputsOf(cell.model).indexOf(output) : -1),
        table: tables().indexOf(table)
      };
    };

    // The rows under the pointer while a drag across row labels goes on.
    let dragging: { table: HTMLTableElement; rows: Set<number> } | null = null;
    const painted = new Set<Element>();
    const paint = () => {
      for (const element of painted) {
        element.classList.remove('jp-mod-picked');
      }
      painted.clear();
      const add = (element: Element) => {
        element.classList.add('jp-mod-picked');
        painted.add(element);
      };
      const picks = picksOf(model.ask);
      tables().forEach((table, position) => {
        const read = readOf(table);
        if (!read) {
          return;
        }
        const mine =
          !!picks &&
          picks.cellId === cellId &&
          picks.table === position &&
          picks.output === place(table).output;
        const rows =
          dragging?.table === table
            ? dragging.rows
            : new Set(mine && !dragging ? picks!.rows : []);
        const headers = mine && !dragging ? picks!.headers : [];
        for (const [cell, target] of read.targets) {
          if (
            target.kind === 'header' &&
            headers.some(path => samePath(path, target.path))
          ) {
            add(cell);
            for (const column of target.columns) {
              (read.columnCells.get(column) ?? []).forEach(add);
            }
          }
        }
        for (const [row, position] of read.rowOf) {
          if (rows.has(position)) {
            add(row);
          }
        }
      });
    };

    const marked = new Set<Element>();
    const mark = () => {
      for (const table of tables()) {
        const read = readOf(table);
        if (!read || marked.has(table)) {
          continue;
        }
        table.classList.add('jp-Epi-asktable');
        marked.add(table);
        let first = true;
        for (const [cell, target] of read.targets) {
          cell.classList.add(
            target.kind === 'header' ? 'jp-Epi-askhead' : 'jp-Epi-askrow'
          );
          // One Tab stop per table: the arrow keys move inside it.
          cell.setAttribute('tabindex', first ? '0' : '-1');
          first = false;
          cell.setAttribute(
            'title',
            target.kind === 'header' ? HEADER_TITLE : ROW_TITLE
          );
          marked.add(cell);
        }
      }
      paint();
    };
    const unmark = () => {
      for (const element of painted) {
        element.classList.remove('jp-mod-picked');
      }
      painted.clear();
      for (const element of marked) {
        element.classList.remove(
          'jp-Epi-asktable',
          'jp-Epi-askhead',
          'jp-Epi-askrow'
        );
        if (element.tagName === 'TH' || element.tagName === 'TD') {
          element.removeAttribute('tabindex');
          element.removeAttribute('title');
        }
      }
      marked.clear();
    };

    // A header or a row label: a <th>, or in a polars table, which writes
    // no row labels, the first <td> of a row.
    const hit = (target: EventTarget | null): IHit | null => {
      const cell =
        target instanceof Element
          ? (target.closest('th, td') as HTMLElement | null)
          : null;
      const table = cell?.closest('table') as HTMLTableElement | null;
      if (!cell || !table || !node.contains(table)) {
        return null;
      }
      const read = readOf(table);
      const picked = read?.targets.get(cell);
      return read && picked ? { cell, table, read, target: picked } : null;
    };
    // The questions open beside the table, or under it when the window has
    // no room on its right, so that the other headers and labels stay clear
    // to pick more; beside a right-hand panel, to its left.
    const anchorFor = (found: IHit, y?: number): IAnchor => {
      const cell = found.cell.getBoundingClientRect();
      if (opensLeft) {
        return {
          x: node.getBoundingClientRect().left,
          y: y ?? cell.top,
          side: 'left'
        };
      }
      const table = found.table.getBoundingClientRect();
      // Past the gutter of the copy button: the popover is 420 px wide and
      // opens 12 px right of its anchor.
      return table.right + 24 + 12 + 420 + 8 <= window.innerWidth
        ? { x: table.right + 24, y: table.top + 20 }
        : { x: cell.left - 12, y: table.bottom + 24 };
    };

    // The header clicked last without a modifier: Shift+click pairs with it.
    let first: { table: HTMLTableElement; target: HeaderTarget } | null = null;
    // The row picked last, from which Shift+click extends, and the rows
    // picked so far, which Ctrl+click adds to.
    let last: { table: HTMLTableElement; row: number } | null = null;
    let chosen: { table: HTMLTableElement; rows: Set<number> } | null = null;

    const askHeader = (found: IHit, keys: IKeys, anchor: IAnchor) => {
      const target = found.target as HeaderTarget;
      const adding = keys.shiftKey || keys.ctrlKey || keys.metaKey;
      const pair =
        adding &&
        first &&
        first.table === found.table &&
        !samePath(first.target.path, target.path)
          ? first.target
          : null;
      if (!pair) {
        first = { table: found.table, target };
      }
      askTableHeaders(
        model,
        place(found.table),
        found.read,
        pair ? [pair, target] : [target],
        anchor
      );
    };

    const askRows = (found: IHit, rows: number[], anchor: IAnchor) => {
      const set = new Set(rows);
      const picked = found.read.rows.filter(row => set.has(row.position));
      chosen = { table: found.table, rows: set };
      void askTableRows(
        model,
        place(found.table),
        found.read,
        picked.map(row => row.labels),
        picked.map(row => row.position),
        anchor
      );
    };
    const between = (found: IHit, from: number[], to: number) => {
      const low = Math.min(...from, to);
      const high = Math.max(...from, to);
      return found.read.rows
        .filter(row => row.position >= low && row.position <= high)
        .map(row => row.position);
    };
    const pickRows = (
      found: IHit,
      keys: IKeys,
      anchor: IAnchor,
      to?: number
    ) => {
      const target = found.target as RowTarget;
      if (to !== undefined && !target.rows.includes(to)) {
        last = { table: found.table, row: to };
        askRows(found, between(found, target.rows, to), anchor);
        return;
      }
      if (keys.shiftKey && last?.table === found.table) {
        askRows(found, between(found, target.rows, last.row), anchor);
        return;
      }
      if ((keys.ctrlKey || keys.metaKey) && chosen?.table === found.table) {
        const rows = new Set(chosen.rows);
        const all = target.rows.every(row => rows.has(row));
        target.rows.forEach(row => (all ? rows.delete(row) : rows.add(row)));
        last = { table: found.table, row: target.rows[0] };
        if (!rows.size) {
          chosen = null;
          model.closeAsk();
          return;
        }
        askRows(found, [...rows], anchor);
        return;
      }
      last = { table: found.table, row: target.rows[0] };
      chosen = { table: found.table, rows: new Set(target.rows) };
      // A label over several rows asks about its group: its own label alone.
      void askTableRows(
        model,
        place(found.table),
        found.read,
        [target.labels],
        target.rows,
        anchor
      );
    };

    let stopDrag: (() => void) | null = null;
    // Where the pointer went down on a header: a click there asks, and a
    // drag from there selects the header's text.
    let pressed: { x: number; y: number } | null = null;
    const onMouseDown = (event: MouseEvent) => {
      const start = hit(event.target);
      if (!start || event.button !== 0) {
        return;
      }
      if (start.target.kind === 'header') {
        pressed = { x: event.clientX, y: event.clientY };
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          // Shift+click pairs two headers: it extends no text selection.
          event.preventDefault();
        }
        return;
      }
      // A drag across row labels picks rows, and selects no text.
      event.preventDefault();
      const keys = {
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey
      };
      const from = start.target.rows;
      let to: number | undefined;
      dragging = { table: start.table, rows: new Set(from) };
      paint();
      const move = (moved: MouseEvent) => {
        const under = document.elementFromPoint(moved.clientX, moved.clientY);
        const row = under?.closest('tr');
        const position = row ? start.read.rowOf.get(row) : undefined;
        if (position === undefined || position === to) {
          return;
        }
        to = position;
        dragging = {
          table: start.table,
          rows: new Set(between(start, from, position))
        };
        paint();
      };
      const up = (released: MouseEvent) => {
        stopDrag?.();
        dragging = null;
        pickRows(start, keys, anchorFor(start, released.clientY), to);
        paint();
      };
      stopDrag = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up, true);
        stopDrag = null;
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up, true);
    };
    const onClick = (event: MouseEvent) => {
      const found = hit(event.target);
      const from = pressed;
      pressed = null;
      // A drag in a header selects its text and asks nothing; the second
      // click of a double-click selects a word.
      if (
        !found ||
        found.target.kind !== 'header' ||
        event.detail > 1 ||
        (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4)
      ) {
        return;
      }
      askHeader(found, event, anchorFor(found));
    };
    // The header or label that the Tab stop of its table is on.
    const stopOn = (cell: HTMLElement, read: IReadTable) => {
      for (const other of read.targets.keys()) {
        other.setAttribute('tabindex', other === cell ? '0' : '-1');
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const found = hit(event.target);
      if (found && event.target === found.cell) {
        stopOn(found.cell, found.read);
      }
    };
    /** The header or label that an arrow key, Home or End moves to from `found`. */
    const moveFrom = (found: IHit, key: string): HTMLElement | null => {
      const cells = [...found.read.targets.keys()] as HTMLElement[];
      if (key === 'Home' || key === 'End') {
        return cells[key === 'Home' ? 0 : cells.length - 1] ?? null;
      }
      const row = found.cell.closest('tr');
      const rows = [
        ...new Set(cells.map(cell => cell.closest('tr')))
      ] as HTMLTableRowElement[];
      const inRow = (tr: HTMLTableRowElement | null) =>
        cells.filter(cell => cell.closest('tr') === tr);
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const along = inRow(row);
        const index = along.indexOf(found.cell);
        return along[index + (key === 'ArrowRight' ? 1 : -1)] ?? null;
      }
      const next = rows[rows.indexOf(row!) + (key === 'ArrowDown' ? 1 : -1)];
      if (!next) {
        return null;
      }
      // The header or label of that row nearest the column of this one: by
      // where it is drawn, or by its place in the row before any layout.
      const left = found.cell.getBoundingClientRect().left;
      const column = (found.cell as HTMLTableCellElement).cellIndex;
      const distance = (item: HTMLElement) => {
        const at = item.getBoundingClientRect().left;
        return left || at
          ? Math.abs(at - left)
          : Math.abs((item as HTMLTableCellElement).cellIndex - column);
      };
      return inRow(next).reduce((best, cell) =>
        distance(cell) < distance(best) ? cell : best
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const found = hit(event.target);
      if (!found || event.target !== found.cell) {
        return;
      }
      if (
        [
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End'
        ].includes(event.key)
      ) {
        // Stop the keys here, so that the view's arrow keys between cells
        // do not also move the focus.
        event.preventDefault();
        event.stopPropagation();
        moveFrom(found, event.key)?.focus();
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (found.target.kind === 'header') {
        askHeader(found, event, anchorFor(found));
      } else {
        pickRows(found, event, anchorFor(found));
      }
    };

    // The renderer fills the host after the first render, and again when
    // the output changes.
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          mark();
        });
      }
    });
    observer.observe(node, { childList: true, subtree: true });
    mark();
    model.changed.connect(paint);
    node.addEventListener('mousedown', onMouseDown);
    node.addEventListener('click', onClick);
    node.addEventListener('keydown', onKeyDown);
    node.addEventListener('focusin', onFocusIn);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      model.changed.disconnect(paint);
      node.removeEventListener('mousedown', onMouseDown);
      node.removeEventListener('click', onClick);
      node.removeEventListener('keydown', onKeyDown);
      node.removeEventListener('focusin', onFocusIn);
      stopDrag?.();
      unmark();
    };
  }, [host, model, cellId, output, index, enabled, opensLeft]);
}

/** The tables of an output that ask questions: see useTableQuestions. */
export function TableQuestions(
  props: ITableQuestionsOptions & { children: React.ReactNode }
): JSX.Element {
  const host = React.useRef<HTMLDivElement>(null);
  useTableQuestions(host, props);
  return (
    <div className="jp-Epi-tablequestions" ref={host}>
      {props.children}
    </div>
  );
}

/**
 * The questions about a pick in a table: why the view cannot ask more, when
 * it cannot; the rows of the frame behind rows picked, with what sets them
 * apart; then the questions.
 */
export function TableAskContent(props: {
  model: EpiModel;
  ask: ITableAsk;
}): JSX.Element {
  const { model, ask } = props;
  const summary = ask.summary;
  const frame = ask.source.frame;
  // While no AI model answers, the questions that run come first.
  const offered = runnableFirst(ask.options, !!model.aiOff()).slice(
    0,
    Math.max(0, model.settings.offeredQuestions)
  );
  return (
    <div className="jp-Epi-ask jp-Epi-tableask">
      {ask.note && <div className="jp-Epi-joinnote">{ask.note}</div>}
      {summary && (
        <>
          <div className="jp-Epi-caption">
            {summary.rows.toLocaleString()} of{' '}
            {summary.total_rows.toLocaleString()} rows of {frame}
            {summary.units !== undefined
              ? ` · ${summary.units.toLocaleString()} ${(summary.unit ?? 'unit').replace(/_id$/, '')}${summary.units === 1 ? '' : 's'}`
              : ''}
          </div>
          <div className="jp-Epi-seen">{summary.seen}</div>
        </>
      )}
      {model.settings.offeredQuestions <= 0 && (
        <div className="jp-Epi-caption jp-Epi-offered-off">
          Offered questions are off in the settings: type your question above.
        </div>
      )}
      <OptionRows model={model} options={offered}>
        {option => (
          <OptionRow
            option={option}
            placement={model.placementFor(option)}
            onApply={() => void model.apply(option)}
            aiOff={aiOffReason(model)}
          />
        )}
      </OptionRows>
      {summary?.mask && summary.rows > 0 && (
        <button
          className="jp-Epi-keep"
          onClick={() => keepTableRows(model, ask)}
        >
          Keep these rows as a variable
        </button>
      )}
      {frame && !summary && model.variable(frame) && (
        <button
          className="jp-Epi-link jp-Epi-tableask-frame"
          onClick={event =>
            void model.askDrop(
              frameItem(frame),
              { item: frameItem(frame) },
              { ...model.pickModifiers },
              ask.anchor ?? anchorOf(event),
              { popover: true }
            )
          }
        >
          Questions about {frame}
        </button>
      )}
    </div>
  );
}
