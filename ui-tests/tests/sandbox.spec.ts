import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { execFileSync } from 'child_process';

import { expect, test } from './fixtures';

/**
 * The view against the sandboxed kernels (whybook/sandbox): the kernelspec
 * "Python 3 (sandboxed)" runs ipykernel under bubblewrap, and the sandboxed
 * copy of an R kernelspec, which `python -m whybook.sandbox xr` writes, runs
 * xeus-r there. Each test needs bubblewrap, and a test server that lists its
 * kernelspec: an install of the package brings the Python one with the
 * provisioner's entry point, and JUPYTER_PATH finds the R one; without
 * either a test skips (TESTING.md).
 */

const KERNEL = 'python3-sandboxed';

/**
 * Why bubblewrap cannot run on this machine, or null. The test server runs
 * on the same machine as the test.
 */
function bubblewrapProblem(): string | null {
  if (process.platform !== 'linux') {
    return 'bubblewrap runs on Linux';
  }
  try {
    execFileSync(
      'bwrap',
      [
        '--unshare-all',
        '--ro-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        'true'
      ],
      { stdio: 'pipe' }
    );
    return null;
  } catch (error: any) {
    return `bubblewrap cannot run here: ${String(error.stderr ?? error.message)}`;
  }
}

async function hasKernelspec(page: IJupyterLabPageFixture): Promise<boolean> {
  return page.evaluate(async (name: string) => {
    const specs = (window as any).jupyterapp.serviceManager.kernelspecs;
    await specs.ready;
    return Boolean(specs.specs?.kernelspecs?.[name]);
  }, KERNEL);
}

