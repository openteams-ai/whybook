/**
 * An agent that works in another notebook (design iteration 1.69), and the
 * menu of the kernel's name (1.68, B1), in the browser against the
 * built extension.
 *
 * - "Would I get the same results in R?" in the Check-up: the agent makes
 *   an R notebook beside the first through JupyterLab's commands, the first
 *   kernel writes a frame to a file, a cell runs in R, and the comparison
 *   comes back to the first notebook as a text cell marked as the agent's.
 *   "Remove its cells and files" takes the R notebook and the file away,
 *   and Undo puts them back.
 * - With the setting "Kernel menu" off, a click on the kernel's name opens
 *   JupyterLab's dialog; on, the default, a menu with Restart kernel, three kernels,
 *   + More… and Reproduce in R, in the Whybook view and in JupyterLab's
 *   notebook view.
 *
 * No model runs: the test answers the agent's routes itself, with the tool
 * calls that a model would make. The R kernel is xeus-r, which the server
 * finds in the environment or through JUPYTER_PATH (TESTING.md); without it
 * the tests skip.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

// Each test starts a Python kernel and an R kernel.
test.describe.configure({ timeout: 240000 });

// Every kernel stops before the test's folder goes: an R kernel that a
// notebook opened again at the end would outlive the test server.
test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const sessions = (window as any).jupyterapp.serviceManager.sessions;
    await sessions.shutdownAll();
  });
});

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

/** The name of the kernelspec of R that is not in the sandbox, or null. */
async function rKernel(page: IJupyterLabPageFixture): Promise<string | null> {
  return page.evaluate(async () => {
    const specs = (window as any).jupyterapp.serviceManager.kernelspecs;
    await specs.ready;
    const found = Object.values(specs.specs?.kernelspecs ?? {}).find(
      (spec: any) =>
        spec?.language?.toLowerCase() === 'r' &&
        !spec?.metadata?.kernel_provisioner
    ) as { name: string; display_name: string } | undefined;
    return found?.name ?? null;
  });
}

function code(id: string, source: string): object {
  return {
    cell_type: 'code',
    execution_count: null,
    id,
    metadata: {},
    outputs: [],
    source
  };
}

