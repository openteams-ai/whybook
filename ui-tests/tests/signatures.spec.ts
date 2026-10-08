/**
 * "Find more defaults with AI" (design iteration 1.53), a setting that is on
 * by default, and the head of Contents with a variable
 * selected (1.11).
 *
 * With the setting on, the kernel reads the signature of each library
 * function that a cell calls, and the model chosen for More questions picks
 * the defaults that can change the result. They show as chips, with the AI
 * tag and the model's reason in the tooltip. Without a model, the setting
 * says what it waits for.
 *
 * No model is called: each test answers the model's route itself, or the
 * fixture aborts it.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test, withoutGuard } from './fixtures';

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

/** Turn "Find more defaults with AI" on or off, as the settings editor does. */
async function findDefaults(
  page: IJupyterLabPageFixture,
  on: boolean
): Promise<void> {
  await page.evaluate(value => {
    (window as any).jupyterapp.shell.currentWidget.content.model.settings.set(
      'findDefaults',
      value
    );
  }, on);
}

/** The server's status, with a connected model that answers at a known price, or with none. */
async function status(
  page: IJupyterLabPageFixture,
  connected: boolean
): Promise<void> {
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: connected,
        claude: connected
          ? {
              ...status.claude,
              available: true,
              provider: 'openrouter',
              label: 'OpenRouter: fake/model',
              reason: null,
              setup: null,
              priced: true
            }
          : {
              ...status.claude,
              available: false,
              provider: 'none',
              label: 'No model',
              reason: 'no model is connected',
              setup: 'Connect one in the AI models panel.'
            },
        remote_model: connected ? 'OpenRouter: fake/model' : null
      }
    });
  });
}

const BY = {
  choice: 'remote',
  model: 'fake/model',
  at: '2026-09-30T09:00:00Z'
};
const DROPNA = 'Rows whose key is missing are left out of the groups.';
const SORT = 'The groups come in the order of their keys.';

/**
 * The model's route, answered by function: groupby's dropna and sort, and
 * merge's how, which the view's own list of defaults shows already. The
 * body of each request is kept in `asked`. With `hold`, the answers wait
 * until the test calls `release`.
 */
async function fakeModel(
  page: IJupyterLabPageFixture,
  hold = false
): Promise<{ asked: any[]; release: () => void }> {
  const asked: any[] = [];
  let release = () => {};
  const released = hold
    ? new Promise<void>(resolve => {
        release = resolve;
      })
    : Promise.resolve();
  await page.route(/\/whybook\/defaults\/ask(\?|$)/, async route => {
    const body = route.request().postDataJSON();
    asked.push(body);
    await released;
    const picks: Record<string, unknown[]> = {
      'DataFrame.groupby': [
        { param: 'dropna', why: DROPNA },
        { param: 'sort', why: SORT }
      ],
      'DataFrame.merge': [
        { param: 'how', why: 'Rows without a match are dropped.' }
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
            by: BY,
            model: 'fake/model',
            cost_usd: 0.0002,
            elapsed: 0.3
          }
        ]
          .map(event => JSON.stringify(event))
          .join('\n') + '\n'
    });
  });
  return { asked, release: () => release() };
}

const CELLS = [
  'import pandas as pd\ndf = pd.DataFrame({"g": ["a", None, "b", "a"], "v": [1, 2, 3, 4]})\nnames = pd.DataFrame({"g": ["a", "b"], "name": ["first", "second"]})',
  'totals = df.merge(names, on="g").groupby("name")["v"].sum()\ntotals'
];

function chips(page: IJupyterLabPageFixture): Locator {
  return page.locator(
    '.jp-Epi-bench .jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-chip'
  );
}

