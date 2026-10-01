/**
 * A pandas table that asks from its headers and row labels
 * (`useTableQuestions` in src/ui/tablequestions.tsx), from the keyboard: one
 * Tab stop per table, and the arrow keys inside it.
 */
import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { Signal } from '@lumino/signaling';

import { TableQuestions } from '../ui/tablequestions';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** df.head(rows) of a frame of `columns` columns, as pandas writes it. */
function pandasTable(rows: number, columns: number): string {
  const head = Array.from({ length: columns }, (_, c) => `<th>c${c}</th>`).join(
    ''
  );
  const body = Array.from(
    { length: rows },
    (_, r) =>
      `<tr><th>${r}</th>${Array.from({ length: columns }, (_, c) => `<td>${r * columns + c}</td>`).join('')}</tr>`
  ).join('');
  return `<table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

let root: Root | null = null;
let host: HTMLElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(): Promise<void> {
  const model: any = {
    changed: new Signal({}),
    notebook: { getMetadata: () => undefined },
    cell: () => null,
    ask: null
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <TableQuestions model={model} cellId="c" output={{} as any} index={0}>
        <div dangerouslySetInnerHTML={{ __html: pandasTable(10, 20) }} />
      </TableQuestions>
    );
  });
}

async function key(name: string): Promise<void> {
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true })
    );
  });
}

function focused(): string {
  return document.activeElement?.textContent ?? '';
}

describe('a table that asks from its headers and row labels', () => {
  it('is one Tab stop, with the arrow keys inside', async () => {
    await mount();
    const stops = host.querySelectorAll<HTMLElement>('[tabindex="0"]');
    expect(stops).toHaveLength(1);
    await act(async () => stops[0].focus());
    expect(focused()).toBe('c0');
    await key('ArrowRight');
    await key('ArrowRight');
    expect(focused()).toBe('c2');
    await key('ArrowLeft');
    expect(focused()).toBe('c1');
    // Down goes to the label of the first row, then of the next row.
    await key('ArrowDown');
    expect(focused()).toBe('0');
    await key('ArrowDown');
    expect(focused()).toBe('1');
    await key('End');
    expect(focused()).toBe('9');
    // The Tab stop follows the focus.
    expect(
      Array.from(host.querySelectorAll('[tabindex="0"]')).map(
        cell => cell.textContent
      )
    ).toEqual(['9']);
  });
});
