/**
 * Two fixes found while the demo video of 7 October was recorded, on a frame
 * like NHEFS.
 *
 * - A column dropped on a model's cell asks whether the effect of the
 *   model's exposure differs by it, and the branch shows the effect in each
 *   level and the interaction (design iteration 1.94).
 * - A question typed about rows picked in a plot goes to the agent with the
 *   pandas mask of those rows (design iteration 1.95).
 *
 * No model is called: the first test asks a template, and the second answers
 * the agent's route itself. The fixture aborts every other model route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

// A frame like NHEFS, coded as NHEFS codes it: qsmk changes wt82_71 by 4 kg
// for sex 0 and by 2 kg for sex 1.
const NHEFS = [
  'import numpy as np',
  'import pandas as pd',
  '',
  'rng = np.random.default_rng(11)',
  'n = 1200',
  'nhefs = pd.DataFrame({',
  '    "seqn": np.arange(233, 233 + n),',
  '    "qsmk": rng.binomial(1, 0.26, n),',
  '    "sex": rng.binomial(1, 0.51, n),',
  '    "race": rng.binomial(1, 0.13, n),',
  '    "age": rng.integers(25, 75, n),',
  '    "education": rng.integers(1, 6, n),',
  '    "smokeintensity": rng.integers(1, 60, n),',
  '    "smokeyrs": rng.integers(1, 60, n),',
  '    "exercise": rng.integers(0, 3, n),',
  '    "active": rng.integers(0, 3, n),',
  '    "wt71": rng.normal(71, 15, n).round(2),',
  '})',
  'effect = np.where(nhefs["sex"] == 0, 4.0, 2.0)',
  'nhefs["wt82_71"] = (effect * nhefs["qsmk"] - 0.1 * (nhefs["age"] - 45) + rng.normal(0, 3, n)).round(3)',
  'nhefs.head()'
].join('\n');

// The cell of the video's notebook that fitted the adjusted model, as the agent wrote it.
const ADJUSTED = [
  'import pandas as pd',
  'import statsmodels.formula.api as smf',
  '',
  '_covars = ["qsmk", "sex", "race", "age", "education", "smokeintensity", "smokeyrs", "exercise", "active", "wt71", "wt82_71"]',
  '_model_data_full = nhefs[_covars].dropna().copy()',
  '_fit_full = smf.ols("wt82_71 ~ qsmk + C(sex) + C(race) + age + C(education) + smokeintensity + smokeyrs + C(exercise) + C(active) + wt71", data=_model_data_full).fit()',
  'print(f"Adjusted qsmk effect (kg): {_fit_full.params[\'qsmk\']:.2f}")'
].join('\n');

const HISTOGRAM = 'import whybook\n\nwhybook.hist(nhefs, "wt82_71")';

/** Write a notebook with these code cells and titles. */
async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  cells: { source: string; title: string }[]
): Promise<void> {
  const notebook = {
    cells: cells.map((cell, index) => ({
      cell_type: 'code',
      execution_count: null,
      id: `cell-${index}`,
      metadata: { whybook: { title: cell.title } },
      outputs: [],
      source: cell.source
    })),
    metadata: {
      kernelspec: {
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
        name: 'python3'
      },
      whybook: { outcome: 'wt82_71', unit: 'seqn' }
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

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

function card(page: IJupyterLabPageFixture, title: string | RegExp): Locator {
  return page
    .locator('.jp-Epi-bench .jp-Epi-cell', {
      has: page.locator('.jp-Epi-title', { hasText: title })
    })
    .last();
}

function column(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator('.jp-Epi-contents .jp-Epi-column').filter({
    has: page.locator('.jp-Epi-item-name', { hasText: new RegExp(`^${name}$`) })
  });
}

/** An HTML5 drag. Chromium starts a drag only when the mouse moves in steps. */
async function drag(
  page: IJupyterLabPageFixture,
  source: Locator,
  target: Locator
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 5, {
    steps: 5
  });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 10
  });
  await page.mouse.up();
}

