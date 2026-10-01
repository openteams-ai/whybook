/**
 * Questions about the notebook itself, a prototype of design iterations
 * 1.67 to 1.70 in the plugin `whybook:checkup`, against the built
 * extension.
 *
 * - The Check-up line at the end of the Exploration panel (1.68, D): folded,
 *   with no note before the first check-up; open, what the rules find, with
 *   no model and no run; then the day of the check-up.
 * - "What would a reviewer ask?": one call to the model of More questions,
 *   only on Ask, whose questions are answered as the view's others are.
 * - "Compare with statsmodels" in the menu of a cell that calls
 *   scikit-learn (1.68, C2): a branch that a model writes.
 * - The setting "Questions about the notebook" takes all of it away.
 * - The Check-up's icon on a notebook's tab (1.68, A3), on the tabs of
 *   Whybook views by default while the Check-up is on; the Check-up
 *   itself is off by default. checkupicon.spec.ts checks the icon itself,
 *   and the outline of the Check-up that the tab opens.
 *
 * No model is called: each test answers the model's routes itself, or the
 * fixture aborts them.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';
import type { Locator, Route } from '@playwright/test';

import { expect, test } from './fixtures';

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

/** A notebook of these code cells, with ids `cell-0` and on. */
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
    metadata: { kernelspec: KERNELSPEC },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

/** Open a notebook in a view: the Whybook view, or JupyterLab's notebook view. */
async function open(
  page: IJupyterLabPageFixture,
  file: string,
  factory = 'Whybook'
): Promise<void> {
  await page.evaluate(
    async ([file, factory]) => {
      await (window as any).jupyterapp.commands.execute('docmanager:open', {
        path: file,
        factory
      });
    },
    [file, factory]
  );
  if (factory === 'Whybook') {
    await expect(page.locator('.jp-Epi-bench').first()).toBeVisible();
    await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0);
  }
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

/**
 * Wait until every code cell of the current view has run, no job runs, and
 * the kernel is idle.
 */
async function ran(page: IJupyterLabPageFixture): Promise<void> {
  await page.waitForFunction(
    () => {
      const widget = (window as any).jupyterapp.shell.currentWidget;
      const model = widget?.content?.model;
      if (!model?.codeCells) {
        return false;
      }
      return (
        model.codeCells().every((cell: any) => cell.count !== null) &&
        model.jobs.jobs.every(
          (job: any) => job.status !== 'running' && job.status !== 'queued'
        ) &&
        widget.context.sessionContext.session?.kernel?.status === 'idle'
      );
    },
    null,
    { timeout: 180000, polling: 200 }
  );
}

async function runAll(page: IJupyterLabPageFixture): Promise<void> {
  await page.locator('.jp-Epi-runall').click();
  await ran(page);
}

/**
 * Wait until the view lists these variables of the kernel: it reads the
 * kernel a moment after the runs, and the rules read what it lists.
 */
async function listed(
  page: IJupyterLabPageFixture,
  names: string[]
): Promise<void> {
  await page.waitForFunction(
    (names: string[]) => {
      const model = (window as any).jupyterapp.shell.currentWidget?.content
        ?.model;
      const live = new Set(
        (model?.variables() ?? [])
          .filter((variable: any) => !variable.stale)
          .map((variable: any) => variable.name)
      );
      return names.every(name => live.has(name));
    },
    names,
    { timeout: 60000, polling: 200 }
  );
}

/** The items of a menu that show, by their labels. */
function shownItems(menu: Locator): Locator {
  return menu.locator('.lm-Menu-item:not(.lm-mod-hidden) .lm-Menu-itemLabel');
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

/** Answer a model's route with these events: `requests` holds each request's body. */
async function answer(
  page: IJupyterLabPageFixture,
  path: RegExp,
  events: unknown[]
): Promise<{ requests: any[] }> {
  const requests: any[] = [];
  await page.route(path, async (route: Route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: events.map(event => JSON.stringify(event)).join('\n') + '\n'
    });
  });
  return { requests };
}

function checkup(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-exploration .jp-Epi-checkup');
}

/** The day as the note of the Check-up gives it: "30 Sep". */
function today(): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ];
  const now = new Date();
  return `${now.getDate()} ${months[now.getMonth()]}`;
}

