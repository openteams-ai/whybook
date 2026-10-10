/**
 * The toolbar of a notebook opened in Whybook takes its items from the
 * settings of `whybook:toolbar` (schema/toolbar.json), as JupyterLab's
 * notebook takes its own from `@jupyterlab/notebook-extension:panel`: an
 * analyst leaves out the items they do not use, and adds the buttons of
 * commands, such as the kernel's Interrupt and Restart.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

const DEFAULT_ITEMS = [
  'epi-view',
  'epi-mode',
  'epi-layout',
  'epi-detail',
  'epi-run-all',
  'epi-ai',
  'spacer',
  'kernelName',
  'executionProgress'
];

async function openInWhybook(
  page: IJupyterLabPageFixture,
  file: string,
  sources = ['x = 1']
): Promise<void> {
  const notebook = {
    cells: sources.map((source, index) => ({
      cell_type: 'code',
      execution_count: null,
      id: `cell-${index}`,
      metadata: {},
      outputs: [],
      source
    })),
    metadata: {
      kernelspec: {
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
        name: 'python3'
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
  await page.evaluate(async (file: string) => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: file,
      factory: 'Whybook'
    });
  }, file);
  await page.waitForFunction(
    file =>
      (window as any).jupyterapp.shell.currentWidget?.context?.path === file &&
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    file,
    { timeout: 120000 }
  );
}

/** The names of the toolbar's items, in order, those in its overflow menu included. */
function itemNames(page: IJupyterLabPageFixture): Promise<string[]> {
  return page.evaluate(() => {
    const toolbar = (window as any).jupyterapp.shell.currentWidget.toolbar
      .node as HTMLElement;
    const popup = document.querySelector('.jp-Toolbar-responsive-popup');
    return [toolbar, popup]
      .filter((node): node is HTMLElement => !!node)
      .flatMap(node =>
        Array.from(node.querySelectorAll<HTMLElement>('[data-jp-item-name]'))
      )
      .map(node => node.dataset.jpItemName!)
      .filter(name => name !== 'toolbar-popup-opener');
  });
}

test('has the items of its settings, the view controls first and the kernel last', async ({
  page,
  tmpPath
}) => {
  await openInWhybook(page, `${tmpPath}/default.ipynb`);
  await expect.poll(() => itemNames(page)).toEqual(DEFAULT_ITEMS);
});

