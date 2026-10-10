/**
 * The layout's item of Whybook's toolbar in JupyterLab's own toolbar
 * (`ReactiveToolbar`), which moves its last items into its "⋯" menu when
 * they do not fit: the kernel's status and name, then AI, Run all and the
 * level of detail, which come after the layout. The three icons of the
 * layouts fold into one menu button when, with them, Run all or AI would go
 * into "⋯", or when the button keeps an item out of "⋯" that the icons push
 * there. Otherwise they stay three icons.
 *
 * jsdom lays nothing out: each item reads the width that Chromium gives it in
 * JupyterLab, and the toolbar's own width is the room of the test. No kernel
 * and no server.
 */
import './fakes/quiet';

import { ReactiveToolbar, Toolbar } from '@jupyterlab/ui-components';
import { MessageLoop } from '@lumino/messaging';
import { Signal } from '@lumino/signaling';
import type { PanelLayout } from '@lumino/widgets';
import { Panel, Widget } from '@lumino/widgets';

import { TOOLBAR_ITEMS, createToolbarItem } from '../widgets';

/** The widths of the items, in px. */
const WIDTHS: Record<string, number> = {
  'epi-view': 161,
  'epi-mode': 171,
  'epi-detail': 182,
  'epi-run-all': 69,
  'epi-ai': 43,
  kernelName: 150,
  executionProgress: 21
};
/** The three icons of the layouts, and the menu button that they fold into. */
const ICONS = 106;
const BUTTON = 52;
/** The width that the toolbar counts for its spacer, and around its items. */
const SPACER = 2;
const PADDING = 7;
const OPENER = 32;

const ORDER: string[] = [...TOOLBAR_ITEMS];

/** The items from the kernel's name on, and from AI on, from Run all on. */
const KERNEL = ['kernelName', 'executionProgress'];
const FROM_AI = ['epi-ai', 'spacer', ...KERNEL];
const FROM_RUN_ALL = ['epi-run-all', ...FROM_AI];

let room = 1000;
let host: Panel | null = null;

