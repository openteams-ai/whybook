/**
 * Design iteration 1.73, where agents' runs live and their history, in the
 * browser against the built extension:
 *
 * - "Reproduce in R" in the menu of the kernel's name puts the run's strip
 *   at the end of the notebook: the view scrolls to it and outlines it. So
 *   does a typed question whose strip is out of sight. With less motion
 *   asked for, the outline holds with no fade.
 * - The notebook keeps each run with its steps and its answer. "Agent runs"
 *   in the Exploration panel lists the runs, and draws a closed run's strip
 *   again. "Show the agent's run" in the menu of a cell that a run wrote,
 *   and in its Cell details, leads to the run. The record outlives the
 *   notebook's closing. With the setting off, none of this shows.
 *
 * No model runs: each test answers the routes of the agent itself. The test
 * of the kernel's menu needs an R kernel, and skips without it (TESTING.md).
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

// Each test runs the cells of its notebook in a kernel first.
test.describe.configure({ timeout: 180000 });

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as any).jupyterapp.serviceManager.sessions.shutdownAll();
  });
});

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

const QUESTION = 'Does pain differ by arm without the short diaries?';
const ANSWER = 'Yes: without the short diaries, arm B has less pain [9].';
const STEP = 'Mean pain by arm, 12 weeks or more';

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

const LOAD =
  'import pandas as pd\ndiary = pd.DataFrame({"arm": ["A", "A", "B", "B"], "pain": [5.0, 6.5, 3.1, 3.3], "weeks": [4, 14, 13, 3]})';

/** A notebook long enough that its end is out of sight: [1] loads, [2] to [8] print. */
async function writeNotebook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const cells = [
    code('load', LOAD),
    ...Array.from({ length: 7 }, (_, index) =>
      code(
        `part${index + 2}`,
        `# Part ${index + 2}\nfor week in range(6):\n    print("week", week, "part ${index + 2}")`
      )
    )
  ];
  const notebook = {
    cells,
    metadata: { kernelspec: KERNELSPEC },
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
  await expect(page.locator('.jp-Epi-bench:visible')).toBeVisible();
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0);
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

/** Run every cell of the view, and wait until each has its label. */
async function runAll(page: IJupyterLabPageFixture): Promise<void> {
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('.jp-Epi-bench .jp-Epi-cell .jp-Epi-label')
  ).toHaveText(
    Array.from({ length: 8 }, (_, index) => `[${index + 1}]`),
    { timeout: 60000 }
  );
}

/** The view scrolled to its top, with the end of the notebook out of sight. */
async function toTop(page: IJupyterLabPageFixture): Promise<void> {
  await page.evaluate(() => {
    const main = document.querySelector('.jp-Epi-main:not(.lm-mod-hidden)');
    main?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  });
  await expect(
    page.locator('.jp-Epi-bench .jp-Epi-cell[data-cell-id="part8"]')
  ).not.toBeInViewport();
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

/** A stream of newline-delimited JSON events, as the server sends them. */
function ndjson(events: object[]): string {
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}

/** The agent's routes: one cell, then the answer. */
async function agentAnswers(page: IJupyterLabPageFixture): Promise<void> {
  await page.route(/\/whybook\/agent(\?.*)?$/, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
        {
          type: 'tool',
          run: 'r1',
          call: 'c1',
          name: 'run_cell',
          input: {
            title: STEP,
            code: 'diary[diary.weeks >= 12].groupby("arm").pain.mean()',
            why: 'leave out the short diaries'
          }
        },
        {
          type: 'result',
          answer: ANSWER,
          cells: ['[9]'],
          follow_up: ['causal: Does the gap hold at each site?'],
          model: 'claude-opus-5-5',
          provider: 'claude-code',
          cost_usd: 0.04,
          elapsed: 9
        }
      ])
    })
  );
  await page.route(/\/whybook\/agent\/result/, route =>
    route.fulfill({ status: 200, json: { ok: true } })
  );
}

/**
 * Record each strip whose outline of `flash` starts: the outline lasts
 * 1.6 s, so the page keeps what it saw.
 */
async function watchFlashes(page: IJupyterLabPageFixture): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as any).__flashed = seen;
    document.addEventListener(
      'animationstart',
      event => {
        const node = event.target as HTMLElement;
        if (
          event.animationName === 'jp-epi-flash' &&
          node.dataset.stripId !== undefined
        ) {
          seen.push(node.dataset.stripId);
        }
      },
      true
    );
  });
}

async function flashed(page: IJupyterLabPageFixture): Promise<string[]> {
  return page.evaluate(() => [...((window as any).__flashed ?? [])]);
}

