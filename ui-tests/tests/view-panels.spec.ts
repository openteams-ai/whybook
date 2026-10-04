/**
 * Popovers, the panels and an agent's run in the view (design iteration
 * 1.83), in the browser against the built extension. Each item names its
 * issue in the testers' report (research/dogfood.md):
 *
 * - The popover of a request's questions stays inside the window, below
 *   the menu bar, and is placed again when the model's questions make it
 *   grow; its list scrolls, and the option that the arrow keys reach comes
 *   into sight (energy 1 and 11, pain 32).
 * - Clearing the search of Contents after a pick keeps its questions open
 *   (energy 10).
 * - The names that an agent's run made for its own steps show under the
 *   run in Variables, folded, and stay off the map (energy 5, pain 3).
 * - The note of a file over a card follows the pointer (energy 17).
 * - The Check-up shows in an open view when its setting turns on, and its
 *   Speed says that the view times cells only while it is on (energy 16,
 *   pain 30).
 * - The values that shape a plot show no chip (pain 14).
 * - The numbers of a quick look wrap in the right panel (pain 20).
 * - The strip of an agent's run says which of its cells the analyst
 *   changed since, and the values of the analyst's code are theirs (pain 6).
 *
 * No model runs: the page answers the model's routes itself.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator, Route } from '@playwright/test';

import { expect, test } from './fixtures';

// Each test runs the cells of its notebook in a kernel first.
test.describe.configure({ timeout: 240000 });

// The model's questions that a test holds: let go at its end, so that no
// request waits past the test.
const holds: (() => void)[] = [];

test.afterEach(async ({ page }) => {
  holds.splice(0).forEach(release => release());
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
  cells: object[],
  whybook: Record<string, unknown> | null = null
): Promise<void> {
  const notebook = {
    cells,
    metadata: { kernelspec: KERNELSPEC, ...(whybook ? { whybook } : {}) },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

async function open(page: IJupyterLabPageFixture, file: string): Promise<void> {
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
}

/** Open a notebook in the Whybook view, run every cell, and wait until each has its label. */
async function openAndRun(
  page: IJupyterLabPageFixture,
  file: string,
  cells: number
): Promise<void> {
  await open(page, file);
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('.jp-Epi-bench .jp-Epi-cell .jp-Epi-label')
  ).toHaveText(
    Array.from({ length: cells }, (_, index) => `[${index + 1}]`),
    { timeout: 90000 }
  );
}

function card(page: IJupyterLabPageFixture, cellId: string): Locator {
  return page.locator(`.jp-Epi-bench .jp-Epi-cell[data-cell-id="${cellId}"]`);
}

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

function variable(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator(`.jp-Epi-variable[data-variable="${name}"]`);
}

function column(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator('.jp-Epi-contents .jp-Epi-column').filter({
    has: page.locator('.jp-Epi-item-name', {
      hasText: new RegExp(`^${name}$`)
    })
  });
}

async function clickMode(page: IJupyterLabPageFixture): Promise<void> {
  await page
    .locator('.jp-Epi-questions .jp-Epi-toggle [data-value="click"]')
    .click();
}

/**
 * The box of an element once it stops moving. After Run all, the Variables
 * list settles and moves the Contents panel under it, so a box read too early
 * sends a drag to the wrong place.
 */
async function settledBox(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await locator.boundingBox());
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [250] }
    )
    .toBe(true);
  return (await locator.boundingBox())!;
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

/** A question of the model, as the server sends it. */
function question(index: number) {
  return {
    id: `claude:${index}`,
    text: `Does kwh_import differ by question ${index} of the model, with a text long enough to take two lines?`,
    type: 'association',
    origin: 'claude',
    template: null,
    variables: [],
    probability: 0.7,
    reasons: ['The model says why'],
    effect: '',
    placement: null,
    code: null,
    action: null
  };
}

/**
 * Answer the model's questions with eight questions, once the test lets
 * them go: the popover first shows the templates' questions alone.
 */
