/**
 * The chips of ThinkStats2's chapter 3, as the sweep of public notebooks
 * found them (design iteration 1.141). A label option, such as xlabel of
 * thinkplot.Config, a function of a file in the notebook's folder, makes no
 * chip and no question in any function, whether the call writes it or leaves
 * it at a default; the other values of the same calls keep their chips. And
 * six calls of download(url) with the files of one folder wrote the folder
 * six times: the first chip writes it, and the others what follows it.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

/** A module of the notebook's folder, as thinkplot.py and thinkstats2.py are. */
const PLOTS = [
  'def config(xlabel=None, ylabel=None, title=None, legend=True, **options):',
  '    return options',
  '',
  '',
  'def pre_plot(num=None, rows=None, cols=None, label=None, suptitle=None):',
  '    return num',
  '',
  '',
  'class Pmf:',
  '    def __init__(self, obj=None, label=None, zlabel="z"):',
  '        self.obj = obj',
  '        self.label = label',
  ''
].join('\n');

const FOLDER = 'https://github.com/AllenDowney/ThinkStats2/raw/master/code/';

const CODE = [
  'import plots\n\n\ndef download(url):\n    return url',
  'plots.config(xlabel="Class size", ylabel="PMF", title="Class sizes", legend=False)',
  'plots.pre_plot(2, label="observed")\npmf = plots.Pmf([7, 12, 17])',
  ['thinkstats2.py', 'thinkplot.py', 'nsfg.py']
    .map(file => `download("${FOLDER}${file}")`)
    .join('\n')
];

/** Write the module and the notebook, open the notebook in Whybook, and run it. */
async function openAndRun(
  page: IJupyterLabPageFixture,
  folder: string
): Promise<void> {
  await page.contents.uploadContent(PLOTS, 'text', `${folder}/plots.py`);
  const file = `${folder}/chap03.ipynb`;
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

/** The words of the chips of a cell. */
function chips(page: IJupyterLabPageFixture, cellId: string) {
  return page.locator(`[data-cell-id="${cellId}"] .jp-Epi-chip code`);
}

test('shows no chip and asks no question for a label option, and keeps the chips of the other values', async ({
  page,
  tmpPath
}) => {
  await openAndRun(page, tmpPath);
  // Left at a default of plots.py, or written in the cell.
  await expect(chips(page, 'cell-2')).toHaveText(
    ['rows None', 'cols None', 'num 2', 'obj [7, 12, 17]'],
    { timeout: 120000 }
  );
  await expect(chips(page, 'cell-1')).toHaveText(['legend False']);
  // Worth asking next asks about the defaults of plots.py, and none of them a label.
  await page.sidebar.openTab('epi-exploration');
  const next = page.locator('#epi-exploration .jp-Epi-next-text');
  await expect(next.filter({ hasText: /^Does rows = None/ })).toHaveCount(1, {
    timeout: 60000
  });
  const asked = await next.allTextContents();
  expect(
    asked.filter(text =>
      /^Does (label|xlabel|ylabel|zlabel|title|suptitle) =/.test(text)
    )
  ).toEqual([]);
});

test('writes the folder of the files that download(url) fetches once, on the first chip', async ({
  page,
  tmpPath
}) => {
  await openAndRun(page, tmpPath);
  const words = chips(page, 'cell-3');
  await expect(words).toHaveCount(3, { timeout: 120000 });
  await expect(words.nth(1)).toHaveText('url …/thinkplot.py');
  await expect(words.nth(2)).toHaveText('url …/nsfg.py');
  await expect(words.nth(0)).toContainText('AllenDowney/ThinkStats2');
  await expect(words.nth(0)).toContainText('thinkstats2.py');
  // The tooltip of a chip gives its URL in full.
  await page.locator('[data-cell-id="cell-3"] .jp-Epi-chip').nth(1).hover();
  await expect(page.locator('.jp-Epi-tooltip')).toContainText(
    `url = '${FOLDER}thinkplot.py'`
  );
});
