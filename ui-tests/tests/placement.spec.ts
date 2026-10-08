/**
 * Where new cells go (design iteration 1.74), in the browser against the
 * built extension:
 *
 * - The pain diary: three agents' runs asked about the same columns. Each
 *   run's cells go after the cells that ran before it, so the notebook runs
 *   from the top after a restart. Before, the second and third runs went
 *   after [2], above the first run's cells that they read, and Run all
 *   failed with NameError (pain 1).
 * - The home energy data: a template asked about the first cell of an
 *   agent's run goes after the run's last cell, the list says so before the
 *   click, and the Check-up finds no cell run after cells below it
 *   (energy 3).
 * - The questions that a model wrote for a request, asked again later, show
 *   the same place as the templates beside them (pain 10).
 *
 * No model is called: each test answers the routes of the model and of the
 * agent itself, with the tool calls that a model could make.
 */
import * as path from 'path';

import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

// The runs run cells in a kernel, and the first test restarts it.
test.describe.configure({ timeout: 240000 });

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as any).jupyterapp.serviceManager.sessions.shutdownAll();
  });
});

const EXAMPLES = path.resolve(__dirname, '..', '..', 'examples');

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

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

async function kernelIdle(page: IJupyterLabPageFixture): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
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
  await kernelIdle(page);
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
    { timeout: 180000, polling: 200 }
  );
}

async function runAll(page: IJupyterLabPageFixture): Promise<void> {
  await page.locator('.jp-Epi-runall').click();
  await ran(page);
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

/** A stream of newline-delimited JSON events, as the server sends them. */
function ndjson(events: object[]): string {
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}

/** The model's questions for each drop: these, in the server's order. */
async function modelQuestions(
  page: IJupyterLabPageFixture,
  questions: object[] = []
): Promise<{ requests: number }> {
  const seen = { requests: 0 };
  await page.route(/\/whybook\/questions\/claude(\?|$)/, async route => {
    seen.requests++;
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        {
          type: 'result',
          elapsed: 0.4,
          model: 'fake/model',
          cost_usd: 0.01,
          questions,
          outcomes: [],
          units: [],
          order: null
        }
      ])
    });
  });
  return seen;
}

/** The agent's routes: each run adds and runs its cells, one tool call each, then answers. */
async function agentRuns(
  page: IJupyterLabPageFixture,
  runs: { title: string; code: string }[][]
): Promise<void> {
  let next = 0;
  await page.route(/\/whybook\/agent(\?.*)?$/, route => {
    const run = `r${next + 1}`;
    const cells = runs[next++] ?? [];
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson([
        { type: 'started', run, keep_local: false, elapsed: 0 },
        ...cells.map((cell, index) => ({
          type: 'tool',
          run,
          call: `${run}-${index}`,
          name: 'run_cell',
          input: { title: cell.title, code: cell.code, why: '' }
        })),
        {
          type: 'result',
          answer: `Run ${next} answered.`,
          cells: [],
          follow_up: [],
          model: 'fake/model',
          provider: 'openrouter',
          cost_usd: 0.03,
          elapsed: 5
        }
      ])
    });
  });
  await page.route(/\/whybook\/agent\/result/, route =>
    route.fulfill({ status: 200, json: { ok: true } })
  );
}

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
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

/** Drop one column of a frame onto another, in Contents. */
async function dropColumns(
  page: IJupyterLabPageFixture,
  frame: string,
  source: string,
  target: string
): Promise<void> {
  await variable(page, frame).click();
  await expect(column(page, target)).toBeVisible();
  await drag(page, column(page, source), column(page, target));
  await expect(popover(page)).toBeVisible();
}

/** The agent's run and the template of each cell, in the notebook's order. */
async function writers(page: IJupyterLabPageFixture): Promise<string[]> {
  return page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const found: string[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      const meta = model.cells.get(i).getMetadata('whybook') ?? {};
      found.push(meta.agent?.run || (meta.template ? 'template' : 'analyst'));
    }
    return found;
  });
}