/** The cell's menu, the one of its ⋯ button, as its item labels. */
async function cellMenu(
  page: IJupyterLabPageFixture,
  cellId: string
): Promise<Locator> {
  const card = page.locator(
    `.jp-Epi-bench .jp-Epi-cell[data-cell-id="${cellId}"]`
  );
  await card.scrollIntoViewIfNeeded();
  await card.locator('.jp-Epi-cellmenu').click();
  const menu = page.locator('.lm-Menu').last();
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * A small analysis with what each rule finds: a frame that no later cell
 * uses, a slow cell, a column merged into a model's data and left out of
 * its formula, and a model whose residuals no cell reads.
 */
const ANALYSIS = [
  'import time\nimport pandas as pd\nimport statsmodels.formula.api as smf',
  'panel = pd.DataFrame({"protein": [1.0, 2.0, 3.0]})',
  'time.sleep(1.5)\nvisits = pd.DataFrame({"patient_id": [1, 1, 2, 2, 3, 3], "week": [1, 2, 1, 2, 1, 2], "pain": [3.0, 2.5, 4.0, 3.5, 5.0, 4.1]})',
  'patients = pd.DataFrame({"patient_id": [1, 2, 3], "age": [40, 50, 61], "height": [170, 181, 165]})',
  'model_data = visits.merge(patients[["patient_id", "age", "height"]], on="patient_id", how="left")\nfit = smf.ols("pain ~ week + age", data=model_data).fit()\nfit.params'
];

// The Check-up is off by default ("Questions about the notebook"): the
// tests of this file turn it on, and those of a describe that sets its own
// settings turn it on again there.
test.use({
  mockSettings: {
    ...galata.DEFAULT_SETTINGS,
    'whybook:checkup': { enabled: true }
  }
});

test.describe('By default', () => {
  test.use({ mockSettings: galata.DEFAULT_SETTINGS });

  test('shows no Check-up and puts no icon on any tab', async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/plain.ipynb`;
    await newNotebook(page, file, ['x = 1']);
    await open(page, file);
    await expect(page.locator('.jp-Epi-exploration')).toBeVisible();
    await expect(checkup(page)).toHaveCount(0);
    await expect(page.locator('.lm-TabBar-tab[data-whybook-ask]')).toHaveCount(
      0
    );
  });
});

test('folds the Check-up at the end of the Exploration panel, with no note before the first; open, it shows what the rules find, and keeps the day', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/analysis.ipynb`;
  await newNotebook(page, file, ANALYSIS);
  await open(page, file);
  await runAll(page);
  await listed(page, ['panel', 'visits', 'patients', 'model_data', 'fit']);
  const section = checkup(page);
  const head = section.locator('.jp-Epi-checkup-head');
  await expect(head).toHaveText('Check-up');
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(section.locator('.jp-Epi-checkup-body')).toHaveCount(0);
  // The name sits at the start of the line, after the caret and the icon of
  // the Check-up, with no note after it.
  const name = head.getByText('Check-up', { exact: true });
  const icon = head.locator('.jp-Epi-checkup-icon');
  const [headBox, iconBox, nameBox] = [
    (await head.boundingBox())!,
    (await icon.boundingBox())!,
    (await name.boundingBox())!
  ];
  expect(iconBox.x - headBox.x).toBeLessThan(24);
  expect(nameBox.x - (iconBox.x + iconBox.width)).toBeLessThan(8);
  // The Check-up is the last block of the panel.
  await expect(page.locator('.jp-Epi-exploration > :last-child')).toHaveClass(
    /jp-Epi-checkup/
  );

  // Run the cell of the frame again, and change the code of the patients
  // without a run: a run from the top would differ.
  const menu = await cellMenu(page, 'cell-1');
  await menu.getByText('Run', { exact: true }).click();
  await ran(page);
  await listed(page, ['panel', 'fit']);
  await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    for (let i = 0; i < model.cells.length; i++) {
      const cell = model.cells.get(i);
      if (cell.id === 'cell-3') {
        cell.sharedModel.setSource(
          `${cell.sharedModel.getSource()}\n# ages checked`
        );
      }
    }
  });

  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  const body = section.locator('.jp-Epi-checkup-body');
  await expect(body.locator('.jp-Epi-checkup-name')).toHaveText([
    'Reproduce',
    'Speed',
    'Review',
    'Gaps'
  ]);
  const found = body.locator('.jp-Epi-checkup-found li');
  // The slowest cell is the sleep of [3], or the imports of [1] when a busy
  // machine takes more than 1.5 s to import pandas and statsmodels; the
  // sleep is named either way, first or as the second slowest.
  await expect(found).toContainText([
    '[6] ran after 3 cells below it, such as [3].',
    '[4] changed after it ran: its outputs come from older code.',
    /^The last runs of 4 of the 5 cells took \d+\.\d s\. \[[13]\] .+ took \d+\.\d s of it \(\d+%\)\.$/,
    '[5] fits fit, a linear model, and no cell reads its residuals.',
    'panel is made in [6], and no later cell uses it.'
  ]);
  expect((await found.allTextContents()).join('\n')).toMatch(
    /\[3\] “time\.sleep\(1\.5\)” took \d+\.\d s/
  );
  await expect(body).toContainText(
    'height is merged into model_data in [5], and left out of its formula.'
  );
  // The rules ran no cell: the counts are as they were.
  await expect(
    page
      .locator(
        '.jp-Epi-bench .jp-Epi-cell[data-cell-id="cell-4"] .jp-Epi-label'
      )
      .first()
  ).toHaveText('[5]');

  // A click on a line shows its cell.
  await body
    .locator('button.jp-Epi-checkup-line', { hasText: 'fits fit' })
    .click();
  await expect(
    page.locator('.jp-Epi-bench .jp-Epi-cell[data-cell-id="cell-4"]')
  ).toBeInViewport();

  // The notebook keeps the day and what the rules found; folded, the line
  // gives the day in grey.
  const kept = await page.evaluate(
    () =>
      (window as any).jupyterapp.shell.currentWidget.context.model.getMetadata(
        'whybook'
      ).checkup
  );
  expect(new Date(kept.last).toDateString()).toBe(new Date().toDateString());
  expect(kept.found).toContain(
    '[5] fits fit, a linear model, and no cell reads its residuals.'
  );
  await head.click();
  await expect(head.locator('.jp-Epi-section-count')).toHaveText(
    `last on ${today()}`
  );
});

