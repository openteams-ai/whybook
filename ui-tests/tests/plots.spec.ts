import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

/*
 * Plots of other libraries: the kernel's matplotlib hook describes each Axes
 * of a figure next to its PNG, so a box dragged on the picture asks about the
 * rows there; when the hook fails, the figure shows as matplotlib ships it;
 * and any picture asks about a point or an area of it, with the AI.
 */

// Each test runs matplotlib in a kernel, and its waits allow up to 180 s: a
// test of 60 s in all timed out while other jobs kept the machine busy.
test.describe.configure({ timeout: 180000 });

const AXES_MIME = 'application/vnd.whybook.axes+json';

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

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

/** Write a notebook with these code cells, and open it in the view. */
async function openNotebook(
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
  await openInWhybook(page, file);
  await kernelIdle(page);
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
  await idle(page);
}

/** The MIME types of each output of a cell, as the notebook keeps them. */
async function outputMimes(
  page: IJupyterLabPageFixture,
  index: number
): Promise<string[][]> {
  return page.evaluate((index: number) => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const outputs = model.cells.get(index).outputs;
    const mimes: string[][] = [];
    for (let i = 0; i < outputs.length; i++) {
      mimes.push(Object.keys(outputs.get(i).data).sort());
    }
    return mimes;
  }, index);
}

/** The Axes that the hook wrote next to the picture of a cell. */
async function axesOf(page: IJupyterLabPageFixture, index: number) {
  return page.evaluate(
    ({ index, mime }) => {
      const model = (window as any).jupyterapp.shell.currentWidget.context
        .model;
      const outputs = model.cells.get(index).outputs;
      for (let i = 0; i < outputs.length; i++) {
        const data = outputs.get(i).data;
        if (data[mime]) {
          return data[mime];
        }
      }
      return null;
    },
    { index, mime: AXES_MIME }
  );
}

/**
 * Drag over a picture from one point to another, each given in the PNG's
 * pixels; the mouse moves in steps, as a drag needs.
 */
async function dragOver(
  page: IJupyterLabPageFixture,
  img: Locator,
  size: { width: number; height: number },
  from: [number, number],
  to: [number, number]
): Promise<void> {
  await img.scrollIntoViewIfNeeded();
  const box = (await img.boundingBox())!;
  const at = ([x, y]: [number, number]) =>
    [
      box.x + (x / size.width) * box.width,
      box.y + (y / size.height) * box.height
    ] as const;
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.mouse.move(...at(to), { steps: 10 });
  await page.mouse.up();
}

const VISITS = [
  'import pandas as pd',
  'import matplotlib.pyplot as plt',
  'visits = pd.DataFrame({"week": list(range(20)), "pain": [float(i % 5) for i in range(20)]})'
].join('\n');

test('asks about the rows in a box dragged on a matplotlib scatter plot', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, `${tmpPath}/matplotlib.ipynb`, [
    VISITS,
    'ax = visits.plot.scatter(x="week", y="pain")'
  ]);
  await runAll(page, ['visits']);
  // The kernel's hook wrote the Axes of the figure next to its PNG, with the
  // frame that pandas plotted.
  const payload = await axesOf(page, 1);
  expect(payload.axes).toHaveLength(1);
  const axes = payload.axes[0];
  expect(axes).toMatchObject({
    frame: 'visits',
    x: { column: 'week', scale: 'linear' },
    y: { column: 'pain', scale: 'linear' },
    marks: 20
  });
  const [left, top, right, bottom] = axes.box;
  const [low, high] = axes.x.limits;
  // Week 9.5, between the tenth and the eleventh row.
  const middle = left + ((9.5 - low) / (high - low)) * (right - left);
  const box = async (img: Locator) =>
    dragOver(
      page,
      img,
      payload.image,
      [left + 3, top + 3],
      [middle, bottom - 3]
    );
  const rows = popover(page).locator('.jp-Epi-caption', { hasText: 'rows' });

  // In the card, at Full: the box asks about weeks 0 to 9 at every pain.
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-1"]');
  const img = card.locator('.jp-Epi-imagebrush img');
  await expect(img).toBeVisible({ timeout: 60000 });
  await expect(card.locator('.jp-Epi-hint')).toContainText(
    'The axes show columns of visits'
  );
  await box(img);
  await expect(rows).toHaveText(/^10 rows/, { timeout: 30000 });
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    /^week -0\.\d+ to 9\.\d+, pain -0\.\d+ to 4\.\d+/
  );
  await expect(card.locator('.jp-Epi-imagebox')).toBeVisible();
  await popover(page).locator('.jp-Epi-close').click();
  await expect(card.locator('.jp-Epi-imagebox')).toHaveCount(0);

  // At Compact, the picture is smaller and asks the same.
  await page.locator('.jp-Epi-detail input').fill('1');
  await expect
    .poll(async () => (await img.boundingBox())!.width)
    .toBeLessThanOrEqual(341);
  await box(img);
  await expect(rows).toHaveText(/^10 rows/, { timeout: 30000 });
  await popover(page).locator('.jp-Epi-close').click();

  // In the cell's details, opened from the thumbnail at Overview.
  await page.locator('.jp-Epi-detail input').fill('0');
  await card.locator('.jp-Epi-miniature').click();
  const panelImg = page.locator('.jp-Epi-details .jp-Epi-imagebrush img');
  await expect(panelImg).toBeVisible();
  await box(panelImg);
  await expect(rows).toHaveText(/^10 rows/, { timeout: 30000 });
  await popover(page).locator('.jp-Epi-close').click();

  // In the Code view, at Full.
  await page.locator('.jp-Epi-detail input').fill('2');
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  const linearImg = page.locator(
    '.jp-Epi-linear-cell[data-cell-id="cell-1"] .jp-Epi-imagebrush img'
  );
  await expect(linearImg).toBeVisible();
  await box(linearImg);
  await expect(rows).toHaveText(/^10 rows/, { timeout: 30000 });
});

