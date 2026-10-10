/**
 * The menu of the "⋯" button of a card (critique 5, the app, A24). The
 * button sent a synthetic right click, so that its menu was JupyterLab's
 * context menu, which ends with "Shift+Right Click for Browser Menu": a hint
 * about a gesture that the analyst did not make, and the widest line of the
 * menu. The button opens a menu of the cell's commands under itself, and a
 * right click keeps the context menu.
 */
import './fakes/quiet';

import { CommandRegistry } from '@lumino/commands';
import * as React from 'react';

import { addCellItem, cellUnderMenu } from '../cellmenu';
import { addContextMenus } from '../contextmenu';
import { Bench } from '../ui/bench';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

/**
 * JupyterLab's application, as the context menus use it: its commands, the
 * items of its context menu, and the element under the last right click.
 */
function application() {
  const commands = new CommandRegistry();
  const items: {
    command?: string;
    type?: string;
    selector: string;
    rank?: number;
  }[] = [];
  let clicked: HTMLElement | null = null;
  const app = {
    commands,
    contextMenu: {
      addItem: (item: (typeof items)[number]) => {
        items.push(item);
        return { dispose: () => undefined, isDisposed: false };
      }
    },
    contextMenuHitTest: (test: (node: HTMLElement) => boolean) => {
      for (let node = clicked; node; node = node.parentElement) {
        if (test(node)) {
          return node;
        }
      }
      return undefined;
    }
  };
  return {
    app: app as any,
    commands,
    items,
    rightClick: (node: HTMLElement) => {
      clicked = node;
    }
  };
}

/** The demo's model [5] after its data [4], on the bench. */
async function bench() {
  const { model } = benchModel([
    { id: 'data', source: 'model_data = diary.dropna()', count: 4 },
    {
      id: 'fit',
      source: 'fit = smf.mixedlm(formula, model_data).fit()',
      count: 5
    }
  ]);
  const ran: string[] = [];
  model.runCell = async (cellId: string) => {
    ran.push(cellId);
  };
  const view = await mount(
    <Bench model={model} editorServices={null} openFile={() => undefined} />
  );
  await settle();
  const button = (cellId: string) =>
    view.host.querySelector<HTMLButtonElement>(
      `[data-cell-id="${cellId}"] .jp-Epi-cellmenu`
    )!;
  return {
    model,
    ran,
    button,
    close: async () => {
      await view.unmount();
      model.dispose();
    }
  };
}

/** The menu open in the page, and the labels of the items it shows. */
function openMenu(): { node: HTMLElement | null; labels: string[] } {
  const node = document.body.querySelector<HTMLElement>('.lm-Menu');
  const labels = Array.from(
    node?.querySelectorAll(
      '.lm-Menu-item[data-type="command"]:not(.lm-mod-hidden) .lm-Menu-itemLabel'
    ) ?? []
  ).map(label => label.textContent ?? '');
  return { node, labels };
}

