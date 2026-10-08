/**
 * Chips in R cells (design iteration 1.79). The R kernel reads its cells with
 * R's own parser (whybook/server/kernel_code/r/analyze_cells.R), so an R cell
 * shows the chips of a Python cell: a constant that it assigns, an argument
 * that it passes, and a default of a known R function that changes the
 * result. "Find more defaults with AI", on by default,
 * sends the formals of the R functions that a cell calls, with their
 * language.
 *
 * These tests need an R kernel, such as xeus-r, whose kernelspec the test
 * server finds (TESTING.md); without one they skip. No model runs: each test
 * answers the model's route itself, or the fixture aborts it.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test, withoutGuard } from './fixtures';
import { tooltipLines } from './tooltips';

/**
 * The name of a kernelspec whose language is R, or null. A sandboxed copy,
 * which names a kernel provisioner, is left to sandbox.spec.ts.
 */
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

function code(id: string, title: string, source: string) {
  return {
    cell_type: 'code',
    execution_count: null,
    id,
    // A title of its own, so that no model is asked to write one.
    metadata: { whybook: { title } },
    outputs: [],
    source
  };
}

/** A frame of visits, and a cell that fits two models to its later weeks. */
function rNotebook(kernel: string) {
  return {
    cells: [
      code(
        'load',
        'Visits',
        [
          'visits <- data.frame(',
          '  patient = rep(1:4, each = 3),',
          '  week = rep(c(0, 4, 8), times = 4),',
          '  arm = factor(rep(c("A", "B"), each = 6)),',
          '  pain = c(6, 5, 4, 7, 6, 6, 5, 3, 2, 6, 4, 3)',
          ')'
        ].join('\n')
      ),
      code(
        'model',
        'Pain by arm after week 4',
        [
          'MIN_WEEK <- 4',
          'later <- visits[visits$week >= MIN_WEEK, ]',
          'fit <- lm(pain ~ arm, data = later)',
          'tt <- t.test(pain ~ arm, data = later, conf.level = 0.9)',
          'cat("p =", round(tt$p.value, 3), "\\n")'
        ].join('\n')
      )
    ],
    metadata: {
      kernelspec: { display_name: 'R', language: 'R', name: kernel }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

/** Open the notebook in the Whybook view, wait for its kernel, and run it. */
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
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
  await page.locator('.jp-Epi-runall').click();
}

/** The chips of the model's cell on the bench. */
function chips(page: IJupyterLabPageFixture) {
  return page.locator(
    '.jp-Epi-bench .jp-Epi-cell[data-cell-id="model"] .jp-Epi-chip'
  );
}

/** The server's status, with a connected model that answers at a known price. */
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

test('an R cell shows the chips of a constant, an explicit argument and a known default', async ({
  page,
  tmpPath
}) => {
  const kernel = await rKernel(page);
  test.skip(!kernel, 'No R kernel: see TESTING.md');
  const file = `${tmpPath}/visits.ipynb`;
  await page.contents.uploadContent(
    JSON.stringify(rNotebook(kernel!)),
    'text',
    file
  );
  await openAndRun(page, file);

  // The defaults that the cell leaves, then the values that it writes.
  await expect(chips(page)).toHaveText(
    [
      'contrasts contr.treatment',
      'na.action na.omit',
      'var.equal FALSE',
      'MIN_WEEK 4',
      'conf.level 0.9'
    ],
    { timeout: 120000 }
  );
  const welch = chips(page).nth(2);
  await expect(welch).toHaveClass(/jp-mod-open/);
  // The tooltip is the value as code and the call; the reason is in the popover.
  const welchTip = await tooltipLines(page, welch);
  expect(welchTip[0]).toBe('var.equal = FALSE');
  expect(welchTip[1]).toMatch(
    /^parameter var\.equal of stats::t\.test, line \d+$/
  );
  expect(welchTip).toHaveLength(2);
  const constant = chips(page).nth(3);
  await expect(constant).not.toHaveClass(/jp-mod-open/);
  expect(await tooltipLines(page, constant)).toEqual(['MIN_WEEK = 4']);
  const level = await tooltipLines(page, chips(page).nth(4));
  expect(level[0]).toBe('conf.level = 0.9');
  expect(level[1]).toMatch(
    /^parameter conf\.level of stats::t\.test, line \d+$/
  );

  // The formula under the chips, and the columns that the cells read.
  await expect(
    page.locator(
      '.jp-Epi-bench .jp-Epi-cell[data-cell-id="model"] .jp-Epi-formula'
    )
  ).toHaveText('pain ~ arm');
  const explored = page.locator('#epi-exploration .jp-Epi-block', {
    hasText: 'Variables explored'
  });
  await expect(explored.locator('.jp-Epi-coverage').first()).toBeVisible();
  await expect(explored).not.toContainText('read in a Python kernel');

  // A chip of an R cell has its questions, which a model answers in R: with
  // no model connected they wait for one. Another value is typed as R code.
  await welch.click();
  const popover = page.locator('.jp-Epi-popover');
  await expect(popover.locator('.jp-Epi-decision-line')).toContainText(
    'var.equal = FALSE'
  );
  await expect(
    popover.getByRole('textbox', { name: 'Another value for var.equal' })
  ).toHaveAttribute('placeholder', 'Another value for var.equal, as in R');
  await expect(
    popover.getByRole('button', { name: /^Choose var\.equal in \[2\]/ })
  ).toContainText('needs AI');
  await expect(popover.locator('.jp-Epi-unsupported')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('"Find more defaults with AI" is on, and asks about the formals of R functions with their language', async ({
  page,
  tmpPath
}) => {
  const kernel = await rKernel(page);
  test.skip(!kernel, 'No R kernel: see TESTING.md');
  await connected(page);
  const asked: any[] = [];
  await page.route(/\/whybook\/defaults\/ask(\?|$)/, async route => {
    const body = route.request().postDataJSON();
    asked.push(body);
    const picks: Record<string, unknown[]> = {
      'stats::t.test': [
        { param: 'var.equal', why: 'Welch is the default.' },
        { param: 'alternative', why: 'Both tails are tested.' }
      ]
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        [
          { type: 'progress', stage: 'thinking', elapsed: 0.1 },
          {
            type: 'result',
            picks: picks[body.function.name] ?? [],
            by: {
              choice: 'remote',
              model: 'fake/model',
              at: '2026-10-01T09:00:00Z'
            },
            model: 'fake/model',
            cost_usd: 0.0002,
            elapsed: 0.3
          }
        ]
          .map(event => JSON.stringify(event))
          .join('\n') + '\n'
    });
  });
  const file = `${tmpPath}/visits.ipynb`;
  await page.contents.uploadContent(
    JSON.stringify(rNotebook(kernel!)),
    'text',
    file
  );
  await openAndRun(page, file);

  // The table's var.equal shows once; the model's other pick joins it. It
  // carries no AI tag: the popover says who flagged it.
  await expect(chips(page)).toHaveText(
    [
      'contrasts contr.treatment',
      'na.action na.omit',
      'var.equal FALSE',
      'alternative two.sided',
      'MIN_WEEK 4',
      'conf.level 0.9'
    ],
    { timeout: 120000 }
  );
  const alternative = chips(page).nth(3);
  await expect(alternative).toHaveClass(/jp-mod-found/);
  await expect(chips(page).locator('.jp-Epi-aitag')).toHaveCount(0);
  const tip = await tooltipLines(page, alternative);
  expect(tip[0]).toBe('alternative = "two.sided"');
  expect(tip[1]).toMatch(/^parameter alternative of stats::t\.test, line \d+$/);
  // Each function's formals go with its language, and nothing of the notebook.
  const ttest = asked.find(body => body.function.name === 'stats::t.test');
  expect(ttest.function).toMatchObject({
    function: 'stats::t.test.formula',
    module: 'stats',
    library: 'stats',
    language: 'R'
  });
  expect(ttest.function.params).toContainEqual({
    name: 'alternative',
    default: '"two.sided"'
  });
  expect(ttest.function).not.toHaveProperty('calls');
  // The review guard's object stays on the server: no model reads it.
  expect(JSON.stringify(asked.map(withoutGuard))).not.toMatch(
    /later|visits|MIN_WEEK/
  );
});