test('asks about the rows in a box on a ninejs chart, after Select rows', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, `${tmpPath}/ninejs.ipynb`, [
    VISITS,
    'from plotnine import aes, geom_point, ggplot\nfrom ninejs import interactive\n\ninteractive(ggplot(visits, aes("week", "pain")) + geom_point())'
  ]);
  await runAll(page, ['visits']);
  // The hook described the figure behind the chart, in the points of its SVG,
  // in the cell that imports ninejs; the points name the frame.
  const payload = await axesOf(page, 1);
  expect(payload.library).toBe('ninejs');
  const axes = payload.axes[0];
  expect(axes).toMatchObject({
    frame: 'visits',
    x: { column: 'week' },
    y: { column: 'pain' },
    marks: 20
  });
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-1"]');
  const frame = card.locator('iframe');
  await expect(frame).toBeVisible({ timeout: 60000 });
  // The chart keeps its own tooltips until Select rows puts a layer over it.
  const select = card.getByRole('button', { name: 'Select rows' });
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  await expect(card.locator('.jp-Epi-imagebrush-cover')).toHaveCount(0);
  await select.click();
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('.jp-Epi-imagebrush-cover')).toHaveCount(1);
  // A box from the Axes' corner to week 9.5 over every pain: the first ten
  // rows. The SVG lies inside the frame's margin of 8 px, as wide as the frame.
  const [left, top, , bottom] = axes.box;
  const [low, high] = axes.x.limits;
  const middle = left + ((9.5 - low) / (high - low)) * (axes.box[2] - left);
  await frame.scrollIntoViewIfNeeded();
  const box = (await frame.boundingBox())!;
  const scale = (box.width - 16) / payload.image.width;
  const at = (x: number, y: number) =>
    [box.x + 8 + x * scale, box.y + 8 + y * scale] as const;
  await page.mouse.move(...at(left + 3, top + 3));
  await page.mouse.down();
  await page.mouse.move(...at(middle, bottom - 3), { steps: 10 });
  await page.mouse.up();
  await expect(
    popover(page).locator('.jp-Epi-caption', { hasText: 'rows' })
  ).toHaveText(/^10 rows/, { timeout: 30000 });
  await expect(card.locator('.jp-Epi-imagebox')).toBeVisible();
});

