/**
 * Cells, texts and outputs on the bench and in the Code view, as fixed on
 * 29 September (research/critique-3.md), in the browser against the built
 * extension. jest checks each of them in jsdom
 * too; the comment above each test names its item and what went wrong.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

// Most tests run the cells of their notebook in a kernel first.
test.describe.configure({ timeout: 120000 });

const PLOT_MIME = 'application/vnd.whybook.plot+json';

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

/** A markdown cell of a notebook that a test writes. */
function text(id: string, source: string): object {
  return { cell_type: 'markdown', id, metadata: {}, source };
}

/**
 * Write a notebook with these cells. The contents API takes an explicit
 * path; with the tree file browser, "new notebook" writes to another folder.
 */
async function writeNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  cells: object[],
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const notebook = {
    cells,
    metadata: { kernelspec: KERNELSPEC, ...metadata },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

/** Write a notebook of code cells with the ids `cell-0`, `cell-1` and so on. */
async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  sources: string[],
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await writeNotebook(
    page,
    file,
    sources.map((source, index) => code(`cell-${index}`, source)),
    metadata
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
  // While the file loads, the bench holds the loading cells alone.
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

/** Wait until no cell runs and no result strip is busy. */
async function idle(page: IJupyterLabPageFixture): Promise<void> {
  // The view draws a queued cell on the next frame after a click, so the
  // state counts as idle only once it has held for half a second.
  await page.evaluate(() => {
    (window as any).epiIdleSince = null;
  });
  await page.waitForFunction(
    () => {
      const state = window as any;
      const busy =
        !!document.querySelector('.jp-Epi-cell-actions button[disabled]') ||
        !!document.querySelector('.jp-Epi-strip .jp-mod-indeterminate');
      if (busy) {
        state.epiIdleSince = null;
        return false;
      }
      state.epiIdleSince = state.epiIdleSince ?? performance.now();
      return performance.now() - state.epiIdleSince > 500;
    },
    null,
    { timeout: 180000, polling: 100 }
  );
}

/**
 * Wait until the view has drawn the notebook as it is now. The view model
 * emits its change on the next animation frame after a change of a cell, and
 * React then draws in a task that it posts. A message posted in the frame
 * after that comes after React's task.
 */
async function drawn(page: IJupyterLabPageFixture): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => resolve();
            channel.port2.postMessage(null);
          })
        )
      )
  );
}

/**
 * An HTML5 drag. Chromium starts a drag only when the mouse moves in steps.
 */
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
  await page.mouse.move(to.x + to.width / 2, to.y + 30, { steps: 10 });
  await page.mouse.up();
}

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

/** The ids of the cells of the current notebook, in order. */
async function cellOrder(page: IJupyterLabPageFixture): Promise<string[]> {
  return page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const ids: string[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      ids.push(model.cells.get(i).id);
    }
    return ids;
  });
}

/** The source of a cell of the current notebook. */
async function sourceOf(
  page: IJupyterLabPageFixture,
  cellId: string
): Promise<string> {
  return page.evaluate(
    cellId =>
      (
        window as any
      ).jupyterapp.shell.currentWidget.context.model.sharedModel.cells
        .find((cell: any) => cell.id === cellId)
        .getSource(),
    cellId
  );
}

/**
 * Wait until the current request of questions has its answer, and the view
 * has drawn it. Once drawn, the questions take the keyboard focus, so a test
 * that moves the focus itself does so after this.
 */
async function questionsSettled(page: IJupyterLabPageFixture): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).jupyterapp.shell.currentWidget.content.model.ask
              ?.loading
        ),
      { timeout: 30000 }
    )
    .toBe(false);
  await drawn(page);
}

/**
 * The questions of the current request once it has its answer: the rows it
 * is about and the options, as the popover shows them.
 */
async function questionsShown(
  page: IJupyterLabPageFixture
): Promise<{ caption: string; options: string[] }> {
  await questionsSettled(page);
  const caption = popover(page).locator('.jp-Epi-caption').first();
  await expect(caption).toBeVisible();
  return {
    caption: (await caption.textContent()) ?? '',
    options: await popover(page).locator('.jp-Epi-option').allTextContents()
  };
}