test.describe('With answers of one cell, a reviewer', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:plugin': { answers: 'cell' },
      'whybook:checkup': { enabled: true }
    }
  });

  test('asks the model what a reviewer would ask only on Ask, and a question it asks is answered as the others are', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const review = await answer(page, /\/whybook\/questions\/review(\?|$)/, [
      { type: 'progress', stage: 'thinking', elapsed: 0.2 },
      {
        type: 'result',
        elapsed: 1.2,
        model: 'fake/model',
        cost_usd: 0.003,
        questions: [
          {
            id: 'review:1',
            text: 'Does the effect of week hold at each height?',
            type: 'model',
            cell: '[5]',
            why: 'Height is merged in and left out.'
          }
        ]
      }
    ]);
    const solve = await answer(page, /\/whybook\/solve(\?|$)/, [
      {
        type: 'result',
        elapsed: 0.4,
        model: 'fake/model',
        cell: {
          code: 'by_height = model_data.groupby("height")["pain"].mean()\nby_height',
          summary: 'Mean pain by height.',
          assumptions: [],
          follow_up: []
        }
      }
    ]);
    const file = `${tmpPath}/review.ipynb`;
    await newNotebook(page, file, ANALYSIS);
    await open(page, file);
    await runAll(page);
    await listed(page, ['fit']);
    const section = checkup(page);
    await section.locator('.jp-Epi-checkup-head').click();
    const card = section.locator('.jp-Epi-checkup-question', {
      hasText: 'What would a reviewer ask?'
    });
    await expect(card).toContainText(
      'A model reads the code of the cells, their titles and what their outputs show'
    );
    // Opening the check-up asks no model.
    expect(review.requests).toEqual([]);
    await card.getByRole('button', { name: 'Ask', exact: true }).click();
    const question = card.locator('.jp-Epi-checkup-asked', {
      hasText: 'Does the effect of week hold at each height?'
    });
    await expect(question).toBeVisible();
    await expect(question.locator('.jp-Epi-aitag')).toHaveCount(1);
    await expect(question.locator('.jp-Epi-next-why')).toHaveText(
      'About [5]. Height is merged in and left out.'
    );
    await expect(
      card.getByRole('button', { name: 'Ask again', exact: true })
    ).toBeVisible();
    expect(review.requests).toHaveLength(1);
    const sent = review.requests[0];
    // The default of More questions: the fast model of the connected provider.
    expect(sent.model).toBe('remote:fast');
    expect(sent.cells.map((cell: any) => cell.label)).toEqual([
      '[1]',
      '[2]',
      '[3]',
      '[4]',
      '[5]'
    ]);
    expect(sent.findings).toContain(
      '[5] fits fit, a linear model, and no cell reads its residuals.'
    );
    // One click asks it: a model writes the cell after [5], and it runs.
    await question
      .getByRole('button', {
        name: 'Ask: Does the effect of week hold at each height?'
      })
      .click();
    const added = page.locator('.jp-Epi-bench .jp-Epi-cell', {
      has: page.locator('.jp-Epi-title', {
        hasText: 'Does the effect of week hold at each height?'
      })
    });
    await expect(added).toBeVisible({ timeout: 60000 });
    await expect.poll(() => solve.requests.length).toBe(1);
    expect(solve.requests[0]).toMatchObject({
      question: { text: 'Does the effect of week hold at each height?' },
      placement: 'new'
    });
  });
});