test('shows a figure as matplotlib ships it when the hook fails, and removes the hook', async ({
  page,
  tmpPath
}) => {
  const plot =
    'fig, ax = plt.subplots()\nax.scatter(visits.week, visits.pain)\nax.set_xlabel("week")\nax.set_ylabel("pain");';
  await openNotebook(page, `${tmpPath}/broken.ipynb`, [
    VISITS,
    // A matplotlib whose Axes answer as the hook does not expect.
    [
      'import matplotlib.axes',
      '_shipped = matplotlib.axes.Axes.get_xlabel',
      'def _moved(self):',
      '    raise AttributeError("get_xlabel moved")',
      'matplotlib.axes.Axes.get_xlabel = _moved',
      plot
    ].join('\n'),
    `matplotlib.axes.Axes.get_xlabel = _shipped\n${plot}`
  ]);
  await runAll(page, ['visits']);
  // One output each, the picture as matplotlib ships it: no traceback, and
  // no Axes; the hook removed itself, so the next figure has none either.
  // Run all waits for visits only, so the later cells' outputs may still come.
  await expect
    .poll(() => outputMimes(page, 1), { timeout: 60000 })
    .toEqual([['image/png', 'text/plain']]);
  await expect
    .poll(() => outputMimes(page, 2), { timeout: 60000 })
    .toEqual([['image/png', 'text/plain']]);
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-1"]');
  const img = card.locator('.jp-Epi-imagebrush img');
  await expect(img).toBeVisible({ timeout: 60000 });
  await expect
    .poll(() => img.evaluate(node => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  // A drag asks about the area of the picture, and not about rows.
  const size = await img.evaluate(node => ({
    width: (node as HTMLImageElement).naturalWidth,
    height: (node as HTMLImageElement).naturalHeight
  }));
  await dragOver(
    page,
    img,
    size,
    [size.width * 0.3, size.height * 0.3],
    [size.width * 0.6, size.height * 0.6]
  );
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    'This area of the plot'
  );
  await expect(popover(page).locator('.jp-Epi-option')).toHaveText([
    /What does the plot show here\?.*needs AI/
  ]);
  await expect(
    popover(page).locator('.jp-Epi-caption', { hasText: 'rows' })
  ).toHaveCount(0);
});

test('asks the AI about a point of a picture, with the picture and the point', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: nothing reaches Claude.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  const asked: any[] = [];
  await page.route(/\/whybook\/solve/, async route => {
    asked.push(route.request().postDataJSON());
    const cell = {
      code: 'print("a dark square on white")',
      summary: 'What the picture shows at the point',
      assumptions: [],
      follow_up: []
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({ type: 'progress', stage: 'writing', elapsed: 0.1 }) +
        '\n' +
        JSON.stringify({ type: 'result', elapsed: 0.2, cell }) +
        '\n'
    });
  });
  // A picture from PIL: no library hook describes it.
  await openNotebook(page, `${tmpPath}/picture.ipynb`, [
    'from PIL import Image, ImageDraw\npicture = Image.new("RGB", (200, 100), "white")\nImageDraw.Draw(picture).rectangle([40, 40, 60, 60], fill="black")',
    'picture'
  ]);
  await runAll(page, ['picture']);
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-1"]');
  const img = card.locator('.jp-Epi-imagebrush img');
  await expect(img).toBeVisible({ timeout: 60000 });
  // A click a quarter across and half down: the black square.
  const box = (await img.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    'This point of the plot'
  );
  await expect(card.locator('.jp-Epi-imagepoint')).toBeVisible();
  // The box for a question of one's own, and one question offered.
  await expect(popover(page).locator('.jp-Epi-ownbox textarea')).toBeEnabled();
  const option = popover(page).locator('.jp-Epi-option', {
    hasText: 'What does the plot show here?'
  });
  await expect(option).toContainText('needs AI');
  await option.click();
  const answer = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-title', {
      hasText: 'What does the plot show here?'
    })
  });
  await expect(answer.locator('.jp-Epi-textoutput')).toHaveText(
    'a dark square on white',
    { timeout: 60000 }
  );
  // The request carries the picture, and the point in fractions and pixels.
  expect(asked).toHaveLength(1);
  const request = asked[0];
  expect(request.question.text).toBe('What does the plot show here?');
  const png = await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    return model.cells.get(1).outputs.get(0).data['image/png'];
  });
  expect(request.image).toMatchObject({
    mime: 'image/png',
    data: png.replace(/\s/g, ''),
    width: 200,
    height: 100
  });
  expect(request.image.point.fx).toBeCloseTo(0.25, 1);
  expect(request.image.point.fy).toBeCloseTo(0.5, 1);
  expect(Math.abs(request.image.point.x - 50)).toBeLessThanOrEqual(2);
  expect(Math.abs(request.image.point.y - 50)).toBeLessThanOrEqual(2);
  expect(request.about).toMatch(
    /^the point 2[45]% across and 5[01]% down the picture that cell \[\d+\] shows/
  );
});
