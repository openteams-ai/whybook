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