describe('The "⋯" button of a card', () => {
  it('opens the commands of its cell under it, which end with "Delete cell"', async () => {
    const { model, button, close } = await bench();
    const { app } = application();
    addContextMenus(app, () => model, model.settings);
    await step(() => button('fit').click());
    const { node, labels } = openMenu();
    await step(() => {
      node?.dispatchEvent(
        new KeyboardEvent('keydown', { keyCode: 27, bubbles: true })
      );
    });
    await close();
    expect(labels).toEqual([
      'Ask about this cell',
      'Run',
      'Show or hide the code',
      'Show on the map',
      'Show in the notebook',
      'Move up',
      'Move down',
      'Delete cell'
    ]);
  });

  it('holds the items of the context menu of the card, in the same order, with those of other plugins', async () => {
    const { model, button, close } = await bench();
    const { app, commands, items } = application();
    // The check-up's comparison, after "Ask about this cell", for [5] alone.
    commands.addCommand('test:compare', {
      label: 'Compare with statsmodels',
      isVisible: () => cellUnderMenu(app)?.dataset.cellId === 'fit',
      execute: () => undefined
    });
    addCellItem(app, {
      command: 'test:compare',
      args: { index: 0 },
      rank: 0.035
    });
    addContextMenus(app, () => model, model.settings);
    // "Show the agent's run", for a cell that a run wrote: not [5].
    commands.addCommand('test:run', {
      label: "Show the agent's run",
      isVisible: () => false,
      execute: () => undefined
    });
    addCellItem(app, { command: 'test:run', rank: 0.085 });
    await step(() => button('fit').click());
    const { node, labels } = openMenu();
    const shown = Array.from(
      node?.querySelectorAll<HTMLElement>('.lm-Menu-item') ?? []
    ).map(item => item.dataset.command ?? item.dataset.type);
    await step(() => {
      node?.dispatchEvent(
        new KeyboardEvent('keydown', { keyCode: 27, bubbles: true })
      );
    });
    await close();
    // The context menu of a card: its items by rank, as JupyterLab orders them.
    const context = items
      .filter(item => item.selector === '.jp-Epi [data-cell-id]')
      .sort((a, b) => a.rank! - b.rank!)
      .map(item => item.command ?? item.type);
    expect({ labels, shown }).toEqual({
      labels: [
        'Ask about this cell',
        'Compare with statsmodels',
        'Run',
        'Show or hide the code',
        'Show on the map',
        'Show in the notebook',
        'Move up',
        'Move down',
        'Delete cell'
      ],
      shown: context
    });
  });

  it('opens from the keyboard with its first item active, and Escape gives the focus back to the button', async () => {
    const { model, button, close } = await bench();
    const { app } = application();
    addContextMenus(app, () => model, model.settings);
    const menuButton = button('fit');
    menuButton.focus();
    // Enter or Space on a button clicks it, with no pointer.
    await step(() => {
      menuButton.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 0 })
      );
    });
    const { node } = openMenu();
    const opened = {
      active:
        node?.querySelector('.lm-Menu-item.lm-mod-active .lm-Menu-itemLabel')
          ?.textContent ?? null,
      focusInMenu: !!node && node.contains(document.activeElement),
      expanded: menuButton.getAttribute('aria-expanded')
    };
    await step(() => {
      node?.dispatchEvent(
        new KeyboardEvent('keydown', { keyCode: 27, bubbles: true })
      );
    });
    const closed = {
      open: !!document.body.querySelector('.lm-Menu'),
      onButton: document.activeElement === menuButton,
      expanded: menuButton.getAttribute('aria-expanded')
    };
    await close();
    expect({ opened, closed }).toEqual({
      opened: {
        active: 'Ask about this cell',
        focusInMenu: true,
        expanded: 'true'
      },
      closed: { open: false, onButton: true, expanded: 'false' }
    });
  });

  it('runs the item picked on the cell of the button, and a right click then acts on the cell under it', async () => {
    const { model, ran, button, close } = await bench();
    const { app, commands, rightClick } = application();
    const compared: (string | undefined)[] = [];
    commands.addCommand('test:compare', {
      label: 'Compare with statsmodels',
      execute: () => {
        compared.push(cellUnderMenu(app)?.dataset.cellId);
      }
    });
    addCellItem(app, { command: 'test:compare', rank: 0.035 });
    addContextMenus(app, () => model, model.settings);
    const key = (node: Element | null, keyCode: number) =>
      step(() => {
        node?.dispatchEvent(
          new KeyboardEvent('keydown', { keyCode, bubbles: true })
        );
      });
    // From the keyboard: down to "Run", then Enter.
    await step(() => {
      button('fit').dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 0 })
      );
    });
    let menu = openMenu().node;
    await key(menu, 40);
    await key(menu, 40);
    await key(menu, 13);
    await settle();
    // Down to the comparison, then Enter.
    await step(() => {
      button('fit').dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 0 })
      );
    });
    menu = openMenu().node;
    await key(menu, 40);
    await key(menu, 13);
    await settle();
    // A right click on [4], and Run in its context menu.
    rightClick(button('data').closest<HTMLElement>('[data-cell-id]')!);
    await commands.execute('whybook:run-cell');
    await commands.execute('test:compare');
    await close();
    expect({ ran, compared }).toEqual({
      ran: ['fit', 'data'],
      compared: ['fit', 'data']
    });
  });
});
