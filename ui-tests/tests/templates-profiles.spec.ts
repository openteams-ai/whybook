/**
 * The templates of profiles, splits by a level and wide frames (design
 * iteration 1.85).
 *
 * - The quick look of a number offers to leave out the rows at its ends,
 *   which the analyst picks, where only a model could leave them out.
 * - A date that each home has once gets no profile by hour of day, and
 *   daily dates get the profile by weekday and month.
 * - A level of the homes dropped on a profile splits it, one line per level,
 *   and an arm dropped on a trajectory splits it and asks a mixed model.
 * - The trajectory names its y axis, and the bars of the arms average one
 *   mean per patient, with intervals.
 * - Two attributes of the homes are counted once per home, with a test.
 * - The rows per home count the homes far below the median, and the quick
 *   look wraps its lines.
 * - A wide diary reshapes to one row per day from a template.
 * - The share between patients on an agent's card runs on the frame that
 *   holds the patients, not on the agent's leftover weekly frame.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

const ENERGY = [
  [
    'import numpy as np',
    'import pandas as pd',
    '',
    'rng = np.random.default_rng(1)',
    'homes = pd.DataFrame({',
    '    "home_id": [f"H{i:02d}" for i in range(12)],',
    '    "tariff": ["flat"] * 8 + ["time of use"] * 4,',
    '    "has_ev": [False] * 6 + [True] * 2 + [False, True, True, True],',
    '    "tou_start": pd.to_datetime([None] * 8 + ["2025-03-03", "2025-03-10", "2025-04-07", "2025-05-05"]),',
    '})',
    'days = pd.date_range("2025-01-01", periods=60, freq="D")',
    'readings = pd.DataFrame({',
    '    "home_id": np.repeat(homes["home_id"].to_numpy(), len(days)),',
    '    "date": np.tile(days, len(homes)),',
    '    "kwh_import": rng.gamma(4, 4, len(homes) * len(days)).astype("float32"),',
    '})',
    'readings["kwh_peak"] = (readings["kwh_import"] * 0.3).astype("float32")',
    'readings.loc[[5, 70, 300], "kwh_import"] = np.float32(0)',
    'readings.loc[[10, 400], "kwh_import"] = np.float32(999.9)',
    '# A meter of the third home lost 20 days.',
    'readings = readings.drop(index=range(130, 150)).reset_index(drop=True)',
    'readings_homes = readings.merge(homes, on="home_id", how="left")',
    'readings_homes.head()'
  ].join('\n')
];

const HALF_HOURLY = [
  'import pandas as pd',
  '',
  'stamps = pd.date_range("2025-02-10", periods=48 * 7, freq="30min")',
  'evening = (stamps.hour >= 16) & (stamps.hour < 19)',
  'half_hourly = pd.concat([',
  '    pd.DataFrame({"home_id": "H1", "timestamp": stamps, "kwh": 0.2 + 0.6 * evening}),',
  '    pd.DataFrame({"home_id": "H2", "timestamp": stamps, "kwh": 0.2 + 0.2 * evening + 0.4 * (stamps.hour < 5)}),',
  '])',
  'homes = pd.DataFrame({"home_id": ["H1", "H2"], "tariff": ["flat", "time of use"]})',
  'half_hourly.head()'
].join('\n');

const PROFILE =
  'import whybook\n\nwhybook.time_profile(half_hourly, "timestamp", "kwh")';

const DIARY = [
  'import numpy as np',
  'import pandas as pd',
  '',
  'rng = np.random.default_rng(3)',
  'patients, weeks = 12, 6',
  'level = np.repeat(rng.normal(5, 1.5, patients), weeks * 7)',
  'arm = np.repeat(np.where(np.arange(patients) % 2, "B", "A"), weeks * 7)',
  'week = np.tile(np.repeat(np.arange(1, weeks + 1), 7), patients)',
  'diary_patients = pd.DataFrame({',
  '    "patient_id": np.repeat([f"P{i:03d}" for i in range(patients)], weeks * 7),',
  '    "week": week,',
  '    "pain": (level - np.where(arm == "B", 0.4, 0.1) * week + rng.normal(0, 1, len(week))).round(1),',
  '    "treatment_arm": arm,',
  '})',
  'diary_patients.head()'
].join('\n');

const TRAJECTORY =
  'import whybook\n\nwhybook.ribbon(diary_patients, x="week", y="pain", units="patient_id")';

const WIDE = [
  'import numpy as np',
  'import pandas as pd',
  '',
  'rng = np.random.default_rng(4)',
  'rows = []',
  'for patient in range(4):',
  '    for week in (1, 2):',
  '        row = {"patient_id": f"P{patient:03d}", "week": week, "analgesic_use": "none"}',
  '        for day in range(1, 8):',
  '            for measure in ("pain", "sleep", "mood"):',
  '                row[f"{measure}_{day}"] = np.nan if day == 7 else float(rng.integers(0, 10))',
  '        rows.append(row)',
  'diary_raw = pd.DataFrame(rows)',
  'diary_raw.head()'
].join('\n');

interface ICellSpec {
  source: string;
  title?: string;
}

/** Write a notebook with these code cells, and the outcome and the unit set by hand. */
async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  cells: (string | ICellSpec)[],
  meta: Record<string, string> = {}
): Promise<void> {
  const notebook = {
    cells: cells.map((cell, index) => {
      const spec = typeof cell === 'string' ? { source: cell } : cell;
      return {
        cell_type: 'code',
        execution_count: null,
        id: `cell-${index}`,
        metadata: spec.title ? { whybook: { title: spec.title } } : {},
        outputs: [],
        source: spec.source
      };
    }),
    metadata: {
      kernelspec: {
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
        name: 'python3'
      },
      whybook: meta
    },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

async function idle(page: IJupyterLabPageFixture): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
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
  await idle(page);
  await page.locator('.jp-Epi-runall').click();
}

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

function option(page: IJupyterLabPageFixture, text: string | RegExp): Locator {
  return popover(page).locator('.jp-Epi-option', { hasText: text });
}

function texts(page: IJupyterLabPageFixture): Locator {
  return popover(page).locator('.jp-Epi-option .jp-Epi-option-text');
}

function variable(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator(`.jp-Epi-variable[data-variable="${name}"]`);
}

function column(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator('.jp-Epi-contents .jp-Epi-column').filter({
    has: page.locator('.jp-Epi-item-name', { hasText: new RegExp(`^${name}$`) })
  });
}

function card(page: IJupyterLabPageFixture, title: string | RegExp): Locator {
  return page
    .locator('.jp-Epi-bench .jp-Epi-cell', {
      has: page.locator('.jp-Epi-title', { hasText: title })
    })
    .last();
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

/** Open a frame's columns in Contents, once the kernel has it. */
async function showColumns(
  page: IJupyterLabPageFixture,
  frame: string,
  first: string
): Promise<void> {
  await expect(variable(page, frame)).toBeVisible({ timeout: 60000 });
  await variable(page, frame).click();
  await expect(column(page, first)).toBeVisible();
}

test('leaves out the rows at the ends of a quick look that the analyst picks, with a clean frame and the rows that went', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/leaveout.ipynb`;
  await newNotebook(page, file, ENERGY, { unit: 'home_id' });
  await openAndRun(page, file);
  await showColumns(page, 'readings', 'kwh_import');

  await drag(page, column(page, 'kwh_import'), column(page, 'kwh_import'));
  await option(
    page,
    'Summarise kwh_import: distribution and missingness'
  ).click();
  const preview = page.locator('.jp-Epi-preview');
  await expect(preview.locator('table')).toContainText('999.9 ×2', {
    timeout: 60000
  });
  await preview.getByRole('button', { name: 'Leave out these rows' }).click();
  const picker = preview.locator('.jp-Epi-leaveout');
  const write = picker.getByRole('button', { name: 'Write the cell' });
  await expect(write).toBeDisabled();
  await picker.getByRole('radio', { name: '0 or less, 3 rows' }).check();
  await picker.getByRole('radio', { name: '999.9 or more, 2 rows' }).check();
  await expect(picker.locator('.jp-Epi-leaveout-rule')).toHaveText(
    '5 rows go: kwh_import is 0 or less, or 999.9 or more.'
  );
  await write.click();
  // The float32 readings of 999.900024 go with the rule that names 999.9.
  await expect(page.locator('.jp-Epi-bench')).toContainText(
    'Left out 5 of 700 rows, where kwh_import is 0 or less, or 999.9 or more.',
    { timeout: 60000 }
  );
  await expect(
    card(page, 'Leave out the rows of readings where kwh_import is 0 or less')
  ).toBeVisible();
  await expect(variable(page, 'readings_clean')).toBeVisible({
    timeout: 60000
  });
});

test('offers no profile for a date that each home has once, and the profile by weekday and month for daily dates', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/dates.ipynb`;
  await newNotebook(page, file, ENERGY, { unit: 'home_id' });
  await openAndRun(page, file);
  await showColumns(page, 'readings_homes', 'tou_start');

  await drag(page, column(page, 'tou_start'), column(page, 'kwh_peak'));
  await expect(
    option(page, 'How does kwh_peak change over tou_start?')
  ).toBeVisible();
  await expect(texts(page).filter({ hasText: /vary by/ })).toHaveCount(0);
  await expect(texts(page).filter({ hasText: /How many rows/ })).toHaveCount(0);
  await popover(page)
    .getByRole('button', { name: 'Close the questions' })
    .click();

  await drag(page, column(page, 'date'), column(page, 'kwh_import'));
  await expect(
    option(page, 'How does kwh_import vary by weekday and by month?')
  ).toBeVisible();
});

test('counts two attributes of the homes once per home with a chi-square test, and the homes far below the median rows', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/counts.ipynb`;
  await newNotebook(page, file, ENERGY, { unit: 'home_id' });
  await openAndRun(page, file);
  await showColumns(page, 'readings_homes', 'tariff');

  await drag(page, column(page, 'tariff'), column(page, 'has_ev'));
  await option(page, 'Are tariff and has_ev independent?').click();
  const bench = page.locator('.jp-Epi-bench');
  await expect(bench).toContainText(
    'has_ev True: from 25% (flat) to 75% (time of use) over the 2 levels of tariff, one row per home.',
    { timeout: 60000 }
  );
  await expect(bench).toContainText(
    'Chi-square test of independence: chi-square = '
  );

  await showColumns(page, 'readings', 'home_id');
  // readings_homes has every column of readings: wait until its list is gone.
  await expect(column(page, 'tariff')).toHaveCount(0);
  await drag(page, column(page, 'home_id'), column(page, 'home_id'));
  await option(page, 'Summarise home_id: rows per home').click();
  const preview = page.locator('.jp-Epi-preview');
  await expect(preview).toContainText(
    '1 home below 54 rows, 90% of the median.',
    {
      timeout: 60000
    }
  );
  // The printed lines wrap in the narrow panel: no box scrolls sideways.
  const printed = preview.locator('.jp-RenderedText pre').first();
  await expect(printed).toHaveCSS('white-space', 'pre-wrap');
  expect(
    await printed.evaluate(node => node.scrollWidth <= node.clientWidth + 1)
  ).toBe(true);
});

test('splits a profile by a level of the homes, one line per tariff, joined on the home', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/profile.ipynb`;
  await newNotebook(
    page,
    file,
    [
      { source: HALF_HOURLY, title: 'Make half_hourly and homes' },
      {
        source: PROFILE,
        title: 'How does kwh vary by hour of day and by weekday?'
      }
    ],
    { outcome: 'kwh', unit: 'home_id' }
  );
  await openAndRun(page, file);
  const profile = card(page, 'How does kwh vary by hour of day');
  await expect(profile.locator('svg.jp-Epi-plot').first()).toBeVisible({
    timeout: 60000
  });
  await showColumns(page, 'homes', 'tariff');

  await drag(page, column(page, 'tariff'), profile.locator('.jp-Epi-title'));
  const split = option(page, 'The same profile of kwh, one line per tariff');
  await expect(split).toBeVisible();
  await expect(texts(page).filter({ hasText: /^Plot / })).toHaveCount(0);
  await split.click();
  const bench = page.locator('.jp-Epi-bench');
  await expect(bench).toContainText(
    'Mean kwh by hour of day, tariff flat: highest at 16:00 (0.8)',
    { timeout: 60000 }
  );
  await expect(bench).toContainText(
    'Mean kwh by hour of day, tariff time of use:'
  );
});

