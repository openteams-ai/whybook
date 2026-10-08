/**
 * Design iterations 1.55 and 1.56, in the browser against
 * the built extension:
 *
 * - 1.56: an agent's run that goes on after its Whybook view closes shows in
 *   JupyterLab's Running panel, with Stop, and in a small status bar item;
 *   a view opened again on the notebook shows the run's strip.
 * - 1.55: an answer whose cell the analyst deletes while the model writes it
 *   waits in a strip where the cell was, and nothing runs until the analyst
 *   puts it back with its cell or alone; the strip has Stop while the model
 *   writes, and a closed answer in the sidebar does not run its code.
 *
 * No model runs: each test answers the routes of the model itself.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

// Each test runs the cells of its notebook in a kernel first.
test.describe.configure({ timeout: 180000 });

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

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

async function writeNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  cells: object[]
): Promise<void> {
  const notebook = {
    cells,
    metadata: { kernelspec: KERNELSPEC },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
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

/** Run every cell of the view, and wait until none runs. */
async function runAll(page: IJupyterLabPageFixture, cells: number) {
  await page.locator('.jp-Epi-runall').click();
  await expect(page.locator('.jp-Epi-cell .jp-Epi-label')).toHaveText(
    Array.from({ length: cells }, (_, index) => `[${index + 1}]`),
    { timeout: 60000 }
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

/** A promise that the test lets go when it wants. */
function gate(): { closed: Promise<void>; open: () => void } {
  let open!: () => void;
  const closed = new Promise<void>(resolve => (open = resolve));
  return { closed, open };
}

/** The ids of the cells of the current notebook, in order. */
async function cellOrder(page: IJupyterLabPageFixture): Promise<string[]> {
  return page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const ids: string[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      ids.push(model.cells.get(i).id);
    }
    return ids;
  });
}

/** The cards of the bench and the strips of deleted cells, in the page's order. */
async function benchOrder(page: IJupyterLabPageFixture): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '.jp-Epi-bench .jp-Epi-cell[data-cell-id], .jp-Epi-bench .jp-Epi-gonestrip'
      )
    ).map(node =>
      node.classList.contains('jp-Epi-gonestrip')
        ? 'strip'
        : (node.getAttribute('data-cell-id') ?? '')
    )
  );
}

/** Ask a typed question about a cell, as its follow-up box does. */
async function askAbout(
  page: IJupyterLabPageFixture,
  text: string,
  place: { kind: string; cell: string; label: string }
): Promise<void> {
  await page.evaluate(
    ([text, place]) => {
      const model = (window as any).jupyterapp.shell.currentWidget.content
        .model;
      void model.askOwn(text, 'request', { place });
    },
    [text, place] as const
  );
}

/** Delete a cell from the menu of its card, as the analyst does. */
async function deleteCard(
  page: IJupyterLabPageFixture,
  cellId: string
): Promise<void> {
  await page
    .locator(`.jp-Epi-cell[data-cell-id="${cellId}"] .jp-Epi-cellmenu`)
    .click();
  await page.locator('.lm-Menu-item', { hasText: /^Delete cell$/ }).click();
}

/** What the kernel says to a line of code, run out of sight of the view. */
async function kernelSays(
  page: IJupyterLabPageFixture,
  source: string
): Promise<string> {
  return page.evaluate(async source => {
    const kernel = (window as any).jupyterapp.shell.currentWidget.context
      .sessionContext.session.kernel;
    let text = '';
    const future = kernel.requestExecute({ code: source, silent: false });
    future.onIOPub = (message: any) => {
      if (message.header.msg_type === 'stream') {
        text += message.content.text;
      }
    };
    await future.done;
    return text.trim();
  }, source);
}

const LOAD =
  'import pandas as pd\ndiary = pd.DataFrame({"arm": ["A", "A", "B", "B"], "pain": [5.0, 6.5, 3.1, 3.3], "weeks": [4, 14, 13, 3]})';

