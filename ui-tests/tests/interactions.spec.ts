/**
 * Pointer and menu interactions of the view (design iteration 1.77), in the
 * browser against the built extension: Click mode, a file dropped on a card, scrolling during a drag,
 * the minimap, a model's card, JupyterLab's Kernel menu, the quick look's
 * preview and a box on a plot. jest checks each of them in jsdom too
 * (src/__tests__/interactions.spec.tsx).
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

// Most tests run the cells of their notebook in a kernel first.
test.describe.configure({ timeout: 180000 });

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

/** A code cell of a notebook that a test writes. */
function code(
  id: string,
  source: string,
  outputs: object[] = [],
  count: number | null = null
): object {
  return {
    cell_type: 'code',
    execution_count: count,
    id,
    metadata: {},
    outputs,
    source
  };
}

/** Write a notebook with these cells. */
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

/** Write a notebook of code cells with the ids `cell-0`, `cell-1` and so on. */
async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  sources: string[]
): Promise<void> {
  await writeNotebook(
    page,
    file,
    sources.map((source, index) => code(`cell-${index}`, source))
  );
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
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0);
}

/** Wait for the kernel of the current view to start. */
async function kernelIdle(page: IJupyterLabPageFixture): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

/** Run every cell, and wait for the kernel's variables to list these. */
async function runAll(
  page: IJupyterLabPageFixture,
  names: string[]
): Promise<void> {
  await page.locator('.jp-Epi-runall').click();
  await page.sidebar.openTab('epi-variables');
  for (const name of names) {
    await expect(
      page.locator(`.jp-Epi-variable[data-variable="${name}"]`)
    ).toBeVisible({ timeout: 120000 });
  }
}

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

/** Ask by clicking, from the toggle of the Questions section. */
async function clickMode(page: IJupyterLabPageFixture): Promise<void> {
  await page
    .locator('.jp-Epi-questions .jp-Epi-toggle [data-value="click"]')
    .click();
}

/** A row of Contents: the column of this name. */
function column(page: IJupyterLabPageFixture, name: string): Locator {
  return page
    .locator('.jp-Epi-contents .jp-Epi-column')
    .filter({ has: page.locator('.jp-Epi-item-name', { hasText: name }) })
    .first();
}

/** The file in the file browser, with the test's folder open. */
async function fileItem(
  page: IJupyterLabPageFixture,
  tmpPath: string,
  name: string
): Promise<Locator> {
  await page.sidebar.openTab('filebrowser');
  await page.filebrowser.refresh();
  const file = page.locator('.jp-DirListing-item', { hasText: name }).first();
  if (!(await file.isVisible())) {
    // The tree file browser shows the test's folder closed.
    await page
      .locator('.jp-DirListing-item', { hasText: tmpPath })
      .first()
      .click();
  }
  await expect(file).toBeVisible();
  return file;
}

/** Start a Lumino drag of a file of the file browser: it starts once the pointer moves a few pixels. */
async function startFileDrag(
  page: IJupyterLabPageFixture,
  file: Locator
): Promise<void> {
  const from = (await file.boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y + from.height / 2 + 10, {
    steps: 5
  });
}

const FRAME =
  'import pandas as pd\nvisits = pd.DataFrame({"patient_id": ["P1", "P1", "P2", "P2"], "week": [1, 2, 1, 2], "crp": [1.5, 2.0, 0.5, 0.7], "dose": [100, 150, 200, 200]})';

test.describe('Click mode', () => {
  test('shows a variable clicked, picks a column, and opens the questions once, beside the target', async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/click.ipynb`;
    await newNotebook(page, file, [FRAME, 'visits.describe()']);
    await openInWhybook(page, file);
    await kernelIdle(page);
    await clickMode(page);
    await runAll(page, ['visits']);
    const questions = page.locator('.jp-Epi-questions');

    // A click on the variable shows its columns, and picks nothing.
    await page.locator('.jp-Epi-variable[data-variable="visits"]').click();
    await expect(column(page, 'week')).toBeVisible();
    await expect(questions.locator('.jp-Epi-picked')).toHaveCount(0);
    await expect(page.locator('.jp-Epi-dropzone')).toHaveCount(0);

    // A column picks; a second column asks, in a popover beside it.
    await column(page, 'week').click();
    await expect(questions.locator('.jp-Epi-picked')).toContainText(
      'week → pick a target'
    );
    const target = column(page, 'crp');
    const box = (await target.boundingBox())!;
    await target.click();
    await expect(popover(page)).toBeVisible();
    await expect(popover(page).locator('.jp-Epi-ask-head code')).toContainText(
      'week'
    );
    // Beside the target: the popover starts where the click was, to its right.
    const opened = (await popover(page).boundingBox())!;
    expect(opened.x).toBeGreaterThanOrEqual(box.x);
    expect(opened.y).toBeLessThan(box.y + box.height);
    // Once: the Questions section keeps its instructions.
    await expect(questions.locator('.jp-Epi-ask-block')).toHaveCount(0);
    await expect(questions.locator('.jp-Epi-instructions')).toBeVisible();
    await popover(page).locator('.jp-Epi-close').first().click();
    await expect(popover(page)).toHaveCount(0);
  });

  test('picks a whole variable from Pick in Contents, and a card from a click on its title', async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/clicktitle.ipynb`;
    await newNotebook(page, file, [FRAME, 'visits.describe()']);
    await openInWhybook(page, file);
    await kernelIdle(page);
    await clickMode(page);
    await runAll(page, ['visits']);
    await page.locator('.jp-Epi-variable[data-variable="visits"]').click();
    await page.locator('.jp-Epi-contents-pick').click();
    await expect(
      page.locator('.jp-Epi-questions .jp-Epi-picked')
    ).toContainText('visits → pick a target');
    const title = page.locator(
      '.jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-cell-head .jp-Epi-title'
    );
    await title.click();
    await expect(popover(page).locator('.jp-Epi-ask-head code')).toHaveText(
      'visits onto [2]'
    );
    await expect(
      page.locator('.jp-Epi-questions .jp-Epi-ask-block')
    ).toHaveCount(0);
  });
});