/** A notebook whose [2] prints the mean pain, 1.25. */
async function writeNotebook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const notebook = {
    cells: [
      {
        cell_type: 'markdown',
        id: 'title',
        metadata: {},
        source: '# Visits'
      },
      code(
        'load',
        'import pandas as pd\nweekly = pd.DataFrame({"arm": ["A", "A", "B", "B"], "week": [12, 24, 12, 24], "pain": [2.5, 1.5, 0.75, 0.25]})'
      ),
      code('mean', 'print(round(weekly.pain.mean(), 4))')
    ],
    metadata: { kernelspec: KERNELSPEC },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

async function openIn(
  page: IJupyterLabPageFixture,
  file: string,
  factory: 'Whybook' | 'Notebook'
): Promise<void> {
  await page.evaluate(
    async ([file, factory]) => {
      await (window as any).jupyterapp.commands.execute('docmanager:open', {
        path: file,
        factory
      });
    },
    [file, factory] as const
  );
  await page.waitForFunction(
    file =>
      (window as any).jupyterapp.shell.currentWidget?.context?.path === file &&
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    file,
    { timeout: 120000 }
  );
}

/** The status says that a model is set up; no model runs. */
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

/** The path of the current widget of the main area. */
async function current(page: IJupyterLabPageFixture): Promise<string | null> {
  return page.evaluate(
    () => (window as any).jupyterapp.shell.currentWidget?.context?.path ?? null
  );
}

// The question "Would I get the same results in R?" is in the Check-up,
// which is off by default; the kernel menu below works with it off.
test.describe('with the Check-up on', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:checkup': { enabled: true }
    }
  });

  test('the agent makes an R notebook beside the first, runs a cell there, and brings back the comparison', async ({
    page,
    tmpPath
  }) => {
    const kernel = await rKernel(page);
    test.skip(!kernel, 'No R kernel: see TESTING.md');
    await connected(page);
    const R_NOTEBOOK = 'visits.R.ipynb';
    const R_CODE =
      'weekly <- read.csv("from_python/weekly.csv")\ncat(round(mean(weekly$pain), 4), "\\n")';
    const requests: any[] = [];
    const results: any[] = [];
    await page.route(/\/whybook\/agent(\?.*)?$/, route => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjson([
          { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
          {
            type: 'tool',
            run: 'r1',
            call: 'c1',
            name: 'new_notebook',
            input: {
              kernel,
              name: R_NOTEBOOK,
              why: 'the same analysis in R'
            }
          },
          {
            type: 'tool',
            run: 'r1',
            call: 'c2',
            name: 'share_frames',
            input: { frames: ['weekly'], notebook: R_NOTEBOOK }
          },
          {
            type: 'tool',
            run: 'r1',
            call: 'c3',
            name: 'run_cell',
            input: {
              notebook: R_NOTEBOOK,
              title: 'Mean pain, in R',
              code: R_CODE,
              why: 'the mean of [2]'
            }
          },
          {
            type: 'result',
            answer: 'The mean pain is the same in R [1] as in [2].',
            cells: ['[2]'],
            follow_up: [],
            model: 'fake/model',
            cost_usd: 0.04,
            elapsed: 12,
            comparison: {
              rows: [
                {
                  estimate: 'mean pain',
                  first: { cell: '[2]', value: '1.25' },
                  second: { cell: '[1]', value: '1.25' }
                }
              ],
              missing: []
            }
          }
        ])
      });
    });
    await page.route(/\/whybook\/agent\/result/, async route => {
      results.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, json: { ok: true } });
    });

    const file = `${tmpPath}/visits.ipynb`;
    await writeNotebook(page, file);
    await openIn(page, file, 'Whybook');
    await page.locator('.jp-Epi-runall').click();
    await expect(
      page.locator('.jp-Epi-bench .jp-Epi-cell[data-cell-id="mean"]')
    ).toContainText('1.25', { timeout: 60000 });

    // The question in the Check-up names the R kernel; nothing runs until Ask.
    const section = page.locator('.jp-Epi-exploration .jp-Epi-checkup');
    await section.locator('.jp-Epi-checkup-head').click();
    const card = section.locator('.jp-Epi-checkup-question', {
      hasText: 'Would I get the same results in R?'
    });
    await expect(card).toContainText(
      'An agent reruns the analysis in a new notebook with R 4.4.3 (xr), and compares the estimates'
    );
    expect(requests).toEqual([]);
    await card.getByRole('button', { name: 'Ask', exact: true }).click();

    // The run's steps: the notebook, the frame, and the cell in R.
    const strip = page.locator('.jp-Epi-bench .jp-Epi-agentrun').first();
    await expect(strip.locator('.jp-Epi-agentrun-status')).toHaveText(
      'Answered with 1 cell here and 1 cell in visits.R.ipynb · R 4.4.3 (xr)',
      { timeout: 120000 }
    );
    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent.compare).toEqual({
      kernel,
      display_name: 'R 4.4.3 (xr)',
      language: 'R'
    });
    expect(sent.kernels.map((item: any) => item.name)).toContain(kernel);
    expect(sent.files.map((item: any) => item.name)).toContain('visits.ipynb');
    expect(
      sent.notebook.cells.map((cell: any) => [cell.label, cell.outputs])
    ).toEqual([
      ['[1]', []],
      ['[2]', ['1.25']]
    ]);

    const [made, shared, ran] = results.map(item => item.result);
    expect(made).toMatchObject({
      status: 'ok',
      notebook: R_NOTEBOOK,
      kernel: 'R 4.4.3 (xr)',
      language: 'R',
      version: 'R 4.4.3',
      parquet: false
    });
    expect(made.packages).toContain('stats');
    expect(shared).toMatchObject({
      status: 'ok',
      folder: 'from_python',
      files: [
        {
          frame: 'weekly',
          path: 'from_python/weekly.csv',
          format: 'csv',
          rows: 4
        }
      ]
    });
    expect(ran).toMatchObject({ status: 'ok', cell: '[1]' });
    expect(ran.outputs[0].text).toContain('1.25');

    // The R notebook, beside the first, with the R kernel: its first text is
    // the agent's, and its cell ran in R. The first notebook kept the focus,
    // and the side panels and the status bar still show its Python kernel.
    expect(await current(page)).toBe(file);
    await expect(
      page.locator('#jp-main-statusbar .jp-Epi-status-runs')
    ).not.toHaveText('Parallel off');
    await expect(page.locator('#epi-exploration')).not.toContainText(
      'This kernel runs R'
    );
    const csv = await page.evaluate(
      async path =>
        (
          await (window as any).jupyterapp.serviceManager.contents.get(path, {
            content: true
          })
        ).content,
      `${tmpPath}/from_python/weekly.csv`
    );
    expect(csv.split('\n')[0]).toBe('arm,week,pain');
    await page
      .locator('.lm-TabBar-tab', { hasText: R_NOTEBOOK })
      .first()
      .click();
    await expect.poll(() => current(page)).toBe(`${tmpPath}/${R_NOTEBOOK}`);
    const rView = page.locator('.jp-Epi-bench:visible');
    await expect(rView.locator('.jp-Epi-note.jp-mod-ai')).toContainText(
      'made this notebook for the question "Would I get the same results in R?"'
    );
    await expect(rView.locator('.jp-Epi-note-by').first()).toContainText(
      'Written by the agent'
    );
    await expect(rView.locator('.jp-Epi-cell')).toContainText('1.25');
    expect(
      await page.evaluate(
        () =>
          (window as any).jupyterapp.shell.currentWidget.context.sessionContext
            .session.kernel.name
      )
    ).toBe(kernel);
    // The R notebook's view names the run and where it was asked.
    await expect(rView.locator('.jp-Epi-agentelsewhere')).toContainText(
      'asked in visits.ipynb'
    );

    // Back in the first notebook: the comparison, marked as the agent's.
    await page
      .locator('.lm-TabBar-tab', { hasText: /^visits\.ipynb/ })
      .first()
      .click();
    await expect.poll(() => current(page)).toBe(file);
    const first = page.locator('.jp-Epi-bench:visible');
    const comparison = first.locator('.jp-Epi-note.jp-mod-ai');
    await expect(comparison).toContainText(
      'Would I get the same results in R?'
    );
    await expect(comparison.locator('table')).toContainText('1.25 ([2])');
    await expect(comparison.locator('table')).toContainText('1.25 (R [1])');
    await expect(
      comparison.locator('.jp-Epi-note-by .jp-Epi-aitag')
    ).toHaveCount(1);
    // The run's strip goes with the text, with the answer in the model's words.
    await expect(comparison.locator('.jp-Epi-agentrun-answer')).toContainText(
      'The mean pain is the same in R [1] as in [2].'
    );

    // Remove takes the R notebook and the file away; Undo puts them back.
    await first
      .locator('.jp-Epi-agentrun .jp-Epi-link', {
        hasText: 'Remove its cells and files'
      })
      .click();
    // The notice's timer waits while the pointer is on it.
    const notice = page.locator('.Toastify__toast', {
      hasText: 'visits.R.ipynb and 1 file that the agent added'
    });
    await notice.hover();
    await expect(
      page.locator('.lm-TabBar-tab', { hasText: R_NOTEBOOK })
    ).toHaveCount(0);
    const exists = (path: string) =>
      page.evaluate(async path => {
        try {
          await (window as any).jupyterapp.serviceManager.contents.get(path, {
            content: false
          });
          return true;
        } catch {
          return false;
        }
      }, path);
    await expect.poll(() => exists(`${tmpPath}/${R_NOTEBOOK}`)).toBe(false);
    await expect
      .poll(() => exists(`${tmpPath}/from_python/weekly.csv`))
      .toBe(false);
    await expect(first.locator('.jp-Epi-note.jp-mod-ai')).toHaveCount(0);
    await notice.locator('.jp-toast-button', { hasText: 'Undo' }).click();
    await expect.poll(() => exists(`${tmpPath}/${R_NOTEBOOK}`)).toBe(true);
    await expect
      .poll(() => exists(`${tmpPath}/from_python/weekly.csv`))
      .toBe(true);
    await expect(
      page.locator('.lm-TabBar-tab', { hasText: R_NOTEBOOK })
    ).toHaveCount(1);
    await expect(first.locator('.jp-Epi-note.jp-mod-ai')).toHaveCount(1);
  });
});

