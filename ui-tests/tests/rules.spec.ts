/**
 * Rules first, and a model when the rules cannot tell (design iterations
 * 1.18 and "rules-then-model").
 *
 * - The values offered from a constant's chip follow the kind of the
 *   constant: a count of days takes common lengths of time, a significance
 *   level the conventional levels next to it. When no rule knows the kind,
 *   the model of More questions suggests values; without one, the chip keeps
 *   half and double, and says that a model would suggest values.
 * - A drop that no template fits asks that model for questions at once, with
 *   a bar, once per drop, and runs none of them.
 *
 * No model is called: each test answers the model's route itself, or the
 * fixture aborts it.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator, Route } from '@playwright/test';

import { expect, test } from './fixtures';
import { tooltipLines } from './tooltips';

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

/**
 * Answer a model's route with these events, once the test lets each answer
 * go: `requests` holds the body of each request, and `release` lets the
 * oldest one waiting go.
 */
async function held(
  page: IJupyterLabPageFixture,
  path: RegExp,
  events: unknown[]
): Promise<{ requests: any[]; release: () => void }> {
  const requests: any[] = [];
  const waiting: (() => void)[] = [];
  await page.route(path, async (route: Route) => {
    requests.push(route.request().postDataJSON());
    await new Promise<void>(resolve => waiting.push(resolve));
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: events.map(event => JSON.stringify(event)).join('\n') + '\n'
    });
  });
  return {
    requests,
    release: () => {
      waiting.shift()?.();
    }
  };
}

const PRINTS = 'print("\\n".join(str(i) for i in range(8)))';