/** The errors in the outputs of the notebook's cells: "[7] NameError: ...". */
async function errors(page: IJupyterLabPageFixture): Promise<string[]> {
  return page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const found: string[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      const cell = model.cells.get(i);
      for (const output of cell.toJSON().outputs ?? []) {
        if (output.output_type === 'error') {
          found.push(
            `[${cell.executionCount}] ${output.ename}: ${output.evalue}`
          );
        }
      }
    }
    return found;
  });
}

// The pain diary notebook of the first pass: the template that loads
// visits, the template of week and analgesic_dose_mg, and then the cells of
// the agent's runs, as the tester's notebook holds them.
const LOAD_VISITS =
  'import sqlite3\nfrom contextlib import closing\n\nimport pandas as pd\n\nwith closing(sqlite3.connect("file:clinic.sqlite?mode=ro", uri=True)) as _db:\n    _frame = pd.read_sql_query(\'SELECT * FROM "visits"\', _db)\nvisits = _frame\ndel _frame\nvisits.head()';
const WITHIN =
  '# Are week and analgesic_dose_mg associated, within or between patients?\nimport whybook\n\nwhybook.within_between(visits, "week", "analgesic_dose_mg", group="patient_id")';
const RUN_1 = [
  {
    title: 'Inspect sqlite tables',
    code: 'import sqlite3\nconn = sqlite3.connect("clinic.sqlite")\ntables = conn.execute("select name from sqlite_master where type=\'table\'").fetchall()\ntables'
  },
  {
    title: 'Check sites and visits schema',
    code: 'print(conn.execute("PRAGMA table_info(sites)").fetchall())\nimport pandas as pd\npd.read_sql("select * from sites limit 5", conn)'
  }
];
// Run 2 reads tables and conn, which only run 1 makes.
const RUN_2 = [
  {
    title: 'Check sqlite tables for treatment arm',
    code: 'import pandas as pd\nfor t in tables:\n    name = t[0]\n    df = pd.read_sql(f"SELECT * FROM {name} LIMIT 5", conn)\n    print(name, df.columns.tolist())'
  },
  {
    title: 'Count the sites',
    code: 'pd.read_sql("select count(*) as sites from sites", conn)'
  }
];
const RUN_3 = [
  {
    title: 'Per-patient slope of dose vs week',
    code: "import numpy as np\n\ndef slope(g):\n    if g['week'].nunique() < 2:\n        return np.nan\n    return np.polyfit(g['week'], g['analgesic_dose_mg'], 1)[0]\n\nslopes = visits.groupby('patient_id').apply(slope, include_groups=False)\nslopes.describe()"
  },
  {
    title: 'Visits per patient and slope sign counts',
    code: "visits_per_patient = visits.groupby('patient_id').size()\nprint(visits_per_patient.describe())\nprint((slopes > 0).sum(), (slopes < 0).sum())"
  }
];

