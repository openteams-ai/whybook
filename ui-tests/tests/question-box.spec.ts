/**
 * A question box that grows with the question (design iteration 1.90), and
 * a template's answer that the bench brings into view (1.93), in the
 * browser against the built extension.
 *
 * - The box of "Your own question" wraps the question and grows with it, a
 *   line at a time, up to four lines, and then scrolls: in the popover of a
 *   click or a drop, in "Worth asking next", under the follow-ups of a cell
 *   and in the checklist of Alt+drop. Enter asks, Shift+Enter branches,
 *   Alt+Enter explores in parallel, no key adds a line, and the Ask button
 *   keeps its width when the place changes its word.
 * - After a template is picked from a drop in the Whybook panel, its new
 *   cell goes right after a cell whose card ends below the fold, and comes
 *   into view with its strip and its outputs. An edit in place leaves the
 *   view where it is, and the strip of an agent's run comes into view.
 *
 * No model is called: the fixture aborts the model routes, and a test that
 * needs a model's answer answers its route itself.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

// The tests run cells in a kernel.
test.describe.configure({ timeout: 180000 });

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as any).jupyterapp.serviceManager.sessions.shutdownAll();
  });
});

/** The longest question that the demo video of 7 October typed, 124 characters. */
const LONG =
  'Effect of qsmk on wt82_71 in kg, adjusted for sex, race, age, education, smokeintensity, smokeyrs, exercise, active and wt71';

// A frame like the NHEFS data of the demo video: whether a person quit
// smoking, and their weight change in kg.
const MAKE = [
  'import numpy as np',
  'import pandas as pd',
  '',
  'rng = np.random.default_rng(0)',
  'n = 400',
  'nhefs = pd.DataFrame({',
  '    "seqn": np.arange(n),',
  '    "qsmk": rng.integers(0, 2, n),',
  '    "age": rng.integers(25, 75, n),',
  '    "wt82_71": rng.normal(2.5, 7.5, n).round(2),',
  '})',
  'nhefs.head()'
].join('\n');

// The quick look of wt82_71 that the demo kept as a cell: a plot and a table.
const LOOK =
  'import whybook\n\nwhybook.hist(nhefs, "wt82_71")\nwhybook.summary(nhefs, "wt82_71")';

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

/** One line of the box, with its padding and border, and four lines. */
const ONE_LINE = 30;
const FOUR_LINES = 90;

/** A notebook of these code cells, with ids `cell-0` and on. */
async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  cells: { source: string; meta?: Record<string, unknown> }[]
): Promise<void> {
  const notebook = {
    cells: cells.map((cell, index) => ({
      cell_type: 'code',
      execution_count: null,
      id: `cell-${index}`,
      metadata: cell.meta ? { whybook: cell.meta } : {},
      outputs: [],
      source: cell.source
    })),
    metadata: { kernelspec: KERNELSPEC },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
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
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

/**
 * Wait until every code cell of the view has run, no job and no agent's
 * run goes on, and the kernel is idle.
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
        model.agentRuns.every(
          (run: any) => run.state !== 'starting' && run.state !== 'working'
        ) &&
        widget.context.sessionContext.session?.kernel?.status === 'idle'
      );
    },
    null,
    { timeout: 120000, polling: 200 }
  );
}

async function runAll(page: IJupyterLabPageFixture): Promise<void> {
  await page.locator('.jp-Epi-runall').click();
  await ran(page);
}

/** The status says that a model is set up, so the box takes text; no model runs. */
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

/** A stream of newline-delimited JSON events, as the server sends them. */
function ndjson(events: object[]): string {
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

/**
 * The field of "Your own question", by its role, which a one-line input
 * and a textarea both have: the tests of an edit in place and of an
 * agent's run also run on a build whose box is one line.
 */
function ownField(within: Locator): Locator {
  return within.getByRole('textbox', { name: 'Your own question' });
}

/** A column of a frame in the Whybook panel. */
function column(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator('#epi-variables .jp-Epi-column').filter({
    has: page.locator('.jp-Epi-item-name', { hasText: new RegExp(`^${name}$`) })
  });
}

/** A card of the bench, by its title. */
function card(page: IJupyterLabPageFixture, title: string): Locator {
  return page.locator('.jp-Epi-bench .jp-Epi-cell').filter({
    has: page.locator(':scope > .jp-Epi-cell-head .jp-Epi-title', {
      hasText: title
    })
  });
}

/** An HTML5 drag. Chromium starts a drag only when the mouse moves in steps. */
async function drag(
  page: IJupyterLabPageFixture,
  source: Locator,
  target: Locator,
  options: { alt?: boolean } = {}
): Promise<void> {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 5, {
    steps: 5
  });
  if (options.alt) {
    await page.keyboard.down('Alt');
  }
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 10
  });
  await page.mouse.up();
  if (options.alt) {
    await page.keyboard.up('Alt');
  }
}