test.describe('the kernel menu, off', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:reproduce': { kernelMenu: false }
    }
  });

  test('a click on the kernel name opens JupyterLab dialog', async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/visits.ipynb`;
    await writeNotebook(page, file);
    await openIn(page, file, 'Whybook');
    await page.locator('.jp-Epi-bench:visible').waitFor();
    await page
      .locator('.jp-NotebookPanel-toolbar, .jp-Toolbar')
      .locator('.jp-KernelName:visible')
      .first()
      .click();
    await expect(page.locator('.jp-Dialog')).toContainText('Select Kernel');
    await expect(page.locator('#jp-Epi-kernelmenu')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.jp-Dialog')).toHaveCount(0);
  });
});

test.describe('the kernel name in a narrow window', () => {
  test.use({ viewport: { width: 1440, height: 810 } });

  test('stays where a click reaches it: in the toolbar, or in its overflow menu', async ({
    page,
    tmpPath
  }) => {
    // With both side panels open, the toolbar has room for "No Kernel" but
    // not for the name of the kernel that then starts. JupyterLab's toolbar
    // measures an item once: it wrapped the longer name onto a row under the
    // notebook, where the click went to the cards.
    const file = `${tmpPath}/visits.ipynb`;
    await writeNotebook(page, file);
    await openIn(page, file, 'Whybook');
    await page.locator('.jp-Epi-bench:visible').waitFor();
    await expect(page.locator('#epi-exploration')).toBeVisible();
    const opener = page
      .locator(
        '.jp-MainAreaWidget:not(.lm-mod-hidden) .jp-Toolbar-responsive-opener'
      )
      .first();
    if (await opener.isVisible()) {
      await opener.click();
    }
    const name = page.locator('.jp-KernelName').first();
    await expect(name).toContainText('Python 3 (ipykernel)');
    // The point at the middle of the name is the name, not what covers it.
    await expect
      .poll(() =>
        name.evaluate(element => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2
          );
          return box.width > 0 && element.contains(hit);
        })
      )
      .toBe(true);
    await name.click();
    await expect(page.locator('#jp-Epi-kernelmenu')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

test.describe('the kernel menu, on by default', () => {
  test("offers Restart, the notebook's kernel with a check mark and three others, + More… and Reproduce in R, in both views", async ({
    page,
    tmpPath
  }) => {
    const kernel = await rKernel(page);
    test.skip(!kernel, 'No R kernel: see TESTING.md');
    const file = `${tmpPath}/visits.ipynb`;
    await writeNotebook(page, file);
    for (const factory of ['Whybook', 'Notebook'] as const) {
      await openIn(page, file, factory);
      const name = page.locator('.jp-KernelName:visible').first();
      await name.click();
      const menu = page.locator('#jp-Epi-kernelmenu');
      await expect(menu).toBeVisible();
      const labels = await menu
        .locator(
          '.lm-Menu-item:not(.lm-mod-hidden):not([data-type="separator"]) .lm-Menu-itemLabel'
        )
        .allTextContents();
      expect(labels[0]).toBe('Restart kernel');
      expect(labels[1]).toBe('Python 3 (ipykernel)');
      await expect(
        menu.locator('.lm-Menu-item.lm-mod-toggled .lm-Menu-itemLabel')
      ).toHaveText(['Python 3 (ipykernel)']);
      // The check mark is drawn, not only the class.
      await expect(
        menu.locator('.lm-Menu-item.lm-mod-toggled .lm-Menu-itemIcon svg')
      ).toBeVisible();
      expect(labels).toContain('R 4.4.3 (xr)');
      expect(labels.slice(2, -2)).toHaveLength(3);
      expect(labels[labels.length - 2]).toBe('+ More…');
      expect(labels[labels.length - 1]).toBe('Reproduce in R 4.4.3 (xr)');
      // No dialog opens with the menu.
      await expect(page.locator('.jp-Dialog')).toHaveCount(0);
      // + More… opens JupyterLab's own dialog.
      await menu.locator('.lm-Menu-item', { hasText: '+ More…' }).click();
      await expect(page.locator('.jp-Dialog')).toContainText('Select Kernel');
      await page.keyboard.press('Escape');
      await expect(page.locator('.jp-Dialog')).toHaveCount(0);
    }

    // From the keyboard: Enter on the name opens the menu, and a kernel of
    // it changes the notebook's kernel.
    await openIn(page, file, 'Whybook');
    const name = page.locator('.jp-KernelName:visible').first();
    await name.locator('button').focus();
    await page.keyboard.press('Enter');
    const menu = page.locator('#jp-Epi-kernelmenu');
    await expect(menu).toBeVisible();
    await menu
      .locator('.lm-Menu-item', { hasText: /^R 4\.4\.3 \(xr\)$/ })
      .click();
    await page.waitForFunction(
      kernel =>
        (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
          ?.session?.kernel?.name === kernel,
      kernel,
      { timeout: 120000 }
    );
    await expect(name).toContainText('R 4.4.3 (xr)');
  });
});