test('outlines the card under a file dragged over its table, says where the drop goes, and asks about the file with the card', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    'tariff,period,eur_per_kwh\nflat,all,0.30\ntou,peak,0.45\n',
    'text',
    `${tmpPath}/tariffs.csv`
  );
  const file = `${tmpPath}/droptable.ipynb`;
  await newNotebook(page, file, [
    `${FRAME}\npd.crosstab(visits.patient_id, visits.week)`
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await runAll(page, ['visits']);
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-0"]');
  const table = card.locator('.jp-Epi-tableoutput table').first();
  await expect(table).toBeVisible({ timeout: 60000 });

  const item = await fileItem(page, tmpPath, 'tariffs.csv');
  await startFileDrag(page, item);
  // Over the table, from one cell of it to the next: the card stays the target.
  const cells = table.locator('td');
  const first = (await cells.first().boundingBox())!;
  const last = (await cells.last().boundingBox())!;
  await page.mouse.move(first.x + 4, first.y + 4, { steps: 12 });
  await page.mouse.move(last.x + 4, last.y + 4, { steps: 6 });
  await expect(card).toHaveClass(/jp-mod-filedrop/);
  await expect(card.locator('.jp-Epi-filedrop-note')).toHaveText(
    'Drop tariffs.csv on [1]'
  );
  await page.mouse.up();
  await expect(popover(page).locator('.jp-Epi-ask-head code')).toHaveText(
    'tariffs.csv onto [1]'
  );
  await expect(card).not.toHaveClass(/jp-mod-filedrop/);
});

