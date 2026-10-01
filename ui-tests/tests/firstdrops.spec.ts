/**
 * The first drops of a new notebook (design iterations 1.64 and 1.65).
 *
 * - A drop or a click asks the model of More questions in the background,
 *   next to the templates: the templates' questions show at once, a bar
 *   shows while the model works, and its questions join the list in the
 *   order that the server gives, marked AI. None runs by itself.
 * - The same call names the likely outcomes and units of the analysis. The
 *   questions that use one show where it came from on a chip, "outcome
 *   kwh_import · inferred by AI", and a click on the chip lists the other
 *   candidates. The rules find an outcome in a model's formula, and a unit
 *   in an id column whose values repeat, with no model.
 * - "Questions from a model" at never, or the switch it replaced saved off,
 *   asks no model.
 *
 * No model is called: each test answers the model's route itself, or the
 * fixture aborts it.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';
import type { Locator, Route } from '@playwright/test';

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

/** Open a notebook in the Whybook view, run every cell, and wait for the kernel. */
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

/** A question as the server sends one of the model's. */
function question(id: string, text: string, type: string) {
  return {
    id,
    text,
    type,
    origin: 'claude',
    template: null,
    variables: [],
    probability: 0.8,
    reasons: ['The model says why'],
    effect: '',
    placement: null,
    code: null,
    action: null
  };
}

/**
 * The model's route, answered as the server would: two questions, one first
 * and one last in the order of the list, and the outcomes and the units.
 * `requests` holds the body of each request, and `release` lets the oldest
 * one waiting go.
 */
async function model(
  page: IJupyterLabPageFixture
): Promise<{ requests: any[]; release: () => void }> {
  const requests: any[] = [];
  const waiting: (() => void)[] = [];
  await page.route(
    /\/whybook\/questions\/claude(\?|$)/,
    async (route: Route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      await new Promise<void>(resolve => waiting.push(resolve));
      const offered = (body.offered ?? []).map((item: any) => item.id);
      const events = [
        { type: 'progress', stage: 'thinking', elapsed: 0.2 },
        {
          type: 'result',
          elapsed: 1.4,
          model: 'fake/model',
          cost_usd: 0.02,
          questions: [
            question(
              'claude:area',
              'Do larger homes by floor_area_m2 use more kwh_import?',
              'association'
            ),
            question(
              'claude:days',
              'Are some homes read on fewer days?',
              'quality'
            )
          ],
          outcomes: [
            { column: 'kwh_import', frame: 'readings', why: 'the energy used' },
            { column: 'kwh_peak', frame: 'readings', why: 'use at the peak' }
          ],
          units: [{ column: 'home_id', frame: 'readings', why: 'read daily' }],
          order: ['claude:area', ...offered, 'claude:days']
        }
      ];
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: events.map(event => JSON.stringify(event)).join('\n') + '\n'
      });
    }
  );
  return {
    requests,
    release: () => {
      waiting.shift()?.();
    }
  };
}

const HOMES = [
  'import pandas as pd\n\nhomes = pd.DataFrame({"home_id": ["H1", "H2", "H3"], "region": ["north", "south", "north"], "floor_area_m2": [80, 120, 95]})',
  'readings = pd.DataFrame({"home_id": ["H1", "H1", "H2", "H2", "H3", "H3"], "day": [1, 2, 1, 2, 1, 2], "kwh_import": [10.0, 12.5, 8.1, 9.0, 11.2, 13.3], "kwh_peak": [3.0, 4.1, 2.2, 2.5, 3.3, 4.0]})\nreadings.head()'
];

function variable(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator(`.jp-Epi-variable[data-variable="${name}"]`);
}

function column(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator('.jp-Epi-contents .jp-Epi-column').filter({
    has: page.locator('.jp-Epi-item-name', { hasText: new RegExp(`^${name}$`) })
  });
}

/** The card of a cell on the bench. */
function card(page: IJupyterLabPageFixture, cellId: string): Locator {
  return page.locator(`.jp-Epi-bench .jp-Epi-cell[data-cell-id="${cellId}"]`);
}