test("shows the kernel's status as JupyterLab's notebook does, next to the kernel's name", async ({
  page,
  tmpPath
}) => {
  await openInWhybook(page, `${tmpPath}/status.ipynb`);
  // JupyterLab's execution indicator: a circle that fills as the cells of a
  // run finish.
  await expect(
    page.locator(
      '[data-jp-item-name="executionProgress"] .jp-Notebook-ExecutionIndicator svg'
    )
  ).toHaveCount(1);
  const layout = (text?: string) =>
    page.evaluate(async (text?: string) => {
      const toolbar = (window as any).jupyterapp.shell.currentWidget.toolbar
        .node as HTMLElement;
      const label = toolbar.querySelector<HTMLElement>(
        '[data-jp-item-name="kernelName"] .jp-ToolbarButtonComponent-label'
      )!;
      if (text) {
        label.textContent = text;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const name = label.getBoundingClientRect();
      const circle = toolbar
        .querySelector('[data-jp-item-name="executionProgress"] svg')!
        .getBoundingClientRect();
      return {
        gap: circle.left - name.right,
        offset: Math.abs(
          name.top + name.height / 2 - (circle.top + circle.height / 2)
        ),
        cut: label.scrollWidth > label.clientWidth
      };
    }, text);
  // The name ends next to the circle, as in the notebook's toolbar, and the
  // two are centred on one line.
  const short = await layout();
  expect(short.gap).toBeGreaterThanOrEqual(2);
  expect(short.gap).toBeLessThanOrEqual(10);
  expect(short.offset).toBeLessThanOrEqual(1);
  expect(short.cut).toBe(false);
  // A long name is cut with an ellipsis before the circle; it ran on under
  // the circle before.
  const long = await layout(
    'R 4.5 in a conda environment with a very long name'
  );
  expect(long.gap).toBeGreaterThanOrEqual(2);
  expect(long.cut).toBe(true);
});

test("counts the cells of Run all in the kernel's status, one at a time", async ({
  page,
  tmpPath
}) => {
  await openInWhybook(page, `${tmpPath}/run.ipynb`, [
    'import time\ntime.sleep(2)\nx = 1',
    'time.sleep(2)\ny = x + 1',
    'time.sleep(2)\nz = y + 1'
  ]);
  const item = page.locator('[data-jp-item-name="executionProgress"]');
  const indicator = item.locator('.jp-Notebook-ExecutionIndicator');
  const tooltip = item.locator('.jp-Notebook-ExecutionIndicator-tooltip');
  void page.evaluate(() =>
    (window as any).jupyterapp.commands.execute('whybook:run-all-cells')
  );
  // Whybook sends a cell once the cell before it finished. JupyterLab's own
  // model of the indicator showed the kernel as idle from the second cell on,
  // with "Executed 2 cells".
  await expect(tooltip).toContainText('Executed 1/3 cells', {
    timeout: 20000
  });
  await expect(indicator).toHaveAttribute('data-status', 'busy');
  await expect(item.locator('[role="progressbar"]')).toHaveAttribute(
    'aria-valuenow',
    /^33\.3/
  );
  await expect(tooltip).toContainText('Executed 2/3 cells', {
    timeout: 20000
  });
  await expect(indicator).toHaveAttribute('data-status', 'busy');
  await expect(tooltip).toContainText('Executed 3 cells', { timeout: 20000 });
  await expect(indicator).toHaveAttribute('data-status', 'idle');
});

test.describe('with items left out and buttons added in the settings', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:toolbar': {
        toolbar: [
          { name: 'epi-mode', disabled: true },
          { name: 'epi-layout', disabled: true },
          {
            name: 'interrupt',
            command: 'whybook:interrupt-kernel',
            rank: 55
          },
          { name: 'restart', command: 'whybook:restart-kernel', rank: 56 }
        ]
      }
    }
  });

  test('leaves out the items turned off, and shows the commands as buttons with their icons', async ({
    page,
    tmpPath
  }) => {
    await openInWhybook(page, `${tmpPath}/custom.ipynb`);
    await expect
      .poll(() => itemNames(page))
      .toEqual([
        'epi-view',
        'epi-detail',
        'epi-run-all',
        'interrupt',
        'restart',
        'epi-ai',
        'spacer',
        'kernelName',
        'executionProgress'
      ]);
    await expect(page.locator('.jp-Epi-modes')).toHaveCount(0);
    // The buttons show the icons of the same buttons of JupyterLab's
    // notebook toolbar, with the command's caption as their tooltip.
    for (const [name, caption] of [
      ['interrupt', 'Interrupt the kernel of this notebook'],
      ['restart', 'Restart the kernel of this notebook']
    ]) {
      const item = page.locator(`[data-jp-item-name="${name}"]`);
      await expect(item.locator('svg')).toHaveCount(1);
      await expect(item.locator(`[title="${caption}"]`)).toHaveCount(1);
    }
    // Restart restarts the kernel of this notebook, through Whybook's command.
    const restarted = page.evaluate(
      () =>
        new Promise<boolean>(resolve => {
          const session = (window as any).jupyterapp.shell.currentWidget.context
            .sessionContext;
          const onStatus = () => {
            if (session.session?.kernel?.status === 'restarting') {
              session.statusChanged.disconnect(onStatus);
              resolve(true);
            }
          };
          session.statusChanged.connect(onStatus);
        })
    );
    await page
      .locator(
        '[data-jp-item-name="restart"] jp-button, [data-jp-item-name="restart"] button'
      )
      .first()
      .click();
    // JupyterLab's dialog asks first, as for the notebook's own Restart.
    await page.locator('.jp-Dialog .jp-mod-accept').click();
    expect(await restarted).toBe(true);
  });
});

/**
 * The three icons of the layouts fold into one menu button when, with them,
 * an item before the spacer would go into "⋯" (Run all and AI among them),
 * or when the button keeps an item in the row that the icons push into "⋯"
 * (src/ui/layoutitem.tsx). The widths of the folded button and of the three
 * icons, from style/toolbar.css and the segmented control of style/base.css.
 */
const BUTTON = 52;
const ICONS = 106;

/**
 * How many items JupyterLab's toolbar keeps in its row, of items of these
 * widths: as many as fit with its 2 + 5 px of padding and its 32 px "⋯"
 * button, and the last one too when every item fits with the padding alone.
 * The same count as `rowCount` of src/ui/layoutitem.tsx.
 */