/** Press Tab until `target` has the focus, at most `limit` times. */
async function tabTo(
  page: IJupyterLabPageFixture,
  target: Locator,
  limit = 10
): Promise<boolean> {
  for (let press = 0; press < limit; press++) {
    await page.keyboard.press('Tab');
    // Tab moves the focus as it is pressed, before the press resolves.
    if (await target.evaluate(node => node === document.activeElement)) {
      return true;
    }
  }
  return false;
}

/**
 * A frame with an outcome, and a model of it: a column dropped onto the
 * model's cell offers questions that templates answer.
 */
const MODEL_CELLS = [
  'import pandas as pd\nimport statsmodels.formula.api as smf\ndf = pd.DataFrame({"y": [1.0, 2, 3, 4, 5, 7, 8, 9], "x": [1, 2, 3, 4, 5, 6, 7, 8], "z": [3, 1, 4, 1, 5, 9, 2, 6]})',
  'data = df.dropna()',
  'fit = smf.ols("y ~ x", data=data).fit()\nfit.params'
];

// Item 1: the bench and the Code view drew a markdown cell as trusted, so an
// event handler written in the text of a notebook from elsewhere ran.
test('runs no event handler of a text from a notebook that nobody trusted, on the bench or in the Code view', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/received.ipynb`;
  await writeNotebook(page, file, [
    text(
      'intro',
      '# A notebook from elsewhere\n\nThe data are in the table below.\n\n<img src="missing.png" onerror="window.__whybookRan = 1">\n'
    ),
    code('c1', 'x = 1')
  ]);
  // The picture's file does not exist, so the browser fires its error event,
  // whose handler the text holds. A listener on the window counts these
  // events in each view. It gets each event on its way to the picture, so
  // once the count grows, the picture's own handler has had its turn.
  await page.evaluate(() => {
    const state = window as any;
    state.pictureErrors = { bench: 0, linear: 0 };
    window.addEventListener(
      'error',
      event => {
        const target = event.target;
        if (target instanceof HTMLImageElement) {
          const view = target.closest('.jp-Epi-bench, .jp-Epi-linear');
          if (view && target.closest('.jp-Epi-note')) {
            state.pictureErrors[
              view.classList.contains('jp-Epi-bench') ? 'bench' : 'linear'
            ]++;
          }
        }
      },
      true
    );
  });
  const errors = (view: 'bench' | 'linear') =>
    page.evaluate(view => (window as any).pictureErrors[view], view);
  const ran = () => page.evaluate(() => (window as any).__whybookRan ?? null);

  await openInWhybook(page, file);
  const note = page.locator('.jp-Epi-bench .jp-Epi-note[data-cell-id="intro"]');
  await expect(note).toContainText('The data are in the table below.');
  await expect.poll(() => errors('bench')).toBeGreaterThanOrEqual(1);
  expect(await ran()).toBeNull();
  // JupyterLab's sanitizer keeps the picture and drops its handler.
  await expect(note.locator('img')).toHaveCount(1);
  await expect(note.locator('img')).not.toHaveAttribute('onerror');

  // The Code view draws the same text, heading and all.
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  const linear = page.locator(
    '.jp-Epi-linear .jp-Epi-note[data-cell-id="intro"]'
  );
  await expect(linear).toContainText('The data are in the table below.');
  await expect.poll(() => errors('linear')).toBeGreaterThanOrEqual(1);
  expect(await ran()).toBeNull();
  await expect(linear.locator('img')).not.toHaveAttribute('onerror');
});

// Item 19: a heading of level one after the title started no section, so a
// notebook that uses # for each section showed one section, "Notebook".
test('starts a section at every heading after the title, on the bench and on the map', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/sections.ipynb`;
  await writeNotebook(page, file, [
    text('title', '# Pain diary study'),
    text('load', '# Load'),
    code('diary', 'diary = {"week": [1, 2, 3], "pain": [5, 4, 3]}'),
    text('weekly', '# Weekly means'),
    code('means', 'means = sum(diary["pain"]) / 3'),
    text('model', '# Model'),
    code('fit', 'fit = means * 2')
  ]);
  await openInWhybook(page, file);
  const bench = page.locator('.jp-Epi-bench');
  await expect(bench.locator('.jp-Epi-nbtitle')).toHaveText('Pain diary study');
  const heads = bench.locator('.jp-Epi-sectionhead');
  await expect(heads.locator('.jp-Epi-sectiontitle')).toHaveText([
    'Load',
    'Weekly means',
    'Model'
  ]);
  await expect(heads.locator('.jp-Epi-label')).toHaveText(['§1', '§2', '§3']);
  // Each section holds the cell under its heading.
  const blocks = bench.locator('.jp-Epi-sectionblock');
  await expect(blocks.nth(0).locator('.jp-Epi-cell')).toHaveAttribute(
    'data-cell-id',
    'diary'
  );
  await expect(blocks.nth(1).locator('.jp-Epi-cell')).toHaveAttribute(
    'data-cell-id',
    'means'
  );
  await expect(blocks.nth(2).locator('.jp-Epi-cell')).toHaveAttribute(
    'data-cell-id',
    'fit'
  );

  // The map has a band for each section.
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await expect(page.locator('.jp-Epi-map-band span')).toHaveText([
    '§1 Load',
    '§2 Weekly means',
    '§3 Model'
  ]);
});

