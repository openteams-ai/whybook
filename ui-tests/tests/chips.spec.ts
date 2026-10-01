/**
 * Chips, their popover and their tooltip (design iteration 1.86).
 *
 * The owner, on 1 October 2026: a click on a chip opened the questions to
 * the right of it and they jumped; the browser's tooltip on a chip came late
 * and in its own style; a library default of a model showed an AI tag and
 * its facts in the tooltip, where the popover should hold them; `drop True`
 * of `reset_index` told nothing; and the header of `read_csv` was a model's
 * business. No model is called: each test answers the model's route itself,
 * or the fixture aborts it.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

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

/** The chips of a cell of the bench. */
function chipsOf(page: IJupyterLabPageFixture, cell: string): Locator {
  return page.locator(
    `.jp-Epi-bench .jp-Epi-cell[data-cell-id="${cell}"] .jp-Epi-chip`
  );
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

const BY = {
  choice: 'remote',
  model: 'fake/model',
  at: '2026-10-01T09:00:00Z'
};
const DROPNA = 'Rows whose key is missing are left out of the groups.';
const SORT = 'The groups come in the order of their keys.';

/** The model's route: groupby's dropna and sort, and nothing for the other functions. */
async function fakeModel(page: IJupyterLabPageFixture): Promise<void> {
  await page.route(/\/whybook\/defaults\/ask(\?|$)/, async route => {
    const body = route.request().postDataJSON();
    const picks: Record<string, unknown[]> = {
      'DataFrame.groupby': [
        { param: 'dropna', why: DROPNA },
        { param: 'sort', why: SORT }
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
}

const CELLS = [
  'import pandas as pd\ndf = pd.DataFrame({"g": ["a", None, "b", "a"], "v": [1, 2, 3, 4]})\nnames = pd.DataFrame({"g": ["a", "b"], "name": ["first", "second"]})',
  'totals = df.merge(names, on="g").groupby("name")["v"].sum()\ntotals'
];

/**
 * The box of the questions of a chip, as the browser draws it at each
 * frame for `ms`, each distinct box once. The check is that the popover
 * holds still, so it needs the time to pass (as `holds` in view.spec.ts).
 */
async function boxesFor(
  page: IJupyterLabPageFixture,
  ms: number
): Promise<string[]> {
  return page.evaluate(
    ms =>
      new Promise<string[]>(resolve => {
        const boxes: string[] = [];
        const start = performance.now();
        const look = () => {
          const node = document.querySelector('.jp-Epi-popover');
          if (node) {
            const { left, top, width, height } = node.getBoundingClientRect();
            const text = `${left},${top},${width},${height}`;
            if (boxes[boxes.length - 1] !== text) {
              boxes.push(text);
            }
          }
          if (performance.now() - start < ms) {
            requestAnimationFrame(look);
          } else {
            resolve(boxes);
          }
        };
        look();
      }),
    ms
  );
}

test('opens the questions of a chip under the chip, left-aligned and inside the window, and holds still while they come', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/under.ipynb`;
  await newNotebook(page, file, CELLS);
  await openAndRun(page, file);
  const chip = chipsOf(page, 'cell-1').first();
  await expect(chip).toHaveText('inner join', { timeout: 60000 });
  const chipBox = (await chip.boundingBox())!;
  // The popover is drawn while its questions load and again as they come:
  // it kept moving from above the chip to beside its cell (before 1 October 2026).
  const sampled = boxesFor(page, 2500);
  await chip.click();
  await expect(
    page.locator('.jp-Epi-popover .jp-Epi-option').first()
  ).toBeVisible();
  const boxes = (await sampled).map(text => text.split(',').map(Number));
  expect(boxes.length).toBeGreaterThan(0);
  const viewport = page.viewportSize()!;
  for (const [left, top, width, height] of boxes) {
    // Under the chip, left-aligned with it, and inside the window.
    expect(top).toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
    expect(Math.abs(left - chipBox.x)).toBeLessThanOrEqual(1);
    expect(left + width).toBeLessThanOrEqual(viewport.width);
    expect(top + height).toBeLessThanOrEqual(viewport.height);
  }
  // It does not move: its top and left are the same in every frame; only its height may change.
  expect(new Set(boxes.map(([left, top]) => `${left},${top}`)).size).toBe(1);
  // Read twice, 500 ms apart, once the questions are there: the same box.
  const first = await boxesFor(page, 1);
  const second = await boxesFor(page, 500);
  expect(first).toHaveLength(1);
  expect(second).toEqual(first);
});

test('shows a tooltip of the view on a chip: the value as code and the call, after a short rest of the pointer and on the keyboard focus, in JupyterLab’s colours, until Escape', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/tooltip.ipynb`;
  await newNotebook(page, file, CELLS);
  await openAndRun(page, file);
  const chip = chipsOf(page, 'cell-1').first();
  await expect(chip).toHaveText('inner join', { timeout: 60000 });
  // The browser's own tooltip is gone.
  expect(await chip.getAttribute('title')).toBeNull();
  const tooltip = page.locator('.jp-Epi-tooltip');
  await expect(tooltip).toHaveCount(0);
  await chip.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('div')).toHaveText([
    "how = 'inner'",
    'parameter how of DataFrame.merge, line 1'
  ]);
  // The value is code, and the chip points to its tooltip.
  await expect(tooltip.locator('div').first().locator('code')).toHaveCount(1);
  await expect(chip).toHaveAttribute(
    'aria-describedby',
    (await tooltip.getAttribute('id'))!
  );
  // Under the chip, left-aligned, inside the window.
  const chipBox = (await chip.boundingBox())!;
  const box = (await tooltip.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
  expect(Math.abs(box.x - chipBox.x)).toBeLessThanOrEqual(1);
  const viewport = page.viewportSize()!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  // JupyterLab's colours and fonts, as the theme's variables give them.
  const reference = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText =
      'background: var(--jp-layout-color1); color: var(--jp-ui-font-color1); font-family: var(--jp-ui-font-family); border: 1px solid var(--jp-border-color1);';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const found = {
      background: style.backgroundColor,
      color: style.color,
      font: style.fontFamily,
      border: style.borderTopColor
    };
    probe.remove();
    return found;
  });
  const drawn = await tooltip.evaluate(node => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      color: style.color,
      font: style.fontFamily,
      border: style.borderTopColor
    };
  });
  expect(drawn).toEqual(reference);
  // It leaves with the pointer.
  await page.mouse.move(2, 2);
  await expect(tooltip).toHaveCount(0);
  // The keyboard's focus shows it at once, and Escape hides it with the focus still on the chip.
  // A key press first: the browser takes a focus that a script gives after a key for the keyboard's.
  await page.keyboard.press('Shift');
  await chip.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await expect(chip).toBeFocused();
});