test.describe('Scrolling during a drag', () => {
  test('scrolls Contents while a column is dragged to its top edge, so it reaches a column out of sight', async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/scrollcols.ipynb`;
    await newNotebook(page, file, [
      'import pandas as pd\nwide = pd.DataFrame({f"c{i:02d}": [i, i + 1] for i in range(40)})'
    ]);
    await openInWhybook(page, file);
    await kernelIdle(page);
    await runAll(page, ['wide']);
    // Contents tall enough for its list of columns, as the analyst would
    // make it: the list scrolls, and the section around it does not.
    await page.evaluate(() => {
      const left = Array.from(
        (window as any).jupyterapp.shell.widgets('left') as any[]
      ).find(widget => widget.id === 'epi-variables');
      left.accordionPanel.setRelativeSizes([0.15, 0.7, 0.15]);
    });
    await page.locator('.jp-Epi-variable[data-variable="wide"]').click();
    const list = page.locator('.jp-Epi-contents .jp-Epi-list.jp-mod-virtual');
    await expect(list).toBeVisible();
    // The list at its end, as after a search: the last column in sight.
    await list.evaluate(node => {
      node.scrollTop = node.scrollHeight;
    });
    const source = column(page, 'c39');
    await expect(source).toBeInViewport();
    const scrollTop = () => list.evaluate(node => node.scrollTop);
    const top = await scrollTop();
    const from = (await source.boundingBox())!;
    const edge = (await list.boundingBox())!;
    await page.mouse.move(from.x + 30, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + from.height / 2 - 6, {
      steps: 5
    });
    // Near the top edge of the list. A browser sends a dragover about every
    // 50 ms while the pointer rests; the test moves the pointer a pixel at a
    // time to the same effect.
    await page.mouse.move(edge.x + 60, edge.y + 6, { steps: 10 });
    for (let i = 0; i < 400 && (await scrollTop()) > 0; i++) {
      await page.mouse.move(edge.x + 60 + (i % 2), edge.y + 6);
    }
    expect(top).toBeGreaterThan(0);
    expect(await scrollTop()).toBe(0);
    // Down to the first column, now in sight, and dropped on it.
    const target = (await column(page, 'c00').boundingBox())!;
    await page.mouse.move(target.x + 60, target.y + target.height / 2, {
      steps: 5
    });
    await page.mouse.up();
    await expect(popover(page).locator('.jp-Epi-ask-head code')).toContainText(
      'c39'
    );
    await expect(popover(page).locator('.jp-Epi-ask-head code')).toContainText(
      'c00'
    );
  });

  test('scrolls the bench while a file from the file browser rests near its bottom edge', async ({
    page,
    tmpPath
  }) => {
    await page.contents.uploadContent(
      'a,b\n1,2\n',
      'text',
      `${tmpPath}/more.csv`
    );
    const file = `${tmpPath}/scrollbench.ipynb`;
    await newNotebook(
      page,
      file,
      Array.from({ length: 24 }, (_, index) => `x${index} = ${index}`)
    );
    await openInWhybook(page, file);
    const main = page.locator('.jp-Epi-main');
    await expect(main).toBeVisible();
    const before = await main.evaluate(node => node.scrollTop);
    const item = await fileItem(page, tmpPath, 'more.csv');
    await startFileDrag(page, item);
    const box = (await main.boundingBox())!;
    // A Lumino drag sends no event while the pointer rests: the bench goes on
    // scrolling all the same.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8, {
      steps: 12
    });
    await expect
      .poll(() => main.evaluate(node => node.scrollTop))
      .toBeGreaterThan(before + 200);
    await page.keyboard.press('Escape');
    await page.mouse.up();
  });
});

test.describe('With the minimap on', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:plugin': { minimap: true }
    }
  });

  test('keeps the minimap clear of the cards on a wide bench', async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/minimap.ipynb`;
    await newNotebook(
      page,
      file,
      Array.from(
        { length: 12 },
        (_, index) => `print("${'a long line of text '.repeat(8)}${index}")`
      )
    );
    await openInWhybook(page, file);
    const minimap = page.locator('.jp-Epi-minimap');
    await expect(minimap).toBeVisible();
    await expect(page.locator('.jp-Epi-bench')).toHaveClass(/jp-mod-gutter/);
    // The dock that holds it adds no height to the bench.
    const dock = (await page.locator('.jp-Epi-minimap-dock').boundingBox())!;
    expect(dock.height).toBe(0);
    const map = (await minimap.boundingBox())!;
    const cards = page.locator('.jp-Epi-bench .jp-Epi-cell');
    const count = await cards.count();
    for (let index = 0; index < count; index++) {
      const card = await cards.nth(index).boundingBox();
      if (card) {
        expect(card.x + card.width).toBeLessThanOrEqual(map.x);
      }
    }
  });
});

// The outputs of the agent's mixed model in the pain tester's notebook:
// statsmodels warns twice, retries with lbfgs, and converges.
const WARNINGS = {
  output_type: 'stream',
  name: 'stderr',
  text:
    '/site-packages/statsmodels/regression/mixed_linear_model.py:2384: ConvergenceWarning: Maximum Likelihood optimization failed to converge. Check mle_retvals\n' +
    '  rslt = super().fit(\n' +
    '/tmp/ipykernel_1/384502019.py:5: ConvergenceWarning: Retrying MixedLM optimization with lbfgs\n' +
    '  fit = model.fit()\n'
};
const SUMMARY = {
  output_type: 'stream',
  name: 'stdout',
  text: [
    '             Mixed Linear Model Regression Results',
    '===============================================================',
    'Model:            MixedLM Dependent Variable: analgesic_dose_mg',
    'No. Observations: 1428    Method:             REML             ',
    'No. Groups:       318     Scale:              1792.9230        ',
    'Min. group size:  3       Log-Likelihood:     -7737.3083       ',
    'Max. group size:  6       Converged:          Yes              ',
    'Mean group size:  4.5                                          ',
    '---------------------------------------------------------------',
    '                  Coef.   Std.Err.   z    P>|z|  [0.025  0.975]',
    '---------------------------------------------------------------',
    'Intercept         207.787    4.101 50.665 0.000 199.749 215.826',
    'week                0.106    0.166  0.639 0.523  -0.220   0.432',
    'Group Var        3611.465   10.331                             ',
    'Group x week Cov   -2.202    0.297                             ',
    'week Var            0.159    0.016                             ',
    '==============================================================='
  ].join('\n')
};