test.describe('With answers of one cell', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:plugin': { answers: 'cell' },
      'whybook:checkup': { enabled: true }
    }
  });

  test('offers "Compare with statsmodels" in the menu of a cell that fits a model of scikit-learn, as a branch that a model writes', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const solve = await answer(page, /\/whybook\/solve(\?|$)/, [
      {
        type: 'result',
        elapsed: 0.4,
        model: 'fake/model',
        cell: {
          code: 'import statsmodels.formula.api as smf\nlogit_fit = smf.logit("y ~ x", data=frame).fit(disp=False)\nlogit_fit.params',
          summary: 'The same model with statsmodels.',
          assumptions: [],
          follow_up: []
        }
      }
    ]);
    const file = `${tmpPath}/sklearn.ipynb`;
    await newNotebook(page, file, [
      'import pandas as pd\nfrom sklearn.linear_model import LogisticRegression\nframe = pd.DataFrame({"x": [0.1, 0.4, 0.5, 0.9, 1.2, 1.4, 1.9, 2.3], "y": [0, 0, 1, 0, 1, 0, 1, 1]})',
      'clf = LogisticRegression().fit(frame[["x"]], frame["y"])\nclf.coef_'
    ]);
    await open(page, file);
    await runAll(page);
    // The first cell calls no model: its menu has no comparison.
    let menu = await cellMenu(page, 'cell-0');
    await expect(shownItems(menu).first()).toHaveText('Ask about this cell');
    await expect(shownItems(menu).nth(1)).toHaveText('Run');
    await page.keyboard.press('Escape');
    menu = await cellMenu(page, 'cell-1');
    await expect(shownItems(menu).nth(1)).toHaveText(
      'Compare with statsmodels'
    );
    const texts = await shownItems(menu).allTextContents();
    // After "Ask about this cell", before "Run".
    expect(texts.slice(0, 3)).toEqual([
      'Ask about this cell',
      'Compare with statsmodels',
      'Run'
    ]);
    const item = menu.locator('.lm-Menu-item', {
      hasText: 'Compare with statsmodels'
    });
    await item.click();
    await expect.poll(() => solve.requests.length).toBe(1);
    expect(solve.requests[0]).toMatchObject({
      question: {
        text: 'Does Logit of statsmodels agree with LogisticRegression of sklearn?'
      },
      placement: 'branch',
      cell: { label: '[2]' }
    });
    const branch = page.locator('.jp-Epi-bench .jp-Epi-cell', {
      has: page.locator('.jp-Epi-title', {
        hasText:
          'Does Logit of statsmodels agree with LogisticRegression of sklearn?'
      })
    });
    await expect(branch.locator('.jp-Epi-label').first()).toHaveText('[2b]', {
      timeout: 60000
    });
  });
});

test.describe('With "Questions about the notebook" off', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:checkup': { enabled: false }
    }
  });

  test('shows no Check-up and no comparison', async ({ page, tmpPath }) => {
    const file = `${tmpPath}/off.ipynb`;
    await newNotebook(page, file, [
      'import pandas as pd\nfrom sklearn.linear_model import LogisticRegression\nframe = pd.DataFrame({"x": [0.1, 0.4, 0.5, 0.9], "y": [0, 0, 1, 1]})',
      'clf = LogisticRegression().fit(frame[["x"]], frame["y"])\nclf.coef_'
    ]);
    await open(page, file);
    await runAll(page);
    await expect(
      page.locator('.jp-Epi-exploration .jp-Epi-block-head', {
        hasText: 'Worth asking next'
      })
    ).toBeVisible();
    await expect(page.locator('.jp-Epi-checkup')).toHaveCount(0);
    const menu = await cellMenu(page, 'cell-1');
    await expect(shownItems(menu).first()).toHaveText('Ask about this cell');
    await expect(shownItems(menu).nth(1)).toHaveText('Run');
    await expect(
      shownItems(menu).filter({ hasText: 'Compare with' })
    ).toHaveCount(0);
  });
});