/** The whybook metadata of the current notebook. */
async function notebookMeta(page: IJupyterLabPageFixture): Promise<any> {
  return page.evaluate(() =>
    (window as any).jupyterapp.shell.currentWidget.context.model.getMetadata(
      'whybook'
    )
  );
}

/** The name of the kernelspec of R that is not in the sandbox, or null. */
async function rKernel(page: IJupyterLabPageFixture): Promise<string | null> {
  return page.evaluate(async () => {
    const specs = (window as any).jupyterapp.serviceManager.kernelspecs;
    await specs.ready;
    const found = Object.values(specs.specs?.kernelspecs ?? {}).find(
      (spec: any) =>
        spec?.language?.toLowerCase() === 'r' &&
        !spec?.metadata?.kernel_provisioner
    ) as { name: string } | undefined;
    return found?.name ?? null;
  });
}

test.describe('the strip of a run that the analyst starts', () => {
  test('Reproduce in R scrolls to the run at the end of the notebook, and outlines it', async ({
    page,
    tmpPath
  }) => {
    const kernel = await rKernel(page);
    test.skip(!kernel, 'No R kernel: see TESTING.md');
    await connected(page);
    const requests: any[] = [];
    // The run starts, and the model fails at once: no R notebook is made.
    await page.route(/\/whybook\/agent(\?.*)?$/, route => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjson([
          { type: 'started', run: 'k1', keep_local: false, elapsed: 0 },
          { type: 'error', message: 'The test stops the run here.' }
        ])
      });
    });
    const file = `${tmpPath}/menu.ipynb`;
    await writeNotebook(page, file);
    await openInWhybook(page, file);
    await runAll(page);
    await toTop(page);
    await watchFlashes(page);

    await page.locator('.jp-KernelName:visible').first().click();
    const menu = page.locator('#jp-Epi-kernelmenu');
    await menu.locator('.lm-Menu-item', { hasText: /^Reproduce in R/ }).click();
    const strip = page.locator('.jp-Epi-bench [data-strip-id^="end:"]');
    await expect(strip).toContainText('Would I get the same results in R?');
    await expect(strip).toBeInViewport();
    await expect
      .poll(() => flashed(page))
      .toEqual([await strip.getAttribute('data-strip-id')]);
    // The strip shows before the request leaves: the run reads the kernel
    // first, which a busy machine makes slower.
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].compare.kernel).toBe(kernel);
  });

  test('a typed question whose strip is out of sight scrolls to it, and the outline holds with no fade for less motion', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    await agentAnswers(page);
    const file = `${tmpPath}/typed.ipynb`;
    await writeNotebook(page, file);
    await openInWhybook(page, file);
    await runAll(page);
    await toTop(page);
    await watchFlashes(page);

    const own = page.locator('.jp-Epi-exploration .jp-Epi-own input');
    await own.fill(QUESTION);
    await own.press('Enter');
    const run = page.locator('.jp-Epi-bench .jp-Epi-agentrun');
    await expect(run.locator('.jp-Epi-agentrun-question')).toHaveText(QUESTION);
    await expect(run).toBeInViewport();
    await expect.poll(async () => (await flashed(page)).length).toBe(1);

    // With less motion asked for, the outline holds, then goes, with no fade.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const timing = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'jp-mod-flash';
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).animationTimingFunction;
      probe.remove();
      return value;
    });
    expect(timing).toBe('steps(1)');
  });
});

