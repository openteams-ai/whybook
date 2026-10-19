/**
 * A card whose first line is one long word, such as a URL, keeps its title
 * in its own box: the title breaks the word where it must, and does not run
 * under the card's Run and Show code buttons, as it did in a notebook of the
 * sweep of real notebooks.
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

test('a title of one long word breaks inside its box, clear of the buttons', async ({
  page,
  tmpPath
}) => {
  const url =
    'https://raw.githubusercontent.com/AllenDowney/ThinkStats2/master/code/2002FemPreg.dat.gz';
  const file = `${tmpPath}/long.ipynb`;
  const notebook = {
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        id: 'c0',
        metadata: {},
        outputs: [],
        source: url
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
  await openInWhybook(page, file);
  const title = page.locator('.jp-Epi-bench .jp-Epi-cell .jp-Epi-title');
  const actions = page.locator(
    '.jp-Epi-bench .jp-Epi-cell .jp-Epi-cell-actions'
  );
  await expect(title).toHaveText(url);
  expect(
    await title.evaluate(element => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  const box = (await title.boundingBox())!;
  const buttons = (await actions.boundingBox())!;
  // The buttons start after the title's box ends, or sit under it.
  expect(
    box.x + box.width <= buttons.x || buttons.y >= box.y + box.height
  ).toBe(true);
});
