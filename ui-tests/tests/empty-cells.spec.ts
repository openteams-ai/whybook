/**
 * A run of empty code cells takes one line on the bench, "6 empty code
 * cells", with no label (design iteration 1.136). Each empty cell was a card
 * "Empty cell" with Run and Show code: bio-heart-data-quality has 56 among
 * its 113 code cells. The Code view still shows each cell.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 120000 });

function code(id: string, source: string): object {
  return {
    cell_type: 'code',
    execution_count: null,
    id,
    metadata: {},
    outputs: [],
    source
  };
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
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

test('a run of empty code cells takes one line on the bench after Run all, and the Code view shows each cell', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/empty.ipynb`;
  const notebook = {
    cells: [
      code('resp', 'resp = {"caseid": [1, 2, 3]}'),
      ...['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map(id => code(id, '')),
      {
        cell_type: 'markdown',
        id: 'exercise',
        metadata: {},
        source: '**Exercise:** count the respondents.'
      },
      code('count', 'count = len(resp["caseid"])'),
      code('last', '')
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
  await openInWhybook(page, file);
  const bench = page.locator('.jp-Epi-bench');
  await page.locator('.jp-Epi-runall').click();
  await expect(
    bench.locator('.jp-Epi-cell[data-cell-id="count"] .jp-Epi-label')
  ).toHaveText('[2]', { timeout: 60000 });

  const lines = bench.locator('.jp-Epi-emptycells');
  await expect(lines).toHaveText(['6 empty code cells', 'An empty code cell']);
  await expect(lines.locator('.jp-Epi-label')).toHaveCount(0);
  await expect(bench.locator('.jp-Epi-cell')).toHaveCount(2);
  await expect(bench.locator('.jp-Epi-cell .jp-Epi-title')).toHaveText([
    'resp = {"caseid": [1, 2, 3]}',
    'count = len(resp["caseid"])'
  ]);
  // The line sits between the first card and the text, in the notebook's order.
  const order = await bench.evaluate(node =>
    Array.from(
      node.querySelectorAll('.jp-Epi-cell, .jp-Epi-note, .jp-Epi-emptycells')
    ).map(item =>
      item.classList.contains('jp-Epi-emptycells')
        ? 'line'
        : item.classList.contains('jp-Epi-note')
          ? 'text'
          : item.getAttribute('data-cell-id')
    )
  );
  expect(order).toEqual(['resp', 'line', 'text', 'count', 'line']);

  // The Code view shows every cell, the empty ones too.
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  await expect(page.locator('.jp-Epi-linear-cell.jp-mod-code')).toHaveCount(9);
});
