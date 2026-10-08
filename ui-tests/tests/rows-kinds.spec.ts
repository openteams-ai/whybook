/**
 * Two fixes found while the demo video of 7 October was recorded, on a frame
 * coded as NHEFS codes it: categories stored as whole numbers.
 *
 * - "Who is in these rows?" lists the categories stored as whole numbers,
 *   the one whose shares differ most first (design iteration 1.99). On
 *   NHEFS its table was empty.
 * - A question that names a causal method is Causal, and a follow-up that
 *   the agent wrote without a type gets the type of its words (design
 *   iteration 1.100). They showed Descriptive.
 *
 * No model is called: the first test asks a template, the second types
 * questions that wait in a checklist, and the third answers the agent's route
 * itself. The fixture aborts every other model route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

// A cohort coded as NHEFS codes it: qsmk, sex and race are 0 or 1, education
// is 1 to 5, and quitters gain 8 kg more.
const COHORT = [
  'import numpy as np',
  'import pandas as pd',
  '',
  'rng = np.random.default_rng(7)',
  'n = 1200',
  'cohort = pd.DataFrame({',
  '    "seqn": np.arange(233, 233 + n),',
  '    "qsmk": rng.binomial(1, 0.26, n),',
  '    "sex": rng.binomial(1, 0.51, n),',
  '    "race": rng.binomial(1, 0.13, n),',
  '    "age": rng.integers(25, 75, n),',
  '    "education": rng.integers(1, 6, n),',
  '    "wt71": rng.normal(71, 15, n).round(2),',
  '})',
  'cohort["wt82_71"] = (8 * cohort["qsmk"] + rng.normal(1, 6, n)).round(2)',
  'cohort.head()'
].join('\n');

const HISTOGRAM = 'import whybook\n\nwhybook.hist(cohort, "wt82_71")';

const MODEL = [
  'import statsmodels.formula.api as smf',
  '',
  'fit = smf.ols("wt82_71 ~ qsmk + C(sex) + C(race) + age + C(education) + wt71", data=cohort).fit()',
  'print(f"Effect of qsmk (kg): {fit.params[\'qsmk\']:.2f}")'
].join('\n');

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

/** An HTML5 drag, with Alt held. Chromium starts a drag only when the mouse moves in steps. */
async function altDrag(
  page: IJupyterLabPageFixture,
  source: Locator,
  target: Locator
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 5, {
    steps: 5
  });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 10
  });
  await page.mouse.up();
  await page.keyboard.up('Alt');
}

