/**
 * The menu of the Ask button of "Your own question" (`PlaceMenu` in
 * src/ui/common.tsx), from the keyboard. The menu is drawn at the end of the
 * page, and closes when the focus goes outside it and its toggle.
 */
import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { Signal } from '@lumino/signaling';

import { DEFAULT_MODELS } from '../model/models';
import type { IPlacement } from '../tokens';
import { OwnQuestion } from '../ui/common';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const places: IPlacement[] = [
  { kind: 'new', cell: 'a', label: 'new cell after [3]' },
  { kind: 'edit', cell: 'a', label: 'edit [3] in place' },
  { kind: 'branch', cell: 'a', label: 'branch of [3]' },
  { kind: 'preview', cell: null, label: 'a preview in the sidebar' }
];

function fakeModel(): any {
  return {
    changed: new Signal({}),
    aiReady: () => true,
    sortOwn: async () => undefined,
    ownType: () => ({ type: 'descriptive', by: null, probability: null }),
    ownPlace: (_: string, offered: IPlacement[]) => ({
      place: offered[0] ?? null,
      by: null
    }),
    settings: { models: { ...DEFAULT_MODELS } },
    status: null,
    api: {},
    refreshStatus: () => undefined,
    variables: () => [],
    ask: null
  };
}

let root: Root | null = null;
let host: HTMLElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <OwnQuestion
        model={fakeModel()}
        onAsk={() => undefined}
        places={places}
      />
    );
  });
  // Some text, so that the Ask button can be pressed.
  const input = host.querySelector('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(input, 'what if pain is log scaled');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function toggle(): HTMLButtonElement {
  return host.querySelector(
    '[aria-label="Where the answer goes"]'
  ) as HTMLButtonElement;
}

function menu(): HTMLElement | null {
  return document.querySelector('.jp-Epi-placemenu');
}

async function key(name: string, options: KeyboardEventInit = {}) {
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, ...options })
    );
  });
}

/** Enter on a button: the browser clicks it, with no pointer. */
async function enter(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.focus();
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })
    );
  });
}

function focused(): string {
  const active = document.activeElement as HTMLElement;
  return active.getAttribute('aria-label') ?? active.textContent ?? '';
}

describe('the menu of the Ask button, from the keyboard', () => {
  it('takes the focus to the place chosen now when Enter opens it', async () => {
    await mount();
    await enter(toggle());
    expect(menu()).not.toBeNull();
    expect(focused()).toBe('✓New cell after [3]');
  });

  it('moves with the arrow keys, and picks with Enter', async () => {
    await mount();
    await enter(toggle());
    await key('ArrowDown');
    expect(focused()).toBe('Edit [3] in place');
    await key('ArrowUp');
    await key('ArrowUp');
    expect(focused()).toBe('A preview in the sidebar');
    await key('Home');
    await key('ArrowDown');
    await enter(document.activeElement as HTMLElement);
    // The menu closes, the focus is back on its toggle, and Ask reads Edit.
    expect(menu()).toBeNull();
    expect(focused()).toBe('Where the answer goes');
    expect(host.querySelector('button[type="submit"]')!.textContent).toBe(
      'Edit'
    );
  });

  it('opens from the toggle with the arrow keys', async () => {
    await mount();
    toggle().focus();
    await key('ArrowUp');
    expect(focused()).toBe('A preview in the sidebar');
  });

  it('closes on Escape, and gives the focus back to the toggle', async () => {
    await mount();
    await enter(toggle());
    await key('ArrowDown');
    await key('Escape');
    expect(menu()).toBeNull();
    expect(focused()).toBe('Where the answer goes');
  });

  it('closes on Tab from an item, with the focus on the toggle to go on from', async () => {
    await mount();
    await enter(toggle());
    await key('Tab');
    expect(menu()).toBeNull();
    expect(focused()).toBe('Where the answer goes');
  });

  it('keeps the focus on the toggle when a pointer opens the menu', async () => {
    await mount();
    await act(async () => {
      toggle().focus();
      toggle().dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
      );
    });
    expect(menu()).not.toBeNull();
    expect(focused()).toBe('Where the answer goes');
    await key('ArrowDown');
    expect(focused()).toBe('✓New cell after [3]');
  });
});