/** The columns of nhefs in the Whybook panel, as a click on the frame lists them. */
async function showColumns(page: IJupyterLabPageFixture): Promise<void> {
  await page
    .locator('#epi-variables .jp-Epi-variable[data-variable="nhefs"]')
    .click();
  await expect(column(page, 'qsmk')).toBeVisible();
}

/** The height of an element, in CSS pixels. */
async function heightOf(locator: Locator): Promise<number> {
  return locator.evaluate(node =>
    Math.round(node.getBoundingClientRect().height)
  );
}

/** Record each height that the box of `selector` takes from now on. */
async function recordHeights(
  page: IJupyterLabPageFixture,
  selector: string
): Promise<void> {
  await page.evaluate(selector => {
    const node = document.querySelector(selector)!;
    const seen: number[] = [];
    (window as any).epiHeights = seen;
    new ResizeObserver(() =>
      seen.push(Math.round(node.getBoundingClientRect().height))
    ).observe(node);
  }, selector);
}

async function recordedHeights(
  page: IJupyterLabPageFixture
): Promise<number[]> {
  return page.evaluate(() => [...(window as any).epiHeights]);
}

/** Whether the whole element shows in the scrolled area of the view. */
async function inView(
  page: IJupyterLabPageFixture,
  locator: Locator
): Promise<boolean> {
  const box = await locator.boundingBox();
  const view = await page.locator('.jp-Epi-main').boundingBox();
  return (
    !!box &&
    !!view &&
    box.y >= view.y - 1 &&
    box.y + box.height <= view.y + view.height + 1
  );
}

/** Record each scroll that the view asks of the page from now on. */
async function recordScrolls(page: IJupyterLabPageFixture): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as any).epiScrolls = seen;
    const scrollTo = Element.prototype.scrollTo;
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollTo = function (this: Element, ...args: any[]) {
      if (this.closest('.jp-Epi-main') || this.matches('.jp-Epi-main')) {
        seen.push('scrollTo');
      }
      return (scrollTo as any).apply(this, args);
    };
    Element.prototype.scrollIntoView = function (
      this: Element,
      ...args: any[]
    ) {
      if (this.closest('.jp-Epi-main')) {
        seen.push(`scrollIntoView ${this.className}`);
      }
      return (scrollIntoView as any).apply(this, args);
    };
  });
}

async function recordedScrolls(
  page: IJupyterLabPageFixture
): Promise<string[]> {
  return page.evaluate(() => [...(window as any).epiScrolls]);
}