test('names the y axis of a trajectory, splits it by arm with a mixed model offered, and plots the arms with one mean per patient', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/trajectory.ipynb`;
  await newNotebook(
    page,
    file,
    [
      { source: DIARY, title: 'Make diary_patients' },
      {
        source: TRAJECTORY,
        title: 'How does pain change over week, per patient?'
      }
    ],
    { outcome: 'pain', unit: 'patient_id' }
  );
  await openAndRun(page, file);
  const trajectory = card(page, 'How does pain change over week');
  await expect(trajectory.locator('.jp-Epi-axis-title').first()).toHaveText(
    'pain',
    { timeout: 60000 }
  );
  await showColumns(page, 'diary_patients', 'treatment_arm');

  await drag(
    page,
    column(page, 'treatment_arm'),
    trajectory.locator('.jp-Epi-title')
  );
  await expect(
    option(page, 'Does treatment_arm change the trajectory of pain?')
  ).toBeVisible();
  await option(
    page,
    'The same trajectory of pain, one line per treatment_arm'
  ).click();
  const split = card(page, 'The same trajectory of pain');
  await expect(split.locator('.jp-Epi-legend')).toContainText('A', {
    timeout: 60000
  });
  await expect(split.locator('.jp-Epi-legend')).toContainText('B');

  await drag(
    page,
    column(page, 'treatment_arm'),
    card(page, 'Make diary_patients').locator('.jp-Epi-title')
  );
  await option(page, 'Plot treatment_arm against pain').click();
  const bars = card(page, 'Plot treatment_arm against pain');
  await expect(bars.locator('.jp-Epi-bar-interval')).toHaveCount(2, {
    timeout: 60000
  });
  await expect(bars).toContainText(
    'Mean pain by treatment_arm, one mean per patient'
  );
});

test('reshapes a wide diary to one row per day from a template', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/reshape.ipynb`;
  await newNotebook(page, file, [WIDE], { unit: 'patient_id' });
  await openAndRun(page, file);
  await expect(variable(page, 'diary_raw')).toBeVisible({ timeout: 60000 });

  await drag(page, variable(page, 'diary_raw'), variable(page, 'diary_raw'));
  const reshape = option(
    page,
    'Reshape diary_raw to one row per day: pain, sleep and mood'
  );
  await expect(reshape).toBeVisible();
  await expect(reshape).not.toContainText('needs AI');
  await reshape.click();
  await expect(page.locator('.jp-Epi-bench')).toContainText(
    '56 days, 8 without any value of pain, sleep or mood, left out.',
    { timeout: 60000 }
  );
  await expect(variable(page, 'diary')).toBeVisible({ timeout: 60000 });
});