function texts(page: IJupyterLabPageFixture): Locator {
  return popover(page).locator('.jp-Epi-option .jp-Epi-option-text');
}

test('asks the model next to the templates, with a bar, puts its questions where the server says, and runs none', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  const answers = await model(page);
  const file = `${tmpPath}/alongside.ipynb`;
  await newNotebook(page, file, HOMES);
  await openAndRun(page, file);
  await expect(variable(page, 'readings')).toBeVisible({ timeout: 60000 });
  await drag(page, variable(page, 'readings'), variable(page, 'homes'));

  // The templates' questions show at once, and a bar while the model works.
  await expect(texts(page).first()).toHaveText(
    'How do readings and homes line up?'
  );
  const line = popover(page).locator('.jp-Epi-modelline');
  await expect(line).toContainText(
    'An AI model adds questions that the templates miss.'
  );
  await expect(line.locator('.jp-Epi-progress')).toBeVisible();
  await expect.poll(() => answers.requests.length).toBe(1);
  const sent = answers.requests[0];
  // The default of More questions: the fast model of the connected provider.
  expect(sent).toMatchObject({
    model: 'remote:fast',
    selection: { source: { name: 'readings' }, target: { name: 'homes' } },
    context: { unit: 'home_id', units: ['home_id'] }
  });
  // The model reads the questions offered, and which of them run.
  expect(
    sent.offered.map((item: any) => [item.text, item.runs])
  ).toContainEqual(['How do readings and homes line up?', true]);

  // Move the pointer off the list, so that the order shows when it comes.
  await page.mouse.move(5, 5);
  answers.release();
  await expect(texts(page).first()).toHaveText(
    'Do larger homes by floor_area_m2 use more kwh_import?AI'
  );
  await expect(texts(page).last()).toHaveText(
    'Are some homes read on fewer days?AI'
  );
  await expect(line).toHaveCount(0);
  await expect(
    popover(page).locator('.jp-Epi-option .jp-Epi-aitag')
  ).toHaveCount(2);
  // Nothing ran by itself: no strip, and the notebook keeps its two cells.
  await expect(page.locator('.jp-Epi-strip')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).jupyterapp.shell.currentWidget.context.model.cells
          .length
    )
  ).toBe(2);

  // The same drop again shows the same list, and asks no model.
  await popover(page)
    .getByRole('button', { name: 'Close the questions' })
    .click();
  await drag(page, variable(page, 'readings'), variable(page, 'homes'));
  await expect(texts(page).first()).toHaveText(
    'Do larger homes by floor_area_m2 use more kwh_import?AI'
  );
  expect(answers.requests).toHaveLength(1);
});

test('shows the outcome that the model named on the questions that use it, and a click on its chip takes another', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  const answers = await model(page);
  const file = `${tmpPath}/outcome.ipynb`;
  await newNotebook(page, file, HOMES);
  await openAndRun(page, file);
  await expect(variable(page, 'readings')).toBeVisible({ timeout: 60000 });
  // A first drop: the model names the outcomes.
  await drag(page, variable(page, 'readings'), variable(page, 'homes'));
  await expect.poll(() => answers.requests.length).toBe(1);
  answers.release();
  await expect(texts(page).first()).toHaveText(
    'Do larger homes by floor_area_m2 use more kwh_import?AI'
  );
  await popover(page)
    .getByRole('button', { name: 'Close the questions' })
    .click();

  // day onto the cell that makes readings: a question about the outcome.
  await variable(page, 'readings').click();
  await drag(page, column(page, 'day'), card(page, 'cell-1'));
  const association = popover(page).locator('.jp-Epi-option', {
    hasText: 'Is day associated with kwh_import here?'
  });
  await expect(association).toBeVisible();
  const chip = popover(page).locator('.jp-Epi-inferred-chip').first();
  await expect(chip).toHaveText('outcome kwh_import · inferred by AIAI');
  await expect(chip.locator('.jp-Epi-aitag')).toHaveAttribute(
    'title',
    /^Named by the remote AI model, fake\/model/
  );
  await expect.poll(() => answers.requests.length).toBe(2);
  answers.release();

  // A click on the chip lists the other outcomes found; one of them becomes
  // the analyst's, and the questions are asked again with it.
  await chip.click();
  const others = popover(page).locator('.jp-Epi-inferred-others');
  await expect(others).toContainText('Other outcomes found:');
  await others
    .locator('.jp-Epi-inferred-chip', { hasText: 'outcome kwh_peak' })
    .click();
  await expect(
    popover(page).locator('.jp-Epi-option', {
      hasText: 'Is day associated with kwh_peak here?'
    })
  ).toBeVisible();
  await expect(
    popover(page).locator('.jp-Epi-inferred-chip').first()
  ).toHaveText('outcome kwh_peak · chosen by you');
  const kept = await page.evaluate(
    () =>
      (window as any).jupyterapp.shell.currentWidget.context.model.getMetadata(
        'whybook'
      ).inferred.outcomes[0]
  );
  expect(kept).toEqual({
    column: 'kwh_peak',
    frame: 'readings',
    by: 'analyst'
  });
});

