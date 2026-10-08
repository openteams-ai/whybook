/**
 * The chips of a file read, and where "Worth asking next" asks about it
 * (design iterations 1.91 and 1.92, from the demo video of 7 October 2026).
 *
 * The first cell of the video read nhefs.csv and showed its first rows, and
 * its chips were header infer, sep <no_default>, n 5 and na_values None:
 * pandas' marker for "not given" in place of the comma that the read used,
 * and the number of rows that head() shows. "Worth asking next" asked about
 * the same defaults first, through the whole analysis.
 *
 * No model is called: the first test answers the model's route itself, and
 * the fixture aborts any other.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

/** Write a notebook with these code cells. */
async function newNotebook(
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
}

/** Open a notebook in the Whybook view, wait for its kernel, and run every cell. */
async function openAndRun(
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
  await page.locator('.jp-Epi-runall').click();
}

/** The server's status with a connected model, which the test fakes: no model runs. */
async function connected(page: IJupyterLabPageFixture): Promise<void> {
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: true,
        claude: {
          ...status.claude,
          available: true,
          provider: 'openrouter',
          label: 'OpenRouter: fake/model',
          reason: null,
          setup: null,
          priced: true
        },
        remote_model: 'OpenRouter: fake/model'
      }
    });
  });
}

/**
 * The model's picks of defaults, as the video's model made them for these
 * two functions; the body of each request is kept in the list returned.
 */
async function fakeModel(page: IJupyterLabPageFixture): Promise<any[]> {
  const asked: any[] = [];
  const picks: Record<string, unknown[]> = {
    'pandas.read_csv': [
      { param: 'sep', why: 'How the fields are separated.' },
      { param: 'na_values', why: 'Which values count as missing.' }
    ],
    'pandas.core.generic.NDFrame.head': [
      { param: 'n', why: 'How many rows are returned from the top.' }
    ]
  };
  await page.route(/\/whybook\/defaults\/ask(\?|$)/, async route => {
    const body = route.request().postDataJSON();
    asked.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({
          type: 'result',
          picks: picks[body.function.function] ?? [],
          by: { choice: 'remote', model: 'fake/model', at: '2026-10-07' },
          model: 'fake/model',
          cost_usd: 0.0001,
          elapsed: 0.2
        }) + '\n'
    });
  });
  return asked;
}

/** A small table of numbers with a header row, with these separators. */
function table(separator: string): string {
  const rows = [
    ['id', 'age', 'weight_change', 'quit'],
    ['1', '42', '-10.1', '0'],
    ['2', '36', '2.6', '0'],
    ['3', '56', '9.4', '1'],
    ['4', '68', '4.9', '0']
  ];
  return rows.map(row => row.join(separator)).join('\n') + '\n';
}

function chips(page: IJupyterLabPageFixture, cell: string): Locator {
  return page.locator(
    `.jp-Epi-bench .jp-Epi-cell[data-cell-id="${cell}"] .jp-Epi-chip`
  );
}

const READ =
  'import pandas as pd\n\ndata = pd.read_csv("data.csv")\ndata.head()';

test('shows the separator that a read uses, and no chip for the rows that a cell shows', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  const asked = await fakeModel(page);
  await page.contents.uploadContent(table(','), 'text', `${tmpPath}/data.csv`);
  const file = `${tmpPath}/read.ipynb`;
  await newNotebook(page, file, [READ]);
  await openAndRun(page, file);
  // The header from the view's own list, then the model's picks of read_csv,
  // then the file. The separator is the comma that pandas documents, where
  // its signature holds <no_default>, and the rows that head() shows are no
  // chip: head() went to no model.
  await expect(chips(page, 'cell-0')).toHaveText(
    ['header infer', 'sep comma', 'na_values None', 'data.csv'],
    { timeout: 60000 }
  );
  const names = asked.map(body => body.function.name);
  expect(names).toContain('read_csv');
  expect(names).not.toContain('NDFrame.head');
  const read = asked.find(body => body.function.name === 'read_csv');
  expect(read.function.params).toContainEqual({ name: 'sep', default: "','" });
  expect(
    read.function.params.filter((param: any) =>
      String(param.default).startsWith('<')
    )
  ).toEqual([]);
  // The tooltip keeps the value as code.
  await chips(page, 'cell-0').nth(1).hover();
  await expect(page.locator('.jp-Epi-tooltip div').first()).toHaveText(
    "sep = ','"
  );
});

test('asks about a read that looks right after the choices of the analysis, and first when the read looks wrong', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(table(','), 'text', `${tmpPath}/data.csv`);
  await page.contents.uploadContent(table(';'), 'text', `${tmpPath}/semi.csv`);
  const file = `${tmpPath}/next.ipynb`;
  await newNotebook(page, file, [
    READ,
    'pairs = data.merge(data, on="id")\npairs.shape'
  ]);
  await openAndRun(page, file);
  const steps = page.locator('.jp-Epi-exploration .jp-Epi-next');
  const texts = steps.locator('.jp-Epi-next-text');
  // The merge's inner join is a choice of the analysis; the header of the
  // read comes after it. In the video's notebook the header came first.
  await expect(texts).toHaveText(
    [
      "Does how = 'inner' change the result of [2]?",
      "Does header = 'infer' change the result of [1]?"
    ],
    { timeout: 60000 }
  );
  await expect(steps.nth(1).locator('.jp-Epi-next-why')).toHaveText(
    'Open assumption in [1]'
  );

  // A file with semicolons, read with the comma of read_csv: one column.
  await page.evaluate(() => {
    const notebook = (window as any).jupyterapp.shell.currentWidget.context
      .model;
    notebook.sharedModel.insertCell(notebook.cells.length, {
      cell_type: 'code',
      id: 'cell-2',
      source: 'semi = pd.read_csv("semi.csv")\nsemi.head()'
    });
  });
  const card = page.locator(
    '.jp-Epi-bench .jp-Epi-cell[data-cell-id="cell-2"]'
  );
  await card.locator('.jp-Epi-cell-actions button', { hasText: 'Run' }).click();
  await expect(card.locator('.jp-Epi-label')).toHaveText('[3]', {
    timeout: 60000
  });
  // Its header comes first now, with what shows that the read went wrong.
  await expect(texts.first()).toHaveText(
    "Does header = 'infer' change the result of [3]?",
    { timeout: 60000 }
  );
  await expect(steps.first().locator('.jp-Epi-next-why')).toHaveText(
    'semi has one column, whose name holds semicolons'
  );
  // The read that looks right is still last.
  await expect(texts.last()).toHaveText(
    "Does header = 'infer' change the result of [1]?"
  );
});
