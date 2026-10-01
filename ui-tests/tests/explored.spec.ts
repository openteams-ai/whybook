/**
 * Variables explored, in the Exploration panel (design iteration 1.82): past
 * five rows a list of a fixed height that scrolls under its head and its
 * count, with the wheel and with the keys; the rows in Auto order, the most
 * used and the largest first; and the menu of the head, from a right click,
 * Shift+F10 or the Menu key, which changes the order with a check mark on
 * the current one. jest checks the order and the block in jsdom too
 * (src/__tests__/explored.spec.tsx).
 *
 * The notebook keeps its frames and the analysis of its cells, as a notebook
 * saved by the view does, so no cell runs.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

/** The key of a kept analysis: FNV-1a of the source, as src/model/tables.ts computes it. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Twelve frames of a home energy notebook, with their rows and columns. */
const FRAMES: [string, number, number][] = [
  ['readings', 129058, 6],
  ['homes', 360, 10],
  ['readings_homes', 129058, 15],
  ['high_outliers', 5124, 6],
  ['sentinel', 4, 6],
  ['zero_rows', 5, 6],
  ['half_hourly', 241920, 3],
  ['tariffs', 5, 6],
  ['df', 33457, 17],
  ['summary', 2, 3],
  ['home_period', 93, 2],
  ['switchers', 22961, 17]
];

/** The frames that each cell reads: cell k makes the frame k, and the last cell makes none. */
const READS: string[][] = [
  ['readings'],
  ['readings', 'homes'],
  ['readings', 'homes', 'readings_homes'],
  ['readings', 'readings_homes', 'high_outliers'],
  ['readings', 'readings_homes', 'sentinel'],
  ['sentinel', 'zero_rows'],
  ['zero_rows', 'half_hourly'],
  ['half_hourly', 'tariffs'],
  ['readings_homes', 'tariffs', 'df'],
  ['half_hourly', 'tariffs', 'df', 'summary'],
  ['home_period'],
  ['readings_homes', 'switchers'],
  ['switchers']
];

/** Auto: by the cells that read each frame, then by its rows times columns. */
const AUTO = [
  'readings_homes',
  'readings',
  'half_hourly',
  'tariffs',
  'df',
  'switchers',
  'homes',
  'zero_rows',
  'sentinel',
  'high_outliers',
  'home_period',
  'summary'
];

/** Largest: by rows times columns; zero_rows and tariffs, as large, in the notebook's order. */
const LARGEST = [
  'readings_homes',
  'readings',
  'half_hourly',
  'df',
  'switchers',
  'high_outliers',
  'homes',
  'home_period',
  'zero_rows',
  'tariffs',
  'sentinel',
  'summary'
];

/** The notebook, with the frames and the analysis that the view keeps. */
function notebook(): object {
  const cells = READS.map((uses, index) => {
    const made = FRAMES[index]?.[0];
    const source = made
      ? `${made} = build(${uses.join(', ')})`
      : `plot(${uses.join(', ')})`;
    return {
      cell_type: 'code',
      execution_count: index + 1,
      id: `c${index}`,
      metadata: {
        whybook: {
          analysis: {
            defs: made ? [made] : [],
            uses,
            formulas: [],
            columns: made ? { [made]: [`${made}_0`] } : {},
            decisions: [],
            attachments: [],
            source: fingerprint(source)
          }
        }
      },
      outputs: [],
      source
    };
  });
  return {
    cells,
    metadata: {
      kernelspec: KERNELSPEC,
      whybook: {
        variables: FRAMES.map(([name, rows, columns], index) => ({
          name,
          label: name,
          kind: 'dataframe',
          rows,
          n_columns: columns,
          columns: Array.from({ length: columns }, (_, column) => ({
            label: `${name}_${column}`,
            kind: 'numeric',
            tag: 'num'
          })),
          cell: `c${index}`
        }))
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

/** Write the notebook, open it in the Whybook view, and show the Exploration panel. */
async function openNotebook(
  page: IJupyterLabPageFixture,
  tmpPath: string
): Promise<void> {
  const file = `${tmpPath}/energy.ipynb`;
  await page.contents.uploadContent(JSON.stringify(notebook()), 'text', file);
  await page.evaluate(async (file: string) => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: file,
      factory: 'Whybook'
    });
  }, file);
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0);
  await page.sidebar.openTab('epi-exploration');
}

/** The block Variables explored: its head, its list and the names of its rows. */
function explored(page: Page) {
  const block = page.locator('#epi-exploration .jp-Epi-explored');
  const list = block.locator('.jp-Epi-explored-list');
  return {
    head: block.locator('.jp-Epi-explored-head'),
    list,
    rows: list.locator('.jp-Epi-coverage'),
    names: () =>
      list.locator('.jp-Epi-coverage-head > span:first-child').allTextContents()
  };
}