// Item 19: a text whose words were all deleted lost its card at once, and
// with it the editor in which the analyst was typing.
test('keeps the card and the editor of a text while its words are deleted', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/texts.ipynb`;
  await writeNotebook(page, file, [
    text('results', '## Results'),
    code('fit', 'fit = 1'),
    text('drop', 'Pain drops after week 3.'),
    text('week6', '### Week 6\nPain stays low after week 6.'),
    code('low', 'low = 2')
  ]);
  await openInWhybook(page, file);
  const bench = page.locator('.jp-Epi-bench');

  // A text of its own: every word goes.
  const drop = bench.locator('.jp-Epi-note[data-cell-id="drop"]');
  await drop.locator('.jp-Epi-note-text').dblclick();
  await expect(drop.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await expect.poll(() => sourceOf(page, 'drop')).toBe('');
  await drawn(page);
  await expect(drop).toHaveCount(1);
  await expect(drop.locator('.cm-content')).toBeFocused();
  // Done closes the editor, and a text with no words has no card.
  await drop.getByRole('button', { name: 'Done' }).click();
  await expect(drop).toHaveCount(0);

  // A text under its own heading: the words under the heading go.
  const week6 = bench.locator('.jp-Epi-note[data-cell-id="week6"]');
  await week6.locator('.jp-Epi-note-text').dblclick();
  await expect(week6.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Backspace');
  await expect.poll(() => sourceOf(page, 'week6')).toBe('### Week 6\n');
  await drawn(page);
  await expect(week6).toHaveCount(1);
  await expect(week6.locator('.cm-content')).toBeFocused();
  await week6.getByRole('button', { name: 'Done' }).click();
  await expect(week6).toHaveCount(0);
  // The heading still starts its section.
  await expect(
    bench.locator('.jp-Epi-sectionhead', { hasText: 'Week 6' })
  ).toBeVisible();
});

// Item 8: Undo of an answer deleted the cell that the answer added, with the
// lines that the analyst had typed in it since, and asked nothing.
test('asks before Undo of an answer removes what the analyst typed in its cell', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/undo.ipynb`;
  await newNotebook(page, file, MODEL_CELLS, { whybook: { outcome: 'y' } });
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const target = page.locator('.jp-Epi-cell[data-cell-id="cell-2"]');
  await expect(target.locator('.jp-Epi-label')).toHaveText('[3]', {
    timeout: 60000
  });
  await idle(page);

  // A column dropped on the model's cell, and a question that a template
  // answers, so no model is called.
  await page.locator('.jp-Epi-variable[data-variable="df"]').click();
  await drag(
    page,
    page.locator('.jp-Epi-column', { hasText: 'z' }).first(),
    target
  );
  await popover(page)
    .locator('.jp-Epi-option', { hasText: 'Is z associated with y here?' })
    .click();
  const strip = target.locator('.jp-Epi-strip');
  await expect(strip.locator('.jp-Epi-strip-action')).toHaveText(
    /^Added \[\d+\] after \[3\]$/,
    { timeout: 60000 }
  );
  await idle(page);
  const cells = await cellOrder(page);
  expect(cells.slice(0, 3)).toEqual(['cell-0', 'cell-1', 'cell-2']);
  expect(cells).toHaveLength(4);
  const added = cells[3];
  const card = page.locator(`.jp-Epi-cell[data-cell-id="${added}"]`);
  const label = (await card.locator('.jp-Epi-label').textContent())!;
  expect(label).toMatch(/^\[\d+\]$/);

  // The analyst types a line in the cell that the answer added.
  await card
    .locator('.jp-Epi-cell-actions button', { hasText: 'Show code' })
    .click();
  await card.locator('.cm-line').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('\nmine = 1');
  await expect.poll(() => sourceOf(page, added)).toContain('mine = 1');

  // Undo asks first, in one line of the strip, which takes the focus.
  const undo = strip.getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  const question = strip.locator('.jp-Epi-undoask');
  await expect(question.locator('.jp-Epi-capnote-text')).toHaveText(
    `You changed ${label} since this answer. Undo removes your changes too.`
  );
  await expect(question.getByRole('button')).toHaveText([
    'Undo anyway',
    'Keep'
  ]);
  await expect(question).toBeFocused();

  // Keep leaves the line, and gives the focus back to Undo.
  await question.getByRole('button', { name: 'Keep' }).click();
  await expect(question).toHaveCount(0);
  await expect(undo).toBeFocused();
  expect(await sourceOf(page, added)).toContain('mine = 1');
  expect(await cellOrder(page)).toEqual(cells);

  // Undo anyway removes the cell, and the card of the cell that the answer
  // was about takes the focus.
  await undo.click();
  await question.getByRole('button', { name: 'Undo anyway' }).click();
  await expect.poll(() => cellOrder(page)).toEqual(cells.slice(0, 3));
  await expect(card).toHaveCount(0);
  await expect(strip).toHaveCount(0);
  await expect(target).toBeFocused();
});

