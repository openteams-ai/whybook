/**
 * How a template shows a table (design iteration 1.101).
 *
 * - "How many rows has each level of ...?", a question to start with that a
 *   file dropped on a new notebook offers, shows a table with a row for each
 *   level, and every row of it, where it printed a line for each column.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

// The test runs the question's code in a kernel.
test.describe.configure({ timeout: 180000 });

/**
 * A file with an id and 8 columns of 10 levels each: 80 rows of levels, more
 * than the 60 rows that pandas shows of a table before it cuts the table to
 * its first and last five rows.
 */
function levelsFile(): string {
  const columns = Array.from({ length: 8 }, (_, index) => `q${index + 1}`);
  const lines = [['patient_id', ...columns].join(',')];
  for (let row = 0; row < 200; row++) {
    lines.push(
      [
        `P${row}`,
        ...columns.map((_, index) => String((row + 3 * index) % 10))
      ].join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

/** A notebook with one empty code cell, as a new notebook has. */
async function newNotebook(
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
        source: ''
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
}

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
}

test('the levels of a file dropped on a new notebook show as a table with a row for each level, every row of it', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    levelsFile(),
    'text',
    `${tmpPath}/levels.csv`
  );
  await newNotebook(page, `${tmpPath}/levels.ipynb`);
  await openInWhybook(page, `${tmpPath}/levels.ipynb`);
  // A notebook without code leaves the file browser open.
  await expect(page.locator('#filebrowser')).toBeVisible();
  await page.filebrowser.refresh();
  const file = page.locator('.jp-DirListing-item', { hasText: 'levels.csv' });
  if (!(await file.isVisible())) {
    // The tree file browser shows the test's folder closed.
    await page
      .locator('.jp-DirListing-item', { hasText: tmpPath })
      .first()
      .click();
  }
  await expect(file).toBeVisible();

  // A Lumino drag: it starts once the pointer moves a few pixels.
  const from = (await file.boundingBox())!;
  const bench = (await page.locator('.jp-Epi-bench').boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y + from.height / 2 + 10, {
    steps: 5
  });
  await page.mouse.move(
    bench.x + bench.width / 2,
    bench.y + bench.height - 80,
    { steps: 10 }
  );
  await page.mouse.up();

  const levels = page.locator('.jp-Epi-popover .jp-Epi-option', {
    hasText: 'How many rows has each level of q1, q2, q3 and 5 more?'
  });
  await levels.click();
  const preview = page.locator('.jp-Epi-preview');
  const table = preview.locator('table').first();
  await expect(table).toBeVisible({ timeout: 60000 });
  // A row for each level of the 8 columns, all 80 of them, under the header rows.
  await expect(table.locator('thead')).toContainText('rows');
  await expect(table.locator('tbody tr')).toHaveCount(80);
  await expect(table.locator('tbody')).toContainText('q8');
  // The counts are no printed text.
  await expect(preview).not.toContainText('q1: ');
});