test.describe('the pain diary', () => {
  test('runs from the top after a restart, with each run after the runs before it', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    await modelQuestions(page);
    await agentRuns(page, [RUN_1, RUN_2, RUN_3]);
    await page.contents.uploadFile(
      path.join(EXAMPLES, 'pain_diary', 'clinic.sqlite'),
      `${tmpPath}/clinic.sqlite`
    );
    const file = `${tmpPath}/pain.ipynb`;
    await newNotebook(page, file, [
      { source: LOAD_VISITS, meta: { template: true } },
      { source: WITHIN, meta: { template: true } }
    ]);
    await openInWhybook(page, file);
    await runAll(page);

    // Three questions typed in the list of week and analgesic_dose_mg,
    // which the server places after [2], the last cell that uses both.
    const questions = [
      'Which tables does clinic.sqlite hold?',
      'Does treatment arm moderate how crp_mg_l changes over week?',
      'How does analgesic_dose_mg evolve over the weeks, per patient?'
    ];
    for (const question of questions) {
      await dropColumns(page, 'visits', 'week', 'analgesic_dose_mg');
      const own = popover(page).locator('.jp-Epi-own textarea');
      await own.fill(question);
      await own.press('Enter');
      await expect(
        page.locator('.jp-Epi-bench .jp-Epi-agentrun', { hasText: question })
      ).toBeVisible();
      await ran(page);
    }
    expect(await errors(page)).toEqual([]);

    // Restart the kernel and Run all, as the tester did.
    await page.evaluate(() =>
      (
        window as any
      ).jupyterapp.shell.currentWidget.context.sessionContext.restartKernel()
    );
    await kernelIdle(page);
    await runAll(page);
    // The cells ran from the top, each once.
    expect(
      await page.evaluate(() =>
        (window as any).jupyterapp.shell.currentWidget.content.model
          .codeCells()
          .map((cell: any) => cell.label)
      )
    ).toEqual(['[1]', '[2]', '[3]', '[4]', '[5]', '[6]', '[7]', '[8]']);
    expect(await errors(page)).toEqual([]);
    await expect(
      page.locator('.jp-Epi-bench .jp-Epi-cell', { hasText: 'NameError' })
    ).toHaveCount(0);

    // Read from the top, the runs come in the order they ran, and each run
    // keeps its own strip, above its cells.
    expect(await writers(page)).toEqual([
      'template',
      'template',
      'r1',
      'r1',
      'r2',
      'r2',
      'r3',
      'r3'
    ]);
    await expect(page.locator('.jp-Epi-bench .jp-Epi-agentrun')).toHaveCount(3);
  });
});

// The home energy notebook of the first pass, in small: readings joined to
// homes, then an agent's run of four cells that cleans the rows and builds
// the peak share.
const READINGS =
  'import pandas as pd\n\nreadings = pd.DataFrame({"home_id": ["H1", "H1", "H2", "H2", "H3", "H3", "H4", "H4"], "date": ["2025-01-01", "2025-07-01"] * 4, "kwh_import": [20.1, 18.0, 999.9, 11.2, 13.3, 12.0, 25.5, 19.9], "kwh_peak": [4.7, 3.1, 4.4, 2.0, 3.0, 2.2, 6.1, 3.0]})\nreadings.head()';
const JOIN =
  'homes = pd.DataFrame({"home_id": ["H1", "H2", "H3", "H4"], "tariff": ["flat", "time of use", "flat", "time of use"], "has_ev": [False, True, False, True]})\nreadings_homes = readings.merge(homes, on="home_id", how="left")\nreadings_homes.head()';
const ENERGY_RUN = [
  'df = readings_homes[(readings_homes.kwh_import < 999) & readings_homes.tariff.notna() & readings_homes.has_ev.notna()].copy()\ndf["peak_share"] = df.kwh_peak / df.kwh_import\ndf.shape',
  'switched = df[df.tariff == "time of use"].home_id.unique()\nlen(switched)',
  'cutoff = pd.Timestamp("2025-06-01")\ncutoff',
  'did = df.groupby([df.home_id.isin(switched), pd.to_datetime(df.date) >= cutoff]).peak_share.mean()\ndid'
];

test.use({
  mockSettings: {
    ...galata.DEFAULT_SETTINGS,
    'whybook:checkup': { enabled: true }
  }
});