// Item 22: a plot had no keyboard path: Tab passed over it, and only a
// pointer could ask about a bar.
test('reaches a plot with Tab, marks a bar with the arrow keys, and asks about it with Enter as a click does', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/bars.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\nimport whybook\ntrial = pd.DataFrame({"arm": ["A", "A", "B", "B", "C", "C"], "pain": [3.0, 4.0, 5.0, 6.0, 2.0, 3.0]})',
    'whybook.bars(trial, "arm", "pain")'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-1"]');
  const plot = card.locator('svg.jp-Epi-plot');
  await expect(plot).toBeVisible({ timeout: 60000 });
  // The questions about a bar read its rows in the kernel.
  await expect(
    page.locator('.jp-Epi-variable[data-variable="trial"]')
  ).toBeVisible({ timeout: 60000 });
  await idle(page);

  // From the buttons of the card, Tab reaches the plot, which names its keys.
  await card
    .locator('.jp-Epi-cell-actions button', { hasText: 'Show code' })
    .focus();
  expect(await tabTo(page, plot)).toBe(true);
  const status = card.locator('.jp-Epi-plot-status');
  await expect(status).toHaveText(
    'The arrow keys move between the bars, and Enter asks about one.'
  );
  // An arrow key marks the first bar, and the next one the second.
  // A bar of a mean gives the 95% interval of the mean (design iteration 1.85).
  await page.keyboard.press('ArrowRight');
  await expect(status).toHaveText(
    'arm A: 3.5, 95% interval -2.85 to 9.85 · 2 rows. Enter asks about it.'
  );
  await expect(plot.locator('.jp-Epi-plot-current')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(status).toHaveText(
    'arm B: 5.5, 95% interval -0.853 to 11.9 · 2 rows. Enter asks about it.'
  );

  // Enter asks about the bar: the questions open.
  await expect(popover(page)).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(popover(page)).toBeVisible();
  const byKey = await questionsShown(page);
  expect(byKey.caption).toMatch(/^2 rows/);
  expect(byKey.options.length).toBeGreaterThan(0);
  await popover(page).locator('.jp-Epi-close').click();
  await expect(popover(page)).toHaveCount(0);

  // A click on the same bar asks the same questions.
  await plot
    .locator('rect')
    .filter({ has: page.locator('title', { hasText: /^B: / }) })
    .click();
  await expect(popover(page)).toBeVisible();
  expect(await questionsShown(page)).toEqual(byKey);
});