test('infers the outcome of a formula and the unit of repeated ids with no model, and says where each came from', async ({
  page,
  tmpPath
}) => {
  const asked: string[] = [];
  page.on('request', request => {
    if (/\/whybook\/questions\/claude$/.test(new URL(request.url()).pathname)) {
      asked.push(request.url());
    }
  });
  const file = `${tmpPath}/rules.ipynb`;
  await newNotebook(page, file, [
    ...HOMES,
    'import statsmodels.formula.api as smf\n\nfit = smf.ols("kwh_import ~ kwh_peak", data=readings).fit()\nfit.params'
  ]);
  await openAndRun(page, file);
  await expect(variable(page, 'fit')).toBeVisible({ timeout: 60000 });
  await variable(page, 'readings').click();
  await drag(page, column(page, 'day'), card(page, 'cell-2'));
  await expect(
    popover(page).locator('.jp-Epi-option', {
      hasText: 'Is day associated with kwh_import here?'
    })
  ).toBeVisible();
  // The rules read the formula of the cell: its label is [3] after Run all.
  await expect(
    popover(page).locator('.jp-Epi-inferred-chip').first()
  ).toHaveText(/^outcome kwh_import · inferred from \[\d+\]$/);
  await popover(page)
    .getByRole('button', { name: 'Close the questions' })
    .click();

  // Two numbers of readings: within or between the homes that the ids repeat over.
  await drag(page, column(page, 'kwh_peak'), column(page, 'kwh_import'));
  await expect(
    popover(page).locator('.jp-Epi-option', {
      hasText:
        'Are kwh_peak and kwh_import associated, within or between homes?'
    })
  ).toBeVisible();
  await expect(popover(page).locator('.jp-Epi-inferred-chip')).toHaveText(
    'unit home_id · inferred from readings'
  );
  expect(asked).toEqual([]);
});

test.describe('With the switch of before saved off', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:plugin': { aiWhenNoTemplate: false }
    }
  });

  test('asks no model about a drop, as with questions from a model at never', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const answers = await model(page);
    const file = `${tmpPath}/never.ipynb`;
    await newNotebook(page, file, HOMES);
    await openAndRun(page, file);
    await expect(variable(page, 'readings')).toBeVisible({ timeout: 60000 });
    await drag(page, variable(page, 'readings'), variable(page, 'homes'));
    const more = popover(page).getByRole('button', {
      name: 'More questions from AI'
    });
    // The list is whole once the button shows: nothing waits for a model.
    await expect(more).toBeVisible();
    await expect(popover(page).locator('.jp-Epi-modelline')).toHaveCount(0);
    expect(answers.requests).toHaveLength(0);
    expect(
      await page.evaluate(
        () =>
          (window as any).jupyterapp.shell.currentWidget.content.model.settings
            .modelQuestions
      )
    ).toBe('never');
  });
});