async function heldQuestions(
  page: IJupyterLabPageFixture
): Promise<() => void> {
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => (release = resolve));
  holds.push(() => release());
  await page.route(
    /\/whybook\/questions\/claude(\?|$)/,
    async (route: Route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjson([
          {
            type: 'result',
            elapsed: 17,
            model: 'fake/model',
            cost_usd: 0.01,
            questions: Array.from({ length: 8 }, (_, index) =>
              question(index + 1)
            ),
            outcomes: [],
            units: [],
            left_out: []
          }
        ])
      });
    }
  );
  return () => release();
}

/** The room of the popover: below JupyterLab's menu bar and above its status bar. */
async function room(
  page: IJupyterLabPageFixture
): Promise<{ top: number; bottom: number }> {
  return page.evaluate(() => {
    const main = document
      .getElementById('jp-main-content-panel')!
      .getBoundingClientRect();
    return { top: main.top, bottom: main.bottom };
  });
}

/** The energy tester's readings_homes: 200 rows and 15 columns. */
const READINGS = `import numpy as np
import pandas as pd
_rng = np.random.default_rng(7)
_n = 200
readings_homes = pd.DataFrame({
    "home_id": [f"H{i % 40:03d}" for i in range(_n)],
    "date": pd.date_range("2025-01-01", periods=_n, freq="D"),
    "kwh_import": _rng.gamma(2.0, 9.0, _n).round(2),
    "kwh_peak": _rng.gamma(2.0, 2.0, _n).round(2),
    "kwh_night": _rng.gamma(2.0, 1.5, _n).round(2),
    "kwh_export": _rng.gamma(1.0, 0.5, _n).round(2),
    "region": _rng.choice(["north", "south", "east"], _n),
    "floor_area_m2": _rng.integers(40, 200, _n),
    "occupants": _rng.integers(1, 6, _n),
    "built": _rng.choice(["pre-1950", "1950-1990", "post-1990"], _n),
    "heating": _rng.choice(["gas boiler", "heat pump", "storage"], _n),
    "has_solar": _rng.choice([True, False], _n),
    "has_ev": _rng.choice([True, False], _n),
    "tariff": _rng.choice(["flat", "time of use"], _n),
    "tou_start": pd.NaT,
})
readings_homes.head()`;