function rowCount(widths: number[], room: number): number {
  let total = 0;
  let count = 0;
  for (const width of widths) {
    total += width;
    if (7 + 32 + total >= room) {
      break;
    }
    count++;
  }
  const all = widths.reduce((sum, width) => sum + width, 0);
  if (count >= widths.length - 1 && 7 + all < room) {
    return widths.length;
  }
  return Math.min(count, widths.length - 1);
}

interface IToolbarState {
  /** The toolbar's width, as the toolbar reads it. */
  room: number;
  /** The items in the toolbar's row and in its "⋯" menu, in order. */
  row: string[];
  menu: string[];
  folded: boolean;
  /** The widths of the items in the row, as the toolbar counts them. */
  widths: Record<string, number>;
  /** The items of the row drawn past the toolbar's end or under its row. */
  overflow: string[];
  height: number;
}

function toolbarState(page: IJupyterLabPageFixture): Promise<IToolbarState> {
  return page.evaluate(() => {
    const toolbar = (window as any).jupyterapp.shell.currentWidget.toolbar;
    const node = toolbar.node as HTMLElement;
    const opener = toolbar.layout.widgets.find((item: any) =>
      item.hasClass('jp-Toolbar-responsive-opener')
    );
    const items = toolbar.layout.widgets.filter((item: any) => item !== opener);
    const box = node.getBoundingClientRect();
    const widths: Record<string, number> = {};
    const overflow: string[] = [];
    for (const item of items) {
      const name = item.node.dataset.jpItemName as string;
      widths[name] = item.hasClass('jp-Toolbar-spacer')
        ? 2
        : item.node.clientWidth;
      const rect = (item.node as HTMLElement).getBoundingClientRect();
      if (
        rect.width > 0 &&
        (rect.right > box.right + 0.5 ||
          rect.top < box.top - 0.5 ||
          rect.bottom > box.bottom + 0.5)
      ) {
        overflow.push(name);
      }
    }
    const layout = document.querySelector(
      '[data-jp-item-name="epi-layout"]'
    ) as HTMLElement;
    return {
      room: node.clientWidth,
      row: items.map((item: any) => item.node.dataset.jpItemName),
      menu: Array.from(
        { length: opener.widgetCount() },
        (_, index) => opener.widgetAt(index).node.dataset.jpItemName
      ),
      folded: layout.classList.contains('jp-mod-folded'),
      widths,
      overflow,
      height: box.height
    };
  });
}

/** The state of the toolbar once it stays the same for half a second. */
async function settledState(
  page: IJupyterLabPageFixture
): Promise<IToolbarState> {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await toolbarState(page));
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [500], timeout: 20000 }
    )
    .toBe(true);
  return JSON.parse(last) as IToolbarState;
}

/** The widths of the items in "⋯", read with the menu open. */
async function menuWidths(
  page: IJupyterLabPageFixture
): Promise<Record<string, number>> {
  const opener = page
    .locator(
      '.jp-MainAreaWidget:not(.lm-mod-hidden) .jp-Toolbar-responsive-opener'
    )
    .first();
  if (!(await opener.isVisible())) {
    return {};
  }
  await opener.click();
  const widths = await page.evaluate(() => {
    const toolbar = (window as any).jupyterapp.shell.currentWidget.toolbar;
    const menu = toolbar.layout.widgets.find((item: any) =>
      item.hasClass('jp-Toolbar-responsive-opener')
    );
    const result: Record<string, number> = {};
    for (let index = 0; index < menu.widgetCount(); index++) {
      const item = menu.widgetAt(index);
      result[item.node.dataset.jpItemName] = item.hasClass('jp-Toolbar-spacer')
        ? 2
        : item.node.clientWidth;
    }
    return result;
  });
  await opener.click();
  return widths;
}

/**
 * At each width of the window, with both side panels open: the items that
 * the toolbar shows and those in "⋯", whether the three icons fold, and that
 * no item overflows the toolbar. The side panels open at the widths of a
 * fresh JupyterLab, or at their 250 px minimum in a workspace saved while a
 * panel was closed: the checks below hold at both, and the items in each
 * place follow from the widths that the browser gives the items.
 */