test('shows no AI tag on a library default that a model flagged, and says in the popover where it comes from, who flagged it and why', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  await fakeModel(page);
  const file = `${tmpPath}/flagged.ipynb`;
  await newNotebook(page, file, CELLS);
  const lookup = page.waitForResponse(/\/whybook\/defaults(\?|$)/);
  await openAndRun(page, file);
  await lookup;
  const chips = chipsOf(page, 'cell-1');
  // The inner join is a default of the view's own list; dropna and sort are the model's.
  await expect(chips).toHaveText(['inner join', 'dropna True', 'sort True'], {
    timeout: 60000
  });
  await expect(chips.locator('.jp-Epi-aitag')).toHaveCount(0);
  const dropna = chips.nth(1);
  await expect(dropna).toHaveClass(/jp-mod-open/);
  expect(await dropna.getAttribute('title')).toBeNull();
  // Its tooltip is short: the value and the call.
  await dropna.hover();
  await expect(page.locator('.jp-Epi-tooltip div')).toHaveText([
    'dropna = True',
    'parameter dropna of DataFrame.groupby, line 1'
  ]);
  await page.mouse.move(2, 2);
  await dropna.click();
  const popover = page.locator('.jp-Epi-popover');
  const line = popover.locator('.jp-Epi-decision-line');
  await expect(line).toHaveText(
    /^dropna = True · default in pandas \d[\w.]* · flagged as important by AI$/
  );
  await expect(line.locator('.jp-Epi-aitag')).toHaveAttribute(
    'title',
    /^Flagged as important by the remote AI model, fake\/model on /
  );
  await expect(popover.locator('.jp-Epi-decision-reason')).toHaveText(DROPNA);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  // A default of the view's own list: the library from the kernel, no AI part, and the list's reason.
  await chips.first().click();
  await expect(line).toHaveText(/^how = 'inner' · default in pandas \d[\w.]*$/);
  await expect(line.locator('.jp-Epi-aitag')).toHaveCount(0);
  await expect(popover.locator('.jp-Epi-decision-reason')).toHaveText(
    'Rows without a match in both frames are dropped.'
  );
});

test('gives the header of read_csv a chip from the rules, whose questions need no model and say so in a short line', async ({
  page,
  tmpPath
}) => {
  const asked: string[] = [];
  page.on('request', request => {
    if (/\/whybook\/decision\/values/.test(request.url())) {
      asked.push(request.url());
    }
  });
  await page.contents.uploadContent(
    'a,b\n1,2\n3,4\n',
    'text',
    `${tmpPath}/homes.csv`
  );
  const file = `${tmpPath}/header.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd',
    'homes = pd.read_csv("homes.csv")\nhomes'
  ]);
  await openAndRun(page, file);
  const chips = chipsOf(page, 'cell-1');
  await expect(chips.first()).toHaveText('header infer', { timeout: 60000 });
  await expect(chips.locator('.jp-Epi-aitag')).toHaveCount(0);
  await chips.first().click();
  const popover = page.locator('.jp-Epi-popover');
  await expect(popover.locator('.jp-Epi-decision-line')).toHaveText(
    /^header = 'infer' · default in pandas \d[\w.]*$/
  );
  await expect(
    popover.locator('.jp-Epi-option .jp-Epi-option-text')
  ).toHaveText([
    'What if header were None?',
    'What if header were 0?',
    'Choose header in [2]'
  ]);
  await expect(popover.locator('.jp-Epi-option-effect').first()).toContainText(
    'reads the first row as data'
  );
  // No sentence about a rule that nobody knows: the rules' own, short.
  await expect(popover.locator('.jp-Epi-valuekind')).toHaveText(
    'A choice of read_csv: its other common values.'
  );
  await expect(popover).not.toContainText('No rule knows');
  expect(asked).toEqual([]);
});

test('shows no chip for a keyword argument that only keeps the books', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/books.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\ndf = pd.DataFrame({"a": [3, 1, 2]})',
    'out = df.sort_values("a").reset_index(drop=True)\nboth = df.merge(df, on="a")\nout'
  ]);
  await openAndRun(page, file);
  // The inner join shows that the cell was analysed: `drop True` of reset_index is not a chip beside it.
  await expect(chipsOf(page, 'cell-1')).toHaveText(['inner join'], {
    timeout: 60000
  });
});