test.describe('a popover inside the window', () => {
  test('keeps a tall Click-mode popover beside a low target inside the window when the model’s questions come, and scrolls the option that the arrow keys reach into sight', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const release = await heldQuestions(page);
    const file = `${tmpPath}/clicktall.ipynb`;
    await writeNotebook(page, file, [code('load', READINGS)]);
    await openAndRun(page, file, 1);
    await clickMode(page);
    await variable(page, 'readings_homes').click();
    // Energy step 16: tou_start, then kwh_peak, low in Contents.
    await column(page, 'kwh_import').click();
    const target = column(page, 'has_solar');
    await expect(target).toBeVisible();
    const row = (await target.boundingBox())!;
    await target.click();
    await expect(popover(page).locator('.jp-Epi-option').first()).toBeVisible({
      timeout: 60000
    });
    const bounds = await room(page);
    const before = (await popover(page).boundingBox())!;
    // Beside the target, its head level with the pointer.
    expect(before.x).toBeGreaterThan(row.x);
    // The model's questions come, 17 s later in the tester's run.
    release();
    await expect(
      popover(page).locator('.jp-Epi-option', { hasText: 'question 1 ' })
    ).toHaveCount(1, { timeout: 30000 });
    await expect
      .poll(async () => {
        const box = (await popover(page).boundingBox())!;
        return box.y + box.height <= bounds.bottom && box.y >= bounds.top;
      })
      .toBe(true);
    const after = (await popover(page).boundingBox())!;
    expect(after.y).toBeLessThan(before.y);
    // Taller than the room: the list scrolls inside the popover.
    const scrolls = await popover(page).evaluate(
      node => node.scrollHeight > node.clientHeight
    );
    expect(scrolls).toBe(true);
    // The last option, below the fold, comes into sight by the arrow keys.
    const options = popover(page).locator('.jp-Epi-option');
    const count = await options.count();
    await options.first().focus();
    for (let index = 1; index < count; index++) {
      await page.keyboard.press('ArrowDown');
    }
    const last = options.last();
    await expect(last).toBeFocused();
    const shown = (await last.boundingBox())!;
    expect(shown.y).toBeGreaterThanOrEqual(after.y);
    expect(shown.y + shown.height).toBeLessThanOrEqual(after.y + after.height);
    await page.keyboard.press('Escape');
  });

  test('places the popover of a drop again when the model’s questions make it grow', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const release = await heldQuestions(page);
    const file = `${tmpPath}/droptall.ipynb`;
    await writeNotebook(page, file, [
      code('load', READINGS),
      code('peak', 'readings_homes.groupby("tariff").kwh_peak.mean()')
    ]);
    await openAndRun(page, file, 2);
    await variable(page, 'readings_homes').click();
    const source = column(page, 'tariff');
    const title = card(page, 'peak').locator('.jp-Epi-title');
    await title.scrollIntoViewIfNeeded();
    const from = await settledBox(source);
    const to = await settledBox(title);
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + from.height / 2 + 5, {
      steps: 5
    });
    await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(popover(page)).toBeVisible();
    // No template fits: the popover waits for the model's questions.
    await expect(popover(page).locator('.jp-Epi-modelline')).toBeVisible({
      timeout: 60000
    });
    const before = (await popover(page).boundingBox())!;
    release();
    await expect(
      popover(page).locator('.jp-Epi-option', { hasText: 'question 1 ' })
    ).toHaveCount(1, { timeout: 30000 });
    const bounds = await room(page);
    await expect
      .poll(async () => {
        const box = (await popover(page).boundingBox())!;
        return box.y >= bounds.top && box.y + box.height <= bounds.bottom;
      })
      .toBe(true);
    // It grew with the model's questions, and stayed beside the drop.
    const after = (await popover(page).boundingBox())!;
    expect(after.height).toBeGreaterThan(before.height + 300);
    expect(after.x).toBe(before.x);
    await page.keyboard.press('Escape');
  });
});