// Item 22: the menu of the Ask button opened from the keyboard with the focus
// left on its caret, where no key moved into the menu.
test('opens the menu of the Ask button from the keyboard on the place chosen, and gives the focus back to its caret', async ({
  page,
  tmpPath
}) => {
  // The status says a model is set up, so that the Ask button has its menu.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  const file = `${tmpPath}/menu.ipynb`;
  await newNotebook(page, file, ['x = 1', 'y = 2']);
  await openInWhybook(page, file);
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await page.locator('.jp-Epi-map-cell').first().click();
  // The questions take the focus when their answer comes, which would take
  // it from the caret.
  await questionsSettled(page);
  const box = popover(page).locator('.jp-Epi-ownbox');
  // "What if" chooses a branch, which is not the first place of the menu.
  await box.locator('input').fill('What if x were 2?');
  const caret = box.locator('.jp-Epi-split-toggle');
  const menu = page.locator('.jp-Epi-placemenu');
  // The places, and the exploration in parallel when there is one.
  const items = menu.locator('button');
  const chosen = menu.locator('[aria-checked="true"]');

  // Enter on the caret opens the menu, with the focus on the place chosen.
  await caret.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(chosen).toBeFocused();
  const places = await items.count();
  const at = await items.evaluateAll(buttons =>
    buttons.findIndex(button => button.getAttribute('aria-checked') === 'true')
  );
  expect(places).toBeGreaterThan(1);
  expect(at).toBeGreaterThan(0);
  // The arrow keys move through the places.
  await page.keyboard.press('ArrowDown');
  await expect(items.nth((at + 1) % places)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(chosen).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.nth(at - 1)).toBeFocused();
  // Escape closes the menu, and the caret takes the focus back.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(caret).toBeFocused();
  await expect(box).toBeVisible();

  // The down arrow on the caret opens the menu the same way.
  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeVisible();
  await expect(chosen).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(caret).toBeFocused();
});

// Item 21: Escape in the editor of a text closed the editor with the focus
// in it, and the focus fell to the page's body.
test('gives the focus to the Edit button of a text after Escape in its editor', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/escape.ipynb`;
  await writeNotebook(page, file, [
    text('results', '## Results'),
    code('fit', 'fit = 1'),
    text('drop', 'Pain drops after week 3.')
  ]);
  await openInWhybook(page, file);

  // On the bench, a double-click opens the editor.
  const note = page.locator('.jp-Epi-bench .jp-Epi-note[data-cell-id="drop"]');
  await note.locator('.jp-Epi-note-text').dblclick();
  await expect(note.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(note.locator('.jp-Epi-note-text')).toContainText(
    'Pain drops after week 3.'
  );
  await expect(note.locator('.jp-Epi-note-edit')).toBeFocused();

  // In the Code view, the Edit button opens it.
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  const linear = page.locator(
    '.jp-Epi-linear .jp-Epi-note[data-cell-id="drop"]'
  );
  await linear.hover();
  await linear.locator('.jp-Epi-note-edit').click();
  await expect(linear.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(linear.locator('.jp-Epi-note-text')).toContainText(
    'Pain drops after week 3.'
  );
  await expect(linear.locator('.jp-Epi-note-edit')).toBeFocused();
});

// Item 35: an output that threw while it drew took the whole view with it.
test('says in its place that an output could not be drawn, and draws the rest of the view', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/broken.ipynb`;
  // A payload with no x axis: the plot reads the type of its x axis.
  const payload = {
    version: 1,
    kind: 'scatter',
    title: 'pain by week',
    y: { field: 'pain', label: 'pain' },
    source: { frame: 'weekly', x: 'week', y: 'pain', by: null, rows: 2 },
    select: 'xy',
    points: [
      { x: 1, y: 4, g: null, i: 0 },
      { x: 2, y: 3, g: null, i: 1 }
    ]
  };
  await writeNotebook(page, file, [
    text('title', '# A plot of another version'),
    code(
      'plot',
      'whybook.scatter(weekly, "week", "pain")',
      [
        {
          output_type: 'display_data',
          metadata: {},
          data: {
            [PLOT_MIME]: payload,
            'text/plain': '<whybook scatter: pain by week>'
          }
        }
      ],
      1
    ),
    code(
      'after',
      'print("still drawn")',
      [{ output_type: 'stream', name: 'stdout', text: 'still drawn\n' }],
      2
    )
  ]);
  await page.evaluate(async (file: string) => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: file,
      factory: 'Whybook'
    });
  }, file);
  const plotCard = page.locator('.jp-Epi-cell[data-cell-id="plot"]');
  await expect(plotCard.locator('.jp-Epi-plotout .jp-Epi-error')).toHaveText(
    'This output could not be drawn'
  );
  // The rest of the view draws: the title, the other cell and its output.
  await expect(page.locator('.jp-Epi-bench .jp-Epi-nbtitle')).toHaveText(
    'A plot of another version'
  );
  await expect(
    page.locator('.jp-Epi-cell[data-cell-id="after"] .jp-Epi-textoutput')
  ).toHaveText('still drawn');
  // So does the map, with both cells.
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await expect(page.locator('.jp-Epi-map-cell')).toHaveCount(2);
});

