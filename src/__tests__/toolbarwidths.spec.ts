/**
 * The parts of JupyterLab's toolbar that the layout's item of Whybook's
 * toolbar relies on (src/ui/layoutitem.tsx): the widths that
 * `ReactiveToolbar` keeps for its items, by their names, in a private field;
 * what it counts beside them, 2 + 5 px of padding and 32 px for its "⋯"
 * button; and how many items it keeps in its row (`rowCount`). These tests
 * fail when JupyterLab changes them. Without the widths, the item keeps one
 * width: the three icons.
 *
 * jsdom lays nothing out: each item reads 100 px, and the toolbar's width is
 * the room of the test.
 */
import './fakes/quiet';

import { ReactiveToolbar } from '@jupyterlab/ui-components';
import { MessageLoop } from '@lumino/messaging';
import type { PanelLayout } from '@lumino/widgets';
import { Panel, Widget } from '@lumino/widgets';

import {
  OPENER_WIDTH,
  TOOLBAR_PADDING,
  rowCount,
  toolbarWidths
} from '../ui/layoutitem';

const NAMES = ['a', 'b', 'c', 'd'];
const WIDTH = 100;

let room = 1000;
let host: Panel | null = null;

afterEach(() => {
  host?.dispose();
  host = null;
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function setup(): Promise<ReactiveToolbar> {
  const toolbar = new ReactiveToolbar();
  Object.defineProperty(toolbar.node, 'clientWidth', {
    configurable: true,
    get: () => room
  });
  host = new Panel();
  host.addWidget(toolbar);
  Widget.attach(host, document.body);
  for (const name of NAMES) {
    const item = new Widget();
    Object.defineProperty(item.node, 'clientWidth', { get: () => WIDTH });
    toolbar.addItem(name, item);
  }
  // The toolbar measures every item again at its first size: it reads the
  // zoom then.
  await resize(toolbar, room);
  return toolbar;
}

async function resize(toolbar: ReactiveToolbar, width: number): Promise<void> {
  room = width;
  MessageLoop.sendMessage(toolbar, new Widget.ResizeMessage(width, 32));
  await settle();
}

/** The items in the toolbar's "⋯" menu. */
function inMenu(toolbar: ReactiveToolbar): string[] {
  const opener = (toolbar.layout as PanelLayout).widgets.find(item =>
    item.hasClass('jp-Toolbar-responsive-opener')
  ) as any;
  return Array.from(
    { length: opener.widgetCount() },
    (_, index) => opener.widgetAt(index).node.dataset.jpItemName
  );
}

describe("JupyterLab's toolbar", () => {
  it('keeps the width of each item by its name, and lays out its items by a width written there', async () => {
    room = 1000;
    const toolbar = await setup();
    const widths = toolbarWidths(toolbar);
    expect(widths).toBeInstanceOf(Map);
    expect(Object.fromEntries(widths!)).toEqual({
      a: WIDTH,
      b: WIDTH,
      c: WIDTH,
      d: WIDTH
    });
    expect(inMenu(toolbar)).toEqual([]);
    // The item b grows by 600 px, and gives the toolbar its new width.
    widths!.set('b', WIDTH + 600);
    await resize(toolbar, 1000);
    expect(inMenu(toolbar)).toEqual(['d']);
  });

  it('counts 2 + 5 px of padding, and 32 px for its "⋯" button', async () => {
    room = 1000;
    const toolbar = await setup();
    await resize(toolbar, 250);
    expect(inMenu(toolbar)).toEqual(['c', 'd']);
    // An item comes back from "⋯" when it fits with the padding and the
    // "⋯" button that stays for the next item.
    await resize(toolbar, TOOLBAR_PADDING + OPENER_WIDTH + 3 * WIDTH);
    expect(inMenu(toolbar)).toEqual(['c', 'd']);
    await resize(toolbar, TOOLBAR_PADDING + OPENER_WIDTH + 3 * WIDTH + 1);
    expect(inMenu(toolbar)).toEqual(['d']);
    // The last one comes back when it fits with the padding alone.
    await resize(toolbar, TOOLBAR_PADDING + 4 * WIDTH);
    expect(inMenu(toolbar)).toEqual(['d']);
    await resize(toolbar, TOOLBAR_PADDING + 4 * WIDTH + 1);
    expect(inMenu(toolbar)).toEqual([]);
  });

  it('keeps as many items in its row as rowCount gives, as it narrows and widens', async () => {
    room = 1000;
    const toolbar = await setup();
    // No width where an item fits exactly: the toolbar keeps such an item in
    // its row, and does not bring it back from "⋯".
    for (const width of [445, 415, 405, 345, 245, 150, 245, 345, 405, 415]) {
      await resize(toolbar, width);
      const count = rowCount(
        NAMES.map(() => WIDTH),
        width
      );
      expect({ width, menu: inMenu(toolbar) }).toEqual({
        width,
        menu: NAMES.slice(count)
      });
    }
  });
});