/** How far the list is scrolled, and how much of it there is to scroll. */
function scrolled(list: Locator) {
  return list.evaluate(node => ({
    top: node.scrollTop,
    room: node.scrollHeight - node.clientHeight
  }));
}

/** The settings that the view saved for its plugin, as JSON text. */
async function savedRaw(page: Page): Promise<string> {
  return page.evaluate(
    async () =>
      (
        await (window as any).jupyterapp.serviceManager.settings.fetch(
          'whybook:plugin'
        )
      ).raw
  );
}

test('the list of Variables explored scrolls past five rows under its head and its count, with the wheel and with the keys', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, tmpPath);
  const { head, list, rows, names } = explored(page);
  await expect(rows).toHaveCount(12);
  await expect(head.locator('.jp-Epi-section-count')).toHaveText('12');
  await expect(head).toHaveAttribute(
    'title',
    'Order: Auto, the most used first, then the largest. Right-click to change it, or press Shift+F10.'
  );
  expect(await names()).toEqual(AUTO);

  // A fixed height, shorter than its rows: the last row is out of sight.
  await expect(list).toHaveClass(/jp-mod-scroll/);
  const start = await scrolled(list);
  expect(start.top).toBe(0);
  expect(start.room).toBeGreaterThan(200);
  await expect(rows.first()).toBeInViewport();
  await expect(rows.last()).not.toBeInViewport();

  // The wheel scrolls the list, and the head stays in sight.
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 150);
  await expect.poll(async () => (await scrolled(list)).top).toBeGreaterThan(0);
  await expect(head).toBeInViewport();

  // Tab goes from the head to the list, and the keys scroll it: End to the
  // last row, Home back to the first.
  await head.focus();
  await page.keyboard.press('Tab');
  await expect(list).toBeFocused();
  await page.keyboard.press('End');
  await expect
    .poll(async () => {
      const { top, room } = await scrolled(list);
      return room - top;
    })
    .toBeLessThanOrEqual(1);
  await expect(rows.last()).toBeInViewport();
  await expect(rows.first()).not.toBeInViewport();
  await expect(head).toBeInViewport();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await scrolled(list)).top).toBe(0);
  await expect(rows.first()).toBeInViewport();
});

test('the menu of the head of Variables explored changes the order, with a check mark on the current one, from a right click and from the keys', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, tmpPath);
  const { head, list, rows, names } = explored(page);
  await expect(rows).toHaveCount(12);
  expect(await names()).toEqual(AUTO);
  const menu = page.locator('.lm-Menu');

  // A right click on the head: the four orders, Auto checked.
  await head.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('.lm-Menu-item .lm-Menu-itemLabel')).toContainText([
    'Auto',
    'Most used',
    'Largest',
    'By name'
  ]);
  await expect(
    menu.getByRole('menuitemcheckbox', { name: 'Auto' })
  ).toHaveAttribute('aria-checked', 'true');
  await expect(menu.locator('.lm-Menu-item.lm-mod-toggled')).toHaveCount(1);
  // A new order shows the first rows of the list.
  await list.evaluate(node => {
    node.scrollTop = node.scrollHeight;
  });
  await expect.poll(async () => (await scrolled(list)).top).toBeGreaterThan(0);
  await menu.getByRole('menuitem', { name: 'By name' }).click();
  await expect(menu).toBeHidden();
  await expect.poll(names).toEqual([...AUTO].sort());
  await expect.poll(async () => (await scrolled(list)).top).toBe(0);
  await expect(head).toHaveAttribute('title', /^Order: By name, from A to Z\./);
  // The order is a setting, which the view saves.
  await expect.poll(() => savedRaw(page)).toContain('"exploredOrder": "name"');

  // Shift+F10 on the head opens the same menu, By name checked, and the
  // arrow keys and Enter pick an order; the head keeps the focus.
  await head.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole('menuitemcheckbox', { name: 'By name' })
  ).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect.poll(names).toEqual(LARGEST);
  await expect(head).toBeFocused();
  await expect.poll(() => savedRaw(page)).toContain('"exploredOrder": "size"');

  // The Menu key opens it too, and Escape closes it, with the focus back on
  // the head and the order as it was.
  await page.keyboard.press('ContextMenu');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole('menuitemcheckbox', { name: 'Largest' })
  ).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(head).toBeFocused();
  expect(await names()).toEqual(LARGEST);
});