test.describe('1.90 a question box that grows with the question', () => {
  test('wraps a long question in the popover and grows with it a line at a time, up to four lines, then scrolls', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const file = `${tmpPath}/grow.ipynb`;
    await newNotebook(page, file, [{ source: 'x = 21' }]);
    await openInWhybook(page, file);
    await runAll(page);
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    await page.locator('.jp-Epi-map-cell').first().click();
    const box = popover(page).locator('.jp-Epi-ownbox');
    const field = box.locator('textarea');
    const outer = box.locator('.jp-Epi-own-field');
    await expect(field).toBeEnabled();
    await expect(field).toHaveAttribute('placeholder', 'Your own question');
    // One line, as JupyterLab's input.
    expect(await heightOf(outer)).toBe(ONE_LINE);

    await recordHeights(page, '.jp-Epi-popover .jp-Epi-own-field');
    await field.click();
    await page.keyboard.type(LONG);
    await expect(field).toHaveValue(LONG);
    await expect.poll(() => heightOf(outer)).toBeGreaterThan(ONE_LINE);
    // A line at a time, 20 px each, and never back while the text grows.
    const grown = await recordedHeights(page);
    expect(grown.length).toBeGreaterThan(1);
    for (const [index, height] of grown.entries()) {
      expect((height - ONE_LINE) % 20).toBe(0);
      expect(height).toBeLessThanOrEqual(FOUR_LINES);
      if (index > 0) {
        expect(height).toBeGreaterThanOrEqual(grown[index - 1]);
      }
    }

    // Past four lines the box stops growing, and its text scrolls.
    await page.keyboard.type(` In the second sentence: ${LONG}`);
    await expect.poll(() => heightOf(outer)).toBe(FOUR_LINES);
    expect(
      await field.evaluate(node => node.scrollHeight > node.clientHeight)
    ).toBe(true);
    // The question is one paragraph: no line break, only the text typed.
    expect(await field.inputValue()).not.toContain('\n');

    // The microphone and the Ask button stay level with the first line.
    const fieldBox = (await outer.boundingBox())!;
    const voice = (await box.locator('.jp-Epi-voice').boundingBox())!;
    const ask = (await box.locator('button[type="submit"]').boundingBox())!;
    expect(voice.y + voice.height / 2 - fieldBox.y).toBeCloseTo(
      ONE_LINE / 2,
      0
    );
    expect(ask.y + ask.height / 2 - fieldBox.y).toBeCloseTo(ONE_LINE / 2, 0);
  });

  test('keeps its height and the width of the Ask button when the place changes the word of the button', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const file = `${tmpPath}/place.ipynb`;
    await newNotebook(page, file, [{ source: 'x = 21' }]);
    await openInWhybook(page, file);
    await runAll(page);
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    await page.locator('.jp-Epi-map-cell').first().click();
    const box = popover(page).locator('.jp-Epi-ownbox');
    const field = box.locator('textarea');
    const outer = box.locator('.jp-Epi-own-field');
    const button = box.locator('button[type="submit"]');
    // "What if" chooses a branch: the button says so.
    await field.fill(
      'What if x were 22, and the cells after it ran again with that value?'
    );
    await expect(box.locator('.jp-Epi-own-meta')).toContainText('branch of');
    await expect(button).toHaveText('Branch');
    const before = {
      height: await heightOf(outer),
      width: (await outer.boundingBox())!.width,
      button: (await button.boundingBox())!.width
    };
    expect(before.height).toBeGreaterThan(ONE_LINE);
    // A new cell, picked in the menu of the Ask button: the word changes,
    // and the box and the button keep their sizes.
    await box.locator('.jp-Epi-split-toggle').click();
    await page
      .locator('.jp-Epi-placemenu button', { hasText: /^New cell after/ })
      .click();
    await expect(button).toHaveText('Ask');
    await expect(box.locator('.jp-Epi-own-meta')).toContainText(
      'new cell after'
    );
    expect(await heightOf(outer)).toBe(before.height);
    expect((await outer.boundingBox())!.width).toBe(before.width);
    expect((await button.boundingBox())!.width).toBe(before.button);
  });

  test('grows in Worth asking next, under the follow-ups of a cell, and in the checklist of Alt+drop', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const file = `${tmpPath}/places.ipynb`;
    await newNotebook(page, file, [
      {
        source: 'x = 21',
        meta: {
          title: 'x = 21',
          follow_up: [{ text: 'Is x ever negative?', type: 'quality' }]
        }
      }
    ]);
    await openInWhybook(page, file);
    await runAll(page);
    const grows = async (box: Locator, text: string) => {
      const field = box.locator('textarea');
      const outer = box.locator('.jp-Epi-own-field');
      await expect(field).toBeEnabled();
      expect(await heightOf(outer)).toBe(ONE_LINE);
      await field.fill(text);
      await expect.poll(() => heightOf(outer)).toBeGreaterThan(ONE_LINE);
      expect(await heightOf(outer)).toBeLessThanOrEqual(FOUR_LINES);
      await field.fill('');
      await expect.poll(() => heightOf(outer)).toBe(ONE_LINE);
    };
    // Worth asking next, in the narrow panel at the right.
    await grows(page.locator('#epi-exploration .jp-Epi-ownbox'), LONG);
    // Under the follow-ups of the cell, as wide as the card.
    await grows(
      page.locator('.jp-Epi-bench .jp-Epi-followups .jp-Epi-ownbox'),
      `${LONG} ${LONG}`
    );
    // The checklist of Alt+drop.
    await drag(
      page,
      page.locator('.jp-Epi-variable[data-variable="x"]'),
      card(page, 'x = 21').locator(':scope > .jp-Epi-cell-head'),
      { alt: true }
    );
    const branch = popover(page).locator('.jp-Epi-ownbox');
    await expect(branch.locator('textarea')).toHaveAttribute(
      'placeholder',
      'Your own question, as one more branch'
    );
    await grows(branch, LONG);
  });

  test('asks on Enter, branches on Shift+Enter, explores in parallel on Alt+Enter, and no key adds a line', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    // The requests that the keys send: recorded, then aborted.
    const asked: { route: string; placement: unknown }[] = [];
    await page.route(/\/whybook\/(solve|agent)(\?.*)?$/, async route => {
      const request = route.request();
      asked.push({
        route: new URL(request.url()).pathname.replace(/.*\/whybook\//, ''),
        placement: request.postDataJSON()?.placement
      });
      await route.abort();
    });
    const file = `${tmpPath}/keys.ipynb`;
    await newNotebook(page, file, [
      { source: 'x = 21', meta: { title: 'x = 21' } }
    ]);
    await openInWhybook(page, file);
    await runAll(page);

    // Worth asking next: Ctrl+Enter and Alt+Enter ask nothing and add no
    // line; Shift+Enter asks, as Enter does where no branch is offered.
    const next = page.locator('#epi-exploration .jp-Epi-ownbox textarea');
    await next.fill('Is x ever negative?');
    await next.press('Control+Enter');
    await next.press('Alt+Enter');
    await expect(next).toHaveValue('Is x ever negative?');
    expect(asked).toEqual([]);
    await next.press('Shift+Enter');
    await expect.poll(() => asked.length).toBe(1);
    await expect(next).toHaveValue('');

    // The popover of a cell: Shift+Enter asks for a branch.
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    await page.locator('.jp-Epi-map-cell').first().click();
    const own = popover(page).locator('.jp-Epi-ownbox textarea');
    await own.fill('Is x large?');
    await own.press('Shift+Enter');
    await expect.poll(() => asked.length).toBe(2);
    expect(asked[1]).toEqual({ route: 'solve', placement: 'branch' });
    await page.locator('.jp-Epi-views [data-value="bench"]').click();

    // Alt+drop: Alt+Enter adds the question to the checklist of branches.
    await drag(
      page,
      page.locator('.jp-Epi-variable[data-variable="x"]'),
      card(page, 'x = 21').locator(':scope > .jp-Epi-cell-head'),
      { alt: true }
    );
    const branch = popover(page).locator('.jp-Epi-ownbox textarea');
    await expect(branch).toHaveAttribute(
      'placeholder',
      'Your own question, as one more branch'
    );
    await branch.fill('Is x even?');
    await branch.press('Alt+Enter');
    await expect(
      popover(page).locator('.jp-Epi-option.jp-mod-checked', {
        hasText: 'Is x even?'
      })
    ).toBeVisible();
    await expect(branch).toHaveValue('');
    expect(asked).toHaveLength(2);
  });
});