// Items 15 and 16: dates went to the view as text, so a ribbon over a date
// column drew a path of NaN; and ticks were cut to two decimals, so ticks
// 0.002 apart read 0, 0, 0.01.
test('draws a ribbon over dates with dates on its axis, and gives each tick of small values its own label', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/axes.ipynb`;
  await writeNotebook(page, file, [
    code(
      'data',
      'import pandas as pd\nimport whybook\ndays = ["2024-01-01", "2024-01-01", "2024-01-02", "2024-01-02", "2024-01-03", "2024-01-03"]\ndiary = pd.DataFrame({"day": pd.to_datetime(days), "pain": [3, 4, 4, 5, 5, 6]})\nsites = pd.DataFrame({"site": ["A", "B", "C", "D"], "incidence": [0.002, 0.004, 0.006, 0.008]})'
    ),
    code('ribbon', 'whybook.ribbon(diary, "day", "pain")'),
    code('bars', 'whybook.bars(sites, "site", "incidence")')
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const ribbon = page.locator(
    '.jp-Epi-cell[data-cell-id="ribbon"] svg.jp-Epi-plot'
  );
  await expect(ribbon).toBeVisible({ timeout: 60000 });
  // The line goes through the mean of each day, and its band around it.
  await expect(ribbon.locator('path[fill="none"]')).toHaveAttribute(
    'd',
    /^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/
  );
  await expect(ribbon.locator('polygon')).not.toHaveAttribute('points', /NaN/);
  // The ticks are days, with the year by the axis label.
  const ticks = ribbon.locator('.jp-Epi-axis > text:not([class])');
  await expect(ticks).toHaveText(['Jan 1', 'Jan 2', 'Jan 3']);
  await expect(ribbon.locator('.jp-Epi-axis-label')).toHaveText('day (2024)');
  // The last tick, at the right edge, ends inside the plot.
  const whole = await ribbon.evaluate(svg => {
    const labels = svg.querySelectorAll('.jp-Epi-axis > text:not([class])');
    const last = labels[labels.length - 1].getBoundingClientRect();
    const box = svg.getBoundingClientRect();
    return last.left >= box.left && last.right <= box.right;
  });
  expect(whole).toBe(true);

  // Bars of 0.002 to 0.008: each tick of the value axis reads its own value.
  const bars = page.locator(
    '.jp-Epi-cell[data-cell-id="bars"] svg.jp-Epi-plot'
  );
  await expect(bars.locator('.jp-Epi-axis > g > text')).toHaveText([
    '0',
    '0.002',
    '0.004',
    '0.006',
    '0.008'
  ]);
});

// Item 7: the code of Keep selection cut the bounds of a brushed box to two
// decimals, so a box over p from 0.0012 to 0.0048 kept between(0, 0).
test('keeps the rows of a box brushed over small values, with its bounds at full precision in the code', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/region.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\nimport whybook\ndf = pd.DataFrame({"p": [0.001, 0.002, 0.003, 0.004, 0.02], "y": [1, 2, 3, 4, 5]})',
    'whybook.scatter(df, "p", "y")'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-1"]');
  const plot = card.locator('svg.jp-Epi-plot');
  await expect(plot).toBeVisible({ timeout: 60000 });
  const shape = (name: string) =>
    page.locator(
      `.jp-Epi-variable[data-variable^="${name}"] .jp-Epi-item-shape`
    );
  await expect(shape('df')).toHaveText('5 × 2', { timeout: 60000 });
  await idle(page);

  // A box from p = 0.0012 to 0.0048, over every value of y. The places of
  // those values on the page come from two ticks of the x axis, and the box
  // starts and ends outside the area of the marks, which holds it to that
  // area: from the lowest y to the highest.
  const corners = await plot.evaluate(svg => {
    const area = svg.querySelector(':scope > g') as SVGGraphicsElement;
    const ticks = Array.from(
      area.querySelectorAll('.jp-Epi-axis > text:not([class])')
    ).map(node => ({
      value: Number(node.textContent),
      x: Number(node.getAttribute('x'))
    }));
    const [a, b] = [ticks[0], ticks[ticks.length - 1]];
    const xOf = (value: number) =>
      a.x + ((value - a.value) * (b.x - a.x)) / (b.value - a.value);
    const bottom = Math.max(
      ...Array.from(area.querySelectorAll('.jp-Epi-axis > g')).map(group =>
        Number(
          /translate\(0,([^)]*)\)/.exec(group.getAttribute('transform')!)![1]
        )
      )
    );
    const matrix = area.getScreenCTM()!;
    const onPage = (x: number, y: number) => {
      const point = new DOMPoint(x, y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    };
    return {
      from: onPage(xOf(0.0012), -4),
      to: onPage(xOf(0.0048), bottom + 4)
    };
  });
  await page.mouse.move(corners.from.x, corners.from.y);
  await page.mouse.down();
  await page.mouse.move(corners.to.x, corners.to.y, { steps: 10 });
  await page.mouse.up();
  const caption = popover(page).locator('.jp-Epi-caption', { hasText: 'rows' });
  await expect(caption).toHaveText(/^3 rows/, { timeout: 30000 });
  const box = await page.evaluate(() => {
    const ask = (window as any).jupyterapp.shell.currentWidget.content.model
      .ask;
    return { x0: ask.x0, x1: ask.x1, y: ask.y };
  });
  expect(box.x0).toBeGreaterThan(0.001);
  expect(box.x0).toBeLessThan(0.002);
  expect(box.x1).toBeGreaterThan(0.004);
  expect(box.x1).toBeLessThan(0.02);
  expect(box.y).toEqual([1, 5]);

  // Keep selection adds a cell whose frame holds the same 3 of the 5 rows,
  // and its code keeps the bounds as brushed.
  await popover(page).locator('.jp-Epi-keep').click();
  await expect(shape('sel_p')).toHaveText('3 × 2', { timeout: 60000 });
  const kept = (await cellOrder(page))[2];
  expect(await sourceOf(page, kept)).toContain(
    `df["p"].between(${box.x0}, ${box.x1}) & df["y"].between(1, 5)`
  );
});

// Item 34: Undo of a delete put the cell back at its old index, which after
// another delete is the place of another cell.
test('puts a deleted cell back between its old neighbours after another delete', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/neighbours.ipynb`;
  await writeNotebook(page, file, [
    code('a', 'a = 1'),
    code('b', 'b = 2'),
    code('c', 'c = 3'),
    code('d', 'd = 4')
  ]);
  await openInWhybook(page, file);
  const remove = async (cellId: string) => {
    await page
      .locator(`.jp-Epi-cell[data-cell-id="${cellId}"] .jp-Epi-cellmenu`)
      .click();
    await page.locator('.lm-Menu-item', { hasText: /^Delete cell$/ }).click();
  };
  await remove('c');
  await expect.poll(() => cellOrder(page)).toEqual(['a', 'b', 'd']);
  await remove('a');
  await expect.poll(() => cellOrder(page)).toEqual(['b', 'd']);

  // The notice of the first delete undoes it: c goes back after b.
  await page
    .locator('.Toastify__toast', { hasText: 'c = 3' })
    .locator('.jp-toast-button', { hasText: 'Undo' })
    .click();
  await expect.poll(() => cellOrder(page)).toEqual(['b', 'c', 'd']);
  await expect
    .poll(() =>
      page
        .locator('.jp-Epi-bench .jp-Epi-cell')
        .evaluateAll(cards =>
          cards.map(card => card.getAttribute('data-cell-id'))
        )
    )
    .toEqual(['b', 'c', 'd']);
});

