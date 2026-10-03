/**
 * The model's questions and the agent (design iteration 1.76), in the
 * browser against the built extension:
 *
 * - A value that a template wrote is the template's: its chip has no AI tag,
 *   and its tooltip and its questions say that the template chose it. A
 *   model's value keeps the AI tag (energy step 6).
 * - A question of the model that the analyst asked does not come back when
 *   the same drop shows the model's questions again (pain step 35). The
 *   next request for questions carries what the agent found.
 *
 * The server's part, which leaves out the questions that use neither item
 * or name a column that no frame holds, is tested in pytest
 * (whybook/server/tests/test_model_questions.py): here the page answers the
 * model's route itself, as the server would. No model runs.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator, Route } from '@playwright/test';

import { expect, test } from './fixtures';
import { tooltipLines } from './tooltips';

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

function code(
  id: string,
  source: string,
  whybook: Record<string, unknown> | null = null
): object {
  return {
    cell_type: 'code',
    execution_count: null,
    id,
    metadata: whybook ? { whybook } : {},
    outputs: [],
    source
  };
}

async function writeNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  cells: object[]
): Promise<void> {
  const notebook = {
    cells,
    metadata: { kernelspec: KERNELSPEC },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

/** Open a notebook in the Whybook view, run every cell, and wait until each has its label. */
async function openAndRun(
  page: IJupyterLabPageFixture,
  file: string,
  cells: number
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
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('.jp-Epi-bench .jp-Epi-cell .jp-Epi-label')
  ).toHaveText(
    Array.from({ length: cells }, (_, index) => `[${index + 1}]`),
    { timeout: 60000 }
  );
}

function card(page: IJupyterLabPageFixture, cellId: string): Locator {
  return page.locator(`.jp-Epi-bench .jp-Epi-cell[data-cell-id="${cellId}"]`);
}

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

/** The status says that a model is set up; no model runs. */
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

