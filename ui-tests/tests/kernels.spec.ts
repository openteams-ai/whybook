import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

/**
 * Kernels of other languages. These tests need an R kernel, such as xeus-r,
 * whose kernelspec the test server finds, for example through JUPYTER_PATH
 * (TESTING.md); without one they skip.
 */

/**
 * The name of a kernelspec whose language is R, or null. A sandboxed copy,
 * which names a kernel provisioner, is left to sandbox.spec.ts.
 */
async function rKernel(page: IJupyterLabPageFixture): Promise<string | null> {
  return page.evaluate(async () => {
    const specs = (window as any).jupyterapp.serviceManager.kernelspecs;
    await specs.ready;
    const found = Object.values(specs.specs?.kernelspecs ?? {}).find(
      (spec: any) =>
        spec?.language?.toLowerCase() === 'r' &&
        !spec?.metadata?.kernel_provisioner
    ) as { name: string } | undefined;
    return found?.name ?? null;
  });
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
  await page.mouse.move(to.x + to.width / 2, to.y + 30, { steps: 10 });
  await page.mouse.up();
}

function code(id: string, source: string, whybook?: Record<string, unknown>) {
  return {
    cell_type: 'code',
    execution_count: null,
    id,
    metadata: whybook ? { whybook } : {},
    outputs: [],
    source
  };
}

/**
 * An R notebook: a frame, a constant, two branches of one cell, the first
 * of which fails, and a cell after them.
 */
