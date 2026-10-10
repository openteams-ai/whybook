/**
 * The layout's menu button, which Whybook's toolbar shows in place of the
 * three icons of the layouts when it is short of room
 * (src/ui/layoutmenu.tsx): the icon of the current layout and a caret, and
 * JupyterLab's menu of the three layouts, with the mouse and the keyboard.
 */
import './fakes/quiet';

import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { Signal } from '@lumino/signaling';

import { LayoutMenuButton } from '../ui/layoutmenu';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function fakeModel(): any {
  const changed = new Signal<unknown, void>({});
  const settings: any = {
    variablesPlacement: 'sidebar',
    explorationPlacement: 'sidebar',
    set(key: string, value: unknown) {
      settings[key] = value;
      changed.emit();
    }
  };
  return { changed, settings };
}

async function mount(model: any): Promise<HTMLButtonElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<LayoutMenuButton model={model} />);
  });
  return host.querySelector('button')!;
}

function menuNode(): HTMLElement | null {
  return document.body.querySelector('.jp-Epi-layoutmenu');
}

function items(): HTMLElement[] {
  return Array.from(
    menuNode()?.querySelectorAll<HTMLElement>('.lm-Menu-item') ?? []
  );
}

/** A key pressed on the element that has the focus: Lumino's menus read its code. */
async function press(key: string, code: number): Promise<void> {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true
  });
  Object.defineProperty(event, 'keyCode', { value: code });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
}

/** A click from Enter or Space on the button: it has no pointer. */
async function keyClick(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })
    );
  });
}

/** Lumino takes the menu out of the page, and the focus comes back a frame later. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
  });
}

describe('the layout menu button', () => {
  it('is a menu button that shows the current layout', async () => {
    const button = await mount(fakeModel());
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe(
      'Layout: where the panels go. Panels in the sidebars'
    );
    // The icon of the layout and a caret.
    expect(button.querySelector('svg.jp-Epi-layout-icon')).not.toBeNull();
    expect(
      button.querySelector('.jp-Epi-layoutbutton-caret svg')
    ).not.toBeNull();
  });

  it('opens the menu of the three layouts from the keyboard, picks one with the arrows and Enter, and gives the focus back', async () => {
    const model = fakeModel();
    const button = await mount(model);
    button.focus();
    await keyClick(button);
    // Lumino gives the focus to the menu a moment after it opens.
    await frame();
    const menu = menuNode();
    expect(menu).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(menu!.id);
    expect(
      menu!.querySelector('[role="menu"]')?.getAttribute('aria-label')
    ).toBe('Layout: where the panels go');
    // Each layout with its icon and its title; the current one is checked.
    expect(
      items().map(item => item.querySelector('.lm-Menu-itemLabel')?.textContent)
    ).toEqual([
      'Panels in the sidebars',
      'Variables beside the notebook',
      'All panels beside the notebook'
    ]);
    for (const item of items()) {
      expect(item.querySelector('.lm-Menu-itemIcon svg')).not.toBeNull();
    }
    expect(items().map(item => item.getAttribute('role'))).toEqual([
      'menuitemcheckbox',
      'menuitem',
      'menuitem'
    ]);
    expect(items()[0].getAttribute('aria-checked')).toBe('true');
    expect(
      items()[0].querySelector('.lm-Menu-itemShortcut svg')
    ).not.toBeNull();
    // The focus is on the current layout.
    expect(document.activeElement).toBe(items()[0]);
    await press('ArrowDown', 40);
    expect(document.activeElement).toBe(items()[1]);
    await press('Enter', 13);
    expect(model.settings.variablesPlacement).toBe('document');
    expect(model.settings.explorationPlacement).toBe('sidebar');
    expect(menuNode()).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await frame();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-label')).toBe(
      'Layout: where the panels go. Variables beside the notebook'
    );
  });

  it('opens on the last layout with the up arrow, on the current one with the down arrow, and closes with Escape', async () => {
    const button = await mount(fakeModel());
    button.focus();
    await press('ArrowUp', 38);
    await frame();
    expect(menuNode()).not.toBeNull();
    expect(document.activeElement).toBe(items()[2]);
    await press('Escape', 27);
    expect(menuNode()).toBeNull();
    await frame();
    expect(document.activeElement).toBe(button);
    await press('ArrowDown', 40);
    await frame();
    expect(document.activeElement).toBe(items()[0]);
    await press('Escape', 27);
  });

  it('opens with a click, and closes with a second click on the button', async () => {
    const button = await mount(fakeModel());
    // A click of the mouse, which counts one press.
    const click = () =>
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
      );
    await act(async () => click());
    expect(menuNode()).not.toBeNull();
    // Lumino closes its menu on a press outside it; the click that follows
    // does not open it again.
    await act(async () => {
      button.dispatchEvent(
        // jsdom has no PointerEvent: the listeners read the type and the button.
        new MouseEvent('pointerdown', { bubbles: true, button: 0 })
      );
    });
    expect(menuNode()).toBeNull();
    await act(async () => click());
    expect(menuNode()).toBeNull();
    await frame();
    await act(async () => click());
    expect(menuNode()).not.toBeNull();
  });
});
