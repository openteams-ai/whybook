/**
 * The templates of a unit's id, a time index and dates (design iteration 1.75).
 *
 * - A unit's id and a time index are no causes: a drop of week onto a dose
 *   offers the dose over the weeks, a line per patient, and no causal
 *   question; patient_id onto the dose offers the share of the variance
 *   between patients, the ICC, with the result in words, where a describe()
 *   of every patient answered before.
 * - The meaning of the rows of within and between shows in full.
 * - The quick look at a number gives its numbers, and at an id the units
 *   with the fewest rows.
 * - A column of dates onto a number offers its profile by hour of day and
 *   weekday, and no "levels of timestamp".
 * - A CSV file next to the notebook loads its ISO dates as dates.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

const VISITS = [
  'import numpy as np\nimport pandas as pd\n\nrng = np.random.default_rng(7)\nvisits = pd.DataFrame({\n    "patient_id": np.repeat([f"P{i:03d}" for i in range(12)], 5),\n    "week": np.tile([0, 4, 8, 12, 16], 12),\n    "analgesic_dose_mg": (np.round((np.repeat(rng.normal(200, 60, 12), 5) + rng.normal(0, 40, 60)) / 50) * 50).clip(0, 400).astype(int),\n})\nvisits.head()'
];

const HALF_HOURLY = [
  'import pandas as pd\n\nstamps = pd.date_range("2025-02-10", periods=48 * 14, freq="30min")\nhalf_hourly = pd.DataFrame({"home_id": ["H1"] * len(stamps), "timestamp": stamps, "kwh": 0.2 + 0.6 * ((stamps.hour >= 16) & (stamps.hour < 19)) + stamps.minute / 3000})\nhalf_hourly.head()'
];

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

test('offers the dose over the weeks with a line per patient, and no question that takes the week or the patient as a cause', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/trajectory.ipynb`;
  await newNotebook(page, file, VISITS);
  await openAndRun(page, file);
  await showColumns(page, 'visits', 'week');

  await drag(page, column(page, 'week'), column(page, 'analgesic_dose_mg'));
  const trajectory = popover(page).locator('.jp-Epi-option', {
    hasText: 'How does analgesic_dose_mg change over week, per patient?'
  });
  await expect(trajectory).toBeVisible();
  await expect(
    texts(page).filter({
      hasText: 'How many rows does each patient have in visits?'
    })
  ).toHaveCount(1);
  await expect(
    texts(page).filter({
      hasText: /causal path|other way round|What else could explain/
    })
  ).toHaveCount(0);

  await trajectory.click();
  // The new card draws a thin line for each of the 12 patients under the mean.
  await expect(page.locator('.jp-Epi-bench .jp-Epi-plot-unitline')).toHaveCount(
    12,
    { timeout: 60000 }
  );
});

test('answers patient_id onto a dose with the share between patients in words, and shows the meaning of within and between in full', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/share.ipynb`;
  await newNotebook(page, file, VISITS);
  await openAndRun(page, file);
  await showColumns(page, 'visits', 'patient_id');

  await drag(
    page,
    column(page, 'patient_id'),
    column(page, 'analgesic_dose_mg')
  );
  const share = popover(page).locator('.jp-Epi-option', {
    hasText:
      'How much of the variation in analgesic_dose_mg lies between patients?'
  });
  await expect(share).toBeVisible();
  await expect(texts(page).filter({ hasText: 'levels of' })).toHaveCount(0);
  await share.click();
  await expect(page.locator('.jp-Epi-bench')).toContainText(
    'of the variance of analgesic_dose_mg lies between the 12 patients',
    { timeout: 60000 }
  );

  await drag(page, column(page, 'week'), column(page, 'analgesic_dose_mg'));
  await popover(page)
    .locator('.jp-Epi-option', {
      hasText:
        'Are week and analgesic_dose_mg associated, within or between patients?'
    })
    .click();
  // pandas cut each meaning at 50 characters, with "...".
  await expect(page.locator('.jp-Epi-bench')).toContainText(
    'when a patient is above its own mean week, is analgesic_dose_mg too?',
    { timeout: 60000 }
  );
});

test('gives the numbers of a number in its quick look, and the patients with the fewest rows in the quick look at an id', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/quicklook.ipynb`;
  await newNotebook(page, file, VISITS);
  await openAndRun(page, file);
  await showColumns(page, 'visits', 'analgesic_dose_mg');

  await drag(
    page,
    column(page, 'analgesic_dose_mg'),
    column(page, 'analgesic_dose_mg')
  );
  // One question on the shape of the dose, where three asked it.
  await expect(texts(page).filter({ hasText: /ransform|normal/ })).toHaveCount(
    1
  );
  await popover(page)
    .locator('.jp-Epi-option', {
      hasText: 'Summarise analgesic_dose_mg: distribution and missingness'
    })
    .click();
  const preview = page.locator('.jp-Epi-preview');
  await expect(preview.locator('table')).toContainText('median', {
    timeout: 60000
  });
  await expect(preview.locator('table')).toContainText('lowest');
  await expect(preview.locator('table')).toContainText('highest');
  await preview.getByRole('button', { name: 'Close the answer' }).click();

  await drag(page, column(page, 'patient_id'), column(page, 'patient_id'));
  await expect(texts(page).filter({ hasText: 'ransform' })).toHaveCount(0);
  await popover(page)
    .locator('.jp-Epi-option', {
      hasText: 'Summarise patient_id: rows per patient'
    })
    .click();
  await expect(preview).toContainText('12 patients in 60 rows.', {
    timeout: 60000
  });
  await expect(preview).toContainText('Rows per patient: 5 each');
});

test('offers the profile of a reading by hour of day and weekday for a column of dates, and no levels of it', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/profile.ipynb`;
  await newNotebook(page, file, HALF_HOURLY);
  await openAndRun(page, file);
  await showColumns(page, 'half_hourly', 'timestamp');

  await drag(page, column(page, 'timestamp'), column(page, 'kwh'));
  const profile = popover(page).locator('.jp-Epi-option', {
    hasText: 'How does kwh vary by hour of day and by weekday?'
  });
  await expect(profile).toBeVisible();
  await expect(
    texts(page).filter({
      hasText: /levels of timestamp|causal path|other way round/
    })
  ).toHaveCount(0);
  await profile.click();
  await expect(page.locator('.jp-Epi-bench')).toContainText(
    'Mean kwh by hour of day: highest at 16:30 (0.81), lowest at 00:00 (0.2).',
    { timeout: 60000 }
  );
});

test('loads the ISO dates of a CSV file next to the notebook as dates', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    'home_id,tariff,tou_start\nH1,flat,\nH2,time of use,2025-03-14\nH3,time of use,2025-04-02\n',
    'text',
    `${tmpPath}/homes.csv`
  );
  await page.evaluate(
    cwd =>
      (window as any).jupyterapp.commands
        .execute('whybook:new-epinotebook', { cwd })
        .then(() => null),
    tmpPath
  );
  const start = page.locator('.jp-Epi-start');
  await start.locator('.jp-Epi-start-file', { hasText: 'homes.csv' }).click();
  const load = popover(page)
    .locator('.jp-Epi-option', { hasText: 'Load homes.csv' })
    .first();
  await expect(load).toContainText('with tou_start as dates');
  await load.click();
  // A new Whybook opens beside the file browser: the Contents are in the view's own panel.
  await page
    .getByRole('tab', { name: 'Whybook: variables and questions' })
    .click();
  await showColumns(page, 'homes', 'tou_start');
  await expect(
    column(page, 'tou_start').locator('.jp-Epi-column-tag')
  ).toHaveText('date');
});