test.describe('1.56 an agent run that goes on after its view closes', () => {
  test('shows in the Running panel with Stop, in the status bar, and in a view opened again', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const QUESTION = 'Does pain differ by arm without the short diaries?';
    // The run's first step waits until the view closes, and its second
    // until the test ends it: the run is at work meanwhile.
    const viewClosed = gate();
    const stopped = gate();
    const results: any[] = [];
    const stops: any[] = [];
    await page.route(/\/whybook\/agent(\?.*)?$/, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjson([
          { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
          {
            type: 'tool',
            run: 'r1',
            call: 'c1',
            name: 'run_cell',
            input: {
              title: 'Mean pain by arm',
              code: 'diary.groupby("arm").pain.mean()',
              why: 'compare the arms'
            }
          },
          {
            type: 'tool',
            run: 'r1',
            call: 'c2',
            name: 'run_cell',
            input: {
              title: 'Mean pain by arm, 12 weeks or more',
              code: 'diary[diary.weeks >= 12].groupby("arm").pain.mean()',
              why: 'leave out the short diaries'
            }
          },
          // What the server sends once the view asked it to stop the run.
          {
            type: 'result',
            stopped: true,
            cost_usd: 0.02,
            elapsed: 30
          }
        ])
      })
    );
    await page.route(/\/whybook\/agent\/result/, async route => {
      const body = route.request().postDataJSON();
      results.push(body);
      await (body.call === 'c1' ? viewClosed.closed : stopped.closed);
      await route.fulfill({ status: 200, json: { ok: true } });
    });
    await page.route(/\/whybook\/agent\/stop/, async route => {
      stops.push(route.request().postDataJSON());
      stopped.open();
      await route.fulfill({ status: 200, json: { ok: true } });
    });
    const file = `${tmpPath}/runs.ipynb`;
    await writeNotebook(page, file, [code('load', LOAD)]);
    await openInWhybook(page, file);
    await kernelIdle(page);
    await runAll(page, 1);
    const status = page.locator('#jp-main-statusbar .jp-Epi-runstatus');
    // No run goes on: the status bar has no item for runs.
    await expect(status).toBeHidden();

    const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
    await own.fill(QUESTION);
    await own.press('Enter');
    const run = page.locator('.jp-Epi-agentrun');
    await expect(
      run.locator('.jp-Epi-agentrun-steps li.jp-mod-done')
    ).toHaveCount(1, { timeout: 60000 });
    // The status bar counts the run.
    await expect(status).toBeVisible();
    await expect(status).toHaveText('1');
    await expect(status.locator('.jp-Epi-runstatus-count')).toHaveAttribute(
      'title',
      /^An agent works in runs\.ipynb: 1 cell so far\./
    );

    // The notebook stays open in JupyterLab's notebook view, and the
    // analyst closes the Whybook view.
    await page.evaluate(async file => {
      await (window as any).jupyterapp.commands.execute('docmanager:open', {
        path: file,
        factory: 'Notebook'
      });
      for (const widget of [
        ...(window as any).jupyterapp.shell.widgets('main')
      ]) {
        if (widget.content?.model?.askOwn) {
          widget.close();
        }
      }
    }, file);
    await expect(page.locator('.jp-Epi-bench')).toHaveCount(0);
    viewClosed.open();
    // The run goes on: its second cell shows in the notebook view.
    await expect(page.locator('.jp-NotebookPanel .jp-CodeCell')).toHaveCount(
      3,
      {
        timeout: 60000
      }
    );
    await expect.poll(() => results.length, { timeout: 60000 }).toBe(2);
    await expect(status).toHaveText('1');

    // A click on the status bar item opens the Running panel on the run.
    await status.click();
    const panel = page.locator('#jp-running-sessions');
    await expect(panel).toBeVisible();
    const item = panel.locator('.jp-Epi-runitem').first();
    await expect(
      item.locator('.jp-RunningSessions-itemLabel').first()
    ).toHaveText('runs.ipynb');
    await expect(
      item.locator('.jp-RunningSessions-itemDetail').first()
    ).toHaveText(/^2 cells · \d+ s$/);
    await expect(panel.locator('.jp-Epi-runitem-question')).toContainText(
      QUESTION
    );

    // A click on the run opens the Whybook view again, on its strip.
    await item.locator('.jp-RunningSessions-itemLabel').first().click();
    await expect(page.locator('.jp-Epi-bench')).toBeVisible();
    await expect(run.locator('.jp-Epi-agentrun-question')).toHaveText(QUESTION);
    await expect(run.locator('.jp-Epi-agentrun-steps li')).toHaveCount(2);
    await expect(run.locator('.jp-Epi-agentrun-status')).toContainText(
      'Working · 2 cells so far'
    );
    await expect(run).toBeInViewport();
    // The panel still shows the question under the notebook.
    await expect(panel.locator('.jp-Epi-runitem-question')).toBeVisible();

    // Stop in the Running panel stops the run, as the strip's Stop does.
    await page.evaluate(() =>
      (window as any).jupyterapp.shell.activateById('jp-running-sessions')
    );
    await item.hover();
    await item.locator('.jp-RunningSessions-itemShutdown').first().click();
    await expect.poll(() => stops).toEqual([{ run: 'r1' }]);
    await expect(run.locator('.jp-Epi-agentrun-status')).toHaveText(
      'Stopped · 2 cells kept'
    );
    await expect(status).toBeHidden();
    await expect(panel.locator('.jp-Epi-runitem')).toHaveCount(0);
  });
});