// Item 35: "Show in the view" did nothing for a cell in a collapsed section
// of the bench.
test('opens a collapsed section to show one of its cells, from Cell details and from the menu of a card on the map', async ({
  page,
  tmpPath
}) => {
  // Four sections of four cells, twelve printed lines each: the bench scrolls.
  const lines = Array.from({ length: 12 }, (_, line) => `line ${line}\n`);
  const cells: object[] = [];
  for (let part = 1; part <= 4; part++) {
    cells.push(text(`part-${part}`, `## Part ${part}`));
    for (let step = 0; step < 4; step++) {
      cells.push(
        code(
          `p${part}-${step}`,
          `# Step ${part}.${step}\nprint("step")`,
          [{ output_type: 'stream', name: 'stdout', text: lines }],
          4 * part + step
        )
      );
    }
  }
  const file = `${tmpPath}/parts.ipynb`;
  await writeNotebook(page, file, cells);
  await openInWhybook(page, file);
  const bench = page.locator('.jp-Epi-bench');
  const head = bench.locator('.jp-Epi-sectionhead', { hasText: 'Part 4' });
  const card = bench.locator('.jp-Epi-cell[data-cell-id="p4-2"]');
  const toTop = () =>
    page.locator('.jp-Epi-main').evaluate(main => (main.scrollTop = 0));

  // A click makes the cell the current one, which Cell details show.
  await card.locator('.jp-Epi-title').click();
  await page
    .locator('#epi-exploration')
    .getByRole('tab', { name: 'Cell details' })
    .click();
  await expect(
    page.locator('#epi-exploration .jp-Epi-details-head')
  ).toContainText('Step 4.2');
  // Its section is collapsed, and the bench is back at its top.
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(card).toHaveCount(0);
  await toTop();

  // "Show in the view" opens the section and brings the card into sight.
  await page
    .locator('#epi-exploration .jp-Epi-details-links button', {
      hasText: 'Show in the view'
    })
    .click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toBeInViewport();

  // So does "Show on the bench" in the menu of the cell's card on the map.
  await head.click();
  await expect(card).toHaveCount(0);
  await toTop();
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await page.locator('.jp-Epi-map-zoom button', { hasText: 'Fit' }).click();
  await page
    .locator('.jp-Epi-map-cell[data-cell-id="p4-2"]')
    .click({ button: 'right' });
  await page
    .locator('.lm-Menu-item', { hasText: /^Show on the bench$/ })
    .click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toBeInViewport();
});