const WINDOWS: {
  width: number;
  check: (state: IToolbarState) => void;
}[] = [
  {
    width: 1024,
    check: state => {
      // The button stays in the toolbar, where the three icons went into "⋯".
      expect(state.folded).toBe(true);
      expect(state.row).toEqual(['epi-view', 'epi-mode', 'epi-layout']);
    }
  },
  {
    width: 1280,
    check: state => {
      expect(state.folded).toBe(true);
      expect(state.row).toContain('epi-detail');
      expect(state.menu).toContain('epi-ai');
    }
  },
  {
    width: 1366,
    check: state => {
      expect(state.row).toContain('epi-run-all');
      expect(state.menu).toEqual(
        expect.arrayContaining(['kernelName', 'executionProgress'])
      );
    }
  },
  {
    width: 1440,
    check: state => {
      expect(state.row).toEqual(
        expect.arrayContaining(['epi-run-all', 'epi-ai'])
      );
      expect(state.menu).toEqual(['kernelName', 'executionProgress']);
    }
  }
];

for (const { width, check } of WINDOWS) {
  test.describe(`in a window ${width} px wide`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('shows the items that fit, folds the layout icons when room is short, and overflows nothing', async ({
      page,
      tmpPath
    }) => {
      await openInWhybook(page, `${tmpPath}/fold.ipynb`);
      // Whybook opens both side panels with the first notebook.
      await expect(page.locator('#epi-variables')).toBeVisible();
      await expect(page.locator('#epi-exploration')).toBeVisible();
      await expect(page.locator('.jp-Epi-layoutitem')).toHaveCount(1);
      const state = await settledState(page);
      const widths = { ...state.widths, ...(await menuWidths(page)) };
      // The items keep their order, those in "⋯" after those shown.
      expect([...state.row, ...state.menu]).toEqual(DEFAULT_ITEMS);
      expect(state.overflow).toEqual([]);
      expect(state.height).toBeLessThan(40);
      // The layout's item measures what the toolbar counts for its form.
      expect(widths['epi-layout']).toBe(state.folded ? BUTTON : ICONS);
      // The toolbar's rows with the three icons and with the button.
      const sizes = (layout: number) =>
        DEFAULT_ITEMS.map(name =>
          name === 'epi-layout' ? layout : widths[name]
        );
      const withIcons = rowCount(sizes(ICONS), state.room);
      const withButton = rowCount(sizes(BUTTON), state.room);
      const beforeSpacer = DEFAULT_ITEMS.indexOf('spacer');
      expect({ width, folded: state.folded }).toEqual({
        width,
        folded: withIcons < beforeSpacer || withButton > withIcons
      });
      expect(state.row).toEqual(
        DEFAULT_ITEMS.slice(0, state.folded ? withButton : withIcons)
      );
      // The three icons show only with Run all and AI in the toolbar.
      if (!state.folded) {
        expect(state.row).toEqual(
          expect.arrayContaining(['epi-run-all', 'epi-ai'])
        );
      }
      check(state);
      test.info().annotations.push({
        type: 'toolbar',
        description: JSON.stringify({
          width,
          room: state.room,
          folded: state.folded,
          row: state.row,
          menu: state.menu
        })
      });
    });
  });
}

test.describe('the layout menu button', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('opens its menu from the keyboard, and gives the focus back on Escape', async ({
    page,
    tmpPath
  }) => {
    await openInWhybook(page, `${tmpPath}/menu.ipynb`);
    await expect(page.locator('#epi-exploration')).toBeVisible();
    const button = page.locator('.jp-Epi-layoutbutton');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    // Shift+Tab from the view reaches the toolbar, and the arrow keys move
    // along its items to the button.
    await page.locator('.jp-Epi-bench button').first().focus();
    await page.keyboard.press('Shift+Tab');
    for (
      let i = 0;
      i < 15 &&
      !(await button.evaluate(node => node === document.activeElement));
      i++
    ) {
      await page.keyboard.press('ArrowRight');
    }
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    const menu = page.locator('.jp-Epi-layoutmenu');
    await expect(menu).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    // The current layout, Panels in the sidebars, has the focus and the check.
    const current = menu.locator('.lm-Menu-item').first();
    await expect(current).toBeFocused();
    await expect(current).toHaveAttribute('aria-checked', 'true');
    await expect(menu.locator('.lm-Menu-itemLabel')).toHaveText([
      'Panels in the sidebars',
      'Variables beside the notebook',
      'All panels beside the notebook'
    ]);
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('.lm-Menu-item').nth(1)).toHaveClass(
      /lm-mod-active/
    );
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});