test.describe("1.93 the bench brings a template's answer into view", () => {
  /** [1] makes nhefs, and the tall card of [2] ends below the fold. */
  async function tallNotebook(page: IJupyterLabPageFixture, file: string) {
    await newNotebook(page, file, [
      { source: MAKE, meta: { title: 'Make nhefs', template: true } },
      {
        source: LOOK,
        meta: {
          title: 'Summarise wt82_71: distribution and missingness',
          template: true
        }
      }
    ]);
    await openInWhybook(page, file);
    await runAll(page);
    // The chips of the constants of [1] come with the kernel's analysis, a
    // moment after the run ends, and push [2] down: on CI, after `drag`
    // measured [2] and before it released the mouse.
    await expect(
      card(page, 'Make nhefs').locator('.jp-Epi-chip').first()
    ).toBeVisible();
    const look = card(page, 'Summarise wt82_71');
    await expect(look.locator('svg').first()).toBeVisible();
    // The view at its top, as after the answer of [2].
    await page.locator('.jp-Epi-main').evaluate(node => {
      node.scrollTop = 0;
    });
    const main = (await page.locator('.jp-Epi-main').boundingBox())!;
    const bottom = await look.evaluate(
      node => node.getBoundingClientRect().bottom
    );
    expect(bottom).toBeGreaterThan(main.y + main.height);
  }

  test('brings the new cell, its strip and its outputs into view, when the cell goes right after the cell asked about', async ({
    page,
    tmpPath
  }) => {
    await tallNotebook(page, `${tmpPath}/template.ipynb`);
    // qsmk dropped onto wt82_71 in the Whybook panel, as in the video.
    await showColumns(page);
    await drag(page, column(page, 'qsmk'), column(page, 'wt82_71'));
    await expect(popover(page)).toBeVisible();
    await popover(page)
      .locator('.jp-Epi-option', {
        hasText: 'Does wt82_71 differ between the levels of qsmk?'
      })
      .first()
      .click();
    const added = card(page, 'Does wt82_71 differ between the levels of qsmk?');
    await expect(added).toHaveCount(1);
    // Asked about [2], the last cell that uses wt82_71, it went right after it.
    const strip = page.locator('.jp-Epi-bench .jp-Epi-strip', {
      hasText: 'Does wt82_71 differ between the levels of qsmk?'
    });
    await expect(strip).toContainText('Added [3] after [2]');
    await ran(page);
    await expect(added.locator('table').first()).toBeVisible();
    await expect.poll(() => inView(page, strip)).toBe(true);
    await expect.poll(() => inView(page, added)).toBe(true);
  });

  test('leaves the view where it is for an edit in place', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    await page.route(/\/whybook\/solve/, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjson([
          {
            type: 'result',
            elapsed: 0.2,
            cell: {
              // The card stays as tall: the table is still the last output.
              code: LOOK.replace(
                'whybook.summary',
                'print(nhefs.wt82_71.isna().sum())\nwhybook.summary'
              ),
              summary: 'Counts the missing weight changes too.',
              assumptions: [],
              follow_up: []
            },
            model: 'a model'
          }
        ])
      })
    );
    await tallNotebook(page, `${tmpPath}/edit.ipynb`);
    await recordScrolls(page);
    const look = card(page, 'Summarise wt82_71');
    // qsmk dropped onto the head of [2], and a question typed that edits it.
    await showColumns(page);
    await drag(
      page,
      column(page, 'qsmk'),
      look.locator(':scope > .jp-Epi-cell-head')
    );
    const box = popover(page).locator('.jp-Epi-ownbox');
    const own = ownField(box);
    await own.fill('Add the count of missing values');
    await expect(box.locator('.jp-Epi-own-meta')).toContainText(
      'edit [2] in place'
    );
    await own.press('Enter');
    // The label follows the count of the cell's run.
    const strip = look.locator('.jp-Epi-strip');
    await expect(strip).toContainText(/Edited \[\d+\] in place/, {
      timeout: 60000
    });
    await ran(page);
    // The strip shows at the bottom of the card, below the fold: no scroll.
    expect(await inView(page, strip)).toBe(false);
    expect(await recordedScrolls(page)).toEqual([]);
  });

  test("brings the strip of an agent's run into view", async ({
    page,
    tmpPath
  }) => {
    await connected(page);
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
              title: 'Mean age by quitting',
              code: 'nhefs.groupby("qsmk").age.mean()',
              why: 'age could explain both'
            }
          },
          {
            type: 'result',
            answer: 'Those who quit were older.',
            cells: ['[3]'],
            follow_up: [],
            model: 'a model',
            provider: 'openrouter',
            cost_usd: 0.01,
            elapsed: 2
          }
        ])
      })
    );
    await page.route(/\/whybook\/agent\/result/, route =>
      route.fulfill({ status: 200, json: { ok: true } })
    );
    await tallNotebook(page, `${tmpPath}/agent.ipynb`);
    await showColumns(page);
    await drag(page, column(page, 'qsmk'), column(page, 'wt82_71'));
    const own = ownField(popover(page));
    await own.fill('What else could explain both?');
    await own.press('Enter');
    const run = page.locator('.jp-Epi-bench .jp-Epi-agentrun', {
      hasText: 'What else could explain both?'
    });
    await expect(run).toBeVisible();
    await ran(page);
    await expect.poll(() => inView(page, run)).toBe(true);
  });
});
