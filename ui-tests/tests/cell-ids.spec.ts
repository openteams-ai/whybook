/**
 * A notebook older than nbformat 4.5 keeps the variables of its last run
 * through a reload (design iteration 1.134). Its file has no cell ids, and
 * JupyterLab gives its cells new ids at each load. Whybook keeps each
 * variable with the id of the cell that made it: with new ids it dropped the
 * variables at the next open, and marked the notebook as changed. When
 * Whybook first writes its metadata to such a notebook, it sets
 * `nbformat_minor` to 5, and JupyterLab then saves the ids.
 *
 * No model is called: the server has no model connected, and the fixture
 * aborts each request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

// The test runs the notebook in two kernels, one after the other.
test.describe.configure({ timeout: 180000 });

/** The sweep's notebook of two cells, as a file of nbformat 4.4. */
const NOTEBOOK = {
  cells: ['x = [1, 2, 3]', 'y = len(x)\ny'].map(source => ({
    cell_type: 'code',
    execution_count: null,
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
  nbformat_minor: 4
};

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
}

/**
 * Wait until the kernel of the current notebook started, and the view saw it
 * start. When the notebook opens, the view keeps the variables of the last
 * run whose cells it finds, and drops the others. It reads a kernel that it
 * saw start only after something runs in it, so nothing else drops them.
 */
async function started(page: IJupyterLabPageFixture): Promise<void> {
  await page.waitForFunction(
    () => {
      const widget = (window as any).jupyterapp.shell.currentWidget;
      return (
        widget?.context?.sessionContext?.session?.kernel?.status === 'idle' &&
        widget.content.model.bridge.startedEmpty
      );
    },
    null,
    { timeout: 120000 }
  );
}

test('a notebook of nbformat 4.4 lists the variables of its last run after a reload with a new kernel, and opens unchanged', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/v44.ipynb`;
  await page.contents.uploadContent(JSON.stringify(NOTEBOOK), 'text', file);
  await openInWhybook(page, file);
  await started(page);
  const names = page.locator('.jp-Epi-variable .jp-Epi-item-name');
  await page.locator('.jp-Epi-runall').click();
  await expect(names).toHaveText(['x', 'y'], { timeout: 60000 });
  await page.evaluate(() =>
    (window as any).jupyterapp.commands.execute('docmanager:save')
  );
  const dirty = () =>
    page.evaluate(
      () => (window as any).jupyterapp.shell.currentWidget.context.model.dirty
    );
  await expect.poll(dirty).toBe(false);
  // The file holds nbformat 4.5 and an id for each cell.
  const saved = await page.evaluate(
    async (file: string) =>
      (
        await (window as any).jupyterapp.serviceManager.contents.get(file, {
          content: true
        })
      ).content,
    file
  );
  expect(saved.nbformat_minor).toBe(5);
  expect(saved.cells.every((cell: any) => typeof cell.id === 'string')).toBe(
    true
  );

  // Close the notebook, shut its kernel down, and open it again.
  await page.evaluate(() => {
    (window as any).jupyterapp.shell.currentWidget.close();
  });
  await page.kernel.shutdownAll();
  await openInWhybook(page, file);
  await started(page);
  await expect(names).toHaveText(['x', 'y']);
  await expect(page.locator('.jp-Epi-stale-note').first()).toContainText(
    '2 from the last run, not in the kernel.'
  );
  // The tab of the notebook has no mark of a change.
  expect(await dirty()).toBe(false);
  await expect(
    page.locator('.lm-DockPanel-tabBar .lm-TabBar-tab.jp-mod-current')
  ).not.toHaveClass(/jp-mod-dirty/);
});
