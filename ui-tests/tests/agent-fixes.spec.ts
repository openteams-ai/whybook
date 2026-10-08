/**
 * Design iteration 1.103, in the browser against the built extension: an
 * agent fixes a failed cell in place, and never leaves one. run_cell with
 * `fix` rewrites the cell that failed, which runs again where it is;
 * remove_cell deletes it; and the run's card says what became of it.
 *
 * No model runs: each test streams the agent's tool calls as the server
 * sends them, and the cells run in the test's kernel. The server's part,
 * finish refused while a failed cell is left, is in
 * whybook/server/tests/test_agent_fixes.py.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

// Each test runs the cell of its notebook in a kernel first.
test.describe.configure({ timeout: 180000 });

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

const LOAD =
  'import pandas as pd\ndiary = pd.DataFrame({"arm": ["A", "A", "B", "B"], "pain": [5.0, 6.5, 3.1, 3.3]})';
// pian for pain: AttributeError, as a cell of an agent can fail.
const FAILING = 'diary.groupby("arm").pian.mean()';
const FIXED = 'diary.groupby("arm").pain.mean()';
const QUESTION = 'Does pain differ by arm?';

async function writeNotebook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const notebook = {
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        id: 'load',
        metadata: {},
        outputs: [],
        source: LOAD
      }
    ],
    metadata: { kernelspec: KERNELSPEC },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

/** Open the notebook in Whybook, and run its cell in a kernel. */
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
  await expect(page.locator('.jp-Epi-cell .jp-Epi-label')).toHaveText(['[1]'], {
    timeout: 60000
  });
}

/** The status says that a model is set up; no model runs. */
async function connected(page: IJupyterLabPageFixture): Promise<void> {
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
}

/**
 * The agent's run as the server streams it, and the results that the view
 * posts for each tool call.
 */
async function streamRun(
  page: IJupyterLabPageFixture,
  tools: { name: string; input: object }[],
  answer: string
): Promise<{ call: string; result: any }[]> {
  const events = [
    { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
    ...tools.map((tool, index) => ({
      type: 'tool',
      run: 'r1',
      call: `c${index + 1}`,
      ...tool
    })),
    {
      type: 'result',
      answer,
      cells: [],
      follow_up: [],
      model: 'test',
      cost_usd: 0.01,
      elapsed: 9
    }
  ];
  const posted: { call: string; result: any }[] = [];
  await page.route(/\/whybook\/agent(\?.*)?$/, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: events.map(event => JSON.stringify(event)).join('\n') + '\n'
    })
  );
  await page.route(/\/whybook\/agent\/result/, async route => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  return posted;
}

/** The code of each cell of the current notebook, in order. */
async function sources(page: IJupyterLabPageFixture): Promise<string[]> {
  return page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const found: string[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      found.push(model.cells.get(i).sharedModel.getSource());
    }
    return found;
  });
}

async function ask(page: IJupyterLabPageFixture): Promise<void> {
  const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
  await own.fill(QUESTION);
  await own.press('Enter');
}

const STEP = {
  title: 'Mean pain by arm',
  why: 'compare the arms'
};

test.describe('1.103 an agent fixes a failed cell in place', () => {
  test('a fix rewrites the cell that failed, and the card says what it fixed', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const posted = await streamRun(
      page,
      [
        { name: 'run_cell', input: { ...STEP, code: FAILING } },
        {
          name: 'run_cell',
          input: { ...STEP, code: FIXED, fix: '[2]', why: 'the column is pain' }
        }
      ],
      'Arm B has less pain than arm A ([3]).'
    );
    const file = `${tmpPath}/fixes.ipynb`;
    await writeNotebook(page, file);
    await openAndRun(page, file);
    await ask(page);
    const run = page.locator('.jp-Epi-agentrun');
    await expect(run.locator('.jp-Epi-agentrun-status')).toHaveText(
      /^Answered with 1 cell/,
      { timeout: 60000 }
    );
    // One cell of the run, in its place, with the fix's code.
    expect(await sources(page)).toEqual([LOAD, FIXED]);
    expect(
      posted.map(item => [
        item.call,
        item.result.status,
        item.result.cell,
        item.result.fixed ?? null
      ])
    ).toEqual([
      ['c1', 'error', '[2]', null],
      ['c2', 'ok', '[3]', '[2]']
    ]);
    expect(posted[0].result.error).toMatch(/^AttributeError: /);
    // The card: one step, done, its cell by its label now, and its error.
    const steps = run.locator('.jp-Epi-agentrun-steps li');
    await expect(steps).toHaveCount(1);
    await expect(steps.first()).toHaveClass(/jp-mod-done/);
    await expect(steps.first().locator('.jp-Epi-agentrun-cell')).toHaveText([
      '[3]'
    ]);
    const note = steps.first().locator('.jp-Epi-agentrun-fixed');
    await expect(note).toHaveText('fixed after AttributeError');
    await expect(note).toHaveAttribute(
      'title',
      /^AttributeError: 'DataFrameGroupBy' object has no attribute 'pian'/
    );
    // The bench shows two cards, the second the cell that ran, and no error.
    await expect(
      page.locator('.jp-Epi-cell .jp-Epi-cell-head > .jp-Epi-label')
    ).toHaveText(['[1]', '[3]']);
    await expect(page.locator('.jp-Epi-bench .jp-Epi-error')).toHaveCount(0);
  });

  test('a cell that the agent removes after it failed leaves its step on the card', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const posted = await streamRun(
      page,
      [
        { name: 'run_cell', input: { ...STEP, code: FAILING } },
        // A fix in a new cell, as the agents of the recorded takes did.
        {
          name: 'run_cell',
          input: { title: 'Mean pain by arm, again', code: FIXED, why: '' }
        },
        {
          name: 'remove_cell',
          input: { cell: '[2]', why: '[3] does its work' }
        }
      ],
      'Arm B has less pain than arm A ([3]).'
    );
    const file = `${tmpPath}/removes.ipynb`;
    await writeNotebook(page, file);
    await openAndRun(page, file);
    await ask(page);
    const run = page.locator('.jp-Epi-agentrun');
    await expect(run.locator('.jp-Epi-agentrun-status')).toHaveText(
      /^Answered with 1 cell/,
      { timeout: 60000 }
    );
    expect(await sources(page)).toEqual([LOAD, FIXED]);
    expect(posted[2]).toMatchObject({
      call: 'c3',
      result: { status: 'ok', cell: '[2]', removed: true }
    });
    const steps = run.locator('.jp-Epi-agentrun-steps li');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toHaveClass(/jp-mod-error/);
    await expect(steps.nth(0).locator('.jp-Epi-agentrun-cell')).toHaveCount(0);
    await expect(steps.nth(0).locator('.jp-Epi-agentrun-fixed')).toHaveText(
      'removed after AttributeError'
    );
    await expect(steps.nth(1)).toHaveClass(/jp-mod-done/);
    await expect(steps.nth(1).locator('.jp-Epi-agentrun-cell')).toHaveText([
      '[3]'
    ]);
  });
});