function ndjson(events: object[]): string {
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
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

test('a value that a template wrote is chosen by the template, and a value of a model by AI', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/chips.ipynb`;
  await writeNotebook(page, file, [
    code(
      'load',
      'import pandas as pd\nreadings = pd.DataFrame({"home_id": ["H1", "H1", "H2", "H3"], "kwh": [1.0, 2.0, 3.0, 4.0]})\nhomes = pd.DataFrame({"home_id": ["H1", "H2", "H3"], "tariff": ["flat", "time of use", "flat"]})'
    ),
    // The join template of energy step 6, with no model call.
    code(
      'join',
      'readings_homes = readings.merge(homes, on="home_id", how="left")\nreadings_homes.head()',
      {
        written_by: 'agent',
        template: true,
        question: {
          id: 'q:join',
          text: 'Join homes to readings on home_id',
          type: 'descriptive'
        }
      }
    ),
    // A cell that a model wrote.
    code(
      'share',
      'share = pd.crosstab(readings_homes["tariff"], readings_homes["home_id"], normalize="index")\nshare',
      {
        written_by: 'agent',
        generated_by: { agent: 'openrouter', model: 'fake/model' }
      }
    )
  ]);
  await openAndRun(page, file, 3);

  const left = card(page, 'join').locator('.jp-Epi-chip', {
    hasText: 'left join'
  });
  await expect(left).toBeVisible({ timeout: 60000 });
  expect(await tooltipLines(page, left)).toContain(
    'Chosen by the template you picked.'
  );
  await expect(left.locator('.jp-Epi-aitag')).toHaveCount(0);
  const normalize = card(page, 'share').locator('.jp-Epi-chip', {
    hasText: 'normalize index'
  });
  expect(await tooltipLines(page, normalize)).toContain('Chosen by AI.');
  await expect(normalize.locator('.jp-Epi-aitag')).toHaveCount(1);

  // The questions of the chip say who chose the value.
  await left.click();
  await expect(
    page.locator('.jp-Epi-caption', {
      hasText: 'chosen by the template you picked'
    })
  ).toBeVisible();
});

const VISITS =
  'import pandas as pd\nvisits = pd.DataFrame({"patient_id": ["P1", "P1", "P2", "P2", "P3", "P3"], "week": [0, 4, 0, 6, 2, 9], "crp_mg_l": [1.2, 3.4, 2.2, 0.8, 4.1, 2.9]})\nvisits.head()';
const ARM = 'Does treatment arm moderate how crp_mg_l changes over week?';
const MEDIATE = 'Does patient_id explain how crp_mg_l changes over week?';
const ANSWER =
  'visits holds no treatment arm column [2], so the question cannot be answered from this data.';

/** A question of the model as the server sends it. */
function question(id: string, text: string) {
  return {
    id,
    text,
    type: 'model',
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

test('a question of the model that the analyst asked does not come back, and the next request carries what the agent found', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  // The model's route, answered as the server would: two questions, first in the list.
  const requests: any[] = [];
  await page.route(
    /\/whybook\/questions\/claude(\?|$)/,
    async (route: Route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      const offered = (body.offered ?? []).map((item: any) => item.id);
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjson([
          {
            type: 'result',
            elapsed: 1.1,
            model: 'fake/model',
            cost_usd: 0.01,
            questions: [
              question('claude:arm', ARM),
              question('claude:patient', MEDIATE)
            ],
            outcomes: [],
            units: [],
            left_out: [],
            order: ['claude:arm', 'claude:patient', ...offered]
          }
        ])
      });
    }
  );
  // The agent answers the question about the arm with one cell.
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
            title: 'The columns of visits',
            code: 'print("columns:", ", ".join(visits.columns))',
            why: 'look for an arm column'
          }
        },
        {
          type: 'result',
          answer: ANSWER,
          cells: ['[2]'],
          follow_up: [],
          model: 'fake/model',
          provider: 'openrouter',
          cost_usd: 0.02,
          elapsed: 5
        }
      ])
    })
  );
  await page.route(/\/whybook\/agent\/result/, route =>
    route.fulfill({ status: 200, json: { ok: true } })
  );

  const file = `${tmpPath}/asked.ipynb`;
  await writeNotebook(page, file, [code('load', VISITS)]);
  await openAndRun(page, file, 1);
  const visits = page.locator('.jp-Epi-variable[data-variable="visits"]');
  await expect(visits).toBeVisible({ timeout: 60000 });
  await visits.click();
  const column = (name: string) =>
    page.locator('.jp-Epi-contents .jp-Epi-column').filter({
      has: page.locator('.jp-Epi-item-name', {
        hasText: new RegExp(`^${name}$`)
      })
    });
  const options = popover(page).locator('.jp-Epi-option .jp-Epi-option-text');

  // Pain step 14: week onto crp_mg_l, and the model's two questions.
  await drag(page, column('week'), column('crp_mg_l'));
  await expect(options.first()).toHaveText(`${ARM}AI`);
  expect(requests).toHaveLength(1);
  expect(requests[0].found).toEqual([]);

  // Pain step 15: the analyst asks it, and the agent answers.
  await popover(page).locator('.jp-Epi-option', { hasText: ARM }).click();
  await expect(
    page.locator('.jp-Epi-bench .jp-Epi-agentrun-answer')
  ).toContainText('no treatment arm column', { timeout: 60000 });

  // Pain step 35: the same drop shows the model's questions it kept, less the one asked.
  await drag(page, column('week'), column('crp_mg_l'));
  await expect(options.first()).toHaveText(`${MEDIATE}AI`);
  await expect(
    popover(page).locator('.jp-Epi-option', { hasText: ARM })
  ).toHaveCount(0);
  expect(requests).toHaveLength(1);

  // Another drop asks the model again, with what the agent found.
  await popover(page)
    .getByRole('button', { name: 'Close the questions' })
    .click();
  await drag(page, column('crp_mg_l'), column('week'));
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].found).toEqual([{ question: ARM, answer: ANSWER }]);
});