test.describe('1.55 an answer whose cell is deleted while the model writes it', () => {
  const FIT = 'by_arm = diary.groupby("arm").pain.mean()\nby_arm';
  const PLOT = 'long = diary[diary.weeks >= 12]\nlong.shape';

  /**
   * The model's route: each request waits until the test lets it go, and
   * answers with the code the test gives.
   */
  async function writer(page: IJupyterLabPageFixture) {
    const waiting: { gate: ReturnType<typeof gate>; code: string }[] = [];
    await page.route(/\/whybook\/solve/, async route => {
      const entry = { gate: gate(), code: '' };
      waiting.push(entry);
      await entry.gate.closed;
      await route
        .fulfill({
          status: 200,
          contentType: 'application/x-ndjson',
          body: ndjson([
            {
              type: 'result',
              cell: {
                code: entry.code,
                summary: 'The mean pain of each arm.',
                assumptions: [],
                follow_up: []
              },
              model: 'claude-opus-5-5',
              cost_usd: 0.01,
              elapsed: 2
            }
          ])
        })
        // The view stopped the request: nothing reads the answer.
        .catch(() => undefined);
    });
    return {
      /** Let the request of this index go, with this code. */
      answer: async (index: number, code: string) => {
        await expect.poll(() => waiting.length).toBeGreaterThan(index);
        waiting[index].code = code;
        waiting[index].gate.open();
      },
      count: () => waiting.length
    };
  }

  test('waits where the cell was, and Restore puts the cell back with the answer', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const model = await writer(page);
    const file = `${tmpPath}/deleted.ipynb`;
    await writeNotebook(page, file, [
      code('load', LOAD),
      code('fit', FIT),
      code('plot', PLOT)
    ]);
    await openInWhybook(page, file);
    await page.evaluate(() =>
      (window as any).jupyterapp.shell.currentWidget.content.model.settings.set(
        'answers',
        'cell'
      )
    );
    await kernelIdle(page);
    await runAll(page, 3);

    await askAbout(page, 'Is the gap between the arms large?', {
      kind: 'new',
      cell: 'fit',
      label: 'new cell after [2]'
    });
    const strip = page.locator(
      '.jp-Epi-cell[data-cell-id="fit"] .jp-Epi-strip'
    );
    // Stop shows while the model writes.
    await expect(strip.getByRole('button', { name: 'Stop' })).toBeVisible();
    // The analyst deletes [2] while the model writes: the strip stays where
    // it was.
    await deleteCard(page, 'fit');
    const gone = page.locator('.jp-Epi-gonestrip');
    await expect(gone.locator('.jp-Epi-strip-note')).toHaveText(
      '[2] was deleted. When the answer comes, it waits here, and nothing runs.'
    );
    // The answer's cell goes after [3], the last cell that ran, and not
    // right after [2]: a new cell goes where it runs, so that the notebook
    // runs from the top (design iteration 1.74).
    await expect(gone.locator('.jp-Epi-strip-action')).toHaveText(
      'Adding a cell after [3]'
    );
    expect(await benchOrder(page)).toEqual(['load', 'strip', 'plot']);

    await model.answer(0, 'gap = by_arm["A"] - by_arm["B"]\ngap');
    const waiting = page.locator('.jp-Epi-waitstrip');
    await expect(waiting.locator('.jp-Epi-strip-action')).toHaveText(
      'Not added'
    );
    await expect(waiting.locator('.jp-Epi-capnote-text')).toHaveText(
      '[2] was deleted while the model wrote this answer, so the answer waits here: nothing was added to the notebook, and nothing ran.'
    );
    await expect(waiting.locator('.jp-Epi-diff')).toContainText(
      '+ gap = by_arm["A"] - by_arm["B"]'
    );
    await expect(waiting.getByRole('button', { name: 'Run it' })).toBeVisible();
    // Nothing was added, and nothing ran.
    expect(await cellOrder(page)).toEqual(['load', 'plot']);
    expect(await kernelSays(page, 'print("gap" in globals())')).toBe('False');

    await waiting.getByRole('button', { name: 'Restore [2] and run' }).click();
    // [2] comes back where it was, and the answer goes after [3], the last
    // cell that ran, with its strip right above it (design iteration 1.74).
    const done = page.locator(
      '.jp-Epi-cell[data-cell-id="plot"] .jp-Epi-strip'
    );
    await expect(done.locator('.jp-Epi-strip-action')).toHaveText(
      /^Added \[\d+\] after \[3\]$/,
      { timeout: 60000 }
    );
    const order = await cellOrder(page);
    expect(order[0]).toBe('load');
    expect(order[1]).toBe('fit');
    expect(order[2]).toBe('plot');
    expect(order).toHaveLength(4);
    expect(await kernelSays(page, 'print(round(gap, 2))')).toBe('2.55');
    await expect(page.locator('.jp-Epi-waitstrip')).toHaveCount(0);
  });

  test('Stop ends an answer, and Run it puts an edit of a deleted cell alone where it was', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const model = await writer(page);
    const file = `${tmpPath}/alone.ipynb`;
    await writeNotebook(page, file, [
      code('load', LOAD),
      code('fit', FIT),
      code('plot', PLOT)
    ]);
    await openInWhybook(page, file);
    await page.evaluate(() =>
      (window as any).jupyterapp.shell.currentWidget.content.model.settings.set(
        'answers',
        'cell'
      )
    );
    await kernelIdle(page);
    await runAll(page, 3);

    // Stop while the model writes: the strip goes, and nothing is added.
    await askAbout(page, 'Is the gap between the arms large?', {
      kind: 'new',
      cell: 'fit',
      label: 'new cell after [2]'
    });
    const strip = page.locator(
      '.jp-Epi-cell[data-cell-id="fit"] .jp-Epi-strip'
    );
    // The request is on its way to the model.
    await expect.poll(() => model.count()).toBe(1);
    await strip.getByRole('button', { name: 'Stop' }).click();
    await expect(strip).toHaveCount(0);
    await model.answer(0, 'stopped = True');
    expect(await cellOrder(page)).toEqual(['load', 'fit', 'plot']);

    // An edit of [2], whose cell the analyst deletes while the model writes.
    await askAbout(page, 'What is the highest pain of each arm?', {
      kind: 'edit',
      cell: 'fit',
      label: 'edit [2] in place'
    });
    await expect(strip.locator('.jp-Epi-strip-action')).toHaveText(
      'Editing [2] in place'
    );
    await deleteCard(page, 'fit');
    await model.answer(1, 'by_arm = diary.groupby("arm").pain.max()\nby_arm');
    const waiting = page.locator('.jp-Epi-waitstrip');
    await expect(waiting.getByRole('button', { name: 'Run it' })).toBeVisible();
    expect(await kernelSays(page, 'print(by_arm["A"])')).toBe('5.75');

    await waiting.getByRole('button', { name: 'Run it' }).click();
    await expect.poll(() => cellOrder(page)).toHaveLength(3);
    const order = await cellOrder(page);
    expect(order[0]).toBe('load');
    expect(order[2]).toBe('plot');
    const added = page.locator(
      `.jp-Epi-cell[data-cell-id="${order[1]}"] .jp-Epi-strip`
    );
    await expect(added.locator('.jp-Epi-strip-action')).toHaveText(
      /^Added \[\d+\] where \[2\] was$/,
      { timeout: 60000 }
    );
    // The edited code ran alone, where [2] was.
    expect(await kernelSays(page, 'print(by_arm["A"])')).toBe('6.5');
    expect(await kernelSays(page, 'print(by_arm["B"])')).toBe('3.3');
    expect(model.count()).toBe(2);
  });

  test('does not run the code of an answer in the sidebar that the analyst closed', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const model = await writer(page);
    const file = `${tmpPath}/preview.ipynb`;
    await writeNotebook(page, file, [code('load', LOAD)]);
    await openInWhybook(page, file);
    await kernelIdle(page);
    await runAll(page, 1);
    await askAbout(page, 'How many diaries are short?', {
      kind: 'preview',
      cell: '',
      label: 'a preview in the sidebar'
    });
    const close = page.getByRole('button', { name: 'Close the answer' });
    await expect(close).toBeVisible();
    // The request is on its way to the model.
    await expect.poll(() => model.count()).toBe(1);
    await close.click();
    await expect(page.locator('.jp-Epi-preview')).toHaveCount(0);
    await model.answer(0, 'short = int((diary.weeks < 12).sum())\nshort');
    // The answer came: the sidebar stays closed, and its code did not run.
    await expect(page.locator('.jp-Epi-preview')).toHaveCount(0);
    expect(await kernelSays(page, 'print("short" in globals())')).toBe('False');
  });
});
