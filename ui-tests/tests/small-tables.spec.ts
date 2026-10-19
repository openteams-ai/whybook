/**
 * A table of up to ten rows shows in full when it fits the card (design
 * iteration 1.138). A miniature shrinks its text to the smallest readable
 * size and is cut at its height: the 7 values of groups.explode("ages") in
 * Python Polars' chapter 12 showed 6 rows and part of the 7th. A table of
 * eleven rows stays a miniature.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

/** Write a notebook with these code cells, open it in Whybook, and wait for its kernel. */
async function openNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  code: string[]
): Promise<void> {
  const notebook = {
    cells: code.map((source, index) => ({
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
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

test('shows a table of seven or ten rows in full, and a table of eleven rows as a miniature', async ({
  page,
  tmpPath
}) => {
  const pains = [3.1, 2.8, 3.3, 2.9, 3.0, 2.7, 3.4, 3.2, 2.6, 3.1, 3.0];
  const frame = (rows: number) =>
    `pd.DataFrame({"week": range(${rows}), "pain": ${JSON.stringify(pains.slice(0, rows))}})`;
  await openNotebook(page, `${tmpPath}/small-tables.ipynb`, [
    'import pandas as pd\n\nages = pd.DataFrame({"ages": [18, 21, 30, 40, 50, 42, 69]})\nages',
    frame(10),
    frame(11)
  ]);
  await page.locator('.jp-Epi-runall').click();
  const table = (id: string) =>
    page.locator(`[data-cell-id="${id}"] .jp-Epi-tableoutput`);

  await expect(table('cell-0')).toHaveClass(/jp-mod-inline/, {
    timeout: 120000
  });
  // Every row shows at the size of the text around it, and no fade cuts the last.
  await expect(table('cell-0').locator('tbody tr')).toHaveCount(7);
  await expect(table('cell-0').locator('tbody tr').last()).toContainText('69');
  await expect(table('cell-0').locator('.jp-Epi-tableoutput-fade')).toHaveCount(
    0
  );
  const scale = await table('cell-0')
    .locator('.jp-Epi-tableoutput-content')
    .evaluate(node => getComputedStyle(node).transform);
  expect(scale).toBe('none');
  await expect(table('cell-1')).toHaveClass(/jp-mod-inline/);
  await expect(table('cell-1').locator('tbody tr')).toHaveCount(10);
  await expect(table('cell-2')).toHaveClass(/jp-mod-miniature/);
});