function rNotebook(kernel: string) {
  return {
    cells: [
      {
        cell_type: 'markdown',
        id: 'intro',
        metadata: {},
        source: '# Visits in R'
      },
      code(
        'load',
        [
          'visits <- data.frame(',
          '  patient_id = 1:6,',
          '  age = c(34, 51, 29, 62, 45, 38),',
          '  arm = factor(c("A", "B", "A", "B", "A", "B")),',
          '  visit = as.Date("2026-01-05") + 7 * 0:5,',
          '  improved = c(TRUE, FALSE, TRUE, TRUE, FALSE, TRUE)',
          ')',
          'min_age <- 30'
        ].join('\n')
      ),
      code(
        'adults',
        [
          'adults <- visits[visits$age >= min_age, ]',
          'cat("Mean age:", mean(adults$age), "\\n")'
        ].join('\n')
      ),
      code('older', 'stop("no visits after week 6")', {
        title: 'Visits after week 6',
        branch: { of: 'adults', letter: 'a' }
      }),
      code(
        'younger',
        'younger <- visits[visits$age < 40, ]\ncat("Younger:", nrow(younger), "\\n")',
        { title: 'Younger patients', branch: { of: 'adults', letter: 'b' } }
      ),
      code('arms', 'table(adults$arm)')
    ],
    metadata: {
      kernelspec: { display_name: 'R', language: 'R', name: kernel }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

test('an R notebook runs, lists its variables and offers questions', async ({
  page,
  tmpPath
}) => {
  const kernel = await rKernel(page);
  test.skip(!kernel, 'No R kernel: see TESTING.md');
  const file = `${tmpPath}/visits.ipynb`;
  await page.contents.uploadContent(
    JSON.stringify(rNotebook(kernel!)),
    'text',
    file
  );
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();

  // The outputs of the main cells, and of the branch that did not fail: a
  // branch without subshells runs after the one before it, whose error
  // does not stop it.
  const cell = (id: string) =>
    page.locator(`.jp-Epi-bench .jp-Epi-cell[data-cell-id="${id}"]`);
  await expect(cell('adults')).toContainText('Mean age: 46', {
    timeout: 120000
  });
  await expect(cell('younger')).toContainText('Younger: 3', {
    timeout: 60000
  });
  await expect(cell('older').locator('.jp-Epi-error')).toContainText(
    'no visits after week 6'
  );
  await expect(cell('arms')).toContainText('A B', { timeout: 60000 });

  // The status bar says why the branches did not run in parallel.
  const runs = page.locator('.jp-Epi-status-runs');
  await expect(runs).toHaveText('Parallel off');
  await expect(runs).toHaveAttribute('title', /no subshells/);

  // R's variables, and the columns of a frame with their types.
  const variable = (name: string) =>
    page.locator(`.jp-Epi-variable[data-variable="${name}"]`);
  await expect(variable('visits')).toContainText('6 × 5', { timeout: 60000 });
  await expect(variable('min_age')).toContainText('30');
  await expect(variable('adults')).toContainText('5 × 5');
  await expect(variable('younger')).toContainText('3 × 5');
  await variable('visits').click();
  const contents = page.locator('.jp-Epi-contents');
  // The list draws on the next frame after the click; evaluateAll does not wait.
  await expect(contents.locator('.jp-Epi-column')).toHaveCount(5);
  const tags = await contents
    .locator('.jp-Epi-column')
    .evaluateAll(rows =>
      rows.map(
        row =>
          `${row.querySelector('.jp-Epi-item-name')?.textContent} ${row.querySelector('.jp-Epi-column-tag')?.textContent}`
      )
    );
  expect(tags).toEqual([
    'patient_id id',
    'age num',
    'arm cat',
    'visit date',
    'improved bool'
  ]);
  await expect(
    contents.locator('.jp-Epi-column', { hasText: 'arm' })
  ).toContainText('A / B');

  // A drop offers questions, each for a model to write in R: the server
  // sends the templates' questions without their Python code.
  await drag(page, variable('visits'), cell('adults'));
  const popover = page.locator('.jp-Epi-popover');
  await expect(popover.locator('.jp-Epi-option').first()).toBeVisible({
    timeout: 30000
  });
  await expect(popover.locator('.jp-Epi-unsupported')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const exploration = page.locator('#epi-exploration');
  // The R kernel reads the columns that each cell uses (design iteration
  // 1.79): visits$age, of the four columns besides the id.
  await expect(
    exploration.locator('.jp-Epi-coverage', { hasText: 'visits' })
  ).toContainText('1 / 4');
  await expect(exploration).not.toContainText('read in a Python kernel');
  await expect(exploration).not.toContainText('Questions need');

  // The map and the Code view show the same cells.
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await expect(page.locator('.jp-Epi-map-cell')).toHaveCount(5);
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  await expect(page.locator('.jp-Epi-linear')).toContainText('Mean age: 46');
});

test.describe('With answers of one cell', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:plugin': { answers: 'cell' }
    }
  });

  test('answers a question in an R notebook with a cell in R, which the R kernel runs', async ({
    page,
    tmpPath
  }) => {
    const kernel = await rKernel(page);
    test.skip(!kernel, 'No R kernel: see TESTING.md');
    // A model is connected, and the route of the answer stands in for it.
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
          }
        }
      });
    });
    const asked: any[] = [];
    await page.route(/\/whybook\/solve(\?|$)/, async route => {
      asked.push(route.request().postDataJSON());
      const result = {
        type: 'result',
        elapsed: 0.4,
        model: 'fake/model',
        cell: {
          code: 'per_arm <- table(adults$arm)\ncat("Arms:", length(per_arm), "\\n")',
          summary: 'Counts the adults in each arm.',
          assumptions: [],
          follow_up: []
        }
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: JSON.stringify(result) + '\n'
      });
    });
    const file = `${tmpPath}/answer.ipynb`;
    await page.contents.uploadContent(
      JSON.stringify(rNotebook(kernel!)),
      'text',
      file
    );
    await openInWhybook(page, file);
    await kernelIdle(page);
    await page.locator('.jp-Epi-runall').click();
    const cell = (id: string) =>
      page.locator(`.jp-Epi-bench .jp-Epi-cell[data-cell-id="${id}"]`);
    await expect(cell('adults')).toContainText('Mean age: 46', {
      timeout: 120000
    });

    // A question typed after a drop: the model writes the cell, in R.
    await drag(
      page,
      page.locator('.jp-Epi-variable[data-variable="adults"]'),
      cell('arms')
    );
    const own = page.locator('.jp-Epi-popover .jp-Epi-own textarea');
    await expect(own).toBeEnabled({ timeout: 30000 });
    await own.fill('How many arms do the adults have?');
    await own.press('Enter');
    await expect(page.locator('.jp-Epi-bench')).toContainText('Arms: 2', {
      timeout: 60000
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].language).toBe('r');
  });
});

/**
 * The kernel "SAS (licence needed)" (research/sas_kernel in the top-level
 * repository): it shows SAS code, highlighted, and answers each cell with
 * this error.
 */
const SAS_KERNEL = 'sas-licence-needed';
const SAS_MESSAGE =
  'This kernel shows SAS code but cannot run it: running SAS needs a SAS licence and a SAS installation.';

async function hasKernelspec(
  page: IJupyterLabPageFixture,
  name: string
): Promise<boolean> {
  return page.evaluate(async (name: string) => {
    const specs = (window as any).jupyterapp.serviceManager.kernelspecs;
    await specs.ready;
    return Boolean(specs.specs?.kernelspecs?.[name]);
  }, name);
}

