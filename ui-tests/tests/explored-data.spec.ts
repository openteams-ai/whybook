/**
 * Variables explored after a run of a notebook with no data frame (design
 * iteration 1.139). The block asked to run the notebook after Run all: the
 * SEIR demo of the sweep of public notebooks holds 16 variables after it,
 * arrays of numbers among them, and no frame. The owner chose to count
 * Series and arrays too: a Series is one square of the row "Series", and an
 * array of numbers of one or two dimensions is a row with its size and one
 * square, since its columns have no names. Each square fills when a cell
 * reads the variable. A notebook with none of these says that it has no
 * data frame yet.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

/** Write a notebook with these code cells, open it in Whybook, wait for its kernel, and show the Exploration panel. */
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
  await page.sidebar.openTab('epi-exploration');
}

/** Press Run all, and wait until the kernel's variables list this one. */
async function runAll(page: IJupyterLabPageFixture, name: string) {
  await page.locator('.jp-Epi-runall').click();
  await page.sidebar.openTab('epi-variables');
  await expect(
    page.locator(`.jp-Epi-variable[data-variable="${name}"]`)
  ).toBeVisible({ timeout: 120000 });
  await page.sidebar.openTab('epi-exploration');
}

/** The block Variables explored, its rows, and a row by its name. */
function explored(page: Page) {
  const block = page.locator('#epi-exploration .jp-Epi-explored');
  const rows = block.locator('.jp-Epi-explored-list .jp-Epi-coverage');
  return {
    block,
    rows,
    names: () =>
      block
        .locator('.jp-Epi-coverage-head > span:first-child')
        .allTextContents(),
    row: (name: string) =>
      rows.filter({
        has: page.locator('.jp-Epi-coverage-head > span:first-child', {
          hasText: new RegExp(`^${name}$`)
        })
      })
  };
}

test('says that a notebook with no data frame has none, once it ran', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, `${tmpPath}/savings.ipynb`, [
    'rate = 0.05\nyears = 10',
    'def grow(amount):\n    return amount * (1 + rate) ** years',
    'grow(100)'
  ]);
  const { block } = explored(page);
  await expect(block).toContainText(
    'Run the notebook to see which columns the analysis uses.'
  );
  await runAll(page, 'rate');
  await expect(block).toContainText('No data frame in this notebook yet.');
  await expect(block).not.toContainText('Run the notebook');
});

test('counts an array of numbers as a row with its size, and each Series as a square of one row', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, `${tmpPath}/seir.ipynb`, [
    [
      'import numpy as np',
      'import pandas as pd',
      '',
      'runs = np.linspace(0, 1, 40).reshape(10, 4)',
      'times = np.arange(10)',
      'axes = np.empty((2, 3), dtype=object)',
      'infected = pd.Series(runs[:, 2], name="infected")',
      'unused = pd.Series([1, 2, 3])'
    ].join('\n'),
    'infected.max(), times.sum()'
  ]);
  await runAll(page, 'runs');
  const { rows, names, row } = explored(page);
  await expect(rows).toHaveCount(3);
  // One cell reads each array: the larger first, and the Series last.
  expect(await names()).toEqual(['runs', 'times', 'Series']);
  await expect(row('runs').locator('.jp-Epi-mono')).toHaveText('10 × 4');
  await expect(row('runs').locator('.jp-Epi-squares > span')).toHaveCount(1);
  await expect(row('runs').locator('.jp-Epi-squares > span')).toHaveClass(
    'jp-mod-used'
  );
  await expect(row('runs').locator('.jp-Epi-caption')).toHaveText(
    'One square: its columns have no names'
  );
  await expect(row('times').locator('.jp-Epi-mono')).toHaveText('10 values');
  // One square for each Series: infected is read by a cell, unused is not.
  await expect(row('Series').locator('.jp-Epi-mono')).toHaveText('1 / 2');
  const squares = row('Series').locator('.jp-Epi-squares > span');
  await expect(squares).toHaveCount(2);
  await expect(squares.nth(0)).toHaveAttribute('title', 'infected');
  await expect(squares.nth(0)).toHaveClass('jp-mod-used');
  await expect(squares.nth(1)).toHaveAttribute('title', 'unused');
  await expect(squares.nth(1)).not.toHaveClass(/jp-mod-used/);
  // The axes are an array of objects: no row. The status bar's "explored"
  // sums up the columns of frames, and the notebook has none.
  expect(await names()).not.toContain('axes');
  await expect(page.locator('.jp-Epi-status')).toBeVisible();
  await expect(page.locator('.jp-Epi-status')).not.toContainText('explored');
});