afterEach(() => {
  host?.dispose();
  host = null;
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

/** The layout's item shows the menu button. */
function isFolded(item: Widget): boolean {
  return item.node.querySelector('.jp-Epi-layoutbutton') !== null;
}

function widthOf(name: string, item: Widget): number {
  if (name === 'epi-layout') {
    return isFolded(item)
      ? BUTTON
      : item.node.querySelector('[role="radiogroup"]')
        ? ICONS
        : 0;
  }
  return name === 'spacer' ? SPACER : WIDTHS[name];
}

/** A toolbar in a panel on the page, with the items of Whybook's toolbar. */
function setup(): { toolbar: ReactiveToolbar; layout: Widget } {
  const toolbar = new ReactiveToolbar();
  Object.defineProperty(toolbar.node, 'clientWidth', {
    configurable: true,
    get: () => room
  });
  host = new Panel();
  host.addWidget(toolbar);
  Widget.attach(host, document.body);
  const panel = {
    content: { model: fakeModel() },
    context: { sessionContext: {} },
    toolbar
  } as any;
  let layout: Widget | null = null;
  for (const name of ORDER) {
    const item =
      name === 'epi-layout'
        ? createToolbarItem('epi-layout', panel, {
            openSettings: () => undefined
          })
        : name === 'spacer'
          ? Toolbar.createSpacerItem()
          : new Widget();
    if (name === 'epi-layout') {
      layout = item;
    }
    Object.defineProperty(item.node, 'clientWidth', {
      configurable: true,
      get: () => widthOf(name, item)
    });
    toolbar.addItem(name, item);
  }
  return { toolbar, layout: layout! };
}

/** The toolbar's "⋯" button, and the items in its menu. */
function opener(toolbar: ReactiveToolbar): Widget & {
  widgetCount(): number;
  widgetAt(index: number): Widget;
} {
  return (toolbar.layout as PanelLayout).widgets.find(item =>
    item.hasClass('jp-Toolbar-responsive-opener')
  ) as any;
}

function inToolbar(toolbar: ReactiveToolbar): string[] {
  return Array.from(toolbar.names()).filter(
    name => name !== 'toolbar-popup-opener'
  );
}

function inMenu(toolbar: ReactiveToolbar): string[] {
  const menu = opener(toolbar);
  return Array.from(
    { length: menu.widgetCount() },
    (_, index) => menu.widgetAt(index).node.dataset.jpItemName ?? ''
  );
}

/** The width of the toolbar's row, as the toolbar counts it. */
function used(toolbar: ReactiveToolbar, layout: Widget): number {
  const items = inToolbar(toolbar).reduce(
    (sum, name) => sum + widthOf(name, layout),
    0
  );
  return PADDING + items + (opener(toolbar).isHidden ? 0 : OPENER);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

/** The toolbar gets a new width, as when the window or a side panel changes. */
async function resize(toolbar: ReactiveToolbar, width: number): Promise<void> {
  room = width;
  MessageLoop.sendMessage(toolbar, new Widget.ResizeMessage(width, 32));
  await settle();
}

describe('the layout item in the toolbar', () => {
  it('keeps the three icons while every item fits with them, and folds them when the button keeps the kernel in the toolbar', async () => {
    room = 1000;
    const { toolbar, layout } = setup();
    await settle();
    await resize(toolbar, 1000);
    expect(isFolded(layout)).toBe(false);
    expect(inMenu(toolbar)).toEqual([]);
    // With the three icons the kernel's name and status go into "⋯"; with
    // the button they fit.
    await resize(toolbar, 900);
    expect(isFolded(layout)).toBe(true);
    expect(inToolbar(toolbar)).toEqual(ORDER);
    expect(inMenu(toolbar)).toEqual([]);
    expect(used(toolbar, layout)).toBeLessThanOrEqual(900);
    await resize(toolbar, 1000);
    expect(isFolded(layout)).toBe(false);
    expect(inMenu(toolbar)).toEqual([]);
  });

  it('keeps the three icons when the button brings nothing back, and folds them before AI or Run all go into "⋯"', async () => {
    room = 1000;
    const { toolbar, layout } = setup();
    await settle();
    // The kernel's name and status are in "⋯" with the icons and with the
    // button: the icons stay.
    await resize(toolbar, 800);
    expect(isFolded(layout)).toBe(false);
    expect(inMenu(toolbar)).toEqual(KERNEL);
    // With the icons AI would go into "⋯": the button keeps it.
    await resize(toolbar, 760);
    expect(isFolded(layout)).toBe(true);
    expect(inMenu(toolbar)).toEqual(KERNEL);
    // With the icons Run all would go too: the button keeps Run all.
    await resize(toolbar, 700);
    expect(isFolded(layout)).toBe(true);
    expect(inMenu(toolbar)).toEqual(FROM_AI);
    expect(used(toolbar, layout)).toBeLessThanOrEqual(700);
    // As narrow as the toolbar of a window 1024 px wide with both side
    // panels open: the button stays in the toolbar, where the three icons
    // went into "⋯".
    await resize(toolbar, 450);
    expect(isFolded(layout)).toBe(true);
    expect(inToolbar(toolbar)).toEqual(['epi-view', 'epi-mode', 'epi-layout']);
    await resize(toolbar, 800);
    expect(isFolded(layout)).toBe(false);
    expect(inMenu(toolbar)).toEqual(KERNEL);
  });

  it('never shows the three icons while Run all or AI are in "⋯", and nothing overflows the toolbar', async () => {
    room = 1000;
    const { toolbar, layout } = setup();
    await settle();
    // The width of the toolbar, whether the icons fold, and the items in "⋯".
    const steps: [number, boolean, string[]][] = [
      [1000, false, []],
      [950, false, []],
      [900, true, []],
      [850, false, KERNEL],
      [780, false, KERNEL],
      [760, true, KERNEL],
      [740, true, KERNEL],
      [700, true, FROM_AI],
      [680, true, FROM_AI],
      [670, true, FROM_RUN_ALL],
      [640, true, FROM_RUN_ALL],
      [600, true, ['epi-detail', ...FROM_RUN_ALL]],
      [450, true, ['epi-detail', ...FROM_RUN_ALL]],
      [400, true, ['epi-layout', 'epi-detail', ...FROM_RUN_ALL]],
      [600, true, ['epi-detail', ...FROM_RUN_ALL]],
      [700, true, FROM_AI],
      [760, true, KERNEL],
      [800, false, KERNEL],
      [900, true, []],
      [1000, false, []]
    ];
    for (const [width, folded, menu] of steps) {
      await resize(toolbar, width);
      expect({
        width,
        folded: isFolded(layout),
        menu: inMenu(toolbar)
      }).toEqual({ width, folded, menu });
      expect([...inToolbar(toolbar), ...inMenu(toolbar)]).toEqual(ORDER);
      expect(used(toolbar, layout)).toBeLessThanOrEqual(width);
      if (!isFolded(layout)) {
        expect(inToolbar(toolbar)).toContain('epi-run-all');
        expect(inToolbar(toolbar)).toContain('epi-ai');
      }
    }
  });

  it('leaves the toolbar alone once it is taken out of it, as when the toolbar settings change', async () => {
    room = 1000;
    const { toolbar, layout } = setup();
    await settle();
    await resize(toolbar, 1000);
    expect(isFolded(layout)).toBe(false);
    // JupyterLab takes the items out without disposing of them, and puts in
    // new ones: here an item of the same name, 300 px wide.
    layout.parent = null;
    const other = new Widget();
    Object.defineProperty(other.node, 'clientWidth', { get: () => 300 });
    toolbar.insertItem(2, 'epi-layout', other);
    await settle();
    await resize(toolbar, 1000);
    expect(inMenu(toolbar)).toEqual(KERNEL);
    expect(isFolded(layout)).toBe(false);
  });
});