test('keeps the questions of a pick open while the analyst clears the search of Contents', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/clearsearch.ipynb`;
  await writeNotebook(page, file, [code('load', READINGS)]);
  await openAndRun(page, file, 1);
  await clickMode(page);
  await variable(page, 'readings_homes').click();
  // Energy step 12: heating, then kwh_import from a search.
  const search = page.locator(
    '.jp-Epi-contents input[aria-label="Search columns"]'
  );
  await search.fill('heating');
  await column(page, 'heating').click();
  await search.fill('kwh_import');
  await column(page, 'kwh_import').click();
  await expect(popover(page).locator('.jp-Epi-ask-head code')).toContainText(
    'kwh_import'
  );
  await expect(popover(page).locator('.jp-Epi-option').first()).toBeVisible({
    timeout: 60000
  });
  await search.fill('');
  await expect(column(page, 'tou_start')).toBeVisible();
  await expect(popover(page)).toBeVisible();
  await expect(popover(page).locator('.jp-Epi-ask-head code')).toContainText(
    'kwh_import'
  );
  // The questions keep the keyboard focus where the analyst put it.
  await expect(search).toBeFocused();
});

/** The key that the view keeps of the code it writes (src/model/handedit.ts). */
function codeKey(source: string): string {
  const value = source.trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const OUTLIERS = 'Does kwh_import have outliers or impossible values?';
const RUN3 = `desc = readings_homes.kwh_import.describe()
q1, q3 = readings_homes.kwh_import.quantile([0.25, 0.75])
iqr = q3 - q1
upper = q3 + 3 * iqr
high_outliers = readings_homes[readings_homes.kwh_import > upper]
print(len(high_outliers), "rows above", round(upper, 1))`;
const RUN4 = `sentinel = readings_homes[readings_homes.kwh_import > 999]
zero_rows = readings_homes[readings_homes.kwh_import == 0]
print(len(sentinel), "sentinel rows,", len(zero_rows), "zero rows")`;

/** The energy notebook after the agent's first run: the analyst's frame and the run's two cells. */
async function energyAfterRun(
  page: IJupyterLabPageFixture,
  file: string,
  later: string | null = null
): Promise<void> {
  const run = (id: string, source: string, step: number) =>
    code(id, source, {
      written_by: 'agent',
      generated_by: { agent: 'openrouter', model: 'fake/model' },
      agent: { run: 'r1', step },
      view_code_key: codeKey(source)
    });
  await writeNotebook(
    page,
    file,
    [
      code('load', READINGS),
      run('run3', RUN3, 1),
      run('run4', RUN4, 2),
      ...(later ? [code('later', later)] : [])
    ],
    {
      agent_runs: {
        r1: {
          question: OUTLIERS,
          provider: 'openrouter',
          model: 'fake/model',
          cost_usd: 0.1,
          cells: ['run3', 'run4'],
          files: [],
          state: 'done',
          at: '2026-10-01T09:42:00.000Z',
          steps: [
            {
              tool: 'run_cell',
              title: 'The distribution and a 3 x IQR fence',
              cells: ['run3'],
              state: 'done'
            },
            {
              tool: 'run_cell',
              title: 'The sentinel and zero rows',
              cells: ['run4'],
              state: 'done'
            }
          ],
          answer: 'No row reads 999.9 here [3], and no row reads 0 [4].'
        }
      }
    }
  );
}

test('lists the names of an agent’s run under the run, folded, and leaves its frames off the map', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/runnames.ipynb`;
  await energyAfterRun(page, file, 'sentinel.describe()');
  await openAndRun(page, file, 4);
  await page.sidebar.openTab('epi-variables');
  const rows = page.locator('.jp-Epi-variables .jp-Epi-variable');
  // The analyst's frame, and sentinel, which a later cell of the analyst reads.
  await expect(rows).toHaveText([/^readings_homes/, /^sentinel/], {
    timeout: 60000
  });
  const head = page.locator('.jp-Epi-rungroup-head');
  await expect(head).toHaveText(`${OUTLIERS}7`);
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await head.click();
  await expect(rows.locator('.jp-Epi-item-name')).toHaveText([
    'readings_homes',
    'sentinel',
    'desc',
    'q1',
    'q3',
    'iqr',
    'upper',
    'high_outliers',
    'zero_rows'
  ]);
  // A name of the run is a variable as any other: a click shows it.
  await variable(page, 'high_outliers').click();
  await expect(
    page.locator('.jp-Epi-contents .jp-Epi-section-head code')
  ).toHaveText('high_outliers');
  // The map draws the analyst's frames, and not the run's.
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await expect(page.locator('.jp-Epi-map-frame').first()).toBeVisible();
  await expect(page.locator('.jp-Epi-map-frame')).toHaveText([
    /readings_homes/,
    /sentinel/
  ]);
});