/**
 * The code of an execute request that the page sends over a kernel's
 * websocket, or null for any other message. JupyterLab sends JSON text, or
 * the binary v1.kernel.websocket.jupyter.org protocol: the number of
 * offsets, the offsets, then the channel, the header, the parent header,
 * the metadata and the content.
 */
function executeCode(payload: string | Buffer): string | null {
  let message: any;
  if (typeof payload === 'string') {
    try {
      message = JSON.parse(payload);
    } catch {
      return null;
    }
  } else {
    const count = Number(payload.readBigUInt64LE(0));
    const offsets = Array.from({ length: count }, (_, i) =>
      Number(payload.readBigUInt64LE(8 * (i + 1)))
    );
    const part = (i: number) =>
      payload.subarray(offsets[i], offsets[i + 1]).toString('utf8');
    message = { header: JSON.parse(part(1)), content: JSON.parse(part(4)) };
  }
  return message?.header?.msg_type === 'execute_request'
    ? String(message.content.code)
    : null;
}

/** A SAS notebook: a data step and a PROC, each with a comment, and a branch. */
function sasNotebook() {
  return {
    cells: [
      code(
        'visits',
        [
          '/* Visits by arm */',
          'data visits;',
          '  input patient_id age arm $;',
          '  datalines;',
          '1 34 A',
          '2 51 B',
          '3 62 B',
          ';',
          'run;'
        ].join('\n')
      ),
      code(
        'arms',
        [
          '* Patients per arm;',
          'proc freq data=visits;',
          '  tables arm;',
          'run;'
        ].join('\n')
      ),
      code('older', 'proc print data=visits(where=(age > 50));\nrun;', {
        title: 'Patients over 50',
        branch: { of: 'arms', letter: 'a' }
      })
    ],
    metadata: {
      kernelspec: {
        display_name: 'SAS (licence needed)',
        language: 'sas',
        name: SAS_KERNEL
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

test('a SAS notebook shows its cells highlighted and titled, and each run says why SAS does not run', async ({
  page,
  tmpPath
}) => {
  test.skip(
    !(await hasKernelspec(page, SAS_KERNEL)),
    `The test server lists no kernelspec "${SAS_KERNEL}": see TESTING.md`
  );
  // Every execute request that the page sends to a kernel.
  const sent: string[] = [];
  page.on('websocket', socket =>
    socket.on('framesent', frame => {
      const code = executeCode(frame.payload);
      if (code !== null) {
        sent.push(code);
      }
    })
  );
  const notebook = sasNotebook();
  const file = `${tmpPath}/visits.ipynb`;
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await expect(page.locator('.jp-Epi-status-runs')).toHaveText('Parallel off');

  // A cell without a title takes the text of its first SAS comment.
  const cell = (id: string) =>
    page.locator(`.jp-Epi-bench .jp-Epi-cell[data-cell-id="${id}"]`);
  await expect(cell('visits').locator('.jp-Epi-title').first()).toHaveText(
    'Visits by arm'
  );
  await expect(cell('arms').locator('.jp-Epi-title').first()).toHaveText(
    'Patients per arm'
  );
  await expect(page.locator('.jp-Epi-variables .jp-Epi-empty')).toContainText(
    'Variables are listed in a Python or R kernel. This kernel runs SAS.'
  );

  // The Code view highlights the cells with CodeMirror's SAS mode: the words
  // of the SAS comment, which Python's mode reads as names, have the colour
  // of a comment.
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  const comment = page
    .locator('.jp-Epi-linear .cm-line span', { hasText: 'Visits by arm' })
    .first();
  await expect(comment).toBeVisible();
  const [color, expected] = await comment.evaluate(span => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--jp-mirror-editor-comment-color)';
    document.body.appendChild(probe);
    const colors = [
      getComputedStyle(span).color,
      getComputedStyle(probe).color
    ];
    probe.remove();
    return colors;
  });
  expect(color).toBe(expected);
  await page.locator('.jp-Epi-views [data-value="bench"]').click();

  // A run shows the kernel's message, and the kernel stays up.
  await page.locator('.jp-Epi-runall').click();
  await expect(cell('visits').locator('.jp-Epi-error')).toContainText(
    SAS_MESSAGE,
    { timeout: 60000 }
  );
  await kernelIdle(page);

  // The page sent the kernel the code of the cells, and no code of its own.
  const sources = new Set(notebook.cells.map(item => item.source));
  expect(sent).toContain(notebook.cells[0].source);
  expect(sent.filter(code => code !== '' && !sources.has(code))).toEqual([]);
});