// Item 35: a pin was kept by the place of its output in the list, so a run
// that printed a line before the table pinned the printed line.
test('keeps the pin of an output on that output after its cell runs again and prints before it', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/pin.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\nruns = globals().get("runs", 0) + 1\nif runs > 1:\n    print("Loaded 3 rows")\npd.DataFrame({"a": [1, 2, 3], "b": [4, 5, 6]})'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-0"]');
  await expect(card.locator('.jp-Epi-label')).toHaveText('[1]', {
    timeout: 60000
  });
  await idle(page);
  const kinds = () =>
    page.evaluate(() => {
      const cell = (
        window as any
      ).jupyterapp.shell.currentWidget.context.model.cells.get(0);
      const found: string[] = [];
      for (let i = 0; i < cell.outputs.length; i++) {
        found.push(cell.outputs.get(i).type);
      }
      return found;
    });
  expect(await kinds()).toEqual(['execute_result']);

  // At Overview every table is a tile, and a click on a tile pins its table
  // under the card.
  const slider = page.locator('.jp-Epi-detail input');
  await slider.fill('0');
  await card.locator('.jp-Epi-tabletile').click();
  const pinned = card.locator('.jp-Epi-pinned');
  await expect(pinned.locator('table')).toBeVisible();

  // The cell runs again, and prints a line before its table.
  await card.locator('.jp-Epi-cell-actions button', { hasText: 'Run' }).click();
  await expect(card.locator('.jp-Epi-label')).toHaveText('[2]', {
    timeout: 60000
  });
  await expect.poll(kinds).toEqual(['stream', 'execute_result']);
  await expect(pinned.locator('table')).toBeVisible();
  await expect(pinned).not.toContainText('Loaded 3 rows');
});