/** The name of an R kernelspec that the sandbox's provisioner runs, or null. */
async function sandboxedR(
  page: IJupyterLabPageFixture
): Promise<string | null> {
  return page.evaluate(async () => {
    const specs = (window as any).jupyterapp.serviceManager.kernelspecs;
    await specs.ready;
    const found = Object.values(specs.specs?.kernelspecs ?? {}).find(
      (spec: any) =>
        spec?.language?.toLowerCase() === 'r' &&
        spec?.metadata?.kernel_provisioner?.provisioner_name ===
          'whybook-sandbox'
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

function code(id: string, source: string[], epi?: Record<string, unknown>) {
  return {
    cell_type: 'code',
    execution_count: null,
    id,
    metadata: epi ? { epi } : {},
    outputs: [],
    source: source.join('\n')
  };
}

/**
 * A frame and a constant, a cell that writes a file in the notebook's folder,
 * a branch that prints whether it runs off the main thread, as a subshell does,
 * and a cell that lists the kernel's network interfaces.
 */
function sandboxNotebook() {
  return {
    cells: [
      code('load', [
        'import pandas as pd',
        'visits = pd.DataFrame({',
        '    "patient_id": [1, 2, 3, 4],',
        '    "age": [34, 51, 29, 62],',
        '    "pain": [3, 5, 2, 6],',
        '})',
        'min_age = 30'
      ]),
      code('adults', [
        'adults = visits[visits["age"] >= min_age]',
        'adults.to_csv("adults.csv", index=False)',
        'print("Adults:", len(adults))'
      ]),
      code(
        'older',
        [
          'import threading',
          'older = visits[visits["age"] > 50]',
          'print("In a subshell:", threading.current_thread() is not threading.main_thread())'
        ],
        { title: 'Older patients', branch: { of: 'adults', letter: 'a' } }
      ),
      code('network', [
        'import socket',
        'print("Interfaces:", [name for _, name in socket.if_nameindex()])'
      ])
    ],
    metadata: {
      kernelspec: {
        display_name: 'Python 3 (sandboxed)',
        language: 'python',
        name: KERNEL
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

test('runs a notebook in the sandboxed kernel, with its variables and a branch in a subshell', async ({
  page,
  tmpPath
}) => {
  const problem = bubblewrapProblem();
  test.skip(problem !== null, problem ?? '');
  test.skip(
    !(await hasKernelspec(page)),
    `The test server lists no kernelspec "${KERNEL}": see TESTING.md`
  );
  const file = `${tmpPath}/sandboxed.ipynb`;
  await page.contents.uploadContent(
    JSON.stringify(sandboxNotebook()),
    'text',
    file
  );
  await openInWhybook(page, file);
  await kernelIdle(page);
  // The kernel in the sandbox has subshells, so branches run in parallel.
  await expect(page.locator('.jp-Epi-status-runs')).toHaveText('Parallel 0/8');
  await page.locator('.jp-Epi-runall').click();

  const cell = (id: string) =>
    page.locator(`.jp-Epi-bench .jp-Epi-cell[data-cell-id="${id}"]`);
  await expect(cell('adults')).toContainText('Adults: 3', {
    timeout: 120000
  });
  await expect(cell('older')).toContainText('In a subshell: True', {
    timeout: 60000
  });
  // The sandbox's network is its own loopback.
  await expect(cell('network')).toContainText("Interfaces: ['lo']", {
    timeout: 60000
  });

  // The Variables panel lists what the cells and the branch made.
  const variable = (name: string) =>
    page.locator(`.jp-Epi-variable[data-variable="${name}"]`);
  await expect(variable('visits')).toContainText('4 × 3', { timeout: 60000 });
  await expect(variable('min_age')).toContainText('30');
  await expect(variable('older')).toContainText('2 × 3');

  // The file that the kernel wrote is at the same path for the server.
  expect(await page.contents.fileExists(`${tmpPath}/adults.csv`)).toBe(true);
});

/**
 * An R notebook: a frame and a constant, a cell that writes a file in the
 * notebook's folder, a branch, and a cell that tries the port of the Jupyter
 * server on the host's 127.0.0.1, which a kernel outside the sandbox reaches.
 */
function rNotebook(kernel: string, port: string) {
  return {
    cells: [
      code('load', [
        'visits <- data.frame(',
        '  patient_id = 1:4,',
        '  age = c(34, 51, 29, 62),',
        '  pain = c(3, 5, 2, 6)',
        ')',
        'min_age <- 30'
      ]),
      code('adults', [
        'adults <- visits[visits$age >= min_age, ]',
        'write.csv(adults, "adults.csv", row.names = FALSE)',
        'cat("Adults:", nrow(adults), "\\n")'
      ]),
      code(
        'older',
        [
          'older <- visits[visits$age > 50, ]',
          'cat("Older:", nrow(older), "\\n")'
        ],
        { title: 'Older patients', branch: { of: 'adults', letter: 'a' } }
      ),
      code('network', [
        `reached <- tryCatch({close(socketConnection("127.0.0.1", ${port}, timeout = 3)); "yes"},`,
        '  error = function(e) "no", warning = function(w) "no")',
        'cat("Server reached:", reached, "\\n")'
      ])
    ],
    metadata: {
      kernelspec: { display_name: 'R (sandboxed)', language: 'R', name: kernel }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

test('runs an R notebook in the sandboxed R kernel, with its variables and no network', async ({
  page,
  tmpPath
}) => {
  const problem = bubblewrapProblem();
  test.skip(problem !== null, problem ?? '');
  const kernel = await sandboxedR(page);
  test.skip(
    !kernel,
    'The test server lists no sandboxed R kernelspec: see TESTING.md'
  );
  const port = new URL(page.url()).port;
  const file = `${tmpPath}/visits-r.ipynb`;
  await page.contents.uploadContent(
    JSON.stringify(rNotebook(kernel!, port)),
    'text',
    file
  );
  await openInWhybook(page, file);
  await kernelIdle(page);
  // xeus-r has no subshells, in the sandbox as outside it.
  await expect(page.locator('.jp-Epi-status-runs')).toHaveText('Parallel off');
  await page.locator('.jp-Epi-runall').click();

  const cell = (id: string) =>
    page.locator(`.jp-Epi-bench .jp-Epi-cell[data-cell-id="${id}"]`);
  await expect(cell('adults')).toContainText('Adults: 3', {
    timeout: 120000
  });
  await expect(cell('older')).toContainText('Older: 2', { timeout: 60000 });
  await expect(cell('network')).toContainText('Server reached: no', {
    timeout: 60000
  });

  // The Variables panel lists R's variables, from the view's R code.
  const variable = (name: string) =>
    page.locator(`.jp-Epi-variable[data-variable="${name}"]`);
  await expect(variable('visits')).toContainText('4 × 3', { timeout: 60000 });
  await expect(variable('min_age')).toContainText('30');
  await expect(variable('older')).toContainText('2 × 3');

  // The file that R wrote is at the same path for the server.
  expect(await page.contents.fileExists(`${tmpPath}/adults.csv`)).toBe(true);
});
