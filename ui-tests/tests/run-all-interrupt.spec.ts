/**
 * An interrupt during Run all stops the run, as Run All Cells of JupyterLab's
 * notebook stops (design iteration 1.135). Interrupt Kernel stopped only the
 * cell that ran, and Run all went on with the cells after it. The sweep's
 * notebook of four cells: Run all, then Interrupt Kernel of the Kernel menu
 * while the second cell sleeps.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 120000 });

const SOURCES = [
  "import time\nprint('cell 0 ran')",
  "time.sleep(15)\nprint('cell 1 ran')",
  "print('cell 2 ran')",
  "print('cell 3 ran')"
];

async function openInWhybook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  await page.evaluate(async (file: string) => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: file,
      factory: 'Whybook'
    });
  }, file);
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0);
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

test('Interrupt Kernel during Run all stops the run, and the cells after the interrupted one stay not run', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/interrupt.ipynb`;
  const notebook = {
    cells: SOURCES.map((source, index) => ({
      cell_type: 'code',
      execution_count: null,
      id: `c${index}`,
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
  await openInWhybook(page, file);
  const card = (index: number) =>
    page.locator(`.jp-Epi-bench .jp-Epi-cell[data-cell-id="c${index}"]`);

  await page.locator('.jp-Epi-runall').click();
  await expect(card(0)).toContainText('cell 0 ran', { timeout: 60000 });
  // The second cell sleeps.
  await expect(card(1).locator('.jp-Epi-cell-actions')).toContainText(
    'Running'
  );
  await page.menu.clickMenuItem('Kernel>Interrupt Kernel');
  await expect(card(1)).toContainText('KeyboardInterrupt', { timeout: 30000 });
  // Run all ends: no cell after it would start later.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).jupyterapp.shell.currentWidget.content.model
            .runningAll
      )
    )
    .toBe(false);
  await expect(card(0).locator('.jp-Epi-label')).toHaveText('[1]');
  await expect(card(1).locator('.jp-Epi-label')).toHaveText('[2]');
  for (const index of [2, 3]) {
    await expect(card(index).locator('.jp-Epi-label')).toHaveText('[ ]');
    // The title is the cell's code; the outputs go under it.
    await expect(card(index).locator('.jp-Epi-cell-foot')).not.toContainText(
      `cell ${index} ran`
    );
  }
  const outputs = await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const counts: number[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      counts.push(model.cells.get(i).outputs.length);
    }
    return counts;
  });
  expect(outputs.slice(2)).toEqual([0, 0]);
});