test.describe('the home energy data', () => {
  test("puts a template asked about a cell of an agent's run after the run, says so before the click, and the Check-up finds nothing run out of order", async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    await modelQuestions(page);
    const file = `${tmpPath}/energy.ipynb`;
    await newNotebook(page, file, [
      { source: READINGS, meta: { template: true } },
      { source: JOIN, meta: { template: true } },
      ...ENERGY_RUN.map((source, index) => ({
        source,
        meta: {
          title: `Step ${index + 1}`,
          written_by: 'agent',
          agent: { run: 'r2', step: index + 1 }
        }
      }))
    ]);
    await openInWhybook(page, file);
    await runAll(page);

    // tariff and has_ev: the last cell that uses both is the run's first, [3].
    await dropColumns(page, 'readings_homes', 'tariff', 'has_ev');
    const option = popover(page).locator('.jp-Epi-option', {
      hasText: 'Are tariff and has_ev independent?'
    });
    await expect(option.locator('.jp-Epi-placement')).toHaveText(
      'new cell after [6]'
    );
    await option.click();
    await ran(page);
    expect(await writers(page)).toEqual([
      'template',
      'template',
      'r2',
      'r2',
      'r2',
      'r2',
      'template'
    ]);
    // The strip shows above the new cell, under the run's last cell.
    const strip = page.locator(
      '.jp-Epi-bench .jp-Epi-cell[data-cell-id="cell-5"] .jp-Epi-strip'
    );
    await expect(strip.locator('.jp-Epi-strip-action')).toHaveText(
      'Added [7] after [6]'
    );
    await expect(strip).toBeInViewport();

    // The Check-up finds no cell that ran after cells below it.
    const head = page.locator(
      '.jp-Epi-exploration .jp-Epi-checkup .jp-Epi-checkup-head'
    );
    await head.scrollIntoViewIfNeeded();
    await head.click();
    const body = page.locator('.jp-Epi-exploration .jp-Epi-checkup-body');
    await expect(body.locator('.jp-Epi-checkup-name').first()).toHaveText(
      'Reproduce'
    );
    await expect(body).not.toContainText('ran after');
  });
});

test.describe('the questions of a model for a request asked again', () => {
  test('show the same place as the templates beside them', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const model = await modelQuestions(page, [
      {
        id: 'claude:taken',
        text: 'Is analgesic_dose_mg recorded as prescribed or as taken?',
        type: 'quality',
        origin: 'claude',
        template: null,
        variables: [],
        probability: 0.8,
        reasons: ['The model says why'],
        effect: '',
        placement: null,
        code: null,
        action: null
      }
    ]);
    const file = `${tmpPath}/again.ipynb`;
    await newNotebook(page, file, [
      {
        source:
          'import pandas as pd\n\nvisits = pd.DataFrame({"patient_id": ["P1", "P1", "P1", "P2", "P2", "P2", "P3", "P3"], "week": [0, 4, 9, 0, 5, 11, 0, 6], "analgesic_dose_mg": [150, 150, 100, 250, 300, 300, 200, 150]})\nvisits.head()',
        meta: { template: true }
      }
    ]);
    await openInWhybook(page, file);
    await runAll(page);

    const placements = popover(page).locator(
      '.jp-Epi-option .jp-Epi-placement'
    );
    await dropColumns(page, 'visits', 'week', 'analgesic_dose_mg');
    await expect(popover(page)).toContainText(
      'Is analgesic_dose_mg recorded as prescribed or as taken?'
    );
    expect(model.requests).toBe(1);
    // A template adds [2], which uses both columns.
    await popover(page)
      .locator('.jp-Epi-option', {
        hasText:
          'Are week and analgesic_dose_mg associated, within or between patients?'
      })
      .click();
    await ran(page);
    // The kernel's analysis of [2] has come: the server places the
    // questions of the next drop after [2].
    await page.waitForFunction(
      () =>
        (window as any).jupyterapp.shell.currentWidget.content.model
          .codeCells()[1]
          ?.analysis?.uses?.includes('visits'),
      null,
      { timeout: 60000, polling: 200 }
    );

    // The same drop again: the model's question comes from the cache.
    await dropColumns(page, 'visits', 'week', 'analgesic_dose_mg');
    const cached = popover(page).locator('.jp-Epi-option', {
      hasText: 'Is analgesic_dose_mg recorded as prescribed or as taken?'
    });
    await expect(cached).toBeVisible();
    expect(model.requests).toBe(1);
    const template = popover(page).locator('.jp-Epi-option', {
      hasText: 'Is the relation between week and analgesic_dose_mg linear?'
    });
    const where = await template.locator('.jp-Epi-placement').textContent();
    expect(where).toMatch(/after \[2\]$/);
    await expect(cached.locator('.jp-Epi-placement')).toHaveText(where!);
    // Every question that adds a cell names the same place.
    const shown = await placements.allTextContents();
    expect(
      shown
        .filter(text => /^(a )?new cell/.test(text))
        .every(text => text === where)
    ).toBe(true);
  });
});