test("folds the warnings of a fit that converged, and shows its summary on the model's card", async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/mixed.ipynb`;
  await writeNotebook(page, file, [
    code(
      'fit',
      'fit = model.fit()\nprint(fit.summary())',
      [WARNINGS, SUMMARY],
      11
    )
  ]);
  await openInWhybook(page, file);
  const card = page.locator('.jp-Epi-cell[data-cell-id="fit"]');
  const folded = card.locator('.jp-Epi-foldedwarnings');
  await expect(folded).toHaveText(
    '2 convergence warnings, then the fit converged'
  );
  await expect(card.locator('.jp-Epi-textoutput.jp-mod-stderr')).toHaveCount(0);
  await expect(card.locator('pre.jp-Epi-textoutput')).toContainText(
    'Converged:          Yes'
  );
  await expect(card.locator('.jp-Epi-logtile')).toHaveCount(0);
  await folded.click();
  await expect(card.locator('.jp-Epi-textoutput.jp-mod-stderr')).toContainText(
    'Retrying MixedLM optimization with lbfgs'
  );
});

test("lets JupyterLab's Kernel menu act on the Whybook view in front", async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/kernelmenu.ipynb`;
  await newNotebook(page, file, ['x = 1', 'y = x + 1']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  // The four items that were greyed out with the view in front.
  await page.menu.openLocator('Kernel');
  for (const label of [
    'Interrupt Kernel',
    'Restart Kernel…',
    'Restart Kernel and Run All Cells…',
    'Change Kernel…'
  ]) {
    const item = await page.menu.getMenuItemLocator(`Kernel>${label}`);
    expect(item).not.toBeNull();
    await expect(item!).not.toHaveClass(/lm-mod-disabled/);
  }
  await page.menu.clickMenuItem('Kernel>Restart Kernel and Run All Cells…');
  await page.locator('.jp-Dialog .jp-mod-accept').click();
  await expect(
    page.locator('.jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-label')
  ).toHaveText('[2]', { timeout: 60000 });
});

test("opens the quick look's preview under the tabs of the right panel, and fits it to the panel", async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/quicklook.ipynb`;
  await newNotebook(page, file, [FRAME]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await runAll(page, ['visits']);
  await page.locator('.jp-Epi-variable[data-variable="visits"]').click();
  // In Drag mode a click picks a column, and a second click asks about it alone.
  await column(page, 'dose').click();
  await column(page, 'dose').click();
  const summarise = popover(page).locator('.jp-Epi-option', {
    hasText: 'Summarise dose'
  });
  await summarise.click();
  const preview = page.locator('#epi-exploration .jp-Epi-right-preview');
  await expect(preview.locator('svg.jp-Epi-plot')).toBeVisible({
    timeout: 60000
  });
  // Under the tabs, above what they show.
  const tabs = (await page
    .locator('#epi-exploration .jp-Epi-tabs')
    .boundingBox())!;
  const shown = (await preview.boundingBox())!;
  expect(shown.y).toBeLessThan(tabs.y + tabs.height + 10);
  // As wide as the panel lets it be: no horizontal scroll bar.
  const plot = (await preview.locator('svg.jp-Epi-plot').boundingBox())!;
  expect(plot.x + plot.width).toBeLessThanOrEqual(shown.x + shown.width);
  // The panel and its parts around the preview are no wider than the panel.
  const overflow = await page
    .locator('#epi-exploration')
    .evaluate(node =>
      [
        node as HTMLElement,
        ...Array.from(
          node.querySelectorAll<HTMLElement>(
            '.jp-Epi-right, .jp-Epi-right-main, .jp-Epi-right-preview, .jp-Epi-preview'
          )
        )
      ]
        .filter(element => element.scrollWidth > element.clientWidth + 1)
        .map(element => element.className)
    );
  expect(overflow).toEqual([]);
});

test('ends a box on a plot at its edge when the pointer is released a few pixels past it', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/box.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\nimport whybook\ndf = pd.DataFrame({"x": range(20), "y": [v % 7 for v in range(20)]})',
    'whybook.scatter(df, "x", "y")'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const plot = page.locator(
    '.jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-plotout svg.jp-Epi-plot'
  );
  await expect(plot).toBeVisible({ timeout: 60000 });
  await plot.scrollIntoViewIfNeeded();
  const area = (await plot.boundingBox())!;
  // From the middle up past the plot's top edge by 4 px, as the tester did.
  await page.mouse.move(area.x + area.width * 0.3, area.y + area.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.9, area.y - 4, { steps: 12 });
  await page.mouse.up();
  const caption = popover(page).locator('.jp-Epi-caption', { hasText: 'rows' });
  await expect(caption).toHaveText(/^\d+ rows/, { timeout: 30000 });
  // The box reaches the top: the points at y = 6, the highest, are in it.
  const top = await page.evaluate(
    () =>
      (window as any).jupyterapp.shell.currentWidget.content.model.ask?.y?.[1]
  );
  expect(top).toBeGreaterThanOrEqual(6);
});