/** The tab of the main area with this label. */
function tab(page: IJupyterLabPageFixture, label: string): Locator {
  return page.locator(
    '#jp-main-dock-panel .lm-DockPanel-tabBar .lm-TabBar-tab',
    {
      has: page.locator('.lm-TabBar-tabLabel', { hasText: label })
    }
  );
}

/** The opacity of the Check-up's icon over a tab's icon, as drawn now. */
function askOpacity(icon: Locator): Promise<string> {
  return icon.evaluate(node => getComputedStyle(node, '::after').opacity);
}

test("with the Check-up on, puts its icon on the tab of a Whybook view, the setting's default, and not on JupyterLab's notebook view", async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/plain.ipynb`;
  const classic = `${tmpPath}/classic.ipynb`;
  await newNotebook(page, file, ['x = 1']);
  await newNotebook(page, classic, ['y = 2']);
  await open(page, file);
  await open(page, classic, 'Notebook');
  await expect(tab(page, 'plain.ipynb')).toHaveAttribute(
    'data-whybook-ask',
    'true'
  );
  await expect(tab(page, 'classic.ipynb')).toHaveCount(1);
  await expect(tab(page, 'classic.ipynb')).not.toHaveAttribute(
    'data-whybook-ask'
  );
});

test.describe("With the Check-up's icon on the tab off", () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:checkup': { enabled: true, tabQuestion: 'off' }
    }
  });

  test('marks no tab', async ({ page, tmpPath }) => {
    const file = `${tmpPath}/plain.ipynb`;
    await newNotebook(page, file, ['x = 1']);
    await open(page, file);
    await expect(tab(page, 'plain.ipynb')).toHaveCount(1);
    await expect(page.locator('.lm-TabBar-tab[data-whybook-ask]')).toHaveCount(
      0
    );
  });
});

test.describe("With the Check-up's icon on the tabs of Whybook views", () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:checkup': { enabled: true, tabQuestion: 'whybook' }
    }
  });

  test("turns the tab's icon into the Check-up's while the pointer is on the tab, with the label still, and a click on it opens the Check-up", async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/tabs.ipynb`;
    await newNotebook(page, file, ['x = 1']);
    await page.contents.uploadContent(
      'print(1)\n',
      'text',
      `${tmpPath}/notes.py`
    );
    await open(page, file);
    await page.evaluate(async (path: string) => {
      await (window as any).jupyterapp.commands.execute('docmanager:open', {
        path
      });
    }, `${tmpPath}/notes.py`);
    const view = tab(page, 'tabs.ipynb');
    await expect(view).toHaveAttribute('data-whybook-ask', 'true');
    // Another file has no ?.
    await expect(tab(page, 'notes.py')).not.toHaveAttribute('data-whybook-ask');
    const icon = view.locator('.lm-TabBar-tabIcon');
    await expect.poll(() => askOpacity(icon)).toBe('0');
    const label = view.locator('.lm-TabBar-tabLabel');
    const before = await label.boundingBox();
    await view.hover();
    await expect.poll(() => askOpacity(icon)).toBe('1');
    expect(await label.boundingBox()).toEqual(before);
    // The file's tab is current: a pointer down on the icon opens the view's
    // Check-up, without the tab bar moving the tab.
    await expect(tab(page, 'notes.py')).toHaveClass(/lm-mod-current/);
    const box = (await icon.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(checkup(page).locator('.jp-Epi-checkup-head')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(view).toHaveClass(/lm-mod-current/);
    // The view's own Check-up opened: no second view of the notebook.
    await expect(tab(page, 'tabs.ipynb')).toHaveCount(1);
  });
});

test.describe("With the Check-up's icon on every notebook's tab", () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:checkup': { enabled: true, tabQuestion: 'notebooks' }
    }
  });

  test("marks JupyterLab's notebook view too, whose icon opens the notebook's Whybook view on its Check-up", async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/classic.ipynb`;
    await newNotebook(page, file, ['x = 1']);
    await open(page, file, 'Notebook');
    const notebookTab = tab(page, 'classic.ipynb');
    await expect(notebookTab).toHaveAttribute('data-whybook-ask', 'true');
    await expect(page.locator('.jp-Epi-bench')).toHaveCount(0);
    await notebookTab.hover();
    const icon = notebookTab.locator('.lm-TabBar-tabIcon');
    await expect.poll(() => askOpacity(icon)).toBe('1');
    const box = (await icon.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('.jp-Epi-bench')).toBeVisible();
    await expect(checkup(page).locator('.jp-Epi-checkup-head')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(tab(page, 'classic.ipynb')).toHaveCount(2);
  });
});