test('shows the defaults that a model picks from the signatures as chips, with the reason and the AI tag, on by default', async ({
  page,
  tmpPath
}) => {
  await status(page, true);
  const model = await fakeModel(page, true);
  const asked = model.asked;
  const lookups: any[] = [];
  page.on('request', request => {
    if (/\/whybook\/defaults$/.test(new URL(request.url()).pathname)) {
      lookups.push(request.postDataJSON());
    }
  });
  const file = `${tmpPath}/defaults.ipynb`;
  await newNotebook(page, file, CELLS);
  // On by default: once the kernel has read the
  // signatures, the server is asked for the answers it kept, then the model.
  const lookup = page.waitForResponse(/\/whybook\/defaults(\?|$)/);
  await openAndRun(page, file);
  await lookup;
  // The inner join of the merge is a default of the view's own list.
  await expect(chips(page)).toHaveText(['inner join'], { timeout: 60000 });
  // While the model reads the signatures, one at a time, a bar follows the
  // chips of each cell whose functions wait.
  const bar = page.locator(
    '.jp-Epi-bench .jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-chips-waiting'
  );
  await expect(bar).toHaveAttribute(
    'title',
    'An AI model reads the signatures of DataFrame.merge and DataFrame.groupby, for more defaults.'
  );
  await expect.poll(() => asked.length).toBe(1);
  model.release();
  // The model's picks, after the view's own chips; merge's how shows once.
  // They carry no AI tag: the model chose to show them, and the popover says so.
  await expect(chips(page)).toHaveText(
    ['inner join', 'dropna True', 'sort True'],
    { timeout: 60000 }
  );
  await expect(bar).toHaveCount(0);
  const dropna = chips(page).nth(1);
  await expect(dropna).toHaveClass(/jp-mod-open/);
  await expect(dropna).toHaveClass(/jp-mod-found/);
  await expect(chips(page).locator('.jp-Epi-aitag')).toHaveCount(0);
  // The tooltip of the view: the value and the call (the facts are in the popover, chips.spec.ts).
  expect(await dropna.getAttribute('title')).toBeNull();
  await dropna.hover();
  await expect(page.locator('.jp-Epi-tooltip div')).toHaveText([
    'dropna = True',
    'parameter dropna of DataFrame.groupby, line 1'
  ]);
  await page.mouse.move(2, 2);

  // One request per function, with the signature and no code of the notebook.
  // The store of kept answers starts empty: found-defaults-value.spec.ts
  // takes out the answers it keeps, among them one about DataFrame.
  const functions = asked.map(body => body.function.name);
  expect(functions.sort()).toEqual([
    'DataFrame',
    'DataFrame.groupby',
    'DataFrame.merge'
  ]);
  const groupby = asked.find(
    body => body.function.name === 'DataFrame.groupby'
  );
  // The default of More questions: the fast model of the connected provider.
  expect(groupby.model).toBe('remote:fast');
  expect(groupby.function.library).toBe('pandas');
  expect(groupby.function.params).toContainEqual({
    name: 'dropna',
    default: 'True'
  });
  expect(groupby.function).not.toHaveProperty('calls');
  // Nothing of the notebook: its names, its code or its data. The review
  // guard's object tells the server the notebook's columns, and the server
  // keeps it: no model reads it.
  expect(JSON.stringify(asked.map(withoutGuard))).not.toMatch(
    /names|totals|second/
  );
  // The server was asked first for the answers it kept, with the same signatures.
  expect(lookups[0].functions.map((f: any) => f.name).sort()).toEqual(
    functions
  );

  // The chip asks its questions as the view's own chips do.
  await dropna.click();
  await expect(
    page.locator('.jp-Epi-popover .jp-Epi-option .jp-Epi-option-text').first()
  ).toHaveText('What if dropna were False?');
  await page.keyboard.press('Escape');

  // Off again: the chips of before, and the answers stay for the page.
  await findDefaults(page, false);
  await expect(chips(page)).toHaveText(['inner join']);
  await findDefaults(page, true);
  await expect(chips(page)).toHaveText([
    'inner join',
    'dropna True',
    'sort True'
  ]);
  expect(asked).toHaveLength(3);
});

test('shows the answers that the server kept without a model, and asks none while no model is connected', async ({
  page,
  tmpPath
}) => {
  await status(page, false);
  const { asked } = await fakeModel(page);
  // The server kept an answer about groupby from an earlier notebook.
  await page.route(/\/whybook\/defaults(\?|$)/, async route => {
    const body = route.request().postDataJSON();
    const groupby = body.functions.find(
      (f: any) => f.name === 'DataFrame.groupby'
    );
    await route.fulfill({
      json: {
        answers: groupby
          ? [
              {
                function: groupby.function,
                library: groupby.library,
                version: groupby.version,
                picks: [{ param: 'dropna', why: DROPNA }],
                by: BY
              }
            ]
          : []
      }
    });
  });
  const file = `${tmpPath}/kept.ipynb`;
  await newNotebook(page, file, CELLS);
  const lookup = page.waitForResponse(/\/whybook\/defaults(\?|$)/);
  await openAndRun(page, file);
  await lookup;
  await expect(chips(page)).toHaveText(['inner join', 'dropna True'], {
    timeout: 60000
  });
  // The view asks after the lookup, in the same task: nothing was asked.
  expect(asked).toEqual([]);
});

test('says in the settings editor that the setting waits for a connected model', async ({
  page
}) => {
  await status(page, false);
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('settingeditor:open', {
      query: 'Whybook'
    });
  });
  const box = page.locator('#jp-Epi-settings-findDefaults');
  // The editor lists the plugins that match; the view's settings open on a click.
  const entry = page
    .locator('.jp-PluginList-entry', { hasText: 'Whybook' })
    .first();
  await expect(box.or(entry).first()).toBeVisible({ timeout: 30000 });
  if (!(await box.isVisible())) {
    await entry.click();
  }
  // On by default.
  await expect(box).toBeChecked({ timeout: 30000 });
  const field = page.locator('.jp-Epi-finddefaultsfield');
  await expect(field.locator('.jp-Epi-finddefaults-note')).toHaveText(
    'Waits for a connected model: connect one in the AI models panel.'
  );
  // The name once, on the box, and the description once, under it.
  const form = page.locator('.jp-SettingsForm', { has: box });
  await expect(
    form.getByText('Find more defaults with AI', { exact: true })
  ).toHaveCount(1);
  await expect(
    form.getByText(/^When a cell runs, the AI model of More questions reads/)
  ).toHaveCount(1);
  await box.uncheck();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const settings = (window as any).jupyterapp.serviceManager.settings;
        return (await settings.fetch('whybook:plugin')).raw;
      })
    )
    .toContain('"findDefaults": false');
});

test('shows the name of the selected variable alone in the head of Contents', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/contents.ipynb`;
  await newNotebook(page, file, [CELLS[0]]);
  await openAndRun(page, file);
  const variable = page.locator('.jp-Epi-variable[data-variable="df"]');
  await expect(variable).toBeVisible({ timeout: 60000 });
  const head = page.locator('#epi-contents-section .jp-Epi-section-head');
  // With nothing selected, Contents has no head: its title names it.
  await expect(head).toBeHidden();
  await variable.click();
  // The head is the name alone, with no "of" before it.
  await expect(head).toBeVisible();
  await expect(head).toHaveText('df', { useInnerText: true });
  await expect(head.locator('code')).toHaveText('df');
});
