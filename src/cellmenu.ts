import type { JupyterFrontEnd } from '@jupyterlab/application';
import { MenuSvg } from '@jupyterlab/ui-components';
import type { ReadonlyJSONObject } from '@lumino/coreutils';

/**
 * The menu of a cell: the context menu that a right click on a card opens,
 * and the menu of the card's "⋯" button, with the same items in the same
 * order. ./contextmenu.ts, the check-up and the agents' runs add the items
 * here, and the bench opens the menu of a button from here.
 */

/** A cell's element: a card, a map node or a note. */
export const CELL = '.jp-Epi [data-cell-id]';

/** An item of the menu of a cell: a command with its arguments, or a line. */
export interface ICellItem {
  command?: string;
  args?: ReadonlyJSONObject;
  type?: 'separator';
  rank: number;
}

/** The items of the menu of a cell, by application. */
const CELL_ITEMS = new WeakMap<JupyterFrontEnd, ICellItem[]>();

/**
 * Add an item to the menu of every cell: the context menu of a right click
 * on a card, and the menu of the card's "⋯" button. Both show the items in
 * the order of their ranks. The command finds its cell with `cellUnderMenu`.
 */
export function addCellItem(app: JupyterFrontEnd, item: ICellItem): void {
  let items = CELL_ITEMS.get(app);
  if (!items) {
    items = [];
    CELL_ITEMS.set(app, items);
  }
  items.push(item);
  app.contextMenu.addItem({ ...item, selector: CELL });
}

/**
 * The menu of the "⋯" buttons of the cards of an application, and the
 * button and the card of the menu while it is open and while it runs the
 * command picked in it.
 */
class ButtonMenu {
  constructor(readonly app: JupyterFrontEnd) {
    this.menu = new MenuSvg({ commands: app.commands });
    this.menu.addClass('jp-Epi-cellmenu-menu');
    this.menu.aboutToClose.connect(this._closing, this);
  }

  readonly menu: MenuSvg;
  button: HTMLElement | null = null;
  card: HTMLElement | null = null;

  /** Open the menu of the cell of this card under its "⋯" button. */
  open(button: HTMLElement, card: HTMLElement, keyboard: boolean): void {
    const { menu } = this;
    menu.clearItems();
    const items = [...(CELL_ITEMS.get(this.app) ?? [])].sort(
      (a, b) => a.rank - b.rank
    );
    for (const item of items) {
      menu.addItem(
        item.type === 'separator'
          ? { type: 'separator' }
          : { command: item.command, args: item.args }
      );
    }
    this.button = button;
    this.card = card;
    const box = button.getBoundingClientRect();
    menu.open(box.left, box.bottom);
    if (keyboard) {
      menu.activateNextItem();
    }
    button.setAttribute('aria-expanded', 'true');
  }

  /** Escape or a pick: the focus goes back to the button. */
  private _closing(): void {
    const { button, menu } = this;
    button?.setAttribute('aria-expanded', 'false');
    if (button?.isConnected && menu.node.contains(document.activeElement)) {
      button.focus();
    }
    // The command picked runs right after the menu closes, on this cell.
    void Promise.resolve().then(() => {
      if (!menu.isAttached) {
        this.button = null;
        this.card = null;
      }
    });
  }
}

/** The menu of the "⋯" buttons of the cards, which `makeCellMenu` makes. */
let buttonMenu: ButtonMenu | null = null;

/** Make the menu of the "⋯" buttons of the cards of this application. */
export function makeCellMenu(app: JupyterFrontEnd): void {
  buttonMenu = new ButtonMenu(app);
}

/**
 * The element of the cell that a menu of a cell is about: the card of the
 * "⋯" button whose menu is open or runs its command, or else the element
 * under the last right click.
 */
export function cellUnderMenu(app: JupyterFrontEnd): HTMLElement | undefined {
  const card = buttonMenu?.app === app ? buttonMenu.card : null;
  return (
    card ?? app.contextMenuHitTest(node => node.dataset.cellId !== undefined)
  );
}

/**
 * Open the menu of a card's cell under the card's "⋯" button: the items of
 * the cell's context menu, without JupyterLab's line about the browser's
 * menu, which is about a right click. From the keyboard, the first item is
 * active. Escape closes the menu, and the focus goes back to the button, as
 * it does after a pick, unless the command picked moves it. False when the
 * page has no such menu.
 */
export function openCellMenu(button: HTMLElement, keyboard: boolean): boolean {
  const card = button.closest<HTMLElement>('[data-cell-id]');
  if (!buttonMenu || !card) {
    return false;
  }
  buttonMenu.open(button, card, keyboard);
  return true;
}