test('offers the values of a count of days and of a significance level by their kind', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/kinds.ipynb`;
  // Two printed outputs above the cell leave room over its chips.
  await newNotebook(page, file, [
    PRINTS,
    PRINTS,
    'WINDOW_DAYS = 30\nALPHA = 0.05\np_values = [0.01, 0.04, 0.2]\nsignificant = [p for p in p_values if p < ALPHA]\nlen(significant)'
  ]);
  await openAndRun(page, file);
  const days = page.locator('.jp-Epi-chip', { hasText: 'WINDOW_DAYS 30' });
  await days.waitFor({ timeout: 60000 });
  await days.click();
  const box = popover(page);
  const texts = box.locator('.jp-Epi-option .jp-Epi-option-text');
  // The fallback rule would give half below and above: 15 and 45.
  await expect(texts.first()).toHaveText('What if WINDOW_DAYS were 21?');
  await expect(texts.nth(1)).toHaveText('What if WINDOW_DAYS were 60?');
  // The line above the values is short (design iteration 1.86).
  await expect(box.locator('.jp-Epi-valuekind')).toHaveText(
    'A count of days: common lengths of time.'
  );
  await expect(box.locator('.jp-Epi-option-effect').first()).toContainText(
    '21 instead of 30 (−9) · three weeks'
  );
  // The rules chose them: no AI tag.
  await expect(box.locator('.jp-Epi-option .jp-Epi-aitag')).toHaveCount(0);

  await box.getByRole('button', { name: 'Close the questions' }).click();
  await expect(box).toHaveCount(0);
  await page.locator('.jp-Epi-chip', { hasText: 'ALPHA 0.05' }).click();
  // The fallback rule would give half and double: 0.025 and 0.1.
  await expect(texts).toHaveText([
    'What if ALPHA were 0.01?',
    'What if ALPHA were 0.1?'
  ]);
  await expect(box.locator('.jp-Epi-valuekind')).toHaveText(
    'A significance level: the conventional levels next to it.'
  );
});

const TEMPERATURE = [
  PRINTS,
  PRINTS,
  'BASE_TEMP_C = 15.5\ndegrees = [10.0, 16.0, 19.5]\nheating = sum(max(0, BASE_TEMP_C - t) for t in degrees)\nheating'
];

test('asks the model for the values of a constant that no rule knows, once, and a picked value is yours', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  const model = await held(page, /\/whybook\/decision\/values(\?|$)/, [
    { type: 'progress', stage: 'thinking', elapsed: 0.2 },
    {
      type: 'result',
      elapsed: 1.1,
      model: 'fake/model',
      cost_usd: 0.0004,
      kind: 'a base temperature of heating degree days',
      values: [
        { value: '12.0', why: 'a lower base, for homes that keep the heat' },
        { value: '18.3', why: '65 °F, the base of US degree days' }
      ]
    }
  ]);
  const file = `${tmpPath}/temperature.ipynb`;
  await newNotebook(page, file, TEMPERATURE);
  await openAndRun(page, file);
  const chip = page.locator('.jp-Epi-chip', { hasText: 'BASE_TEMP_C 15.5' });
  await chip.waitFor({ timeout: 60000 });
  await chip.click();
  const box = popover(page);
  const kind = box.locator('.jp-Epi-valuekind');
  // While the model works, a bar shows, and the half and double wait.
  await expect(kind).toContainText('Analysing…');
  await expect(kind.locator('.jp-Epi-progress')).toBeVisible();
  await expect.poll(() => model.requests.length).toBe(1);
  // The default of More questions: the fast model of the connected provider.
  expect(model.requests[0]).toMatchObject({
    model: 'remote:fast',
    decision: { name: 'BASE_TEMP_C', value: '15.5' }
  });
  const texts = box.locator('.jp-Epi-option .jp-Epi-option-text');
  await expect(
    box.locator('.jp-Epi-option', { hasText: 'What if BASE_TEMP_C were' })
  ).toHaveCount(0);
  model.release();
  await expect(texts).toHaveText([
    'What if BASE_TEMP_C were 12.0?AI',
    'What if BASE_TEMP_C were 18.3?AI'
  ]);
  // After the model answered, the line is gone: the AI tag on each value
  // says who chose it, and its tooltip has the kind.
  await expect(kind).toHaveCount(0);
  await expect(box.locator('.jp-Epi-option-effect').nth(1)).toContainText(
    '65 °F, the base of US degree days'
  );
  await expect(
    box.locator('.jp-Epi-option .jp-Epi-aitag').first()
  ).toHaveAttribute('title', /^Proposed by the remote AI model, fake\/model/);

  // Another click on the chip shows the same values, and asks no model again.
  await box.getByRole('button', { name: 'Close the questions' }).click();
  await chip.click();
  await expect(texts.first()).toHaveText('What if BASE_TEMP_C were 12.0?AI');
  expect(model.requests).toHaveLength(1);

  // A value that the analyst picks is theirs: its chip says "you".
  await box.locator('.jp-Epi-option', { hasText: 'were 12.0?' }).click();
  const branch = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-title', {
      hasText: 'What if BASE_TEMP_C were 12.0?'
    })
  });
  await expect(branch.locator('.jp-Epi-textoutput')).toHaveText('2.0', {
    timeout: 60000
  });
  const yours = branch.locator('.jp-Epi-chip', {
    hasText: 'BASE_TEMP_C_if_12_0 12.0'
  });
  // The analyst's value is a plain chip: no AI tag, not the colour of a
  // value that nobody chose, and no line of who chose it in its tooltip.
  await expect(yours).toBeVisible({ timeout: 60000 });
  await expect(yours.locator('.jp-Epi-aitag')).toHaveCount(0);
  await expect(yours).not.toHaveClass(/jp-mod-open/);
  expect(
    (await tooltipLines(page, yours)).some(line => line.startsWith('Chosen by'))
  ).toBe(false);
});

test('keeps half and double without a model, and says that a model would suggest values', async ({
  page,
  tmpPath
}) => {
  const asked: string[] = [];
  page.on('request', request => {
    if (/\/whybook\/decision\/values$/.test(new URL(request.url()).pathname)) {
      asked.push(request.url());
    }
  });
  const file = `${tmpPath}/nomodel.ipynb`;
  await newNotebook(page, file, TEMPERATURE);
  await openAndRun(page, file);
  const chip = page.locator('.jp-Epi-chip', { hasText: 'BASE_TEMP_C 15.5' });
  await chip.waitFor({ timeout: 60000 });
  await chip.click();
  const box = popover(page);
  await expect(box.locator('.jp-Epi-option .jp-Epi-option-text')).toHaveText([
    'What if BASE_TEMP_C were 7.75?',
    'What if BASE_TEMP_C were 31.0?'
  ]);
  const kind = box.locator('.jp-Epi-valuekind');
  await expect(kind).toHaveText(
    'Half and double the value: no AI model answers.'
  );
  // Why no model answers is the line's tooltip.
  await expect(kind).toHaveAttribute(
    'title',
    /^A model would suggest values that fit it, and none answers: .+\.$/
  );
  expect(asked).toEqual([]);
});

const DROP = ['items = {"a": 1, "b": 2}\nnames = ["a", "b"]'];

const QUESTIONS = [
  { type: 'progress', stage: 'thinking', elapsed: 0.2 },
  {
    type: 'result',
    elapsed: 1.4,
    model: 'fake/model',
    cost_usd: 0.001,
    questions: [
      {
        id: 'claude:1',
        text: 'Which keys of items are in names?',
        type: 'descriptive',
        origin: 'claude',
        template: null,
        variables: ['items', 'names'],
        probability: 0.7,
        reasons: ['The two hold the same keys'],
        effect: '',
        placement: null,
        code: null,
        action: null
      },
      {
        id: 'claude:2',
        text: 'Does names list each key of items once?',
        type: 'quality',
        origin: 'claude',
        template: null,
        variables: ['items', 'names'],
        probability: 0.6,
        reasons: ['A key listed twice counts twice'],
        effect: '',
        placement: null,
        code: null,
        action: null
      }
    ]
  }
];

test('asks the model at once when no template fits a drop, with a bar, once, and runs none', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  const model = await held(
    page,
    /\/whybook\/questions\/claude(\?|$)/,
    QUESTIONS
  );
  const file = `${tmpPath}/notemplate.ipynb`;
  await newNotebook(page, file, DROP);
  await openAndRun(page, file);
  const items = page.locator('.jp-Epi-variable[data-variable="items"]');
  const names = page.locator('.jp-Epi-variable[data-variable="names"]');
  await expect(names).toBeVisible({ timeout: 60000 });
  await drag(page, items, names);
  const box = popover(page);
  const line = box.locator('.jp-Epi-notemplate');
  await expect(line).toContainText(
    'No template has a question for this: an AI model writes more.'
  );
  await expect(line.locator('.jp-Epi-progress')).toBeVisible();
  await expect.poll(() => model.requests.length).toBe(1);
  expect(model.requests[0]).toMatchObject({
    model: 'remote:fast',
    selection: { source: { name: 'items' }, target: { name: 'names' } }
  });
  model.release();
  const texts = box.locator('.jp-Epi-option .jp-Epi-option-text');
  await expect(texts).toHaveText([
    'Which keys of items are in names?AI',
    'Does names list each key of items once?AI'
  ]);
  await expect(line).toHaveText(
    'No template has a question for this, so an AI model suggested the questions marked AI. None runs until you pick it.'
  );
  // Nothing ran by itself: no strip, and the notebook keeps its one cell.
  await expect(page.locator('.jp-Epi-strip')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).jupyterapp.shell.currentWidget.context.model.cells
          .length
    )
  ).toBe(1);

  // The same drop again shows the same questions, and asks no model again.
  await box.getByRole('button', { name: 'Close the questions' }).click();
  await expect(box).toHaveCount(0);
  await drag(page, items, names);
  await expect(texts).toHaveText([
    'Which keys of items are in names?AI',
    'Does names list each key of items once?AI'
  ]);
  expect(model.requests).toHaveLength(1);
});

test('says that a model would suggest questions when none answers, and asks none', async ({
  page,
  tmpPath
}) => {
  const asked: string[] = [];
  page.on('request', request => {
    if (/\/whybook\/questions\/claude$/.test(new URL(request.url()).pathname)) {
      asked.push(request.url());
    }
  });
  const file = `${tmpPath}/nomodeldrop.ipynb`;
  await newNotebook(page, file, DROP);
  await openAndRun(page, file);
  const items = page.locator('.jp-Epi-variable[data-variable="items"]');
  const names = page.locator('.jp-Epi-variable[data-variable="names"]');
  await expect(names).toBeVisible({ timeout: 60000 });
  await drag(page, items, names);
  await expect(popover(page).locator('.jp-Epi-notemplate')).toHaveText(
    /^No template has a question for this\. A model would suggest questions, and none answers: .+\.$/
  );
  expect(asked).toEqual([]);
});

test('with questions from a model set to never, a drop that no template fits waits for More questions from AI', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  const model = await held(
    page,
    /\/whybook\/questions\/claude(\?|$)/,
    QUESTIONS
  );
  const file = `${tmpPath}/settingoff.ipynb`;
  await newNotebook(page, file, DROP);
  await openAndRun(page, file);
  // The choice that replaced the switch "Questions from AI when no template
  // fits"; a saved switch that is off reads as never
  // (firstdrops.spec.ts).
  await page.evaluate(() => {
    (window as any).jupyterapp.shell.currentWidget.content.model.settings.set(
      'modelQuestions',
      'never'
    );
  });
  const items = page.locator('.jp-Epi-variable[data-variable="items"]');
  const names = page.locator('.jp-Epi-variable[data-variable="names"]');
  await expect(names).toBeVisible({ timeout: 60000 });
  await drag(page, items, names);
  const more = popover(page).getByRole('button', {
    name: 'More questions from AI'
  });
  await expect(more).toBeVisible();
  await expect(popover(page).locator('.jp-Epi-notemplate')).toHaveCount(0);
  expect(model.requests).toHaveLength(0);
  // The button asks, as before.
  await more.click();
  await expect.poll(() => model.requests.length).toBe(1);
  model.release();
  await expect(
    popover(page).locator('.jp-Epi-option .jp-Epi-option-text')
  ).toHaveText([
    'Which keys of items are in names?AI',
    'Does names list each key of items once?AI'
  ]);
});