test('notes where a file goes next to the pointer while it is over a card', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    'tariff,period,eur_per_kwh\nflat,all,0.30\ntou,peak,0.45\n',
    'text',
    `${tmpPath}/tariffs.csv`
  );
  const file = `${tmpPath}/dropnote.ipynb`;
  await writeNotebook(page, file, [
    code(
      'cross',
      `${READINGS}\npd.crosstab(readings_homes.tariff, readings_homes.has_ev)`
    )
  ]);
  await openAndRun(page, file, 1);
  const target = card(page, 'cross');
  const table = target.locator('.jp-Epi-tableoutput table').first();
  await expect(table).toBeVisible({ timeout: 60000 });
  await page.sidebar.openTab('filebrowser');
  await page.filebrowser.refresh();
  let item = page.locator('.jp-DirListing-item', { hasText: 'tariffs.csv' });
  if (!(await item.first().isVisible())) {
    await page
      .locator('.jp-DirListing-item', { hasText: tmpPath })
      .first()
      .click();
  }
  item = item.first();
  await expect(item).toBeVisible();
  const from = (await item.boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y + from.height / 2 + 10, {
    steps: 5
  });
  const cells = table.locator('td');
  for (const index of [0, 3]) {
    const cell = (await cells.nth(index).boundingBox())!;
    const x = cell.x + 4;
    const y = cell.y + 4;
    await page.mouse.move(x, y, { steps: 8 });
    const note = target.locator('.jp-Epi-filedrop-note');
    await expect(note).toHaveText('Drop tariffs.csv on [1]');
    // Right below the name of the file that the pointer carries.
    await expect
      .poll(async () => {
        const box = (await note.boundingBox())!;
        return Math.abs(box.x - x) <= 40 && box.y - y >= 0 && box.y - y <= 60;
      })
      .toBe(true);
    await expect(note).toBeInViewport();
  }
  await page.mouse.up();
  await expect(popover(page).locator('.jp-Epi-ask-head code')).toHaveText(
    'tariffs.csv onto [1]'
  );
});

test('shows the Check-up in an open view when its setting turns on, and says that Speed times cells only while it is on', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/checkupon.ipynb`;
  await writeNotebook(page, file, [code('a', 'x = 1')]);
  await openAndRun(page, file, 1);
  await page.sidebar.openTab('epi-exploration');
  await expect(page.locator('.jp-Epi-checkup')).toHaveCount(0);
  // Settings > Settings Editor > "Questions about the notebook", ticked.
  await page.evaluate(async () => {
    const registry = await (window as any).galata.getPlugin(
      '@jupyterlab/apputils-extension:settings'
    );
    await registry.set('whybook:checkup', 'enabled', true);
  });
  const head = page.locator('.jp-Epi-checkup-head');
  await expect(head).toBeVisible();
  await head.click();
  await expect(page.locator('.jp-Epi-checkup')).toContainText(
    'No run times yet. Whybook times a cell only while "Questions about the notebook" is on and the notebook is open in it. Run the cells again to time them.'
  );
  await page.evaluate(async () => {
    const registry = await (window as any).galata.getPlugin(
      '@jupyterlab/apputils-extension:settings'
    );
    await registry.set('whybook:checkup', 'enabled', false);
  });
  await expect(page.locator('.jp-Epi-checkup')).toHaveCount(0);
});

test('shows no chip for the values that shape a plot, and keeps the chip of cov_type', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/plotchips.ipynb`;
  await writeNotebook(page, file, [
    code(
      'load',
      'import pandas as pd\nimport matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nimport statsmodels.formula.api as smf\nweekly = pd.DataFrame({"patient_id": ["P1", "P1", "P2", "P2", "P3", "P3"], "week": [1, 2, 1, 2, 1, 2], "pain": [5.0, 4.0, 6.0, 4.5, 3.0, 2.5]})'
    ),
    code(
      'card',
      'fig, ax = plt.subplots(figsize=(8, 5))\nax.plot(weekly["week"], weekly["pain"], marker="o")\nax.set_xlabel("Week")\nax.set_ylabel("Mean pain")\nax.set_title("Mean pain by week")\nfit = smf.ols("pain ~ week", data=weekly).fit(cov_type="cluster", cov_kwds={"groups": weekly["patient_id"]})\nprint(fit.params)',
      {
        written_by: 'agent',
        generated_by: { agent: 'openrouter', model: 'fake/model' }
      }
    )
  ]);
  await openAndRun(page, file, 2);
  const chips = card(page, 'card').locator('.jp-Epi-chip');
  await expect(chips.filter({ hasText: 'cov_type' })).toHaveCount(1, {
    timeout: 60000
  });
  for (const drawing of ['figsize', 'xlabel', 'ylabel', 'marker', 'label']) {
    await expect(
      chips.filter({ hasText: new RegExp(`^${drawing}\\b`) })
    ).toHaveCount(0);
  }
});

