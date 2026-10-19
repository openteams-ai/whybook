/**
 * The words of a URL in a chip (design iteration 1.143): what matters in it,
 * and not its scheme. A GitHub URL shows the GitHub mark, the owner, the
 * repository and the path, and the branch that it names; a record of Zenodo
 * its number, as its DOI ends, and the file; any other URL its host and
 * path. The file name shows whole, and the tooltip and the popover of the
 * chip give the URL in full.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

const GITHUB =
  'https://raw.githubusercontent.com/someone/rainfall/dev/data/rain_2019.csv';
const ZENODO =
  'https://zenodo.org/records/1234567/files/stations_2020.csv?download=1';
const NOAA =
  'https://www.ncei.noaa.gov/data/global-summary-of-the-day/access/2019/01001099999.csv';

const CODE = [
  'def fetch(url):\n    return url',
  `fetch("${GITHUB}")`,
  `fetch("${ZENODO}")`,
  `fetch("${NOAA}")`
];

/** Write the notebook, open it in Whybook, and run it. */
async function openAndRun(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const notebook = {
    cells: CODE.map((source, index) => ({
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
  await page.locator('.jp-Epi-runall').click();
}

function chip(page: IJupyterLabPageFixture, cellId: string) {
  return page.locator(`[data-cell-id="${cellId}"] .jp-Epi-chip`);
}

test('shows a URL in a chip by what matters in it, with the GitHub mark for GitHub, and the URL in full in its tooltip and popover', async ({
  page,
  tmpPath
}) => {
  await openAndRun(page, `${tmpPath}/urls.ipynb`);
  const github = chip(page, 'cell-1');
  await expect(github.locator('code')).toHaveText(
    'url someone/rainfall/data/rain_2019.csv @dev',
    { timeout: 120000 }
  );
  await expect(github.locator('.jp-Epi-chip-mark svg')).toBeVisible();
  await expect(github.locator('.jp-Epi-chip-ref')).toHaveText(' @dev');
  await expect(chip(page, 'cell-2').locator('code')).toHaveText(
    'url zenodo.1234567/stations_2020.csv'
  );
  await expect(chip(page, 'cell-3').locator('code')).toHaveText(
    'url www.ncei.noaa.gov/data/global-summary-of-the-day/access/2019/01001099999.csv'
  );
  for (const id of ['cell-2', 'cell-3']) {
    await expect(chip(page, id).locator('.jp-Epi-chip-mark')).toHaveCount(0);
  }
  // The tooltip, and the first line of the popover, give the URL in full.
  await github.hover();
  await expect(page.locator('.jp-Epi-tooltip')).toContainText(
    `url = '${GITHUB}'`
  );
  await github.click();
  await expect(
    page.locator('.jp-Epi-popover .jp-Epi-decision-line code')
  ).toHaveText(`url = '${GITHUB}'`);
});