test('sex dropped on the adjusted model asks whether the effect of qsmk differs by sex, and its branch shows the effect in each level', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/interaction.ipynb`;
  await newNotebook(page, file, [
    { source: NHEFS, title: 'Make nhefs' },
    { source: ADJUSTED, title: 'Effect of qsmk on wt82_71, adjusted' }
  ]);
  await openAndRun(page, file);
  const model = card(page, 'Effect of qsmk on wt82_71, adjusted');
  await expect(model).toContainText('Adjusted qsmk effect (kg):', {
    timeout: 60000
  });
  const frame = page.locator('.jp-Epi-variable[data-variable="nhefs"]');
  await expect(frame).toBeVisible({ timeout: 60000 });
  await frame.click();
  await expect(column(page, 'sex')).toBeVisible();

  await drag(page, column(page, 'sex'), model.locator('.jp-Epi-title'));
  const question = 'Does the effect of qsmk on wt82_71 differ by sex?';
  const first = popover(page).locator('.jp-Epi-option').first();
  // The first question offered, and it runs at once: no model writes it.
  await expect(first).toContainText(question);
  await expect(first).toContainText(
    'Refits with qsmk × sex: the effect in each level'
  );
  await expect(first).not.toContainText('needs AI');
  await first.click();

  const branch = card(page, question);
  await expect(branch).toContainText('Effect of qsmk on wt82_71: ', {
    timeout: 60000
  });
  await expect(branch).toContainText(/where sex is 0, .* where sex is 1\./);
  await expect(branch).toContainText('Interaction of qsmk and sex: ');
  // A branch of the model's cell, with names of its own: the model's cell keeps its fit.
  await expect(branch.locator('.jp-Epi-label').first()).toHaveText(/^\[2b\]/);
});

test('a question typed about the rows picked in a histogram goes to the agent with the mask of those rows', async ({
  page,
  tmpPath
}) => {
  // A model is connected, so that the box takes a question; the agent's
  // route is answered here, and nothing reaches a model.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  const sent: any[] = [];
  await page.route(/\/whybook\/(agent|solve)(\?.*)?$/, route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        [
          { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
          {
            type: 'result',
            answer: 'Answered.',
            cells: [],
            follow_up: [],
            model: 'fake/model',
            provider: 'openrouter',
            cost_usd: 0.01,
            elapsed: 1
          }
        ]
          .map(event => JSON.stringify(event))
          .join('\n') + '\n'
    });
  });
  const file = `${tmpPath}/selection.ipynb`;
  await newNotebook(page, file, [
    { source: NHEFS, title: 'Make nhefs' },
    { source: HISTOGRAM, title: 'Distribution of wt82_71' }
  ]);
  await openAndRun(page, file);
  const plot = card(page, 'Distribution of wt82_71').locator(
    '.jp-Epi-plotout svg.jp-Epi-plot'
  );
  await expect(plot).toBeVisible({ timeout: 60000 });

  // The highest weight changes, picked on the histogram.
  const area = (await plot.boundingBox())!;
  await page.mouse.move(area.x + area.width * 0.7, area.y + area.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(
    area.x + area.width * 0.95,
    area.y + area.height * 0.5,
    {
      steps: 10
    }
  );
  await page.mouse.up();
  await expect(
    popover(page).locator('.jp-Epi-caption', { hasText: 'rows' })
  ).toHaveText(/^\d+ rows/, { timeout: 30000 });
  const box = popover(page).locator('.jp-Epi-own').getByRole('textbox');
  await box.fill('How many of them quit smoking, and how old were they?');
  await box.press('Enter');

  await expect.poll(() => sent.length, { timeout: 30000 }).toBe(1);
  const [body] = sent;
  expect(body.question.text).toBe(
    'How many of them quit smoking, and how old were they?'
  );
  expect(body.about).toMatch(
    /^the rows of nhefs where [-\d.]+ <= wt82_71 <= [-\d.]+, picked in the plot /
  );
  expect(body.rows.frame).toBe('nhefs');
  expect(body.rows.mask).toMatch(
    /^nhefs\["wt82_71"\]\.between\([-\d.e]+, [-\d.e]+\)$/
  );
});