test('wraps the numbers of a quick look in the right panel, so that each shows whole', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/quicklook.ipynb`;
  await writeNotebook(page, file, [
    code(
      'load',
      'import pandas as pd\ndiary = pd.DataFrame({"patient_id": [f"P{i % 300:03d}" for i in range(36941)], "pain": [(i * 7) % 11 if i % 3 else 0 for i in range(36941)]})'
    )
  ]);
  await openAndRun(page, file, 1);
  await clickMode(page);
  await variable(page, 'diary').click();
  await column(page, 'pain').click();
  await column(page, 'pain').click();
  await popover(page)
    .locator('.jp-Epi-option', { hasText: 'Summarise pain' })
    .click({ timeout: 60000 });
  await page.sidebar.openTab('epi-exploration');
  const table = page.locator('.jp-Epi-preview .jp-Epi-rendered table');
  await expect(table).toBeVisible({ timeout: 60000 });
  // The box of the table scrolls no wider than the panel.
  const fits = await table.evaluate(node => {
    const box = node.closest('.jp-Epi-rendered')!;
    return box.scrollWidth <= box.clientWidth + 1;
  });
  expect(fits).toBe(true);
  await expect(table.locator('td').first()).toHaveText('36,941');
});

test('says under an agent’s answer which of its cells the analyst changed since, and badges the values of the analyst’s code as theirs', async ({
  page,
  tmpPath
}) => {
  const agents =
    'long = diary_raw.melt(id_vars=["patient_id"])\nlong = long.dropna()';
  const edited =
    'diary = diary_raw.melt(id_vars=["patient_id"])\ndiary = diary.dropna(thresh=2)';
  const file = `${tmpPath}/handedit.ipynb`;
  await writeNotebook(
    page,
    file,
    [
      code(
        'load',
        'import pandas as pd\ndiary_raw = pd.DataFrame({"patient_id": ["P1", "P2"], "pain_1": [3, 5], "pain_2": [4, 6]})'
      ),
      // The analyst renamed the agent's frame and added thresh=2, by hand.
      code('melt', edited, {
        written_by: 'agent',
        generated_by: { agent: 'openrouter', model: 'fake/model' },
        agent: { run: 'r1', step: 1 },
        view_code_key: codeKey(agents)
      })
    ],
    {
      agent_runs: {
        r1: {
          question: 'Reshape diary_raw: one row per patient-day',
          provider: 'openrouter',
          model: 'fake/model',
          cost_usd: 0.05,
          cells: ['melt'],
          files: [],
          state: 'done',
          at: '2026-10-01T09:40:00.000Z',
          steps: [
            {
              tool: 'run_cell',
              title: 'Melt diary_raw to one row per day',
              cells: ['melt'],
              state: 'done'
            }
          ],
          answer: 'The long frame has 41,160 day-level rows [2].'
        }
      }
    }
  );
  await openAndRun(page, file, 2);
  // The value the analyst typed is theirs: a plain chip, with no AI tag.
  const thresh = card(page, 'melt').locator('.jp-Epi-chip', {
    hasText: 'thresh 2'
  });
  await expect(thresh).toBeVisible({ timeout: 60000 });
  await expect(thresh).not.toHaveClass(/jp-mod-open/);
  await expect(thresh.locator('.jp-Epi-aitag')).toHaveCount(0);
  // The run's strip, drawn again from the notebook's record of it.
  await page.sidebar.openTab('epi-exploration');
  await page.locator('.jp-Epi-runhistory-head').click();
  await page
    .locator('.jp-Epi-runhistory-question', { hasText: 'Reshape diary_raw' })
    .click();
  await expect(page.locator('.jp-Epi-agentrun-edited')).toHaveText(
    'You changed the code of [2] since this answer: what it says of that cell may no longer hold.'
  );
});