test.describe('the history of runs', () => {
  test('lists a closed run, draws its strip again, and leads to it from its cell, also after the notebook closes', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    await agentAnswers(page);
    const file = `${tmpPath}/history.ipynb`;
    await writeNotebook(page, file);
    await openInWhybook(page, file);
    await runAll(page);

    const own = page.locator('.jp-Epi-exploration .jp-Epi-own input');
    await own.fill(QUESTION);
    await own.press('Enter');
    const run = page.locator('.jp-Epi-bench .jp-Epi-agentrun');
    await expect(run.locator('.jp-Epi-agentrun-answer')).toContainText(
      'arm B has less pain',
      { timeout: 60000 }
    );
    // The notebook keeps the run with its steps and its answer.
    const record = (await notebookMeta(page)).agent_runs.r1;
    expect(record).toMatchObject({
      question: QUESTION,
      state: 'done',
      answer: ANSWER,
      follow_up: ['causal: Does the gap hold at each site?'],
      steps: [{ tool: 'run_cell', title: STEP, state: 'done' }]
    });
    const added = record.cells[0];

    // The analyst closes the strip: the history still lists the run.
    await run.getByRole('button', { name: 'Close; the cells stay' }).click();
    await expect(run).toHaveCount(0);
    const history = page.locator('.jp-Epi-exploration .jp-Epi-runhistory');
    const head = history.locator('.jp-Epi-runhistory-head');
    await expect(head).toHaveText('Agent runs1');
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await head.click();
    const row = history.locator('.jp-Epi-runhistory-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.jp-Epi-runhistory-status')).toHaveText(
      'Answered with 1 cell'
    );
    await expect(row.locator('.jp-Epi-runhistory-cell')).toHaveText('[9]');

    // A click on the question draws the strip again, where it was.
    await toTop(page);
    await row.locator('.jp-Epi-runhistory-question').click();
    await expect(run.locator('.jp-Epi-agentrun-answer')).toContainText(
      'arm B has less pain'
    );
    await expect(run.locator('.jp-Epi-agentrun-title')).toHaveText(STEP);
    await expect(run).toBeInViewport();
    await expect(
      run.getByRole('button', { name: /^Remove its cells/ })
    ).toHaveCount(0);
    await run.getByRole('button', { name: 'Close; the cells stay' }).click();
    await expect(run).toHaveCount(0);

    // The menu of the cell that the run wrote leads to the run.
    const card = page.locator(
      `.jp-Epi-bench .jp-Epi-cell[data-cell-id="${added}"]`
    );
    await card.locator('.jp-Epi-cellmenu').click();
    await page
      .locator('.lm-Menu-item', { hasText: "Show the agent's run" })
      .click();
    await expect(run.locator('.jp-Epi-agentrun-question')).toHaveText(QUESTION);
    await run.getByRole('button', { name: 'Close; the cells stay' }).click();
    // The analyst's own cell has no such item.
    await page
      .locator(
        '.jp-Epi-bench .jp-Epi-cell[data-cell-id="load"] .jp-Epi-cellmenu'
      )
      .click();
    await expect(
      page.locator('.lm-Menu-item', { hasText: 'Show in the notebook' })
    ).toBeVisible();
    await expect(
      page.locator('.lm-Menu-item:not(.lm-mod-hidden)', {
        hasText: "Show the agent's run"
      })
    ).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The notebook closes, and opens again: the history lists the run, and
    // Cell details leads from its cell to it.
    await page.evaluate(async () => {
      const widget = (window as any).jupyterapp.shell.currentWidget;
      await widget.context.save();
      widget.dispose();
    });
    await expect(page.locator('.jp-Epi-bench')).toHaveCount(0);
    await openInWhybook(page, file);
    await expect(run).toHaveCount(0);
    await page
      .locator(
        `.jp-Epi-bench .jp-Epi-cell[data-cell-id="${added}"] .jp-Epi-cell-head`
      )
      .click();
    await page
      .locator('#epi-exploration .jp-Epi-tabs [role="tab"]', {
        hasText: 'Cell details'
      })
      .click();
    const details = page.locator('#epi-exploration .jp-Epi-details-run');
    await expect(details).toHaveText(
      `In the agent's run for "${QUESTION}". Show the agent's run`
    );
    await details.getByRole('button', { name: "Show the agent's run" }).click();
    await expect(run.locator('.jp-Epi-agentrun-answer')).toContainText(
      'arm B has less pain'
    );
    await expect(run).toBeInViewport();
  });
});

test.describe('the history of runs, off', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:agent-runs': { history: false }
    }
  });

  test('keeps what the notebook kept before, and shows no history', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    await agentAnswers(page);
    const file = `${tmpPath}/off.ipynb`;
    await writeNotebook(page, file);
    await openInWhybook(page, file);
    await runAll(page);
    const own = page.locator('.jp-Epi-exploration .jp-Epi-own input');
    await own.fill(QUESTION);
    await own.press('Enter');
    const run = page.locator('.jp-Epi-bench .jp-Epi-agentrun');
    await expect(run.locator('.jp-Epi-agentrun-answer')).toContainText(
      'arm B has less pain',
      { timeout: 60000 }
    );
    const record = (await notebookMeta(page)).agent_runs.r1;
    expect(Object.keys(record).sort()).toEqual([
      'at',
      'cells',
      'cost_usd',
      'files',
      'model',
      'provider',
      'question',
      'seconds',
      'state'
    ]);
    await run.getByRole('button', { name: 'Close; the cells stay' }).click();
    await expect(
      page.locator('.jp-Epi-exploration .jp-Epi-block-head').first()
    ).toBeVisible();
    await expect(page.locator('.jp-Epi-runhistory')).toHaveCount(0);
    await page
      .locator(
        `.jp-Epi-bench .jp-Epi-cell[data-cell-id="${record.cells[0]}"] .jp-Epi-cellmenu`
      )
      .click();
    await expect(
      page.locator('.lm-Menu-item', { hasText: 'Show in the notebook' })
    ).toBeVisible();
    await expect(
      page.locator('.lm-Menu-item:not(.lm-mod-hidden)', {
        hasText: "Show the agent's run"
      })
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