/** The highest weight changes, picked on the histogram: mostly quitters. */
async function pickTheHighest(page: IJupyterLabPageFixture): Promise<void> {
  const plot = card(page, 'Distribution of wt82_71').locator(
    '.jp-Epi-plotout svg.jp-Epi-plot'
  );
  await expect(plot).toBeVisible({ timeout: 60000 });
  await expect(
    page.locator('.jp-Epi-variable[data-variable="cohort"]')
  ).toBeVisible({ timeout: 60000 });
  await plot.scrollIntoViewIfNeeded();
  const area = (await plot.boundingBox())!;
  await page.mouse.move(area.x + area.width * 0.7, area.y + area.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(
    area.x + area.width * 0.95,
    area.y + area.height * 0.5,
    { steps: 10 }
  );
  await page.mouse.up();
  await expect(
    popover(page).locator('.jp-Epi-caption', { hasText: 'rows' })
  ).toHaveText(/^\d+ rows/, { timeout: 30000 });
}

/** A model is connected, so that a box takes a question; no model is called. */
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

test('a range of a histogram lists the categories stored as whole numbers in Who is in these rows?, the one that differs most first', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/rows.ipynb`;
  await newNotebook(page, file, [
    { source: COHORT, title: 'Make cohort' },
    { source: HISTOGRAM, title: 'Distribution of wt82_71' }
  ]);
  await openAndRun(page, file);
  await pickTheHighest(page);
  await popover(page)
    .locator('.jp-Epi-option', { hasText: 'Who is in these rows?' })
    .click();

  const answer = card(page, 'Who is in these rows?');
  // Each person has one row, and seqn is the notebook's unit.
  await expect(answer).toContainText(
    /\d+ of 1,200 rows, \d+ of 1,200 seqns\./,
    {
      timeout: 60000
    }
  );
  const table = answer.locator('.jp-Epi-tableoutput table').first();
  // The table was empty: every column of the cohort holds numbers.
  const labels = table.locator('tbody th');
  await expect(labels.first()).toHaveText('qsmk');
  const shown = (await labels.allTextContents()).map(text => text.trim());
  for (const name of ['sex', 'race', 'education']) {
    expect(shown).toContain(name);
  }
  // An age of 50 values is a measure, and an id is no category.
  expect(shown).not.toContain('age');
  expect(shown).not.toContain('seqn');
});

test('a causal method typed in the checklist of an Alt+drop on a model is Causal, and so is its branch', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  // The model's cell of each branch, answered here: nothing reaches a model.
  const asked: any[] = [];
  await page.route(/\/whybook\/solve(\?.*)?$/, route => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({
          type: 'result',
          elapsed: 0.2,
          cell: {
            code: `print("estimated ${asked.length}")`,
            summary: 'Prints a line.',
            assumptions: [],
            follow_up: []
          },
          model: 'fake/model'
        }) + '\n'
    });
  });
  const file = `${tmpPath}/methods.ipynb`;
  await newNotebook(page, file, [
    { source: COHORT, title: 'Make cohort' },
    { source: MODEL, title: 'Effect of qsmk on wt82_71, adjusted' }
  ]);
  await openAndRun(page, file);
  const model = card(page, 'Effect of qsmk on wt82_71, adjusted');
  await expect(model).toContainText('Effect of qsmk (kg):', {
    timeout: 60000
  });
  const frame = page.locator('.jp-Epi-variable[data-variable="cohort"]');
  await expect(frame).toBeVisible({ timeout: 60000 });
  await frame.click();
  await expect(column(page, 'qsmk')).toBeVisible();

  await altDrag(page, column(page, 'qsmk'), model.locator('.jp-Epi-title'));
  await expect(popover(page)).toContainText('parallel exploration');
  const box = popover(page).locator('.jp-Epi-own').getByRole('textbox');
  const methods = [
    'Estimate it with inverse probability weighting',
    'Estimate it by standardisation (g-formula)'
  ];
  for (const method of methods) {
    await box.fill(method);
    await box.press('Enter');
    const typed = popover(page).locator('.jp-Epi-option', { hasText: method });
    // It joins the branches checked, as a method: it showed Descriptive.
    await expect(typed).toHaveAttribute('aria-pressed', 'true');
    await expect(typed.locator('.jp-Epi-type')).toHaveText('Causal');
  }

  // As in the video, the two methods alone start: the templates' questions
  // are unchecked, one at a time, since each click changes the list.
  const others = popover(page)
    .locator('.jp-Epi-option[aria-pressed="true"]')
    .filter({ hasNotText: /inverse probability|standardisation/ });
  while ((await others.count()) > 0) {
    const count = await others.count();
    await others.first().click();
    await expect(others).toHaveCount(count - 1);
  }
  const start = popover(page).locator('.jp-Epi-parallel-foot button');
  await expect(start).toHaveText('Start 2 branches');
  await start.click();
  for (const method of methods) {
    await expect(card(page, method)).toHaveAttribute(
      'data-question-type',
      'causal',
      { timeout: 30000 }
    );
  }
  // The model that writes each branch reads the kind too.
  await expect.poll(() => asked.length, { timeout: 30000 }).toBe(2);
  expect(
    asked.map(body => [body.question.text, body.question.type]).sort()
  ).toEqual(methods.map(method => [method, 'causal']).sort());
});

test('a follow-up that the agent wrote without a type shows the type of its words, and a follow-up asks with the type that it shows', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  const sent: any[] = [];
  await page.route(/\/whybook\/(agent|solve)(\?.*)?$/, route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        [
          {
            type: 'started',
            run: `r${sent.length}`,
            keep_local: false,
            elapsed: 0
          },
          {
            type: 'result',
            answer: 'Age and the weight in 1971 differ between the groups.',
            cells: [],
            // As the agent wrote them in the takes of the video.
            follow_up: [
              'Would you like an adjusted estimate controlling for these candidates?',
              'missing-data: How would multiple imputation change the estimate and uncertainty?',
              'causal: Would conclusions hold under stronger assumptions about outcome missingness?'
            ],
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
  const file = `${tmpPath}/followups.ipynb`;
  await newNotebook(page, file, [
    { source: COHORT, title: 'Make cohort' },
    { source: HISTOGRAM, title: 'Distribution of wt82_71' }
  ]);
  await openAndRun(page, file);
  await pickTheHighest(page);
  const box = popover(page).locator('.jp-Epi-own').getByRole('textbox');
  await box.fill('What else could explain both qsmk and wt82_71?');
  await box.press('Enter');

  const followUps = page.locator('.jp-Epi-agentrun-followup');
  await expect(followUps).toHaveCount(3, { timeout: 30000 });
  // The first two showed Descriptive: the first has no type, and the second
  // one of the model's own.
  await expect(followUps.locator('.jp-Epi-type')).toHaveText([
    'Causal',
    'Data quality',
    'Causal'
  ]);
  await expect(followUps.nth(1)).toContainText(
    'missing-data: How would multiple imputation change the estimate and uncertainty?'
  );
  await followUps.nth(2).click();
  await expect.poll(() => sent.length, { timeout: 30000 }).toBe(2);
  // Its words alone would make it Data quality: "missingness".
  expect(sent[1].question).toEqual({
    text: 'Would conclusions hold under stronger assumptions about outcome missingness?',
    type: 'causal'
  });
});
