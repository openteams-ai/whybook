/**
 * The question about the levels of a column, "Does y differ between the
 * levels of x?", waits for a column of at most 20 levels (design iteration
 * 1.140). The sweep of public notebooks offered it for columns of 27 to 3,239
 * levels, mostly dates stored as text: AverageTemperature dragged onto dt in
 * Berkeley Earth's temperatures of Germany. The quick look at both columns
 * stays, and so do the questions that need AI.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

const TEMPERATURES = [
  'import pandas as pd',
  '',
  'days = [f"2019-01-{day:02d}" for day in range(1, 31)]',
  'temps = pd.DataFrame({',
  '    "dt": days * 2,',
  '    "site": ["north", "south", "east"] * 20,',
  '    "temperature": [round(5 + 0.1 * i, 1) for i in range(60)],',
  '})',
  'temps.head()'
].join('\n');

/** Write a notebook with this code cell, open it in Whybook, run it, and wait for the kernel. */
async function openAndRun(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const notebook = {
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        id: 'cell-0',
        metadata: {},
        outputs: [],
        source: TEMPERATURES
      }
    ],
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
  await page.locator('.jp-Epi-runall').click();
  await page.sidebar.openTab('epi-variables');
  const temps = page.locator('.jp-Epi-variable[data-variable="temps"]');
  await expect(temps).toBeVisible({ timeout: 120000 });
  await temps.click();
  await expect(column(page, 'temperature')).toBeVisible();
}

function column(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator('.jp-Epi-contents .jp-Epi-column').filter({
    has: page.locator('.jp-Epi-item-name', { hasText: new RegExp(`^${name}$`) })
  });
}

/** An HTML5 drag. Chromium starts a drag only when the mouse moves in steps. */
async function drag(
  page: IJupyterLabPageFixture,
  source: Locator,
  target: Locator
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 5, {
    steps: 5
  });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 10
  });
  await page.mouse.up();
}

/** The texts of the questions of the popover, once it holds the quick look at both columns. */
async function questions(
  page: IJupyterLabPageFixture,
  quickLook: string
): Promise<string[]> {
  const texts = page.locator(
    '.jp-Epi-popover .jp-Epi-option .jp-Epi-option-text'
  );
  await expect(texts.filter({ hasText: quickLook })).toHaveCount(1, {
    timeout: 30000
  });
  return texts.allTextContents();
}

test('asks whether a number differs between the levels of a column of 3 levels, and not of one of 30', async ({
  page,
  tmpPath
}) => {
  await openAndRun(page, `${tmpPath}/temperatures.ipynb`);
  // 30 dates stored as text.
  await drag(page, column(page, 'temperature'), column(page, 'dt'));
  const many = await questions(
    page,
    'Summarise temperature and dt: distribution and missingness'
  );
  expect(
    many.filter(text => text.includes('differ between the levels'))
  ).toEqual([]);
  // A question that needs AI about its levels stays.
  expect(many).toContain(
    'Is the spread of temperature similar across the levels of dt?'
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('.jp-Epi-popover')).toHaveCount(0);
  // Three sites.
  await drag(page, column(page, 'temperature'), column(page, 'site'));
  const few = await questions(
    page,
    'Summarise temperature and site: distribution and missingness'
  );
  expect(few).toContain('Does temperature differ between the levels of site?');
});
