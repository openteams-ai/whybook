/**
 * A card's title does not stop at an open bracket (design iteration 1.137).
 * A card's title is the first line of its code, so a call written over
 * several lines gave titles such as "corpus = pl.DataFrame(": 244 cards in
 * 24 notebooks of the sweep of real notebooks. The title now closes the
 * brackets that its line leaves open, after an ellipsis. A bracket in a
 * string or a comment does not count, and a comment gives its text, as
 * before.
 *
 * No kernel runs and no model is called: the fixture aborts each request to
 * a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

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

test('the title of a call written over several lines closes its brackets after an ellipsis', async ({
  page,
  tmpPath
}) => {
  const sources = [
    'corpus = pl.DataFrame(\n    {"text": texts}\n)',
    '(alta\n    .filter(pl.col("x") > 1)\n)',
    'model = smf.ols(  # (the formula\n    "y ~ x", data=df\n)',
    'label = "pain (0 to 10"',
    '# Load the data (from S3\nx = 1',
    'weekly = diary.groupby("week").mean()'
  ];
  const file = `${tmpPath}/titles.ipynb`;
  const notebook = {
    cells: sources.map((source, index) => ({
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
  await expect(
    page.locator('.jp-Epi-bench .jp-Epi-cell .jp-Epi-title')
  ).toHaveText([
    'corpus = pl.DataFrame(…)',
    '(alta…)',
    'model = smf.ols(…)  # (the formula',
    'label = "pain (0 to 10"',
    'Load the data (from S3',
    'weekly = diary.groupby("week").mean()'
  ]);
});