test("asks the share between patients on an agent's card of the frame that holds the patients", async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/share.ipynb`;
  const agent = [
    'weekly = {}',
    'for arm, grp in diary_patients.groupby("treatment_arm"):',
    '    grp = grp.groupby("week", as_index=False)["pain"].mean()',
    '    weekly[arm] = grp',
    'weekly["A"].head()'
  ].join('\n');
  await newNotebook(
    page,
    file,
    [
      { source: DIARY, title: 'Make diary_patients' },
      { source: agent, title: 'Weekly means by arm' }
    ],
    { outcome: 'pain', unit: 'patient_id' }
  );
  await openAndRun(page, file);
  await showColumns(page, 'diary_patients', 'patient_id');
  await expect(variable(page, 'grp')).toBeVisible({ timeout: 60000 });

  await drag(
    page,
    column(page, 'patient_id'),
    card(page, 'Weekly means by arm').locator('.jp-Epi-title')
  );
  await option(
    page,
    'How much of the variation in pain lies between patients?'
  ).click();
  await expect(page.locator('.jp-Epi-bench')).toContainText(
    'of the variance of pain lies between the 12 patients',
    { timeout: 60000 }
  );
});

test('asks who is in the rows of a range picked on a trajectory, and how the arms compare there', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/range.ipynb`;
  await newNotebook(
    page,
    file,
    [
      { source: DIARY, title: 'Make diary_patients' },
      {
        source: TRAJECTORY,
        title: 'How does pain change over week, per patient?'
      }
    ],
    { outcome: 'pain', unit: 'patient_id' }
  );
  await openAndRun(page, file);
  const plot = page.locator(
    '.jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-plotout svg.jp-Epi-plot'
  );
  await expect(plot).toBeVisible({ timeout: 60000 });
  await expect(variable(page, 'diary_patients')).toBeVisible({
    timeout: 60000
  });
  await plot.scrollIntoViewIfNeeded();
  const area = (await plot.boundingBox())!;
  // From week 4 or so to the right edge, the late weeks.
  await page.mouse.move(area.x + area.width * 0.6, area.y + area.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width - 14, area.y + area.height * 0.5, {
    steps: 12
  });
  await page.mouse.up();
  await expect(
    option(page, 'How do the groups of treatment_arm compare here?')
  ).toBeVisible({ timeout: 30000 });
  await option(page, 'Who is in these rows?').click();
  await expect(page.locator('.jp-Epi-bench')).toContainText(
    /\d+ of 504 rows, 12 of 12 patients\./,
    { timeout: 60000 }
  );
});
