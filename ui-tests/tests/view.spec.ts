import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';
import * as path from 'path';

import { expect, test } from './fixtures';
import { tooltipLines } from './tooltips';

const DEMO = path.resolve(__dirname, '..', '..', 'examples', 'pain_diary');

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
  // While the file loads, the bench holds the loading cells and the minimap
  // button alone: "the first button of the bench" was the minimap, and the
  // cells came in before it.
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0);
}

/**
 * Upload the pain diary demo next to its prep module, open it in the view
 * and run every cell.
 */
async function openDemo(
  page: IJupyterLabPageFixture,
  tmpPath: string,
  options: { run?: boolean } = {}
): Promise<void> {
  await page.contents.uploadFile(
    path.join(DEMO, 'prep.py'),
    `${tmpPath}/prep.py`
  );
  await page.contents.uploadFile(
    path.join(DEMO, 'pain_diary_cohort.ipynb'),
    `${tmpPath}/pain_diary_cohort.ipynb`
  );
  await openInWhybook(page, `${tmpPath}/pain_diary_cohort.ipynb`);
  await kernelIdle(page);
  if (options.run === false) {
    return;
  }
  await page.locator('.jp-Epi-runall').click();
  await expect
    .poll(() => page.locator('.jp-Epi-variable').count(), { timeout: 180000 })
    .toBeGreaterThanOrEqual(5);
  await idle(page);
}

/** The whybook metadata of every cell of the current notebook. */
async function cellMetas(page: IJupyterLabPageFixture): Promise<any[]> {
  return page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const found: any[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      found.push(model.cells.get(i).getMetadata('whybook') ?? {});
    }
    return found;
  });
}

/**
 * Wait until `check` has held for `ms` in a row, or `timeout` has passed. After
 * a reload, JupyterLab opens the URL's file a moment after the layout comes
 * back, and the view closes that copy a moment later: one look can come
 * before the copy. The assertions after it report the state.
 */
async function holds(
  check: () => Promise<boolean>,
  ms = 3000,
  timeout = 30000
): Promise<void> {
  const end = Date.now() + timeout;
  let since: number | null = null;
  while (Date.now() < end) {
    if (await check()) {
      since = since ?? Date.now();
      if (Date.now() - since >= ms) {
        return;
      }
    } else {
      since = null;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/**
 * The main area that the next load of the page restores: the name of each
 * widget in it, and of the current one. JupyterLab saves the layout in the
 * workspace a moment after it changes, and galata keeps the workspace for
 * the next load.
 */
async function savedLayout(
  page: IJupyterLabPageFixture
): Promise<{ widgets: string[]; current: string | null }> {
  return page.evaluate(async () => {
    const app = (window as any).jupyterapp;
    const workspace = await app.serviceManager.workspaces.fetch('default');
    const main = workspace.data['layout-restorer:data']?.main;
    const widgets: string[] = [];
    const walk = (area: any) => {
      widgets.push(...(area?.widgets ?? []));
      (area?.children ?? []).forEach(walk);
    };
    walk(main?.dock);
    return { widgets: widgets.sort(), current: main?.current ?? null };
  });
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

/** Wait until no cell runs and no result strip is busy. */
async function idle(page: IJupyterLabPageFixture): Promise<void> {
  // The view draws a queued cell on the next frame after a click, so the
  // state counts as idle only once it has held for half a second.
  await page.evaluate(() => {
    (window as any).epiIdleSince = null;
  });
  await page.waitForFunction(
    () => {
      const state = window as any;
      const busy =
        !!document.querySelector('.jp-Epi-cell-actions button[disabled]') ||
        !!document.querySelector('.jp-Epi-strip .jp-mod-indeterminate');
      if (busy) {
        state.epiIdleSince = null;
        return false;
      }
      state.epiIdleSince = state.epiIdleSince ?? performance.now();
      return performance.now() - state.epiIdleSince > 500;
    },
    null,
    { timeout: 180000, polling: 100 }
  );
}

/**
 * An HTML5 drag. Chromium starts a drag only when the mouse moves in steps.
 */
async function drag(
  page: IJupyterLabPageFixture,
  source: Locator,
  target: Locator,
  options: { shift?: boolean; alt?: boolean; dx?: number; dy?: number } = {}
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 5, {
    steps: 5
  });
  if (options.shift) {
    await page.keyboard.down('Shift');
  }
  if (options.alt) {
    await page.keyboard.down('Alt');
  }
  await page.mouse.move(
    to.x + (options.dx ?? to.width / 2),
    to.y + (options.dy ?? 30),
    { steps: 10 }
  );
  await page.mouse.up();
  if (options.shift) {
    await page.keyboard.up('Shift');
  }
  if (options.alt) {
    await page.keyboard.up('Alt');
  }
}

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

/** Wait until the current view has the server's status. */
async function statusRead(page: IJupyterLabPageFixture): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).jupyterapp.shell.currentWidget.content.model
            .status !== null
      )
    )
    .toBe(true);
}

/**
 * How many tables of the current view wait for labels from a model, after
 * the check that the tile of this cell makes: whether its table has the
 * labels of the model chosen for labels, and whether that model may write
 * them. A tile makes the check in an effect after it renders, and a request
 * goes 400 ms later with the other tiles', so when no request goes, no event
 * marks it. Made here, once the view has the status and the settings that
 * the check reads, the same check gives the same answer, whether the tile's
 * effect ran yet or not.
 */
async function tablesAskingForLabels(
  page: IJupyterLabPageFixture,
  cellId: string
): Promise<number> {
  return page.evaluate(cellId => {
    const widget = (window as any).jupyterapp.shell.currentWidget;
    const notes = widget.content.model.tableNotes;
    const cells = widget.context.model.cells;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells.get(i);
      for (let j = 0; cell.id === cellId && j < cell.outputs.length; j++) {
        const output = cell.outputs.get(j);
        if (String(output.data['text/html'] ?? '').includes('<table')) {
          notes.request(cellId, output);
        }
      }
    }
    return notes.pending;
  }, cellId);
}

/** Answers of one cell, as before agents: the tests of that path choose it. */
async function oneCellAnswers(page: IJupyterLabPageFixture): Promise<void> {
  await page.evaluate(() => {
    const settings = (window as any).jupyterapp.shell.currentWidget.content
      .model.settings;
    settings.set('answers', 'cell');
  });
}

/**
 * Write a notebook with these code cells. The contents API takes an explicit
 * path; with the tree file browser, "new notebook" writes to another folder.
 */
async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  code: string[] = [''],
  metadata: Record<string, unknown> = {}
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
      },
      ...metadata
    },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

test('opens a notebook in the Whybook view', async ({ page, tmpPath }) => {
  await newNotebook(page, `${tmpPath}/view.ipynb`, ['x = 1']);
  await openInWhybook(page, `${tmpPath}/view.ipynb`);

  // The views go from the most detail to the least, and the modes from
  // exploration to the finished analysis.
  const views = page.locator('.jp-Epi-views .jp-Epi-segment');
  await expect(views).toHaveText(['Code', 'Bench', 'Map']);
  await expect(page.locator('.jp-Epi-modes .jp-Epi-segment')).toHaveText([
    'Wonder',
    'Do',
    'Report'
  ]);
  await expect(page.locator('#epi-variables')).toBeVisible();
  await expect(page.locator('#epi-exploration')).toBeVisible();
  // Spoken questions are off by default: the question box shows a grey
  // microphone that says so.
  const voice = page.locator('#epi-exploration .jp-Epi-ownbox .jp-Epi-voice');
  await expect(voice).toHaveAttribute('aria-disabled', 'true');
  await expect(voice).toHaveAttribute('title', /^Ask by voice: off\./);
  // The microphone sits in the middle of the field's first line, with no
  // line box under it, at 14 px.
  const place = await voice.evaluate(button => {
    const field = button.parentElement!.querySelector('textarea')!;
    const glyph = button.querySelector('svg')!.getBoundingClientRect();
    const box = field.getBoundingClientRect();
    return {
      offset: glyph.top + glyph.height / 2 - (box.top + box.height / 2),
      size: glyph.width
    };
  });
  expect(Math.abs(place.offset)).toBeLessThan(0.5);
  expect(place.size).toBe(14);
  // The status bar is short, and says the rest in its tooltip.
  const runs = page.locator('.jp-Epi-status-runs');
  await expect(runs).toHaveText('Parallel 0/8');
  // The tooltip also says that a parallel run shares the kernel's variables.
  await expect(runs).toHaveAttribute(
    'title',
    /^0 of 8 parallel runs busy\. A parallel run is a subshell of the same kernel: it reads and writes the same variables/
  );
  // With nothing selected, Contents has no head: its title names it.
  await expect(
    page.locator('#epi-contents-section .jp-Epi-section-head')
  ).toBeHidden();

  // The file browser's Open With menu shows the view with its icon.
  await page.sidebar.openTab('filebrowser');
  await page.filebrowser.openDirectory(tmpPath);
  await page
    .locator('.jp-DirListing-item', { hasText: 'view.ipynb' })
    .click({ button: 'right' });
  await page
    .locator('.lm-Menu-item', { hasText: /^Open With/ })
    .first()
    .hover();
  const item = page.locator('.lm-Menu-item', { hasText: /^Whybook$/ });
  await expect(item).toBeVisible();
  await expect(item.locator('.lm-Menu-itemIcon svg')).toBeVisible();
});

test('shows the Whybook view again after a reload, with no second tab of the notebook', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/reload.ipynb`;
  await newNotebook(page, file, ['x = 1']);
  await openInWhybook(page, file);
  // JupyterLab keeps the path of the current document in the URL, and a
  // reload opened that file again, in the notebook view, which it showed.
  await expect.poll(() => page.url()).toContain(`/tree/${file}`);
  const views = () =>
    page.evaluate(
      path =>
        Array.from((window as any).jupyterapp.shell.widgets('main'))
          .filter((widget: any) => widget.context?.path === path)
          .map((widget: any) =>
            widget.node.classList.contains('jp-NotebookPanel')
              ? 'notebook'
              : 'whybook'
          ),
      file
    );
  await expect.poll(views).toEqual(['whybook']);
  // The layout is saved a moment after it changes, and the reload restores
  // the one saved last.
  await expect
    .poll(() => savedLayout(page))
    .toEqual({
      widgets: expect.arrayContaining([`whybook:${file}`]),
      current: `whybook:${file}`
    });
  const notebookInFront = () =>
    page.evaluate(
      () =>
        (window as any).jupyterapp.shell.currentWidget?.node.classList.contains(
          'jp-NotebookPanel'
        ) ?? null
    );
  // galata's own wait wants the launcher in front, and the view is.
  await page.reload({ waitForIsReady: false });
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
  // The copy that the URL opens came after one look at the tabs, and the
  // test failed on an idle machine: the state has to hold.
  await holds(
    async () =>
      JSON.stringify(await views()) === '["whybook"]' &&
      (await notebookInFront()) === false
  );
  expect(await views()).toEqual(['whybook']);
  expect(await notebookInFront()).toBe(false);
  // With the notebook view open beside the Whybook view, both come back,
  // once each.
  await page.evaluate(() =>
    (window as any).jupyterapp.commands
      .execute('whybook:open-notebook')
      .then(() => null)
  );
  await expect.poll(views).toEqual(['whybook', 'notebook']);
  await page.evaluate(path => {
    const app = (window as any).jupyterapp;
    const view = Array.from(app.shell.widgets('main')).find(
      (widget: any) =>
        widget.context?.path === path &&
        !widget.node.classList.contains('jp-NotebookPanel')
    ) as any;
    app.shell.activateById(view.id);
  }, file);
  await expect
    .poll(() => savedLayout(page))
    .toEqual({
      widgets: expect.arrayContaining([`notebook:${file}`, `whybook:${file}`]),
      current: `whybook:${file}`
    });
  // galata's own wait wants the launcher in front, and the view is.
  await page.reload({ waitForIsReady: false });
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
  await holds(
    async () =>
      JSON.stringify((await views()).sort()) === '["notebook","whybook"]'
  );
  expect((await views()).sort()).toEqual(['notebook', 'whybook']);
});

test('moves and deletes cells from their menu, and moves them by the prompt in the Code view', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/order.ipynb`;
  await newNotebook(page, file, ['x = 1', 'y = 2', 'z = x + y']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('.jp-Epi-cell[data-cell-id="cell-2"] .jp-Epi-label')
  ).toHaveText('[3]', { timeout: 60000 });
  // The notice of a delete names the cells that use what the cell defined,
  // from the analysis that follows the run: a new kernel gets none before.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).jupyterapp.shell.currentWidget.content.model.cell(
            'cell-2'
          )?.analysis?.uses ?? []
      )
    )
    .toContain('x');
  const order = () =>
    page.evaluate(() => {
      const model = (window as any).jupyterapp.shell.currentWidget.context
        .model;
      const ids: string[] = [];
      for (let i = 0; i < model.cells.length; i++) {
        ids.push(model.cells.get(i).id);
      }
      return ids;
    });
  const menu = page.locator('.lm-Menu');
  const item = (label: string) =>
    menu.locator('.lm-Menu-item', { hasText: new RegExp(`^${label}$`) });

  // The ⋯ button of a card opens the cell's menu, as a right-click does.
  await page
    .locator('.jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-cellmenu')
    .click();
  await item('Move up').click();
  await expect.poll(order).toEqual(['cell-1', 'cell-0', 'cell-2']);
  // The first cell has no place above it.
  await page
    .locator('.jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-title')
    .click({ button: 'right' });
  await expect(item('Move up')).toHaveClass(/lm-mod-disabled/);
  await page.keyboard.press('Escape');

  // A delete names the cells that use what the cell defined, and Undo puts
  // the cell back in its place, with its outputs.
  await page
    .locator('.jp-Epi-cell[data-cell-id="cell-0"] .jp-Epi-cellmenu')
    .click();
  await item('Delete cell').click();
  await expect.poll(order).toEqual(['cell-1', 'cell-2']);
  const notice = page.locator('.jp-toastContainer', {
    hasText: 'Deleted [1] x = 1'
  });
  await expect(notice).toContainText('[3] uses names it defined');
  await notice.locator('.jp-toast-button', { hasText: 'Undo' }).click();
  await expect.poll(order).toEqual(['cell-1', 'cell-0', 'cell-2']);
  await expect(
    page.locator('.jp-Epi-cell[data-cell-id="cell-0"] .jp-Epi-label')
  ).toHaveText('[1]');

  // In the Code view, a drag of the prompt moves the cell, as in the notebook.
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  await drag(
    page,
    page.locator(
      '.jp-Epi-linear-cell[data-cell-id="cell-2"] .jp-Epi-linear-prompt'
    ),
    page.locator('.jp-Epi-linear-cell[data-cell-id="cell-1"]'),
    { dy: 4 }
  );
  await expect.poll(order).toEqual(['cell-2', 'cell-1', 'cell-0']);
});

test('moves a section of the panel to the file browser and back', async ({
  page,
  tmpPath
}) => {
  await newNotebook(page, `${tmpPath}/sections.ipynb`, ['x = 1']);
  await openInWhybook(page, `${tmpPath}/sections.ipynb`);
  const title = (panel: string) =>
    page.locator(
      `${panel} .jp-AccordionPanel-title[aria-controls="epi-questions-section"]`
    );
  await title('#epi-variables').click({ button: 'right' });
  await page
    .locator('.lm-Menu-item', { hasText: 'Move to File Browser' })
    .click();
  await page.evaluate(() =>
    (window as any).jupyterapp.shell.activateById('filebrowser')
  );
  await expect(title('#filebrowser')).toBeVisible();
  await expect(page.locator('#filebrowser .jp-Epi-questions')).toBeVisible();

  // With the panels in the view, the moved section is not shown twice.
  await page.locator('.jp-Epi-layout [data-value="all-here"]').click();
  await expect(page.locator('.jp-Epi-docpanel.jp-mod-left')).toBeVisible();
  await expect(
    page.locator('.jp-Epi-docpanel.jp-mod-left .jp-Epi-questions')
  ).toHaveCount(0);
  // Back in the sidebar, the Whybook panel opens in front of the file browser.
  await page.locator('.jp-Epi-layout [data-value="sidebars"]').click();
  await page.evaluate(() =>
    (window as any).jupyterapp.shell.activateById('filebrowser')
  );

  await title('#filebrowser').click({ button: 'right' });
  await page
    .locator('.lm-Menu-item', { hasText: 'Move back to Whybook' })
    .click();
  await page.evaluate(() =>
    (window as any).jupyterapp.shell.activateById('epi-variables')
  );
  await expect(title('#epi-variables')).toBeVisible();
  await expect(title('#filebrowser')).toHaveCount(0);
});

test('lists the variables of the kernel', async ({ page, tmpPath }) => {
  await newNotebook(page, `${tmpPath}/variables.ipynb`, [
    'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2, None]})'
  ]);
  await openInWhybook(page, `${tmpPath}/variables.ipynb`);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();

  const row = page.locator('.jp-Epi-variable', { hasText: 'df' });
  await expect(row).toContainText('3 × 1', { timeout: 60000 });
  await row.click();
  await expect(
    page.locator('.jp-Epi-column', { hasText: 'a' }).first()
  ).toBeVisible();
});

/**
 * Before JupyterLab loads: record each execute request that the page sends
 * to a kernel, a program of the view by its name and a cell by its code, and
 * whether the Variables section ever drew its progress circle.
 */
function recordKernelRequests(): void {
  const state = window as any;
  state.epiExecutes = [];
  state.epiCircle = false;
  const decoder = new TextDecoder();
  // JupyterLab sends kernel messages as JSON text, or in the binary
  // v1.kernel.websocket.jupyter.org protocol: offsets, then the parts.
  const decode = (data: any): any => {
    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    if (!(data instanceof ArrayBuffer)) {
      return null;
    }
    const view = new DataView(data);
    const offsets: number[] = [];
    for (let i = 0; i < Number(view.getBigUint64(0, true)); i++) {
      offsets.push(Number(view.getBigUint64(8 * (i + 1), true)));
    }
    const part = (i: number) =>
      decoder.decode(data.slice(offsets[i], offsets[i + 1]));
    return { header: JSON.parse(part(1)), content: JSON.parse(part(4)) };
  };
  const Socket = window.WebSocket;
  class Recording extends Socket {
    send(data: any): void {
      const message = decode(data);
      if (message?.header?.msg_type === 'execute_request') {
        const code: string = message.content.code;
        const program = /\n {4}_whybook_(\w+)\(__import__/.exec(code);
        state.epiExecutes.push(program ? program[1] : code);
      }
      super.send(data);
    }
  }
  state.WebSocket = Recording;
  new MutationObserver(() => {
    if (document.querySelector('.jp-Epi-variables .jp-Epi-spinner')) {
      state.epiCircle = true;
    }
  }).observe(document, { subtree: true, childList: true });
}

test('reads nothing from a new kernel until a cell runs, and shows no progress circle', async ({
  page,
  tmpPath
}) => {
  await page.addInitScript(recordKernelRequests);
  // The page's timers run on a clock that the test controls: it runs at the
  // speed of the wall clock until the test advances it.
  await page.clock.install();
  // JupyterLab hides its shell from the moment the theme loads until the
  // next animation frame. On the test's clock that frame runs after every
  // timer that the start queued before it, up to a second later, and the
  // launcher can open in between. A launcher that opens in a hidden shell
  // cannot take the focus, so it never becomes the current tab that
  // galata's wait after a reload looks for. The test waits for the shell to
  // show instead, and then brings the launcher to the front as galata does.
  await page.reload({ waitForIsReady: false });
  await page.waitForFunction(
    () =>
      !!document.body.dataset.jpThemeName &&
      !document.getElementById('jupyterlab-splash') &&
      !document.getElementById('main')?.classList.contains('lm-mod-hidden')
  );
  await page.activity.activateTab('Launcher');
  const file = `${tmpPath}/fresh.ipynb`;
  await newNotebook(page, file, ['x = 41\ny = x + 1']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  // Before, the view read the kernel 1.5 s after it opened. The plot hooks
  // give a kernel with no status in JupyterLab a request 2 s after it
  // started; ipywidgets' comm gives the kernel its status here, so the plot
  // hooks wait too. The test runs the page's timers of the next 3 s now. A
  // read that one of them started is still under way at the checks below,
  // or it has sent its requests.
  await page.clock.runFor(3000);
  expect(
    await page.evaluate(
      () => (window as any).jupyterapp.shell.currentWidget.content.model.reading
    )
  ).toBe(false);
  const executes = () => page.evaluate(() => (window as any).epiExecutes);
  expect(await executes()).toEqual([]);
  await expect(page.locator('.jp-Epi-variables .jp-Epi-empty')).toContainText(
    'No variables yet'
  );
  expect(await page.evaluate(() => (window as any).epiCircle)).toBe(false);

  await page
    .locator(
      '.jp-Epi-cell[data-cell-id="cell-0"] .jp-Epi-cell-actions button',
      {
        hasText: 'Run'
      }
    )
    .click();
  await expect(
    page.locator('.jp-Epi-variables .jp-Epi-variable .jp-Epi-item-name')
  ).toHaveText(['x', 'y']);
  // The hooks before the first cell, the cell, then one refresh.
  await expect
    .poll(executes)
    .toEqual([
      'plot_hooks',
      'x = 41\ny = x + 1',
      'inspect_variables',
      'analyze_cells'
    ]);
});

test('lists what another client runs in the kernel, and reads nothing after its silent requests', async ({
  page,
  tmpPath
}) => {
  await page.addInitScript(recordKernelRequests);
  await page.reload();
  const file = `${tmpPath}/other.ipynb`;
  await newNotebook(page, file, ['x = 1']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  // Another client of the same kernel: a console, or a second tab. The view
  // counts an execution when the kernel's idle status after it arrives, and
  // a counted execution makes a read of the kernel due. `run` returns
  // whether the view counted this one, at the moment that status arrived in
  // the view: the bridge's handler of the status was connected first, so it
  // ran before the test's.
  const run = (code: string, silent: boolean) =>
    page.evaluate(
      async ({ code, silent }) => {
        const app = (window as any).jupyterapp;
        const widget = app.shell.currentWidget;
        const sessionContext = widget.context.sessionContext;
        const kernel = sessionContext.session.kernel;
        const bridge = widget.content.model.bridge;
        let counted = false;
        const count = (_: unknown, change: string) => {
          counted = counted || change === 'executed';
        };
        bridge.changed.connect(count);
        const other = app.serviceManager.kernels.connectTo({
          model: { id: kernel.id, name: kernel.name },
          handleComms: false
        });
        // ipykernel 7.3 can leave the first request of a new connection
        // unread until another request comes to the kernel
        // (ipython/ipykernel#1554, fixed in 7.4), and nothing else sends one
        // here. When the kernel info reply of this client is late, the
        // notebook's connection sends a request after 1, 3 and 7 s, as the
        // view does for its own connections (subshellConnection). The code
        // goes once the reply came.
        for (const wait of [1000, 2000, 4000]) {
          const answered = await Promise.race([
            other.info.then(() => true),
            new Promise<boolean>(resolve =>
              setTimeout(() => resolve(false), wait)
            )
          ]);
          if (answered) {
            break;
          }
          void kernel.requestKernelInfo();
        }
        await other.info;
        const future = other.requestExecute({ code, silent });
        const request = future.msg.header.msg_id;
        await new Promise<void>(resolve => {
          const idle = (_: unknown, msg: any) => {
            if (
              msg.header.msg_type === 'status' &&
              msg.content.execution_state === 'idle' &&
              msg.parent_header?.msg_id === request
            ) {
              sessionContext.iopubMessage.disconnect(idle);
              resolve();
            }
          };
          sessionContext.iopubMessage.connect(idle);
        });
        await future.done;
        other.dispose();
        bridge.changed.disconnect(count);
        return counted;
      },
      { code, silent }
    );
  const reads = () =>
    page.evaluate(
      () =>
        (window as any).epiExecutes.filter(
          (what: string) => what === 'inspect_variables'
        ).length
    );
  expect(await run('z = 3', false)).toBe(true);
  await expect(
    page.locator('.jp-Epi-variables .jp-Epi-variable .jp-Epi-item-name')
  ).toHaveText(['z']);
  await expect.poll(reads).toBe(1);
  // A silent request, as another Whybook view's listing of the kernel is:
  // two views of one kernel read it after each other's listing, without end.
  // Not counted, it makes no read due.
  expect(await run('w = 4', true)).toBe(false);
  expect(await reads()).toBe(1);
});

test('links the cells that make and use a variable in Contents, for every kind', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/contents.ipynb`;
  await newNotebook(page, file, [
    'import numpy as np\nimport pandas as pd\ndf = pd.DataFrame({"a": [1.0, 2.0, 4.0]})',
    'high = np.float64(-0.4131654135338354)',
    'df[df.a > high]',
    'm = df.a.mean() + high\nnames = list(df.columns)'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const row = (name: string) =>
    page.locator('.jp-Epi-variable').filter({
      has: page.locator('.jp-Epi-item-name', {
        hasText: new RegExp(`^${name}$`)
      })
    });
  await expect(row('names')).toBeVisible({ timeout: 60000 });
  // A numpy number shows short, as the list and the card say it; its full
  // value is in the tooltip, and the card is no wider than its panel.
  await expect(row('high')).toContainText('-0.41317');
  await row('high').click();
  const contents = page.locator('.jp-Epi-contents');
  const value = contents.locator('.jp-Epi-card-value');
  await expect(value).toHaveText('-0.41317');
  await expect(value).toHaveAttribute(
    'title',
    'np.float64(-0.4131654135338354)'
  );
  await expect
    .poll(() => contents.evaluate(node => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  // The same line for every kind, each label a link to its cell.
  const cells = contents.locator('.jp-Epi-varcells');
  await expect(cells).toHaveText('Made by [2] · Used by [3] and [4]');
  await row('df').click();
  await expect(cells).toHaveText('Made by [1] · Used by [3] and [4]');
  await row('names').click();
  await expect(cells).toHaveText('Made by [4]');
  await row('df').click();
  await cells.getByRole('button', { name: '[3]' }).click();
  await expect(page.locator('.jp-Epi-cell[data-cell-id="cell-2"]')).toHaveClass(
    /jp-mod-flash/
  );
});

test('keeps the name of a variable whole when its value is long', async ({
  page,
  tmpPath
}) => {
  // The name and the value shrank alike, so a long value cut REPORT_TITLE to
  // "REPORT_…" and DB_URL to "D…".
  const file = `${tmpPath}/names.ipynb`;
  await newNotebook(page, file, [
    'REPORT_TITLE = "Knee pain study, weekly visits, both arms"\nMIN_DAYS = 14'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const row = page.locator('.jp-Epi-variable').filter({
    has: page.locator('.jp-Epi-item-name', { hasText: /^REPORT_TITLE$/ })
  });
  await expect(row).toBeVisible({ timeout: 60000 });
  await expect
    .poll(() =>
      row
        .locator('.jp-Epi-item-name')
        .evaluate(node => node.scrollWidth <= node.clientWidth)
    )
    .toBe(true);
  // The value still shows, cut where it does not fit.
  await expect(row.locator('.jp-Epi-item-shape')).toContainText("'Knee pain");
});

test('explains both ways to ask a question', async ({ page, tmpPath }) => {
  await newNotebook(page, `${tmpPath}/ask.ipynb`, ['x = 1']);
  await openInWhybook(page, `${tmpPath}/ask.ipynb`);
  const questions = page.locator('.jp-Epi-questions');
  const segment = (value: string) =>
    questions.locator(`.jp-Epi-toggle [data-value="${value}"]`);

  await segment('click').click();
  await expect(questions).toContainText(
    'Click a column to pick it, or a variable to see what is inside'
  );
  await expect(questions.locator('.jp-Epi-switches')).toBeVisible();

  // A radio group: the arrow keys move the choice.
  await segment('click').press('ArrowLeft');
  await expect(segment('drag')).toHaveAttribute('aria-checked', 'true');
  await expect(questions).toContainText('Drag a variable or a column');
});

/**
 * A frame with an outcome, and a model of it: a column dropped onto the
 * model's cell offers questions that templates answer, among them an edit
 * of the cell in place.
 */
const MODEL_CELLS = [
  'import pandas as pd\nimport statsmodels.formula.api as smf\ndf = pd.DataFrame({"y": [1.0, 2, 3, 4, 5, 7, 8, 9], "x": [1, 2, 3, 4, 5, 6, 7, 8], "z": [3, 1, 4, 1, 5, 9, 2, 6]})',
  'data = df.dropna()',
  'fit = smf.ols("y ~ x", data=data).fit()\nfit.params'
];

test('cancels a pick of Click mode when the way of asking changes', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/cancel.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\nscores = pd.DataFrame({"a": [1, 2]})',
    'scores.a.sum()'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  const questions = page.locator('.jp-Epi-questions');
  const segment = (value: string) =>
    questions.locator(`.jp-Epi-toggle [data-value="${value}"]`);
  await segment('click').click();
  try {
    await page.locator('.jp-Epi-runall').click();
    const scores = page.locator('.jp-Epi-variable[data-variable="scores"]');
    await expect(scores).toBeVisible({ timeout: 60000 });
    // A click on a variable shows it in Contents, and Pick there picks it
    // (design iteration 1.77).
    await scores.click();
    await page.locator('.jp-Epi-contents-pick').click();
    await expect(questions.locator('.jp-Epi-picked')).toContainText(
      'scores → pick a target'
    );
    await expect(page.locator('.jp-Epi-dropzone').first()).toBeVisible();
    // Drag shows its own help, and the cards drop their targets.
    await segment('drag').click();
    await expect(questions.locator('.jp-Epi-picked')).toHaveCount(0);
    await expect(questions).toContainText('Drag a variable or a column');
    await expect(page.locator('.jp-Epi-dropzone')).toHaveCount(0);
  } finally {
    // Back to the default. Galata mocks the settings of each test, so the next test starts from the defaults anyway.
    await segment('drag').click();
  }
});

test('reaches the questions with the keyboard alone: a pick in Click mode, its cells, and the questions of a map cell', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/keys.ipynb`;
  await newNotebook(page, file, MODEL_CELLS, { whybook: { outcome: 'y' } });
  await openInWhybook(page, file);
  await kernelIdle(page);
  const questions = page.locator('.jp-Epi-questions');
  const segment = (value: string) =>
    questions.locator(`.jp-Epi-toggle [data-value="${value}"]`);
  await segment('click').click();
  try {
    await page.locator('.jp-Epi-runall').click();
    await expect(
      page.locator('.jp-Epi-cell[data-cell-id="cell-2"] .jp-Epi-label')
    ).toHaveText('[3]', { timeout: 60000 });
    await idle(page);
    // The variables are one Tab stop, and the arrow keys move between them.
    const rows = page.locator('.jp-Epi-variable');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('.jp-Epi-variable[tabindex="0"]')).toHaveCount(1);
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(rows.first()).toBeFocused();
    // Enter selects df, and a column of it is picked from Contents.
    const df = page.locator('.jp-Epi-variable[data-variable="df"]');
    await df.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    const z = page.locator('.jp-Epi-column', { hasText: 'z' }).first();
    await z.focus();
    await page.keyboard.press('Enter');
    await expect(questions.locator('.jp-Epi-picked')).toContainText(
      'z → pick a target'
    );
    // A few Tab presses reach "Go to the cells", which leads to the targets.
    const go = questions.getByRole('button', { name: 'Go to the cells' });
    for (let i = 0; i < 15; i++) {
      if (await go.evaluate(node => node === document.activeElement)) {
        break;
      }
      await page.keyboard.press('Tab');
    }
    await expect(go).toBeFocused();
    await page.keyboard.press('Enter');
    const targets = page.locator('.jp-Epi-bench .jp-Epi-dropzone');
    await expect(targets.first()).toBeFocused();
    // The targets are one Tab stop, and the arrow keys move between cells.
    await expect(targets.nth(2)).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(targets.nth(2)).toBeFocused();
    await expect(targets.nth(2)).toContainText('Ask about z with [3]');
    await page.keyboard.press('Enter');
    // The questions show in the Questions section, the focus on the first.
    const options = questions.locator('.jp-Epi-option');
    await expect(options.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(options.first()).toBeFocused();
    // Escape closes them, and the focus goes back to the cell asked about.
    await page.keyboard.press('Escape');
    await expect(questions.locator('.jp-Epi-ask-block')).toHaveCount(0);
    await expect(
      page.locator('.jp-Epi-cell[data-cell-id="cell-2"]')
    ).toBeFocused();

    // On the map, Enter on a cell opens its questions with the focus on the
    // first one, and Escape brings the focus back to the cell.
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    const node = page.locator('.jp-Epi-map-cell[data-cell-id="cell-1"]');
    await node.focus();
    await page.keyboard.press('Enter');
    await expect(popover(page).locator('.jp-Epi-option').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popover(page)).toHaveCount(0);
    await expect(node).toBeFocused();
    // Enter opens them again, and Enter on a question asks it: its answer
    // shows under the cell, and the focus is back on the cell.
    await page.keyboard.press('Enter');
    await expect(popover(page).locator('.jp-Epi-option').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(popover(page)).toHaveCount(0);
    await expect(node).toBeFocused();
    await expect(node.locator('.jp-Epi-map-answer')).toBeVisible();
  } finally {
    // Back to the default. Galata mocks the settings of each test, so the next test starts from the defaults anyway.
    await segment('drag').click();
  }
});

test('reaches every item of the toolbar and the AI models panel from the keyboard', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/toolbar.ipynb`;
  await newNotebook(page, file, ['x = 1']);
  await openInWhybook(page, file);
  const view = page.locator('.jp-Epi-views [aria-checked="true"]');
  await expect(view).toHaveAttribute('data-value', 'bench');
  const focused = () =>
    page.evaluate(() => {
      const node = document.activeElement as HTMLElement;
      return (
        node.getAttribute('data-value') ??
        node.getAttribute('aria-label') ??
        node.textContent?.trim() ??
        ''
      );
    });
  // Shift+Tab from the first control of the view reaches the toolbar.
  await page.locator('.jp-Epi-bench button').first().focus();
  await page.keyboard.press('Shift+Tab');
  await expect.poll(focused).toBe('linear');
  // The arrow keys move along the whole toolbar and leave the view as it
  // was. They cycled through Code, Bench and Map, and switched the view at
  // each press, and nothing after Map could be reached.
  const seen: string[] = [];
  for (let i = 0; i < 15 && !seen.includes('AI'); i++) {
    await page.keyboard.press('ArrowRight');
    seen.push(await focused());
  }
  expect(seen.slice(0, 6)).toEqual([
    'bench',
    'map',
    'wonder',
    'do',
    'report',
    'sidebars'
  ]);
  expect(seen).toContain('Run all');
  expect(seen[seen.length - 1]).toBe('AI');
  await expect(view).toHaveAttribute('data-value', 'bench');
  // Enter opens the AI models panel with the focus in it, and Tab moves
  // inside it: the focus stayed on the button, and Tab closed the panel.
  await page.keyboard.press('Enter');
  const panel = page.locator('.jp-Epi-aipanel');
  await expect(panel).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(panel).toBeVisible();
  await expect
    .poll(() => panel.evaluate(node => node.contains(document.activeElement)))
    .toBe(true);
  // Escape closes it and gives the focus back to the AI button.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.jp-Epi-aibutton')).toBeFocused();
  // Space on a view chooses it, and so does Enter.
  for (let i = 0; i < 15 && (await focused()) !== 'map'; i++) {
    await page.keyboard.press('ArrowLeft');
  }
  await page.keyboard.press('Space');
  await expect(view).toHaveAttribute('data-value', 'map');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(view).toHaveAttribute('data-value', 'bench');
  // A mouse click opens the panel too, and it stays open.
  await page.locator('.jp-Epi-aibutton').click();
  await expect(panel).toBeFocused();
  await page.keyboard.press('Escape');
});

test('moves the panels into the view and back', async ({ page, tmpPath }) => {
  await newNotebook(page, `${tmpPath}/layout.ipynb`);
  await openInWhybook(page, `${tmpPath}/layout.ipynb`);
  const layout = (value: string) =>
    page.locator(`.jp-Epi-layout [data-value="${value}"]`);

  await layout('all-here').click();
  await expect(page.locator('.jp-Epi-docpanel')).toHaveCount(2);
  await expect(page.locator('#epi-variables')).toBeHidden();

  await layout('sidebars').click();
  await expect(page.locator('.jp-Epi-docpanel')).toHaveCount(0);
  await expect(page.locator('#epi-variables')).toBeVisible();
});

test('starts from a data file dragged from the file browser', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    'patient_id,visit,score\nP1,1,3\nP2,1,5\n',
    'text',
    `${tmpPath}/visits.csv`
  );
  await newNotebook(page, `${tmpPath}/start.ipynb`);
  await openInWhybook(page, `${tmpPath}/start.ipynb`);
  // A notebook without code leaves the file browser open.
  await expect(page.locator('#filebrowser')).toBeVisible();
  await page.filebrowser.refresh();
  const file = page.locator('.jp-DirListing-item', { hasText: 'visits.csv' });
  if (!(await file.isVisible())) {
    // The tree file browser shows the test's folder closed.
    await page
      .locator('.jp-DirListing-item', { hasText: tmpPath })
      .first()
      .click();
  }
  await expect(file).toBeVisible();

  // A Lumino drag: it starts once the pointer moves a few pixels.
  const from = (await file.boundingBox())!;
  const bench = (await page.locator('.jp-Epi-bench').boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y + from.height / 2 + 10, {
    steps: 5
  });
  await page.mouse.move(
    bench.x + bench.width / 2,
    bench.y + bench.height - 80,
    { steps: 10 }
  );
  await page.mouse.up();

  await expect(popover(page)).toContainText('Load visits.csv as visits');
  await popover(page)
    .locator('.jp-Epi-option', { hasText: 'Load visits.csv' })
    .click();
  await expect(
    page.locator('.jp-Epi-title', { hasText: 'Load visits.csv as visits' })
  ).toBeVisible();
  await page.sidebar.openTab('epi-variables');
  await expect(
    page.locator('.jp-Epi-variable', { hasText: 'visits' })
  ).toBeVisible({ timeout: 60000 });
});

test('loads a table from the Databases panel', async ({ page, tmpPath }) => {
  await newNotebook(page, `${tmpPath}/tables.ipynb`, [
    [
      'import sqlite3',
      'from contextlib import closing',
      'with closing(sqlite3.connect("clinic.sqlite")) as db:',
      '    db.execute("CREATE TABLE visits (patient_id TEXT, crp REAL)")',
      '    db.executemany("INSERT INTO visits VALUES (?, ?)", [("P1", 1.0), ("P2", 2.5)])',
      '    db.commit()'
    ].join('\n')
  ]);
  await openInWhybook(page, `${tmpPath}/tables.ipynb`);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect
    .poll(() => page.contents.fileExists(`${tmpPath}/clinic.sqlite`))
    .toBe(true);

  await page.sidebar.openTab('epi-databases');
  const panel = page.locator('#epi-databases');
  await panel.locator('.jp-Epi-databases-refresh').click();
  await panel
    .locator(`.jp-Epi-tree-row[title="${tmpPath}/clinic.sqlite"]`)
    .click();
  const table = panel.locator('.jp-Epi-tree-row.jp-mod-table', {
    hasText: 'visits'
  });
  await expect(table).toContainText('2 rows');

  await drag(page, table, page.locator('.jp-Epi-bench'));
  await expect(popover(page)).toContainText('Load visits as visits');
  await popover(page)
    .locator('.jp-Epi-option', { hasText: 'Load visits as visits' })
    .click();
  await expect(
    page.locator('.jp-Epi-title', { hasText: 'Load visits as visits' })
  ).toBeVisible();
});

/** A table as pandas writes it: an index column of <th>, values in <td>. */
function frameHtml(rows: number, columns: number, value: string): string {
  const head = Array.from({ length: columns }, (_, c) => `<th>col_${c}</th>`);
  const body = Array.from(
    { length: rows },
    (_, r) =>
      `<tr><th>${r}</th>${head.map(() => `<td>${value}</td>`).join('')}</tr>`
  );
  return (
    '<div><table border="1" class="dataframe">' +
    `<thead><tr><th></th>${head.join('')}</tr></thead>` +
    `<tbody>${body.join('')}</tbody></table></div>`
  );
}

/**
 * A notebook whose cells show saved tables, so no kernel is needed: a small
 * one, a long one and a wide one.
 */
async function tableNotebook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const cell = (id: string, html: string, plain: string) => ({
    cell_type: 'code',
    execution_count: 1,
    id,
    metadata: {},
    source: `# ${id}`,
    outputs: [
      {
        output_type: 'execute_result',
        execution_count: 1,
        metadata: {},
        data: { 'text/html': html, 'text/plain': plain }
      }
    ]
  });
  const notebook = {
    cells: [
      cell('small', frameHtml(5, 8, '1234.56'), 'a small table'),
      cell('long', frameHtml(12, 5, '1234.56'), 'a long table'),
      cell('wide', frameHtml(3, 30, 'a wide value'), 'col_0 col_1 ...')
    ],
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

test('shows a table in full, as a miniature or as a tile, by its room', async ({
  page,
  tmpPath
}) => {
  await tableNotebook(page, `${tmpPath}/tables.ipynb`);
  await openInWhybook(page, `${tmpPath}/tables.ipynb`);
  const table = (id: string) =>
    page.locator(`[data-cell-id="${id}"] .jp-Epi-tableoutput`);

  await expect(table('small')).toHaveClass(/jp-mod-inline/);
  await expect(table('small').locator('table')).toBeVisible();
  // More than five rows: shrunk, and cut at the height of a miniature.
  await expect(table('long')).toHaveClass(/jp-mod-miniature/);
  await expect(table('long').locator('.jp-Epi-tableoutput-fade')).toBeVisible();
  await expect(table('long')).toContainText('12 × 5');
  // Too wide to read when shrunk: a tile with the size under "Table".
  await expect(table('wide')).toHaveClass(/jp-mod-tile/);
  await expect(table('wide').locator('.jp-Epi-tabletile-kind')).toHaveText(
    'Table'
  );
  await expect(table('wide').locator('.jp-Epi-tabletile-dims')).toHaveText(
    '3 × 30'
  );

  // Less room: the small table shrinks, then becomes a tile.
  await page.setViewportSize({ width: 1100, height: 1000 });
  await expect(table('small')).toHaveClass(/jp-mod-miniature/);
  await page.setViewportSize({ width: 900, height: 1000 });
  await expect(table('small')).toHaveClass(/jp-mod-tile/);

  // A click on a tile shows the table in full under the cell.
  await table('small').locator('.jp-Epi-tabletile').click();
  await expect(
    page.locator('[data-cell-id="small"] .jp-Epi-pinned table')
  ).toBeVisible();
});

test("labels a table tile with Claude's words and keeps them in the cell", async ({
  page,
  tmpPath
}) => {
  // The test server turns the requests off (c.Whybook.describe_tables), so
  // nothing reaches Claude; these routes answer in place of the server.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: true,
        describe_tables: true,
        local_models: [
          {
            id: 'gemma-4-e2b',
            label: 'Gemma 4 E2B',
            kind: 'local',
            size_mb: 2841,
            note: 'a note',
            repo: 'ggml-org/gemma-4-E2B-it-GGUF',
            available: true,
            reason: null,
            downloadable: false
          }
        ]
      }
    });
  });
  const requests: any[] = [];
  await page.route(/\/whybook\/tables\/describe/, async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const local = body.model === 'gemma-4-e2b';
    const tables = body.tables.map((table: { id: string }) => ({
      id: table.id,
      description: local ? 'local words' : 'wide sample',
      headline: local ? '' : '3 significant'
    }));
    const model = local ? 'Gemma 4 E2B' : 'claude-opus-5-5';
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({ type: 'progress', stage: 'writing', elapsed: 0.1 }) +
        '\n' +
        JSON.stringify({ type: 'result', elapsed: 0.2, tables, model }) +
        '\n'
    });
  });
  const file = `${tmpPath}/labels.ipynb`;
  await tableNotebook(page, file);
  await openInWhybook(page, file);
  const tile = page.locator('[data-cell-id="wide"] .jp-Epi-tabletile');

  await expect(tile.locator('.jp-Epi-tabletile-description')).toHaveText(
    'wide sample'
  );
  await expect(tile.locator('.jp-Epi-tabletile-headline')).toHaveText(
    '3 significantAI'
  );
  // A model wrote the labels: they end with the AI tag, which names it.
  const tag = tile.locator('.jp-Epi-tabletile-headline .jp-Epi-aitag');
  await expect(tag).toBeVisible();
  await expect(tag).toHaveAttribute(
    'title',
    /^Written by the remote AI model, claude-opus-5-5 on /
  );
  // Only the tile is described: the other tables show their data.
  expect(requests).toHaveLength(1);
  expect(requests[0].tables).toHaveLength(1);
  expect(requests[0].tables[0]).toMatchObject({
    code: '# wide',
    text: 'col_0 col_1 ...',
    rows: 3,
    columns: 30
  });

  // Kept in the cell metadata, under the hash of the output.
  const labels = await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    for (let i = 0; i < model.cells.length; i++) {
      const cell = model.cells.get(i);
      if (cell.id === 'wide') {
        return Object.values(cell.getMetadata('whybook')?.tables ?? {});
      }
    }
    return null;
  });
  expect(labels).toMatchObject([
    {
      description: 'wide sample',
      headline: '3 significant',
      // The default of labels: the fastest model of the connected provider.
      by: { choice: 'remote:fastest', model: 'claude-opus-5-5' }
    }
  ]);

  // Saved and opened again: the labels show without a new request.
  await page.evaluate(async () => {
    const widget = (window as any).jupyterapp.shell.currentWidget;
    await widget.context.save();
    widget.dispose();
  });
  await openInWhybook(page, file);
  await expect(tile.locator('.jp-Epi-tabletile-description')).toHaveText(
    'wide sample'
  );
  await statusRead(page);
  expect(await tablesAskingForLabels(page, 'wide')).toBe(0);
  expect(requests).toHaveLength(1);

  // Another model for labels: it writes its own, and its tag names it.
  const labelsModel = (choice: string) =>
    page.evaluate(choice => {
      const settings = (window as any).jupyterapp.shell.currentWidget.content
        .model.settings;
      settings.set('models', { ...settings.models, labels: choice });
    }, choice);
  await labelsModel('gemma-4-e2b');
  await expect(tile.locator('.jp-Epi-tabletile-description')).toHaveText(
    'local wordsAI'
  );
  await expect(
    tile.locator('.jp-Epi-tabletile-description .jp-Epi-aitag')
  ).toHaveAttribute('title', /^Written by Gemma 4 E2B, a local model on /);
  expect(requests).toHaveLength(2);
  expect(requests[1].model).toBe('gemma-4-e2b');
  // Back to the default, the fastest remote model: its labels were kept, so
  // none is asked for.
  await labelsModel('remote:fastest');
  await expect(tile.locator('.jp-Epi-tabletile-description')).toHaveText(
    'wide sample'
  );
  expect(await tablesAskingForLabels(page, 'wide')).toBe(0);
  expect(requests).toHaveLength(2);
});

test('chooses the model of each task from the toolbar, and in the settings', async ({
  page,
  tmpPath
}) => {
  // The remote model is turned off for table labels, one local model is ready
  // and one is not downloaded; the route below answers in place of the model.
  // Its answer carries the warning of a fast JSON check that failed, which
  // the status reports from then on.
  const warning =
    'The fast JSON check failed: TypeError: sample() takes 2 positional arguments, with llama-cpp-python 0.4.0 (measured with 0.3.35).';
  let failed = false;
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    const local = (
      id: string,
      label: string,
      tier: string,
      available: boolean
    ) => ({
      id,
      label,
      kind: 'local',
      tier,
      size_mb: 1000,
      note: 'a note',
      repo: `ggml-org/${label}`,
      available,
      reason: available ? null : 'not downloaded: hf download',
      downloadable: !available
    });
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: true,
        describe_tables: false,
        local_models: [
          local('gemma-4-e2b', 'Gemma 4 E2B', 'recommended', true),
          local('minicpm5-2b', 'MiniCPM5 2B', 'smaller', false)
        ],
        json_check_warning: failed ? warning : null
      }
    });
  });
  const requests: any[] = [];
  await page.route(/\/whybook\/tables\/describe/, async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    failed = true;
    const tables = body.tables.map((table: { id: string }) => ({
      id: table.id,
      description: 'local words',
      headline: ''
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({ type: 'result', elapsed: 0.2, tables, warning }) + '\n'
    });
  });
  const file = `${tmpPath}/models.ipynb`;
  await tableNotebook(page, file);
  await openInWhybook(page, file);
  const item = page.locator('.jp-Epi-status-models');
  await expect(item).toHaveText('AI: remote · 1 cannot run');
  // Labels are for the remote model, which the server turns off for tables.
  await statusRead(page);
  expect(await tablesAskingForLabels(page, 'wide')).toBe(0);
  expect(requests).toHaveLength(0);

  // The item opens the panel of the view's toolbar.
  await item.click();
  const panel = page.locator('.jp-Epi-aipanel');
  await expect(panel).toBeVisible();
  // Each task has a help icon that says what it controls, and so do
  // "Keep data on this machine", "Connected model" and "Review guard".
  const help = panel.locator('.jp-Epi-help');
  await expect(help).toHaveCount(9);
  const typed = panel.locator(
    '.jp-Epi-help[aria-label="What Typed questions controls"]'
  );
  await expect(typed).toHaveAttribute('title', /counts as descriptive/);
  await typed.click();
  await expect(panel.locator('.jp-Epi-help-text')).toContainText(
    'With the keywords alone'
  );
  await typed.click();
  await expect(panel.locator('.jp-Epi-help-text')).toHaveCount(0);
  await expect(panel.locator('#jp-Epi-quick-cells option')).toHaveText([
    'Remote AI model',
    'Off'
  ]);
  await expect(panel).toContainText('turned off on the server');
  // More questions: every local model, under the heading of its machine.
  await expect(panel.locator('#jp-Epi-quick-questions option')).toHaveText([
    'Remote AI model',
    'Gemma 4 E2B, local',
    'MiniCPM5 2B, local (cannot run)',
    'Off'
  ]);
  await expect
    .poll(() =>
      panel
        .locator('#jp-Epi-quick-questions optgroup')
        .evaluateAll(groups => groups.map(group => group.getAttribute('label')))
    )
    .toEqual(['Local, for a laptop with 16 GB', 'Local, smaller, for 8 GB']);
  // Typed questions: the rules, the local models, and Jev, greyed without a key.
  await expect(panel.locator('#jp-Epi-quick-typed option')).toHaveText([
    'Keywords, built in',
    'Gemma 4 E2B, local',
    'MiniCPM5 2B, local (cannot run)',
    'Jev by TypeSafe, remote (cannot run)'
  ]);
  await expect(
    panel.locator('#jp-Epi-quick-typed option[value="jev"]')
  ).toBeDisabled();
  await panel.locator('#jp-Epi-quick-labels').selectOption('gemma-4-e2b');
  await expect(item).toHaveText('AI: remote and local');
  const saved = await page.evaluate(async () => {
    const settings = (window as any).jupyterapp.serviceManager.settings;
    return (await settings.fetch('whybook:plugin')).raw;
  });
  expect(saved).toContain('"labels": "gemma-4-e2b"');

  // The tile is labelled by the local model.
  await page.keyboard.press('Escape');
  const tile = page.locator('[data-cell-id="wide"] .jp-Epi-tabletile');
  await expect(tile.locator('.jp-Epi-tabletile-description')).toContainText(
    'local words'
  );
  await expect(tile.locator('.jp-Epi-aitag')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe('gemma-4-e2b');
  // The request carries the JSON check of the settings, fast by default. The
  // warning of the answer shows once as a notification, and stays in the panel.
  expect(requests[0].json_check).toBe('fast');
  await expect(
    page.locator('.Toastify__toast', { hasText: 'The fast JSON check failed' })
  ).toBeVisible();
  await page.locator('.jp-Epi-aibutton').click();
  await expect(panel.locator('.jp-Epi-aipanel-note.jp-mod-warning')).toHaveText(
    warning
  );

  // All AI settings: JupyterLab's settings editor, where a missing model
  // offers its download with its size and repository.
  await panel.locator('button', { hasText: 'All AI settings' }).click();
  const field = page.locator('.jp-Epi-modelsfield');
  await expect(field).toBeVisible();
  await expect(field.locator('.jp-mod-warning')).toHaveText(warning);
  const select = (task: string) => field.locator(`#jp-Epi-model-${task}`);
  await select('labels').selectOption('minicpm5-2b');
  await expect(field).toContainText('Download 1.0 GB');
  await expect(field).toContainText('from ggml-org/MiniCPM5 2B');
  // The schema takes any model id, so the choice is saved.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const settings = (window as any).jupyterapp.serviceManager.settings;
        return (await settings.fetch('whybook:plugin')).raw;
      })
    )
    .toContain('"labels": "minicpm5-2b"');

  // With AI off for cells, a typed question cannot be asked.
  await select('cells').selectOption('off');
  await page.locator('.lm-TabBar-tab', { hasText: 'models.ipynb' }).click();
  await expect(page.locator('.jp-Epi-own textarea').first()).toHaveAttribute(
    'placeholder',
    'AI is off for cells and answers in the settings'
  );
});

test('greys the questions that need AI when no model answers, says how to set one up, and shows why a model cannot run under its select', async ({
  page,
  tmpPath
}) => {
  // The test server's CLI does not exist, so its status reports, without a
  // call to the model, that the remote model cannot answer, and why. The
  // reason depends on the server: without the claude extra it names the
  // missing SDK, with it the CLI. The view shows the one the status gives.
  const file = `${tmpPath}/noai.ipynb`;
  const notebook = {
    cells: [
      {
        cell_type: 'markdown',
        id: 'note',
        metadata: {},
        source:
          '## Results\n\nPain fell by 26% in arm B, a gain of 1.4 points on the scale.'
      },
      {
        cell_type: 'code',
        execution_count: null,
        id: 'long',
        metadata: {},
        outputs: [],
        source:
          '# A long title for this cell, which the map shows on two lines of its card\nx = 1'
      }
    ],
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
  await openInWhybook(page, file);
  const status = await (await page.request.get('/whybook/status')).json();
  const { reason, setup } = status.claude as { reason: string; setup: string };
  expect(reason).toBeTruthy();
  await page
    .locator('[data-cell-id="note"]')
    .getByRole('button', { name: 'Question this text' })
    .click();
  const box = popover(page);
  await expect(box.locator('.jp-Epi-aioff')).toHaveText(
    `Questions marked needs AI and your own questions are off: ${reason}. ${setup}`
  );
  // Every question about a text needs AI: they stay, greyed, and do nothing.
  const option = box.locator('.jp-Epi-option').first();
  await expect(option).toHaveAttribute('aria-disabled', 'true');
  await expect(option).toHaveAttribute('title', `Needs an AI model: ${reason}`);
  await option.click({ force: true });
  await expect(page.locator('.jp-Epi-strip')).toHaveCount(0);
  await expect(box.locator('.jp-Epi-ownbox textarea')).toBeDisabled();
  await box.locator('.jp-Epi-close').click();

  // The AI panel: the chosen model's name fills its select, and the reason
  // it cannot run shows in full under it, with how to set it up.
  await page.locator('.jp-Epi-aibutton').click();
  const panel = page.locator('.jp-Epi-aipanel');
  const cells = panel.locator('#jp-Epi-quick-cells');
  await expect(cells.locator('option:checked')).toHaveText('Remote AI model');
  await expect(
    panel
      .locator('.jp-Epi-aipanel-row', {
        has: page.locator('#jp-Epi-quick-cells')
      })
      .locator('.jp-Epi-aipanel-note')
  ).toHaveText(`Cannot run: ${reason}. ${setup}`);
  await page.keyboard.press('Escape');

  // The cards of the map are 260 px wide, and a long title takes two lines.
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  const card = page.locator('.jp-Epi-map-cell[data-cell-id="long"]');
  expect((await card.boundingBox())!.width).toBeCloseTo(260, 0);
  const title = card.locator('.jp-Epi-map-cell-title');
  const lines = await title.evaluate(
    node =>
      node.getBoundingClientRect().height /
      parseFloat(getComputedStyle(node).lineHeight)
  );
  expect(Math.round(lines)).toBe(2);
  await expect(title).toHaveAttribute(
    'title',
    'A long title for this cell, which the map shows on two lines of its card'
  );
});

test('summarises a frame under its columns in Contents', async ({
  page,
  tmpPath
}) => {
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true, describe_tables: true }
    });
  });
  const requests: any[] = [];
  await page.route(/\/whybook\/frames\/describe/, async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const frames = body.frames.map((frame: { id: string }) => ({
      id: frame.id,
      summary: 'One row per visit: the score of each patient.'
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: JSON.stringify({ type: 'result', elapsed: 0.2, frames }) + '\n'
    });
  });
  const file = `${tmpPath}/frames.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\nvisits = pd.DataFrame({"patient": ["a", "b"], "score": [1, 2]})'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const row = page.locator('.jp-Epi-variable', { hasText: 'visits' });
  await expect(row).toContainText('2 × 2', { timeout: 60000 });
  await row.click();

  const summary = page.locator('.jp-Epi-contents .jp-Epi-framesummary');
  await expect(summary).toContainText(
    'One row per visit: the score of each patient.'
  );
  await expect(summary.locator('.jp-Epi-aitag')).toBeVisible();
  expect(requests).toHaveLength(1);
  // The default of Labels and captions: the fastest model of the connected provider.
  expect(requests[0]).toMatchObject({
    model: 'remote:fastest',
    frames: [{ name: 'visits', rows: 2 }]
  });
  expect(
    requests[0].frames[0].columns.map((column: { name: string }) => column.name)
  ).toEqual(['patient', 'score']);
  // Kept in the notebook's metadata: selecting the frame again asks nothing.
  const kept = await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    return model.getMetadata('whybook')?.frames?.visits?.summary;
  });
  expect(kept).toBe('One row per visit: the score of each patient.');
});

test('asks a question typed beside the questions offered', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: nothing reaches Claude.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  const asked: any[] = [];
  await page.route(/\/whybook\/solve/, async route => {
    const body = route.request().postDataJSON();
    asked.push(body);
    const cell = {
      code: `x * ${asked.length + 1}`,
      summary: 'x times a number',
      assumptions: [],
      follow_up: [{ text: 'Is x ever negative?', type: 'quality' }]
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({ type: 'progress', stage: 'writing', elapsed: 0.1 }) +
        '\n' +
        JSON.stringify({
          type: 'result',
          elapsed: 0.2,
          cell,
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-5',
          cost_usd: 0.012
        }) +
        '\n'
    });
  });
  const file = `${tmpPath}/own.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  await oneCellAnswers(page);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(page.locator('.jp-Epi-cell .jp-Epi-label').first()).toHaveText(
    '[1]'
  );

  // A cell of the map: a question typed in its popover goes after it.
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await page.locator('.jp-Epi-map-cell').first().click();
  const box = popover(page).locator('.jp-Epi-ownbox');
  const field = box.locator('textarea');
  // The box says where the answer goes, from the question's words.
  await field.fill('What if x were 22?');
  await expect(box.locator('.jp-Epi-own-meta')).toContainText(
    'branch of [1] · runs in parallel'
  );
  await expect(box.locator('button[type="submit"]')).toHaveText('Branch');
  // The menu of the Ask button offers the other places, over the page, so
  // that a short popover does not cut it.
  await box.locator('.jp-Epi-split-toggle').click();
  const menu = page.locator('.jp-Epi-placemenu button');
  await expect(menu).toHaveText([
    'New cell after [1]',
    'Edit [1] in place',
    /Branch of \[1\] · runs in parallel/,
    'A preview in the sidebar'
  ]);
  await menu.first().click();
  await expect(box.locator('button[type="submit"]')).toHaveText('Ask');
  await field.fill('What is twice x?');
  await field.press('Enter');
  await page.locator('.jp-Epi-views [data-value="bench"]').click();
  // The strip on the cell asked about names the question too: find the
  // answer by its title.
  const card = (title: string) =>
    page.locator('.jp-Epi-cell', {
      has: page.locator('.jp-Epi-title', { hasText: title })
    });
  const answer = card('What is twice x?');
  await expect(answer.locator('.jp-Epi-textoutput')).toHaveText('42', {
    timeout: 60000
  });
  expect(asked[0]).toMatchObject({
    question: { text: 'What is twice x?', type: 'descriptive' },
    placement: 'new',
    cell: { source: 'x = 21' }
  });
  // A cell that a model wrote is marked so in its metadata, where a program
  // reads it (architecture/limits.md, "Constraints"): which AI wrote it, with
  // the provider and the model that the server named, what it cost, and when.
  const written = (await cellMetas(page)).find(
    meta => meta.title === 'What is twice x?'
  );
  expect(written).toMatchObject({
    written_by: 'agent',
    generated_by: {
      agent: 'openrouter',
      model: 'anthropic/claude-sonnet-5',
      cost_usd: 0.012,
      choice: 'remote'
    }
  });
  expect(Date.parse(written.generated_by.at)).not.toBeNaN();
  // What a model wrote about its answer shows as such.
  await expect(answer.locator('.jp-Epi-summary .jp-Epi-aitag')).toBeVisible();
  await expect(answer.locator('.jp-Epi-followup .jp-Epi-ai')).toHaveText(
    'Is x ever negative?'
  );

  // A follow-up of one's own, under the ones the answer offers.
  const followUp = answer.locator('.jp-Epi-followups .jp-Epi-own textarea');
  await followUp.fill('What is three times x?');
  await followUp.press('Enter');
  await expect(
    card('What is three times x?').locator('.jp-Epi-textoutput')
  ).toHaveText('63', { timeout: 60000 });

  // Worth asking next: a question about the notebook goes at its end.
  const next = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
  await next.fill('What is four times x?');
  await next.press('Enter');
  await expect(
    page.locator('.jp-Epi-cell').last().locator('.jp-Epi-textoutput')
  ).toHaveText('84', { timeout: 60000 });
  const titles = await page
    .locator('.jp-Epi-cell .jp-Epi-title')
    .allTextContents();
  expect(titles).toEqual([
    'x = 21',
    'What is twice x?',
    'What is three times x?',
    'What is four times x?'
  ]);

  // Alt+drop: a typed question joins the checklist of branches.
  await drag(
    page,
    page.locator('.jp-Epi-variable', { hasText: /^x/ }).first(),
    card('x = 21'),
    { alt: true }
  );
  const branch = popover(page).locator('.jp-Epi-own textarea');
  await expect(branch).toHaveAttribute(
    'placeholder',
    'Your own question, as one more branch'
  );
  // The popover says so, and a checkbox turns it off and on again.
  const parallel = popover(page).locator('.jp-Epi-parallel-switch input');
  await expect(parallel).toBeChecked();
  await branch.fill('Is x even?');
  await branch.press('Enter');
  await expect(
    popover(page).locator('.jp-Epi-option.jp-mod-checked', {
      hasText: 'Is x even?'
    })
  ).toBeVisible();
  // The view renders the new request on the next frame: wait for it, as
  // uncheck() would check the box at once.
  await parallel.click();
  await expect(parallel).not.toBeChecked();
  await expect(popover(page).locator('.jp-Epi-own textarea')).toHaveAttribute(
    'placeholder',
    'Your own question'
  );

  // Shift+Enter asks for a branch, as Shift+drop does.
  const count = asked.length;
  const own = popover(page).locator('.jp-Epi-own textarea');
  await own.fill('Is x large?');
  await own.press('Shift+Enter');
  await expect.poll(() => asked.length).toBe(count + 1);
  expect(asked[count]).toMatchObject({
    question: { text: 'Is x large?' },
    placement: 'branch'
  });
});

test('keeps what the AI wrote about a cell it edits in place, says when the edit fails, and Undo takes it all back', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: nothing reaches Claude.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  await page.route(/\/whybook\/solve/, async route => {
    const body = route.request().postDataJSON();
    const fails = body.question.text.includes('check');
    const cell = {
      code: fails
        ? 'x = 21\nraise ValueError("x is not checked")'
        : 'x = 21\nhalf = x / 2',
      summary: 'Halves x.',
      assumptions: [{ text: 'x is a number', kind: 'data' }],
      follow_up: [{ text: 'Is half a whole number?', type: 'quality' }]
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({ type: 'progress', stage: 'writing', elapsed: 0.1 }) +
        '\n' +
        JSON.stringify({
          type: 'result',
          elapsed: 0.2,
          cell,
          model: 'a model'
        }) +
        '\n'
    });
  });
  const file = `${tmpPath}/edit.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const card = page.locator('.jp-Epi-cell').first();
  await expect(card.locator('.jp-Epi-label')).toHaveText('[1]');
  const marks = async () => {
    const meta = (await cellMetas(page))[0];
    return {
      written_by: meta.written_by,
      generated_by: meta.generated_by?.agent,
      summary: meta.summary,
      assumptions: meta.assumptions,
      follow_up: meta.follow_up
    };
  };
  const unmarked = {
    written_by: undefined,
    generated_by: undefined,
    summary: undefined,
    assumptions: undefined,
    follow_up: undefined
  };
  expect(await marks()).toEqual(unmarked);

  // A question typed about the cell that starts with "Add" edits it in place.
  const ask = async (question: string) => {
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    await page.locator('.jp-Epi-map-cell').first().click();
    const box = popover(page).locator('.jp-Epi-ownbox');
    await box.locator('textarea').fill(question);
    await expect(box.locator('.jp-Epi-own-meta')).toContainText(
      /edit \[\d+\] in place/
    );
    await box.locator('textarea').press('Enter');
    await page.locator('.jp-Epi-views [data-value="bench"]').click();
  };
  await ask('Add half of x');
  const strip = card.locator('.jp-Epi-strip');
  await expect(strip).toContainText('Edited [2] in place', { timeout: 60000 });
  await expect(strip).not.toHaveClass(/jp-mod-error/);
  // What the model wrote about its code stays with the code, as for a new
  // cell, and shows on the card.
  await expect.poll(marks).toEqual({
    written_by: 'agent',
    generated_by: 'claude-code',
    summary: 'Halves x.',
    assumptions: [{ text: 'x is a number', kind: 'data' }],
    follow_up: [{ text: 'Is half a whole number?', type: 'quality' }]
  });
  await expect(card.locator('.jp-Epi-summary')).toContainText('Halves x.');
  await expect(card.locator('.jp-Epi-followup').first()).toContainText(
    'Is half a whole number?'
  );

  // Undo puts back the analyst's code, without the marks of a model.
  await strip.getByText('Undo').click();
  await expect.poll(marks).toEqual(unmarked);
  await expect(card.locator('.jp-Epi-summary')).toHaveCount(0);
  await idle(page);

  // An edit whose cell fails says so, and keeps its Undo.
  await ask('Add a check of x');
  await expect(strip).toHaveClass(/jp-mod-error/, { timeout: 60000 });
  await expect(strip).toContainText('failed');
  await expect(strip).toContainText('ValueError');
  await strip.getByText('Undo').click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).jupyterapp.shell.currentWidget.context.model.cells
          .get(0)
          .sharedModel.getSource()
      )
    )
    .toBe('x = 21');
});

test('says which branches of a parallel exploration failed, and keeps the done ones done', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: nothing reaches Claude.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  await page.route(/\/whybook\/solve/, async route => {
    const body = route.request().postDataJSON();
    const event = body.question.text.includes('changes')
      ? { type: 'error', message: 'No AI model answered' }
      : {
          type: 'result',
          elapsed: 0.2,
          cell: {
            code: 'x % 2 == 0',
            summary: 'Whether x is even.',
            assumptions: [],
            follow_up: []
          }
        };
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: JSON.stringify(event) + '\n'
    });
  });
  const file = `${tmpPath}/parallel.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(page.locator('.jp-Epi-cell .jp-Epi-label').first()).toHaveText(
    '[1]'
  );
  // A job goes from the job manager as soon as it ends: the strip then
  // shows what each branch ended with.
  await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.content.model;
    model.jobs.linger = 0;
  });
  await drag(
    page,
    page.locator('.jp-Epi-variable', { hasText: /^x/ }).first(),
    page.locator('.jp-Epi-cell').first(),
    { alt: true }
  );
  // The offered question needs AI, and the AI fails to write it; a typed
  // question joins the checklist, and the AI writes it.
  const own = popover(page).locator('.jp-Epi-own textarea');
  await own.fill('Is x even?');
  await own.press('Enter');
  await expect(
    popover(page).locator('.jp-Epi-option.jp-mod-checked')
  ).toHaveCount(2);
  await popover(page).getByText('Start 2 branches').click();
  const strip = page.locator('.jp-Epi-parallel');
  await expect(strip).toContainText('1 of 2 done · 1 failed', {
    timeout: 60000
  });
  await expect(strip.locator('.jp-Epi-error')).toHaveText(
    'No AI model answered'
  );
  await expect(
    strip.locator('.jp-Epi-parallel-row', { hasText: 'Is x even?' })
  ).toContainText('done');
  // The branch that the AI did not write leaves no placeholder behind.
  const sources = await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const found: string[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      found.push(model.cells.get(i).sharedModel.getSource());
    }
    return found;
  });
  expect(sources).toEqual(['x = 21', 'x % 2 == 0']);
});

test('undoes and redoes typing in an editor of the view', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/typing.ipynb`;
  await newNotebook(page, file, ['x = 1']);
  await openInWhybook(page, file);
  const source = () =>
    page.evaluate(() =>
      (window as any).jupyterapp.shell.currentWidget.context.model.cells
        .get(0)
        .sharedModel.getSource()
    );
  const card = page.locator('.jp-Epi-cell').first();
  await card.getByText('Show code').click();
  await card.locator('.cm-line').first().click();
  await page.keyboard.press('End');
  // Two edits, apart by more than the half second that joins keystrokes
  // into one step of the history: the cell's undo manager adds a change to
  // the last step until its capture timeout has passed since the last one.
  await page.keyboard.type(' + 1');
  await expect.poll(source).toBe('x = 1 + 1');
  await page.waitForFunction(() => {
    const history = (
      window as any
    ).jupyterapp.shell.currentWidget.context.model.cells.get(0).sharedModel
      .undoManager;
    return Date.now() - history.lastChange >= history.captureTimeout;
  });
  await page.keyboard.type(' + 2');
  await expect.poll(source).toBe('x = 1 + 1 + 2');
  await page.keyboard.press('Control+z');
  await expect.poll(source).toBe('x = 1 + 1');
  await page.keyboard.press('Control+z');
  await expect.poll(source).toBe('x = 1');
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(source).toBe('x = 1 + 1');
  await page.keyboard.press('Control+y');
  await expect.poll(source).toBe('x = 1 + 1 + 2');
});

test('answers a question in the right sidebar, with what the AI is doing', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: nothing reaches Claude.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  // The answer waits until the test lets it go, as a slow model would.
  let release = () => {};
  const answered = new Promise<void>(resolve => (release = resolve));
  await page.route(/\/whybook\/solve/, async route => {
    await answered;
    const cell = {
      code: 'x * 2',
      summary: 'twice x',
      assumptions: [],
      follow_up: []
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: [
        { type: 'progress', stage: 'starting', elapsed: 1 },
        { type: 'result', elapsed: 2, cell }
      ]
        .map(event => JSON.stringify(event) + '\n')
        .join('')
    });
  });
  const file = `${tmpPath}/answer.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(page.locator('.jp-Epi-cell .jp-Epi-label').first()).toHaveText(
    '[1]'
  );
  // The right sidebar is closed: the answer opens it.
  await page.evaluate(() => (window as any).jupyterapp.shell.collapseRight());
  const right = page.locator('.jp-Epi-right');
  await expect(right).toBeHidden();

  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await page.locator('.jp-Epi-map-cell').first().click();
  const box = popover(page).locator('.jp-Epi-ownbox');
  await box.locator('textarea').fill('What is twice x?');
  await box.locator('.jp-Epi-split-toggle').click();
  await page
    .locator('.jp-Epi-placemenu button', {
      hasText: 'A preview in the sidebar'
    })
    .click();
  await box.locator('textarea').press('Enter');

  // The answer opens under the tabs of the right panel, where it is seen,
  // at the height of its content (design iteration 1.77).
  const answer = right.locator('.jp-Epi-right-preview .jp-Epi-preview');
  await expect(answer).toBeVisible();
  await expect(right).not.toHaveClass(/jp-mod-split/);
  await expect(right.locator('.jp-Epi-tabs')).toBeVisible();
  await expect(page.locator('.jp-Epi-contents .jp-Epi-preview')).toHaveCount(0);
  // A bar moves while the model works: it keeps its height in the column.
  const bar = answer.locator('.jp-Epi-progress');
  expect((await bar.boundingBox())!.height).toBeGreaterThan(3);
  // While the model starts, the time counts up.
  const stage = answer.locator('.jp-Epi-preview-stage');
  await expect(stage).toHaveText(/^AI is starting · \d+ s$/);
  await expect(stage).toHaveText(/^AI is starting · [2-9] s$/, {
    timeout: 5000
  });
  // A progress event names the stage and the model's last thought. The route
  // sends its events at once, so the test sets what such an event sets.
  await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.content.model;
    model.preview.stage = 'thinking';
    model.preview.thinking = 'x is 21, so twice x is 42.';
    model._emit();
  });
  await expect(stage).toHaveText(/^AI is thinking · \d+ s$/);
  await expect(answer.locator('.jp-Epi-thinking')).toHaveText(
    'x is 21, so twice x is 42.'
  );

  release();
  // The thinking line above says 42 too: the output is what counts.
  await expect(answer.locator('.jp-Epi-plain-outputs')).toContainText('42', {
    timeout: 60000
  });
  await expect(answer.locator('.jp-Epi-preview-status')).toHaveCount(0);
  await expect(
    answer.getByRole('button', { name: 'Keep as a cell' })
  ).toBeVisible();
  await answer.getByRole('button', { name: 'Close the answer' }).click();
  await expect(right).not.toHaveClass(/jp-mod-split/);
});

test('asks for a guess while a typed question runs, counts it, and offers no questions at 0', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: nothing reaches Claude.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  let release = () => {};
  const answered = new Promise<void>(resolve => (release = resolve));
  await page.route(/\/whybook\/solve/, async route => {
    await answered;
    const cell = {
      code: 'x * y',
      summary: 'x times y',
      assumptions: [],
      follow_up: []
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: JSON.stringify({ type: 'result', elapsed: 1, cell }) + '\n'
    });
  });
  const file = `${tmpPath}/guess.ipynb`;
  await newNotebook(page, file, ['x = 21', 'y = 4']);
  await openInWhybook(page, file);
  await oneCellAnswers(page);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(page.locator('.jp-Epi-cell .jp-Epi-label').first()).toHaveText(
    '[1]'
  );
  const settings = (key: string, value: unknown) =>
    page.evaluate(
      ([key, value]) =>
        (
          window as any
        ).jupyterapp.shell.currentWidget.content.model.settings.set(key, value),
      [key, value] as [string, unknown]
    );
  try {
    // A typed association question: the AI writes its cell while the test waits.
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    await page.locator('.jp-Epi-map-cell').first().click();
    const field = popover(page).locator('.jp-Epi-ownbox textarea');
    await field.fill('Is x associated with y?');
    await field.press('Enter');
    await page.locator('.jp-Epi-views [data-value="bench"]').click();

    // While the cell is written, one optional click records a guess.
    const guess = page.locator('.jp-Epi-strip .jp-Epi-guess');
    await expect(guess.locator('.jp-Epi-guess-option')).toHaveText([
      'Higher',
      'Lower',
      'No difference',
      'Not sure'
    ]);
    await expect(
      guess.getByRole('button', { name: 'Why guess first' })
    ).toBeVisible();
    await guess.getByRole('button', { name: 'Higher' }).click();
    await expect(page.locator('.jp-Epi-strip .jp-Epi-guess')).toContainText(
      'You guessed first: expected higher'
    );
    release();
    // The answer's cell keeps the guess beside its result.
    const answer = page.locator('.jp-Epi-cell', {
      has: page.locator('.jp-Epi-title', { hasText: 'Is x associated with y?' })
    });
    await expect(answer.locator('.jp-Epi-textoutput')).toHaveText('84', {
      timeout: 60000
    });
    await expect(answer.locator('.jp-Epi-guess-chip')).toHaveText(
      'expected higher'
    );
    // The Exploration panel counts the guess, and the typed question apart.
    const numbers = page.locator('.jp-Epi-right .jp-Epi-numbers');
    // One guess, in the singular.
    const guesses = numbers.locator(
      '[title="Results you guessed before seeing them"]'
    );
    await expect(guesses).toHaveText('1guess');
    await expect(page.locator('.jp-Epi-right .jp-Epi-shades')).toHaveText(
      'Darker: questions you typed. Lighter: questions you picked.'
    );
    await expect(
      page
        .locator('.jp-Epi-right .jp-Epi-typebar-count')
        .and(page.locator('[title="1 typed, 0 picked"]'))
    ).toHaveText('1');

    // The settings can turn the guesses off: the prompt, the line and the count go.
    await settings('guessFirst', false);
    await expect(page.locator('.jp-Epi-strip .jp-Epi-guess')).toHaveCount(0);
    await expect(guesses).toHaveCount(0);

    // With 0 offered questions, a request offers none, and says why.
    await settings('offeredQuestions', 0);
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    await page.locator('.jp-Epi-map-cell').first().click();
    await expect(popover(page).locator('.jp-Epi-offered-off')).toBeVisible();
    await expect(popover(page).locator('.jp-Epi-option')).toHaveCount(0);
    await expect(
      popover(page).locator('.jp-Epi-ownbox textarea')
    ).toBeVisible();
  } finally {
    // Back to the default. Galata mocks the settings of each test, so the next test starts from the defaults anyway.
    await settings('guessFirst', true);
    await settings('offeredQuestions', 12);
  }
});

test('shows on the map how an answer asked there goes, and counts a question once its cell ran', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: nothing reaches Claude.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  let fail = () => {};
  const failing = new Promise<void>(resolve => (fail = resolve));
  await page.route(/\/whybook\/solve/, async route => {
    const question = route.request().postDataJSON().question.text;
    let events: object[];
    if (question.startsWith('Is x associated')) {
      await failing;
      events = [
        {
          type: 'error',
          message:
            'No AI model answered: the Claude Code CLI is missing on the server.'
        }
      ];
    } else {
      const cell = {
        code: 'x * y',
        summary: 'x times y',
        assumptions: [],
        follow_up: []
      };
      events = [{ type: 'result', elapsed: 1, cell }];
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: events.map(event => JSON.stringify(event)).join('\n') + '\n'
    });
  });
  const file = `${tmpPath}/mapanswer.ipynb`;
  await newNotebook(page, file, ['x = 21', 'y = 4']);
  await openInWhybook(page, file);
  await oneCellAnswers(page);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('.jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-label')
  ).toHaveText('[2]', { timeout: 60000 });
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  const node = page.locator('.jp-Epi-map-cell[data-cell-id="cell-1"]');
  const ask = async (text: string) => {
    // A click on the selected cell unselects it: the questions open on the next.
    if ((await node.getAttribute('aria-pressed')) === 'true') {
      await node.click();
    }
    await node.click();
    const field = popover(page).locator('.jp-Epi-ownbox textarea');
    await field.fill(text);
    await field.press('Enter');
  };
  await ask('Is x associated with y?');
  // While the AI writes the cell, its node says so, with the seconds and a bar.
  const answer = node.locator('.jp-Epi-map-answer');
  await expect(answer).toContainText(/^Writing the cell, \d+ s/);
  await expect(answer.locator('.jp-Epi-progress')).toBeVisible();
  // It fails: the node says why, and the question does not count as asked.
  fail();
  await expect(answer).toHaveClass(/jp-mod-error/);
  await expect(answer).toContainText(
    'Failed: No AI model answered: the Claude Code CLI is missing on the server.'
  );
  const asked = page
    .locator('.jp-Epi-right .jp-Epi-block-head', { hasText: 'Questions asked' })
    .locator('.jp-Epi-big');
  await expect(asked).toHaveText('0');
  await expect(page.locator('.jp-Epi-right .jp-Epi-failedcount')).toHaveText(
    'Not counted: 1 question that failed.'
  );
  // Another question is answered: the node says what the answer did, and
  // the question counts once its cell ran.
  await ask('What is x times y?');
  await expect(answer).toHaveText(/^Added \[3\] after \[2\]/, {
    timeout: 60000
  });
  await expect(asked).toHaveText('1');
  // The link shows the strip on the bench.
  await answer.getByRole('button', { name: 'Show on the bench' }).click();
  await expect(
    page.locator('.jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-strip')
  ).toContainText('Added [3] after [2]');
});

test('offers other values of a constant under its chip, and tries a typed one', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/whatif.ipynb`;
  // Two printed outputs above the cell leave room over its chips.
  const lines = 'print("\\n".join(str(i) for i in range(8)))';
  await newNotebook(page, file, [
    lines,
    lines,
    'ALPHA = 0.05\np_values = [0.01, 0.04, 0.2]\nsignificant = [p for p in p_values if p < ALPHA]\nlen(significant)'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  // A chip shows the name and the value, without "=".
  const chip = page.locator('.jp-Epi-chip', { hasText: 'ALPHA 0.05' });
  await chip.waitFor({ timeout: 60000 });
  await chip.click();
  const box = popover(page);
  await expect(box.locator('.jp-Epi-ask-head')).toContainText('ALPHA = 0.05');
  // A significance level: the conventional levels next to it (rules.spec.ts).
  await expect(box.locator('.jp-Epi-option .jp-Epi-option-text')).toHaveText([
    'What if ALPHA were 0.01?',
    'What if ALPHA were 0.1?'
  ]);
  // The questions open under the chip (design iteration 1.86, chips.spec.ts).
  const chipBox = (await chip.boundingBox())!;
  const boxBox = (await box.boundingBox())!;
  expect(boxBox.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height - 1);

  // A value typed as in Python runs in a branch of the cell.
  await box.locator('.jp-Epi-valuebox input').fill('0.3');
  await box.locator('.jp-Epi-valuebox button[type="submit"]').click();
  const branch = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-title', { hasText: 'What if ALPHA were 0.3?' })
  });
  await expect(branch.locator('.jp-Epi-textoutput')).toHaveText('3', {
    timeout: 60000
  });
  // A template wrote the branch, and the value is the analyst's: its chip
  // is plain, without the AI tag.
  const typed = branch.locator('.jp-Epi-chip', { hasText: 'ALPHA_if_0_3 0.3' });
  await expect(typed).toHaveText('ALPHA_if_0_3 0.3', { timeout: 60000 });
  await expect(typed.locator('.jp-Epi-aitag')).toHaveCount(0);
  await expect(typed).not.toHaveClass(/jp-mod-open/);
  // So does the question about it, where the AI's value says "The agent chose it".
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await page.locator('.jp-Epi-map-cell.jp-mod-branch').click();
  const yours = popover(page).locator('.jp-Epi-option', {
    hasText: /= 0\.3 the right choice in/
  });
  await expect(yours).toContainText('You chose it; no cell has checked it');
  await expect(yours).not.toContainText('The agent chose it');
  await popover(page).locator('.jp-Epi-close').click();
  await page.locator('.jp-Epi-views [data-value="bench"]').click();
  // A value that is not Python says so, and runs nothing.
  await chip.click();
  await box.locator('.jp-Epi-valuebox input').fill('0.3 +');
  await box.locator('.jp-Epi-valuebox button[type="submit"]').click();
  await expect(box.locator('.jp-Epi-valuebox .jp-Epi-error')).toContainText(
    'is not a Python value'
  );
});

test('shows one chip for two merges that leave how, and tries a value in one merge alone', async ({
  page,
  tmpPath
}) => {
  // Each merge drops one visit: the merge with patients drops patient 3, and
  // the merge with labs patient 2.
  const file = `${tmpPath}/merges.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\nvisits = pd.DataFrame({"patient_id": [1, 2, 3], "pain": [3, 5, 4]})\npatients = pd.DataFrame({"patient_id": [1, 2], "arm": ["A", "B"]})\nlabs = pd.DataFrame({"patient_id": [1, 3], "crp": [4.0, 9.0]})',
    'data = visits.merge(patients, on="patient_id").merge(labs, on="patient_id")\nlen(data)'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const cell = page.locator('.jp-Epi-cell[data-cell-id="cell-1"]');
  // One chip stands for both merges, short, in the colour of a value that
  // nobody chose; its tooltip names the merges.
  const chip = cell.locator('.jp-Epi-chip', { hasText: 'inner join' });
  await expect(chip).toHaveText('inner join ×2', { timeout: 60000 });
  await expect(chip).toHaveClass(/jp-mod-open/);
  expect(await tooltipLines(page, chip)).toContain(
    'In both merges: the merge with patients (line 1) and the merge with labs (line 1).'
  );

  // Its what-if asks where the value goes.
  await chip.click();
  const box = popover(page);
  const where = box.locator('.jp-Epi-where .jp-Epi-segment');
  await expect(where).toHaveText([
    'Both merges',
    'Merge with patients',
    'Merge with labs'
  ]);
  const texts = box.locator('.jp-Epi-option .jp-Epi-option-text');
  await expect(texts.first()).toHaveText(
    'What if how were "left" in both merges?'
  );
  await where.filter({ hasText: 'labs' }).click();
  await expect(texts.first()).toHaveText(
    'What if how were "left" in the merge with labs?'
  );
  await texts.first().click();

  // The branch keeps patient 2, whom the merge with labs dropped, and still
  // drops patient 3 in the merge with patients: 2 rows, where a left join in
  // both merges keeps 3.
  const branch = page.locator('.jp-Epi-cell.jp-mod-branch', {
    has: page.locator('.jp-Epi-title', {
      hasText: 'What if how were "left" in the merge with labs?'
    })
  });
  await expect(branch.locator('.jp-Epi-textoutput')).toHaveText('2', {
    timeout: 60000
  });
  const code = await page.evaluate(() => {
    const cells = (window as any).jupyterapp.shell.currentWidget.context.model
      .cells;
    for (let i = 0; i < cells.length; i++) {
      const source: string = cells.get(i).sharedModel.getSource();
      if (source.includes('in the merge with labs')) {
        return source;
      }
    }
    return '';
  });
  expect(code).toContain(
    'data_if_left = visits.merge(patients, on="patient_id").merge(labs, on="patient_id", how="left")'
  );
  // The calls now leave different values: a chip for each, named by the
  // frame it joins. The left join is the analyst's choice: a plain chip.
  const chips = branch.locator('.jp-Epi-chip');
  await expect(chips).toHaveText(
    ['inner join · patients', 'left join · labs'],
    {
      timeout: 60000
    }
  );
  await expect(chips.nth(0)).toHaveClass(/jp-mod-open/);
  await expect(chips.nth(1)).not.toHaveClass(/jp-mod-open/);
  await expect(chips.nth(1).locator('.jp-Epi-aitag')).toHaveCount(0);
});

test('says what an answer did, and closes its strip with its × or after work on another cell', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/strips.ipynb`;
  await newNotebook(page, file, [
    'x = 1',
    'ALPHA = 0.05\np_values = [0.01, 0.04, 0.2]\nsignificant = [p for p in p_values if p < ALPHA]\nlen(significant)'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const chip = page.locator('.jp-Epi-chip', { hasText: 'ALPHA 0.05' });
  await chip.waitFor({ timeout: 60000 });
  const strip = page.locator(
    '.jp-Epi-cell[data-cell-id="cell-1"] .jp-Epi-strip'
  );
  const tryValue = async (value: string) => {
    await chip.click();
    await popover(page).locator('.jp-Epi-valuebox input').fill(value);
    await popover(page)
      .locator('.jp-Epi-valuebox button[type="submit"]')
      .click();
  };

  // Once done, the strip says what the answer did, in the past tense.
  await tryValue('0.3');
  await expect(strip.locator('.jp-Epi-strip-action')).toHaveText(
    /^Branched \[2\] as \[2[b-z]\]$/,
    { timeout: 60000 }
  );
  // Its × closes it, and the branch stays.
  await strip.locator('.jp-Epi-close').click();
  await expect(strip).toHaveCount(0);
  await expect(
    page.locator('.jp-Epi-title', { hasText: 'What if ALPHA were 0.3?' })
  ).toBeVisible();

  // By default a finished strip closes a while after another cell runs; the
  // test shortens the while.
  await page.evaluate(() => {
    (window as any).jupyterapp.shell.currentWidget.content.model.stripLinger =
      300;
  });
  await tryValue('0.5');
  await expect(strip.locator('.jp-Epi-strip-action')).toHaveText(/^Branched/, {
    timeout: 60000
  });
  await page
    .locator(
      '.jp-Epi-cell[data-cell-id="cell-0"] .jp-Epi-cell-actions button',
      {
        hasText: 'Run'
      }
    )
    .click();
  await expect(strip).toHaveCount(0, { timeout: 10000 });
});

test('closes the questions and the Ask menu when a click or focus goes elsewhere', async ({
  page,
  tmpPath
}) => {
  // The status says a model is set up, so that the Ask button has its menu.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  const file = `${tmpPath}/dismiss.ipynb`;
  await newNotebook(page, file, ['x = 1', 'y = 2']);
  await openInWhybook(page, file);
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  const cell = page.locator('.jp-Epi-map-cell').first();
  await cell.click();
  const box = popover(page).locator('.jp-Epi-ownbox');
  await expect(box).toBeVisible();

  // A click inside the questions, or in the Questions section, keeps them.
  await box.locator('textarea').click();
  await page.locator('.jp-Epi-questions .jp-Epi-section-head').first().click();
  await expect(popover(page)).toBeVisible();

  // The Ask menu closes on a click outside it, and the questions stay.
  await box.locator('textarea').fill('What if x were 2?');
  await box.locator('.jp-Epi-split-toggle').click();
  const menu = page.locator('.jp-Epi-placemenu');
  await expect(menu).toBeVisible();
  await popover(page).locator('.jp-Epi-ask-head code').click();
  await expect(menu).toHaveCount(0);
  await expect(popover(page)).toBeVisible();

  // The Ask menu also closes when the keyboard focus leaves it.
  await box.locator('.jp-Epi-split-toggle').click();
  await expect(menu).toBeVisible();
  await page.locator('input[placeholder="Filter variables"]').focus();
  await expect(menu).toHaveCount(0);
  // So do the questions: the focus is in another panel now.
  await expect(popover(page)).toHaveCount(0);

  // A click in another panel closes them too.
  await cell.click();
  await expect(popover(page)).toBeVisible();
  await page.locator('input[placeholder="Filter variables"]').click();
  await expect(popover(page)).toHaveCount(0);
});

test('sorts a typed question with the model chosen for typed questions', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: no model runs.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: true,
        local_models: [
          {
            id: 'gemma-4-e2b',
            label: 'Gemma 4 E2B',
            kind: 'local',
            size_mb: 2841,
            note: 'a note',
            repo: 'ggml-org/gemma',
            available: true,
            reason: null,
            downloadable: false
          }
        ]
      }
    });
  });
  const sorted: any[] = [];
  await page.route(/\/whybook\/questions\/sort/, async route => {
    sorted.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        type: {
          choice: 'quality',
          probabilities: { quality: 0.8, descriptive: 0.2 }
        },
        place: null,
        model: 'Gemma 4 E2B'
      })
    });
  });
  const file = `${tmpPath}/sorted.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(page.locator('.jp-Epi-cell .jp-Epi-label').first()).toHaveText(
    '[1]'
  );
  await page.locator('.jp-Epi-aibutton').click();
  await page.locator('#jp-Epi-quick-typed').selectOption('gemma-4-e2b');
  await page.keyboard.press('Escape');

  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await page.locator('.jp-Epi-map-cell').first().click();
  const box = popover(page).locator('.jp-Epi-ownbox');
  const meta = box.locator('.jp-Epi-own-meta');
  // No keyword gives a type: the model does, marked as AI.
  await box.locator('textarea').fill('Are these weights plausible?');
  await expect(meta).toContainText('Data quality');
  await expect(meta.locator('.jp-Epi-aitag').first()).toHaveAttribute(
    'title',
    'Type chosen by Gemma 4 E2B, 80%'
  );
  expect(sorted).toHaveLength(1);
  expect(sorted[0]).toMatchObject({
    text: 'Are these weights plausible?',
    model: 'gemma-4-e2b',
    cell: 'x = 21'
  });
  // A keyword types the question: the model is not asked. The box sorts a
  // text 300 ms after the typing stops, and each text is noted here once
  // its sort has ended, with a request or without.
  await page.evaluate(() => {
    const state = window as any;
    const model = state.jupyterapp.shell.currentWidget.content.model;
    const sortOwn = model.sortOwn;
    state.epiSorted = [];
    model.sortOwn = async function (this: unknown, ...args: unknown[]) {
      await sortOwn.apply(this, args);
      state.epiSorted.push(args[0]);
    };
  });
  await box.locator('textarea').fill('Is x related to its double?');
  await expect(meta).toContainText('Association');
  await expect(meta.locator('.jp-Epi-aitag')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).epiSorted))
    .toContain('Is x related to its double?');
  expect(sorted).toHaveLength(1);
});

test('orders the questions offered with the model chosen for question order', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: no model runs. The status
  // reports that the remote model can answer, which the test server's cannot.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: true,
        local_models: [
          {
            id: 'gemma-4-e2b',
            label: 'Gemma 4 E2B',
            kind: 'local',
            size_mb: 2841,
            note: 'a note',
            repo: 'ggml-org/gemma',
            available: true,
            reason: null,
            downloadable: false
          }
        ]
      }
    });
  });
  // The model puts the rules' last question first. The answers about a drop
  // wait until the test lets each one go; a failure answers with an error.
  const ranked: any[] = [];
  const waiting: (() => void)[] = [];
  let fail = false;
  await page.route(/\/whybook\/questions\/rank/, async route => {
    const body = route.request().postDataJSON();
    ranked.push(body);
    if (body.selection) {
      await new Promise<void>(resolve => waiting.push(resolve));
    }
    const count = body.questions.length;
    const scores = Object.fromEntries(
      body.questions.map((question: { id: string }, index: number) => [
        question.id,
        (index + 1) / (count + 1)
      ])
    );
    const event = fail
      ? { type: 'error', message: 'the model file is missing', elapsed: 0.1 }
      : {
          type: 'result',
          elapsed: 0.2,
          scores,
          model: 'Gemma 4 E2B',
          file: 'ggml-org/gemma/gemma.gguf',
          cost_usd: 0
        };
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: JSON.stringify(event) + '\n'
    });
  });
  // The code names no column, so each column but the outcome is worth
  // asking about next.
  const file = `${tmpPath}/ranked.ipynb`;
  await newNotebook(
    page,
    file,
    [
      'import pandas as pd\nnames = "age pain sleep mood".split()\ndf = pd.DataFrame(dict(zip(names, [[30, 41, 52, 63], [2.0, 3.5, 4.0, 6.5], [7, 6, 5, 8], [3, 2, 4, 1]])))'
    ],
    { whybook: { outcome: 'pain' } }
  );
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-aibutton').click();
  await expect(page.locator('#jp-Epi-quick-ranking option')).toHaveText([
    'Rules, built in',
    'Remote AI model',
    'Gemma 4 E2B, local',
    'Jev by TypeSafe, remote (cannot run)'
  ]);
  await page.locator('#jp-Epi-quick-ranking').selectOption('gemma-4-e2b');
  await page.keyboard.press('Escape');
  await page.locator('.jp-Epi-runall').click();
  const row = page.locator('.jp-Epi-variable', { hasText: 'df' });
  await expect(row).toBeVisible({ timeout: 60000 });

  // Worth asking next takes the model's order, and names the model.
  const next = page.locator('.jp-Epi-exploration');
  await expect(next.locator('.jp-Epi-ordernote')).toContainText(
    'Ordered by Gemma 4 E2B',
    { timeout: 30000 }
  );
  const steps = ranked.find(body => !body.selection);
  expect(steps.model).toBe('gemma-4-e2b');
  await expect(next.locator('.jp-Epi-next-text').first()).toHaveText(
    steps.questions[steps.questions.length - 1].text
  );

  // A drop of the frame on itself shows the rules' order at once, and the
  // model's order waits while the pointer is on the list.
  const texts = popover(page).locator('.jp-Epi-option .jp-Epi-option-text');
  const note = popover(page).locator('.jp-Epi-ordernote');
  await drag(page, row, row, { dx: 60, dy: 8 });
  await expect(note).toHaveText('Ordering with Gemma 4 E2B…');
  const rules = await texts.allInnerTexts();
  expect(rules.length).toBeGreaterThan(1);
  await popover(page).locator('.jp-Epi-option').first().hover();
  await expect.poll(() => waiting.length).toBe(1);
  const drop = ranked[ranked.length - 1];
  expect(drop).toMatchObject({
    model: 'gemma-4-e2b',
    selection: { source: { name: 'df' } }
  });
  expect(drop.questions.slice(0, rules.length).map((q: any) => q.text)).toEqual(
    rules
  );
  waiting.shift()!();
  await expect(note).toHaveText(
    'Gemma 4 E2B ordered these questions. Show its order'
  );
  await expect(texts).toHaveText(rules);
  await note.locator('button', { hasText: 'Show its order' }).click();
  const reversed = drop.questions
    .map((q: any) => q.text)
    .reverse()
    .slice(0, rules.length);
  await expect(texts).toHaveText(reversed);
  await expect(note).toContainText('Ordered by Gemma 4 E2B');
  await expect(note.locator('.jp-Epi-aitag')).toHaveAttribute(
    'title',
    /^Ordered by Gemma 4 E2B, a local model/
  );
  // The model's number shows beside the rules' in the tooltip of relevance.
  await expect(
    popover(page).locator('.jp-Epi-relevance').first()
  ).toHaveAttribute('title', /Gemma 4 E2B gives \d+%; the rules gave \d+%/);

  // With the pointer away from the list, the order shows when it comes.
  await popover(page)
    .getByRole('button', { name: 'Close the questions' })
    .click();
  await expect(popover(page)).toHaveCount(0);
  await drag(page, row, row, { dx: 60, dy: 8 });
  await expect(note).toHaveText('Ordering with Gemma 4 E2B…');
  await page.mouse.move(2, 2);
  await expect.poll(() => waiting.length).toBe(1);
  waiting.shift()!();
  await expect(note).toContainText('Ordered by Gemma 4 E2B');
  await expect(texts).toHaveText(reversed);

  // A model that fails leaves the rules' order, and says why.
  fail = true;
  await popover(page)
    .getByRole('button', { name: 'Close the questions' })
    .click();
  await expect(popover(page)).toHaveCount(0);
  await drag(page, row, row, { dx: 60, dy: 8 });
  await page.mouse.move(2, 2);
  await expect.poll(() => waiting.length).toBe(1);
  waiting.shift()!();
  await expect(note).toHaveText(
    "In the rules' order: Gemma 4 E2B failed (the model file is missing)"
  );
  await expect(texts).toHaveText(rules);
});

test('answers a typed question with an agent that adds and runs cells and side explorations', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: no model runs. The agent's
  // stream asks the view for one cell, then two branches of it, and answers.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  const asked: any[] = [];
  await page.route(/\/whybook\/agent(\?.*)?$/, async route => {
    asked.push(route.request().postDataJSON());
    const events = [
      { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
      {
        type: 'progress',
        stage: 'thinking',
        message: 'Compare the arms first.',
        elapsed: 0.2
      },
      {
        type: 'tool',
        run: 'r1',
        call: 'c1',
        name: 'run_cell',
        input: {
          title: 'Mean pain by arm',
          code: 'visits.groupby("arm").pain.mean()',
          why: 'compare the arms'
        }
      },
      { type: 'text', text: 'Arm B looks lower. Is that robust?' },
      {
        type: 'tool',
        run: 'r1',
        call: 'c2',
        name: 'explore',
        input: {
          of: '[2]',
          why: 'Is the difference robust?',
          branches: [
            { title: 'Median', code: 'visits.groupby("arm").pain.median()' },
            {
              title: 'Without the highest value',
              code: 'visits[visits.pain < 6].groupby("arm").pain.mean()'
            }
          ]
        }
      },
      {
        type: 'result',
        answer:
          'Arm B has less pain than arm A ([2]), and the median agrees ([2b]).',
        cells: ['[2]', '[2b]'],
        follow_up: ['causal: What could confound arm and pain?'],
        model: 'claude-opus-5-5',
        cost_usd: 0.05,
        elapsed: 3
      }
    ];
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: events.map(event => JSON.stringify(event)).join('\n') + '\n'
    });
  });
  const results: any[] = [];
  await page.route(/\/whybook\/agent\/result/, async route => {
    results.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  const file = `${tmpPath}/agent.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\nvisits = pd.DataFrame({"arm": ["A", "A", "B", "B"], "pain": [5.0, 6.5, 3.1, 3.3]})'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('.jp-Epi-variable', { hasText: 'visits' })
  ).toBeVisible({ timeout: 60000 });

  const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
  await own.fill('Does pain differ by arm?');
  await own.press('Enter');
  const run = page.locator('.jp-Epi-agentrun');
  await expect(run.locator('.jp-Epi-agentrun-question')).toHaveText(
    'Does pain differ by arm?'
  );
  // One step per tool: the cell, then its two branches, each linked by label.
  const steps = run.locator('.jp-Epi-agentrun-steps li');
  await expect(steps).toHaveCount(2, { timeout: 60000 });
  await expect(steps.nth(0)).toContainText('[2]');
  await expect(steps.nth(0)).toContainText('Mean pain by arm');
  await expect(steps.nth(1)).toContainText(
    'Side exploration: Is the difference robust?'
  );
  await expect(steps.nth(1).locator('.jp-Epi-agentrun-cell')).toHaveText([
    '[2b]',
    '[2c]'
  ]);
  await expect(run.locator('.jp-Epi-agentrun-status')).toHaveText(
    'Answered with 3 cells',
    { timeout: 60000 }
  );
  // The answer links its cells, and is marked as written by a model.
  const answer = run.locator('.jp-Epi-agentrun-answer');
  await expect(answer).toContainText('Arm B has less pain than arm A');
  await expect(answer.locator('.jp-Epi-agentrun-cell')).toHaveText([
    '[2]',
    '[2b]'
  ]);
  await expect(answer.locator('.jp-Epi-aitag')).toHaveAttribute(
    'title',
    /^Answered by the remote AI model, claude-opus-5-5/
  );
  await expect(run.locator('.jp-Epi-agentrun-followup')).toHaveText(
    /What could confound arm and pain\?/
  );

  // The request carried the question and the notebook; the results went back.
  expect(asked[0]).toMatchObject({
    question: { text: 'Does pain differ by arm?' }
  });
  expect(results.map(result => [result.run, result.call])).toEqual([
    ['r1', 'c1'],
    ['r1', 'c2']
  ]);
  expect(results[0].result).toMatchObject({ status: 'ok', cell: '[2]' });
  expect(results[0].result.outputs[0].text).toContain('5.75');
  expect(results[1].result.branches.map((branch: any) => branch.cell)).toEqual([
    '[2b]',
    '[2c]'
  ]);
  expect(results[1].result.branches[0].outputs[0].text).toContain('5.75');
  // The cells are in the notebook, the branches as branches of [2].
  const titles = await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const found: string[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      found.push(model.cells.get(i).getMetadata('whybook')?.title ?? '');
    }
    return found;
  });
  expect(titles.slice(1)).toEqual([
    'Mean pain by arm',
    'Median',
    'Without the highest value'
  ]);
  // Each cell that the agent added is marked as written by an AI, with its
  // run: the provider connected on the server, and the model that the run's
  // end named. The notebook keeps the run, with what the whole run cost.
  const added = (await cellMetas(page)).slice(1);
  for (const meta of added) {
    expect(meta).toMatchObject({
      written_by: 'agent',
      generated_by: { agent: 'claude-code', model: 'claude-opus-5-5' },
      agent: { run: 'r1' }
    });
    expect(Date.parse(meta.generated_by.at)).not.toBeNaN();
  }
  const runs = await page.evaluate(
    () =>
      (window as any).jupyterapp.shell.currentWidget.context.model.getMetadata(
        'whybook'
      )?.agent_runs
  );
  expect(runs?.r1).toMatchObject({
    provider: 'claude-code',
    model: 'claude-opus-5-5',
    cost_usd: 0.05,
    state: 'done'
  });
  expect(runs.r1.cells).toHaveLength(added.length);

  // As a card, the run heads the cells it added.
  const agentView = (value: string) =>
    page.evaluate(value => {
      const settings = (window as any).jupyterapp.shell.currentWidget.content
        .model.settings;
      settings.set('agentView', value);
    }, value);
  await agentView('card');
  const card = page.locator('.jp-Epi-agentgroup');
  await expect(card.locator('.jp-Epi-agentrun.jp-mod-card')).toBeVisible();
  await expect(card.locator('.jp-Epi-cell')).toHaveCount(3);
  await expect(page.locator('.jp-Epi-agentpointer')).toContainText(
    'in the card below'
  );
  // In the sidebar, it takes the lower half of the right panel.
  await agentView('sidebar');
  await expect(
    page.locator('.jp-Epi-right-answer .jp-Epi-agentrun.jp-mod-sidebar')
  ).toBeVisible();
  await expect(page.locator('.jp-Epi-agentgroup')).toHaveCount(0);

  // Remove its cells, and Undo puts them back.
  await page
    .locator('.jp-Epi-right-answer .jp-Epi-agentrun')
    .getByRole('button', { name: 'Remove its cells' })
    .click();
  await expect(page.locator('.jp-Epi-cell')).toHaveCount(1);
  await page.locator('.jp-toast-button', { hasText: 'Undo' }).click();
  await expect(page.locator('.jp-Epi-cell')).toHaveCount(4);
});

test('lets the agent write a module next to the notebook, marked as written by AI, and removes it with its cells', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: no model runs. The agent
  // writes a module, imports it in a cell, and answers.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true }
    });
  });
  await page.route(/\/whybook\/agent(\?.*)?$/, async route => {
    const events = [
      { type: 'started', run: 'r2', keep_local: false, elapsed: 0 },
      {
        type: 'tool',
        run: 'r2',
        call: 'f1',
        name: 'write_file',
        input: {
          path: 'pain_tools.py',
          content: 'FACTOR = 2\n\n\ndef scaled(x):\n    return FACTOR * x\n',
          why: 'functions that several cells call'
        }
      },
      {
        type: 'tool',
        run: 'r2',
        call: 'c1',
        name: 'run_cell',
        input: {
          title: 'Scale x',
          code: 'import pain_tools\n\nprint(pain_tools.scaled(x))'
        }
      },
      {
        type: 'result',
        answer: 'Twice x is 42 ([2]).',
        cells: ['[2]'],
        follow_up: [],
        model: 'claude-opus-5-5',
        cost_usd: 0.01,
        elapsed: 2
      }
    ];
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: events.map(event => JSON.stringify(event)).join('\n') + '\n'
    });
  });
  const results: any[] = [];
  await page.route(/\/whybook\/agent\/result/, async route => {
    results.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  const file = `${tmpPath}/module.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(page.locator('.jp-Epi-variable', { hasText: /^x/ })).toBeVisible(
    {
      timeout: 60000
    }
  );

  const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
  await own.fill('What is x scaled by the factor?');
  await own.press('Enter');
  const run = page.locator('.jp-Epi-agentrun');
  await expect(run.locator('.jp-Epi-agentrun-status')).toHaveText(
    'Answered with 1 cell and 1 file',
    { timeout: 60000 }
  );
  // The step names the file and opens it; the module's function ran in the cell.
  const step = run.locator('.jp-Epi-agentrun-steps li').first();
  await expect(step.locator('.jp-Epi-agentrun-file')).toHaveText(
    'pain_tools.py'
  );
  await expect(step).toContainText('A module of 6 lines');
  await expect(
    page
      .locator('.jp-Epi-cell', {
        has: page.locator('.jp-Epi-title', { hasText: 'Scale x' })
      })
      .locator('.jp-Epi-textoutput')
  ).toHaveText('42', { timeout: 60000 });
  expect(results[0]).toMatchObject({
    call: 'f1',
    result: { status: 'ok', path: 'pain_tools.py', lines: 6 }
  });

  // The file's first line marks it as written by AI, and the notebook records it.
  const module = `${tmpPath}/pain_tools.py`;
  const read = () =>
    page.evaluate(async (path: string) => {
      try {
        const model = await (
          window as any
        ).jupyterapp.serviceManager.contents.get(path, { content: true });
        return model.content as string;
      } catch {
        return null;
      }
    }, module);
  const written = await read();
  expect(written?.split('\n')[0]).toMatch(
    /^# Written by AI \(Whybook's agent\) for module\.ipynb on \d{4}-\d{2}-\d{2}\.$/
  );
  expect(written).toContain('def scaled(x):');
  const record = await page.evaluate(
    (path: string) =>
      (window as any).jupyterapp.shell.currentWidget.context.model.getMetadata(
        'whybook'
      )?.files?.[path],
    module
  );
  expect(record).toMatchObject({
    generated_by: { agent: 'claude-code', model: 'claude-opus-5-5' },
    run: 'r2'
  });

  // Removing the run's work deletes the module with the cell; Undo writes it back.
  await run.getByRole('button', { name: 'Remove its cells and files' }).click();
  await expect.poll(read).toBeNull();
  await page.locator('.jp-toast-button', { hasText: 'Undo' }).click();
  await expect.poll(read).toBe(written);
});

/**
 * A status that says a model with a known price is connected, for the tests
 * of the cost; with `labels`, the server lets it write labels and captions.
 */
async function pricedModel(
  page: IJupyterLabPageFixture,
  labels = false
): Promise<void> {
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        ...(labels ? { describe_tables: true } : {}),
        claude_available: true,
        claude: {
          ...status.claude,
          available: true,
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-5',
          priced: true,
          reason: null,
          setup: null
        }
      }
    });
  });
}

/** The whybook metadata of the current notebook. */
async function notebookMetadata(page: IJupyterLabPageFixture): Promise<any> {
  return page.evaluate(
    () =>
      (window as any).jupyterapp.shell.currentWidget.context.model.getMetadata(
        'whybook'
      ) ?? {}
  );
}

/** Write a notebook whose cells carry the view's metadata. */
async function notebookWithMeta(
  page: IJupyterLabPageFixture,
  file: string,
  cells: { source: string; whybook?: Record<string, unknown> }[],
  whybook: Record<string, unknown>
): Promise<void> {
  const notebook = {
    cells: cells.map((cell, index) => ({
      cell_type: 'code',
      execution_count: null,
      id: `cell-${index}`,
      metadata: cell.whybook ? { whybook: cell.whybook } : {},
      outputs: [],
      source: cell.source
    })),
    metadata: {
      kernelspec: {
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
        name: 'python3'
      },
      whybook
    },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

test("shows what a notebook's answers cost behind a setting, the time of a new answer, and a cap kept in the notebook", async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: no model runs.
  await pricedModel(page);
  await page.route(/\/whybook\/solve/, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({
          type: 'result',
          elapsed: 6.4,
          cell: {
            code: 'x * 3',
            summary: 'x times three',
            assumptions: [],
            follow_up: []
          },
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-5',
          cost_usd: 0.02
        }) + '\n'
    });
  });
  // The analyst's cell, an answer of one cell, the two cells of an agent's
  // run, whose record holds the cost, and an answer by a model without a
  // known price. The answers cost $0.016 and $0.05: $0.066 in all.
  const at = '2026-09-28T09:00:00.000Z';
  const byModel = (
    title: string,
    generated: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => ({
    title,
    written_by: 'agent',
    asked_by: 'user',
    generated_by: { choice: 'remote', at, ...generated },
    ...extra
  });
  const file = `${tmpPath}/cost.ipynb`;
  await notebookWithMeta(
    page,
    file,
    [
      { source: 'x = 21' },
      {
        source: 'x * 2',
        whybook: byModel('Twice x', {
          agent: 'openrouter',
          model: 'anthropic/claude-sonnet-5',
          cost_usd: 0.016,
          seconds: 8.1
        })
      },
      {
        source: 'x + 1',
        whybook: byModel(
          'x plus one',
          { agent: 'openrouter', model: 'm', cost_usd: null },
          { agent: { run: 'r1', step: 1 } }
        )
      },
      {
        source: 'x - 1',
        whybook: byModel(
          'x minus one',
          { agent: 'openrouter', model: 'm', cost_usd: null },
          { agent: { run: 'r1', step: 2 } }
        )
      },
      {
        source: 'x / 7',
        whybook: byModel('A seventh of x', {
          agent: 'huggingface',
          model: 'Qwen/Qwen3.8-27B:ovhcloud',
          cost_usd: null,
          seconds: 11.4
        })
      }
    ],
    {
      agent_runs: {
        r1: {
          question: 'What is next to x?',
          provider: 'openrouter',
          model: 'm',
          cost_usd: 0.05,
          seconds: 41.6,
          cells: ['cell-2', 'cell-3'],
          files: [],
          state: 'done',
          at
        }
      }
    }
  );
  await openInWhybook(page, file);
  await oneCellAnswers(page);
  await kernelIdle(page);
  const card = (title: string) =>
    page.locator('.jp-Epi-cell', {
      has: page.locator('.jp-Epi-title', { hasText: title })
    });
  const details = async (title: string) => {
    await card(title)
      .first()
      .locator('.jp-Epi-cell-head')
      .click({ position: { x: 40, y: 10 } });
    await page
      .locator('.jp-Epi-tabs button', { hasText: 'Cell details' })
      .click();
    return page.locator('.jp-Epi-details');
  };
  const section = (title: string) =>
    page.locator('.jp-Epi-details-section').filter({
      has: page.locator('.jp-Epi-details-toggle', { hasText: title })
    });

  // Off, as at first: no cost shows beyond what "Written by" said before.
  const block = page.locator('.jp-Epi-cost');
  await expect(block).toHaveCount(0);
  await details('Twice x');
  await expect(section('Written by')).toContainText('for 0.016 US dollars');
  await expect(section('Cost')).toHaveCount(0);

  // A search for "cost" in the settings editor finds the setting.
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('settingeditor:open', {
      query: 'cost'
    });
  });
  const entry = page
    .locator('.jp-PluginList-entry', { hasText: 'Cost of AI answers' })
    .first();
  await expect(entry).toBeVisible({ timeout: 30000 });
  await entry.click();
  const check = page.getByRole('checkbox', { name: 'Cost of AI answers' });
  await expect(check).not.toBeChecked();
  await check.check();
  await openInWhybook(page, file);
  await page.locator('.jp-Epi-tabs button', { hasText: 'Exploration' }).click();

  // The total counts each answer once, and the one without a price apart.
  await expect(block.locator('.jp-Epi-big')).toHaveText('$0.066');
  await expect(block).toContainText('No cap on this notebook.');
  await expect(block.locator('.jp-Epi-cost-unpriced')).toHaveText(
    '1 call without a known price, not counted against the cap.'
  );
  await expect(block.locator('.jp-Epi-block-head')).toHaveAttribute(
    'title',
    /does not count against the cap/
  );

  // Cell details: the dollars and the time of the answer, and the run's for
  // a cell of a run; "Written by" leaves the cost to its section.
  await details('Twice x');
  await expect(section('Cost')).toContainText('Written for $0.016 in 8 s.');
  await expect(section('Written by')).not.toContainText('US dollars');
  await details('x minus one');
  await expect(section('Cost')).toContainText(
    "Written in an agent's run, which cost $0.05 in 42 s for its 2 cells."
  );
  await details('A seventh of x');
  await expect(section('Cost')).toContainText(
    'Written in 11 s, at no known price.'
  );
  await details('x = 21');
  await expect(section('Cost')).toContainText('You wrote this code.');

  // A cap of $0.50, set in the section, goes with the notebook.
  await page.locator('.jp-Epi-tabs button', { hasText: 'Exploration' }).click();
  const field = block.getByLabel('Cap, in US dollars');
  await field.fill('two');
  await expect(block.locator('.jp-Epi-cost-invalid')).toBeVisible();
  await expect(block.getByRole('button', { name: 'Set' })).toBeDisabled();
  await field.fill('$0.5');
  await block.getByRole('button', { name: 'Set' }).click();
  await expect(block).toContainText('$0.066 of $0.50.');
  await expect(field).toHaveValue('0.50');
  expect((await notebookMetadata(page)).cost_cap_usd).toBe(0.5);

  // A new answer of one cell records its time with its cost, and counts.
  await page.locator('.jp-Epi-runall').click();
  await expect(card('Twice x').locator('.jp-Epi-textoutput')).toHaveText('42', {
    timeout: 60000
  });
  const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
  await own.fill('What is x times three?');
  await own.press('Enter');
  await expect(
    card('What is x times three?').locator('.jp-Epi-textoutput')
  ).toHaveText('63', { timeout: 60000 });
  const written = (await cellMetas(page)).find(
    meta => meta.title === 'What is x times three?'
  );
  expect(written.generated_by).toMatchObject({ cost_usd: 0.02, seconds: 6.4 });
  await expect(block.locator('.jp-Epi-big')).toHaveText('$0.086');
  await details('What is x times three?');
  await expect(section('Cost')).toContainText('Written for $0.02 in 6 s.');

  // Remove takes the cap away.
  await page.locator('.jp-Epi-tabs button', { hasText: 'Exploration' }).click();
  await block.getByRole('button', { name: 'Remove' }).click();
  await expect(block).toContainText('No cap on this notebook.');
  expect((await notebookMetadata(page)).cost_cap_usd).toBeUndefined();
});

test("keeps what every model call cost, with the setting off too: a template cell's labels, the title and the summary of the analyst's cell, and a total that stays when cells go", async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: no model runs. Each call
  // costs what a model of OpenRouter would.
  await pricedModel(page, true);
  const answer = (usd: number, fields: Record<string, unknown>) =>
    JSON.stringify({
      type: 'result',
      elapsed: 1.2,
      model: 'openrouter:anthropic/claude-sonnet-5',
      cost_usd: usd,
      ...fields
    }) + '\n';
  const asked: Record<string, any[]> = { titles: [], labels: [], frames: [] };
  await page.route(/\/whybook\/cells\/title/, async route => {
    const body = route.request().postDataJSON();
    asked.titles.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: answer(0.00041, {
        cells: body.cells.map((cell: any) => ({
          id: cell.id,
          title: 'Thirty columns of counts'
        }))
      })
    });
  });
  await page.route(/\/whybook\/tables\/describe/, async route => {
    const body = route.request().postDataJSON();
    asked.labels.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: answer(0.0021, {
        tables: body.tables.map((table: any) => ({
          id: table.id,
          description: 'column summaries',
          headline: ''
        }))
      })
    });
  });
  await page.route(/\/whybook\/frames\/describe/, async route => {
    const body = route.request().postDataJSON();
    asked.frames.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: answer(0.00031, {
        frames: body.frames.map((frame: any) => ({
          id: frame.id,
          summary: 'Thirty columns of small counts.'
        }))
      })
    });
  });
  // The analyst's cell makes a frame of 30 columns, and the second cell is as
  // a drop answered from a template leaves it: the view wrote it, and no
  // model. At Overview, the bench shows its table as a tile, which a model
  // labels.
  const file = `${tmpPath}/calls.ipynb`;
  await notebookWithMeta(
    page,
    file,
    [
      {
        source:
          'import pandas as pd\nwide = pd.DataFrame({f"col_{i}": range(3) for i in range(30)})'
      },
      {
        source: 'wide.describe()',
        whybook: {
          title: 'Describe wide',
          question: {
            id: 'drop:describe',
            text: 'Describe wide',
            type: 'descriptive'
          },
          asked_by: 'user',
          written_by: 'agent',
          template: true,
          placement: {
            kind: 'new',
            cell: 'cell-0',
            label: 'new cell after [1]'
          }
        }
      }
    ],
    {}
  );
  await openInWhybook(page, file);
  await page.evaluate(() => {
    (window as any).jupyterapp.shell.currentWidget.content.model.settings.set(
      'detail',
      'overview'
    );
  });
  await kernelIdle(page);

  // With the setting off, as at first: the view shows no cost, and keeps
  // each call's cost in the notebook all the same.
  await page.locator('.jp-Epi-runall').click();
  await expect.poll(() => asked.labels.length, { timeout: 60000 }).toBe(1);
  await expect.poll(() => asked.titles.length, { timeout: 60000 }).toBe(1);
  expect(asked.labels[0].tables.map((table: any) => table.cell)).toEqual([
    'cell-1'
  ]);
  expect(asked.titles[0].cells.map((cell: any) => cell.id)).toEqual(['cell-0']);
  const variable = page.locator('.jp-Epi-variable', { hasText: 'wide' });
  await variable.click();
  await expect.poll(() => asked.frames.length, { timeout: 60000 }).toBe(1);
  await expect(page.locator('.jp-Epi-cost')).toHaveCount(0);
  await expect
    .poll(async () => (await notebookMetadata(page)).costs)
    .toEqual({
      labels: { usd: 0.0021, n: 1, seconds: 1.2 },
      titles: { usd: 0.00041, n: 1, seconds: 1.2 },
      summaries: { usd: 0.00031, n: 1, seconds: 1.2 }
    });
  const metas = await cellMetas(page);
  expect(metas[0].costs).toEqual({
    titles: { usd: 0.00041, n: 1 },
    summaries: { usd: 0.00031, n: 1 }
  });
  expect(metas[1].costs).toEqual({ labels: { usd: 0.0021, n: 1 } });

  // On, the total counts every call, with the exact amount on hover and the
  // sums by kind in a fold.
  await page.evaluate(() => {
    (window as any).jupyterapp.shell.currentWidget.content.model.settings.set(
      'showCost',
      true
    );
  });
  const block = page.locator('.jp-Epi-cost');
  const total = block.locator('.jp-Epi-big .jp-Epi-usd');
  await expect(total).toHaveText('$0.0028');
  await expect(total).toHaveAttribute('title', '$0.00282, 0.28 cents');
  await block.getByRole('button', { name: 'Where it went' }).click();
  await expect(block.locator('.jp-Epi-cost-kinds tr')).toHaveText([
    /^Titles\s*1 call\s*\$0\.00041$/,
    /^Table labels\s*1 call\s*\$0\.0021$/,
    /^Frame summaries\s*1 call\s*\$0\.00031$/
  ]);

  // Cell details: the template cell says that no model wrote it, and lists
  // what models did for it; so does the analyst's cell.
  const card = (title: string) =>
    page.locator('.jp-Epi-cell', {
      has: page.locator('.jp-Epi-title', { hasText: title })
    });
  const cost = page.locator('.jp-Epi-details-section').filter({
    has: page.locator('.jp-Epi-details-toggle', { hasText: 'Cost' })
  });
  const details = async (title: string) => {
    await card(title)
      .first()
      .locator('.jp-Epi-cell-head')
      .click({ position: { x: 40, y: 10 } });
    await page
      .locator('.jp-Epi-tabs button', { hasText: 'Cell details' })
      .click();
  };
  await details('Describe wide');
  await expect(cost.locator('.jp-Epi-details-cost')).toHaveText(
    'Written from a template, with no model call.'
  );
  await expect(
    page.locator('.jp-Epi-details-section').filter({
      has: page.locator('.jp-Epi-details-toggle', { hasText: 'Written by' })
    })
  ).toContainText(
    'Whybook wrote the code from a template, with no model call.'
  );
  await expect(cost.locator('.jp-Epi-cost-parts tr')).toHaveText([
    /^The labels of its tables\s*1 call\s*\$0\.0021$/
  ]);
  await expect(
    cost.locator('.jp-Epi-cost-parts .jp-Epi-usd').first()
  ).toHaveAttribute('title', '$0.0021, 0.21 cents');
  await details('Thirty columns of counts');
  await expect(cost.locator('.jp-Epi-details-cost')).toHaveText(
    'You wrote this code.'
  );
  await expect(cost.locator('.jp-Epi-cost-parts tr')).toHaveText([
    /^Its title\s*1 call\s*\$0\.00041$/,
    /^The summary of a frame it makes\s*1 call\s*\$0\.00031$/
  ]);

  // The total stays when a cell goes, and when an undo takes it back.
  await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.content.model;
    model.deleteCell('cell-1');
  });
  await expect(page.locator('.jp-Epi-cell')).toHaveCount(1);
  await page.locator('.jp-Epi-tabs button', { hasText: 'Exploration' }).click();
  await expect(total).toHaveText('$0.0028');
  expect((await notebookMetadata(page)).costs.labels.usd).toBe(0.0021);
});

test("holds an answer at the notebook's cap until Go on raises the cap by $1, and asks again when a run stops at the cap", async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: no model runs. The first
  // run adds a cell, then stops at what was left under the notebook's cap;
  // the second answers.
  await pricedModel(page);
  const asked: any[] = [];
  await page.route(/\/whybook\/agent(\?.*)?$/, async route => {
    const body = route.request().postDataJSON();
    asked.push(body);
    const events =
      asked.length === 1
        ? [
            { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
            {
              type: 'tool',
              run: 'r1',
              call: 'c1',
              name: 'run_cell',
              input: { title: 'One more than x', code: 'y = x + 1\ny' }
            },
            {
              type: 'result',
              stopped: true,
              capped: { by: 'notebook', usd: body.budget_usd },
              answer: null,
              cells: [],
              model: 'openrouter:anthropic/claude-sonnet-5',
              cost_usd: 1.02,
              elapsed: 30.2
            }
          ]
        : [
            { type: 'started', run: 'r2', keep_local: false, elapsed: 0 },
            {
              type: 'result',
              answer: 'x is 21 ([1]).',
              cells: ['[1]'],
              follow_up: [],
              model: 'openrouter:anthropic/claude-sonnet-5',
              cost_usd: 0.1,
              elapsed: 5
            }
          ];
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: events.map(event => JSON.stringify(event)).join('\n') + '\n'
    });
  });
  await page.route(/\/whybook\/agent\/result/, route =>
    route.fulfill({ status: 200, json: { ok: true } })
  );
  // A run of $0.50 has reached the notebook's cap of $0.50.
  const file = `${tmpPath}/capped.ipynb`;
  await notebookWithMeta(page, file, [{ source: 'x = 21' }], {
    cost_cap_usd: 0.5,
    agent_runs: {
      r0: {
        question: 'An earlier question',
        provider: 'openrouter',
        model: 'm',
        cost_usd: 0.5,
        cells: [],
        files: [],
        state: 'done',
        at: '2026-09-28T09:00:00.000Z'
      }
    }
  });
  await openInWhybook(page, file);
  await page.evaluate(() => {
    const settings = (window as any).jupyterapp.shell.currentWidget.content
      .model.settings;
    settings.set('showCost', true);
    settings.set('answers', 'agent');
  });
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(page.locator('.jp-Epi-cell .jp-Epi-label').first()).toHaveText(
    '[1]'
  );
  const block = page.locator('.jp-Epi-cost');
  await expect(block).toContainText(
    '$0.50 of $0.50: an answer that needs a model waits until you go on.'
  );

  // The question does not start, and its strip says why.
  const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
  await own.fill('What is x?');
  await own.press('Enter');
  const held = page.locator('.jp-Epi-heldstrip');
  await expect(held).toContainText('Not started');
  await expect(held).toContainText('What is x?');
  await expect(held).toContainText(
    "The notebook's cap is reached: $0.50 of $0.50."
  );
  expect(asked).toHaveLength(0);

  // Go on raises the cap by $1, and the run gets what is left under it.
  await held.getByRole('button', { name: 'Go on, for up to $1 more' }).click();
  await expect(held).toHaveCount(0);
  const run = page.locator('.jp-Epi-agentrun');
  await expect(run.locator('.jp-Epi-agentrun-status')).toHaveText(
    "Stopped at the notebook's cap · 1 cell kept",
    { timeout: 60000 }
  );
  expect(asked).toHaveLength(1);
  expect(asked[0].budget_usd).toBe(1);
  expect(asked[0].question.text).toBe('What is x?');
  let meta = await notebookMetadata(page);
  expect(meta.cost_cap_usd).toBe(1.5);
  expect(meta.agent_runs.r1).toMatchObject({
    cost_usd: 1.02,
    seconds: 30.2,
    state: 'stopped'
  });

  // The run cannot go on from where it stopped: Go on says that it starts
  // over, raises the cap by $1 and asks the question again.
  await expect(run.locator('.jp-Epi-capnote')).toContainText(
    "Stopped at the notebook's cap: $1.52 of $1.50. Go on asks the question again from the start, and the cells of this run stay."
  );
  await run.getByRole('button', { name: 'Go on, for up to $1 more' }).click();
  await expect(run.locator('.jp-Epi-agentrun-answer')).toContainText(
    'x is 21',
    { timeout: 60000 }
  );
  expect(asked).toHaveLength(2);
  expect(asked[1].question.text).toBe('What is x?');
  expect(asked[1].budget_usd).toBeCloseTo(0.98, 6);
  meta = await notebookMetadata(page);
  expect(meta.cost_cap_usd).toBe(2.5);
  expect(meta.agent_runs.r2).toMatchObject({ cost_usd: 0.1, state: 'done' });
  // The cell of the stopped run stays.
  await expect(
    page.locator('.jp-Epi-cell', {
      has: page.locator('.jp-Epi-title', { hasText: 'One more than x' })
    })
  ).toHaveCount(1);
  await expect(block.locator('.jp-Epi-big')).toHaveText('$1.62');
});

test('keeps the data on this machine by the setting, and shows the lock that the server sets', async ({
  page,
  tmpPath
}) => {
  // These routes answer in place of the server: no model runs.
  let fixed = false;
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: true,
        describe_tables: true,
        keep_data_local: fixed
      }
    });
  });
  const solved: any[] = [];
  await page.route(/\/whybook\/solve/, async route => {
    solved.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({ type: 'error', message: 'answered by the test' }) +
        '\n'
    });
  });
  const file = `${tmpPath}/local.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await expect(page.locator('.jp-Epi-status-models')).toHaveText('AI: remote');

  // The analyst's setting: labels need a local model, and the status bar says where the data stays.
  await page.locator('.jp-Epi-aibutton').click();
  const panel = page.locator('.jp-Epi-aipanel');
  const box = panel.locator('#jp-Epi-quick-keepDataLocal');
  await expect(box).not.toBeChecked();
  await box.check();
  // The chosen model keeps its name in the select, and the line under it
  // says why it cannot run.
  await expect(
    panel.locator('#jp-Epi-quick-labels option[value="remote"]')
  ).toHaveText('Remote AI model');
  await expect(panel).toContainText(
    'Cannot run: the data stays on this machine, and the remote model would read the table'
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('.jp-Epi-status-models')).toHaveText(
    'AI: remote, data stays here · 1 cannot run'
  );

  // A question for one cell says so, and the server cuts the prompt back.
  await page.evaluate(() => {
    const settings = (window as any).jupyterapp.shell.currentWidget.content
      .model.settings;
    settings.set('answers', 'cell');
  });
  const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
  await own.fill('What is twice x?');
  await own.press('Enter');
  // The view reads a kernel that it saw start before its first request to a
  // model, which sends the kernel's packages: that took 5 s and more in two
  // runs of ten, on the kernel of a notebook opened a second before.
  await expect.poll(() => solved.length, { timeout: 30000 }).toBe(1);
  expect(solved[0].keep_data_local).toBe(true);

  // The server's lock: the box shows checked and greyed, with the reason,
  // in the panel and in the settings editor.
  fixed = true;
  await page.evaluate(async () => {
    const settings = (window as any).jupyterapp.shell.currentWidget.content
      .model.settings;
    settings.set('keepDataLocal', false);
    await (
      window as any
    ).jupyterapp.shell.currentWidget.content.model.refreshStatus();
  });
  await page.locator('.jp-Epi-aibutton').click();
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  await expect(panel).toContainText(
    'Fixed on the server: c.Whybook.keep_data_local'
  );
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('settingeditor:open', {
      query: 'Whybook'
    });
  });
  const field = page.locator('#jp-Epi-settings-keepDataLocal');
  // The editor lists the plugins that match; the view's settings open on a click.
  const entry = page
    .locator('.jp-PluginList-entry', { hasText: 'Whybook' })
    .first();
  if (!(await field.isVisible()) && (await entry.isVisible())) {
    await entry.click();
  }
  await expect(field).toBeChecked({ timeout: 30000 });
  await expect(field).toBeDisabled();
  await expect(page.locator('.jp-Epi-datapolicyfield')).toContainText(
    'Fixed on the server'
  );
});

test("shows each setting once in the settings editor: one description of Keep data on this machine and of Custom local models, no replaced setting, and the view's icon on the entry", async ({
  page
}) => {
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('settingeditor:open', {
      query: 'Whybook'
    });
  });
  const field = page.locator('#jp-Epi-settings-keepDataLocal');
  // The editor lists the plugins that match; the view's settings open on a click.
  const entry = page
    .locator('.jp-PluginList-entry', { hasText: 'Whybook' })
    .first();
  await expect(field.or(entry).first()).toBeVisible({ timeout: 30000 });
  if (!(await field.isVisible())) {
    await entry.click();
  }
  await expect(field).toBeVisible({ timeout: 30000 });
  const form = page.locator('.jp-SettingsForm', { has: field });
  // The name once, on the check box, and the description once, under it.
  await expect(
    form.getByText('Keep data on this machine', { exact: true })
  ).toHaveCount(1);
  await expect(form.getByText(/leave the machine/)).toHaveCount(1);
  await expect(
    form.getByText(/Labels and captions then need a local model/)
  ).toHaveCount(1);
  // mapOutputs, replaced by mapDetail, stays out of the form.
  await expect(
    form.getByText('Outputs on the map', { exact: true })
  ).toBeVisible();
  await expect(form.getByText(/Outputs on the map \(replaced\)/)).toBeHidden();
  await expect(form.getByText(/Replaced by mapDetail/)).toBeHidden();
  // Custom local models, an array: JupyterLab writes its description under
  // the title and again under the Add button, and the second copy is hidden.
  await expect(
    form
      .getByText(/^GGUF models that the Jupyter server runs/)
      .filter({ visible: true })
  ).toHaveCount(1);
  // The entry of the list carries the view's icon (jupyter.lab.setting-icon).
  await expect(
    entry.locator('svg[data-icon="whybook:epinotebook"]')
  ).toBeVisible();
});

test('sets the level of detail of outputs, and shows outputs on the map', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/detail.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\npd.DataFrame({"a": [1, 2], "b": [3, 4]})',
    'print("one\\ntwo\\nthree\\nfour")'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const table = page.locator('.jp-Epi-tableoutput');
  // Full, the default: the small table in full, and four printed lines.
  await expect(table).toHaveClass(/jp-mod-inline/, { timeout: 60000 });
  await expect(page.locator('.jp-Epi-textoutput')).toHaveText(
    'one\ntwo\nthree\nfour'
  );
  const slider = page.locator('.jp-Epi-detail input');
  await expect(page.locator('.jp-Epi-detail-value')).toHaveText('Full');
  // Compact: no table in full, and more than three lines make a tile.
  await slider.fill('1');
  await expect(page.locator('.jp-Epi-detail-value')).toHaveText('Compact');
  await expect(table).toHaveClass(/jp-mod-miniature/);
  await expect(page.locator('.jp-Epi-logtile')).toContainText('4 lines');
  // Overview: every table is a tile.
  await slider.fill('0');
  await expect(table).toHaveClass(/jp-mod-tile/);

  // The map has its own levels on the same slider: Minimal by default, one
  // line of small tiles per cell.
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await expect(page.locator('.jp-Epi-detail-value')).toHaveText('Minimal');
  const tiles = page.locator('.jp-Epi-map-output');
  await expect(tiles).toHaveText(['2 × 2', '4 lines']);
  // None: the cells alone.
  await slider.fill('0');
  await expect(page.locator('.jp-Epi-detail-value')).toHaveText('None');
  await expect(tiles).toHaveCount(0);
  // Overview: the tiles of the bench's Overview, and the card grows to hold them.
  const card = page.locator('.jp-Epi-map-cell').first();
  const minimalHeight = (await card.boundingBox())!.height;
  await slider.fill('2');
  await expect(page.locator('.jp-Epi-detail-value')).toHaveText('Overview');
  const overview = page.locator('.jp-Epi-map-overview');
  await expect(overview.locator('.jp-Epi-tableoutput')).toHaveClass(
    /jp-mod-tile/
  );
  await expect(overview.locator('.jp-Epi-logtile')).toContainText('4 lines');
  await expect
    .poll(async () => (await card.boundingBox())!.height)
    .toBeGreaterThan(minimalHeight + 30);
  // A click on a tile selects the cell, as a click on the card does.
  await overview.locator('.jp-Epi-tableoutput').first().click();
  await expect(card).toHaveClass(/jp-mod-selected/);
  await page.keyboard.press('Escape');
  await slider.fill('1');
  await expect(tiles).toHaveCount(2);

  // The Code view follows the slider of the bench: tiles at overview, as on the
  // bench; the map's level did not change it.
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  await expect(page.locator('.jp-Epi-detail-value')).toHaveText('Overview');
  const linearTable = page.locator('.jp-Epi-linear .jp-Epi-tableoutput');
  await expect(linearTable).toHaveClass(/jp-mod-tile/);
  await slider.fill('1');
  await expect(linearTable).toHaveClass(/jp-mod-miniature/);
  await expect(page.locator('.jp-Epi-linear .jp-Epi-logtile')).toContainText(
    '4 lines'
  );
  // Full: every output as in the notebook.
  await slider.fill('2');
  await expect(page.locator('.jp-Epi-detail-value')).toHaveText('Full');
  await expect(linearTable).toHaveCount(0);
  await expect(
    page.locator('.jp-Epi-linear-outputs .jp-RenderedHTMLCommon table')
  ).toHaveCount(1);
  await expect(
    page.locator('.jp-Epi-linear-outputs .jp-RenderedText')
  ).toContainText('four');
});

test('shows a cell of the map on the bench, and leads back to the current cell', async ({
  page,
  tmpPath
}) => {
  // Sixteen cells of twelve printed lines each: the bench scrolls.
  const lines = Array.from({ length: 12 }, (_, line) => `line ${line}\n`);
  const notebook = {
    cells: Array.from({ length: 16 }, (_, index) => ({
      cell_type: 'code',
      execution_count: index + 1,
      id: `cell-${index}`,
      metadata: {},
      source: `# Step ${index}\nprint("step ${index}")`,
      outputs: [{ output_type: 'stream', name: 'stdout', text: lines }]
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
  const file = `${tmpPath}/steps.ipynb`;
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
  await openInWhybook(page, file);

  // A double-click on a cell of the map shows it on the bench.
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await page.locator('.jp-Epi-map-cell[data-cell-id="cell-2"]').dblclick();
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-2"]');
  await expect(card).toBeInViewport();

  // Scrolled away, the bench leads back to it.
  const back = page.locator('.jp-Epi-backtocell');
  await expect(back).toHaveCount(0);
  await page
    .locator('.jp-Epi-main')
    .evaluate(main => main.scrollTo({ top: main.scrollHeight }));
  await expect(back).toHaveClass(/jp-mod-above/);
  await expect(back).toContainText('Step 2');
  await back.click();
  await expect(card).toBeInViewport();
  await expect(back).toHaveCount(0);

  // The menu of a card on the bench shows it on the map, and not on the bench.
  await card.locator('.jp-Epi-cell-head').click({ button: 'right' });
  const menu = page.locator('.lm-Menu-item:not(.lm-mod-hidden)');
  await expect(menu.filter({ hasText: 'Show on the bench' })).toHaveCount(0);
  await menu.filter({ hasText: 'Show on the map' }).click();
  const mapCard = page.locator('.jp-Epi-map-cell[data-cell-id="cell-2"]');
  await expect(mapCard).toBeInViewport();
  // The button on the card's head does what the double-click does.
  await mapCard.hover();
  await mapCard.locator('.jp-Epi-map-show').click();
  await expect(card).toBeInViewport();
});

test('sizes plots by the level of detail, brushes a box on a scatter plot, copies outputs and shows the cell of an output', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/scatter.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd\nimport whybook\ndf = pd.DataFrame({"x": range(20), "y": [v % 7 for v in range(20)]})',
    'whybook.scatter(df, "x", "y")',
    'print("copy me")'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.jp-Epi-runall').click();
  const card = page.locator('.jp-Epi-cell[data-cell-id="cell-1"]');
  const plot = card.locator('.jp-Epi-plotout svg.jp-Epi-plot');
  const width = async () => (await plot.boundingBox())!.width;
  // Full, the default: the plot at a readable size in its card.
  await expect(plot).toBeVisible({ timeout: 60000 });
  const full = await width();
  // Compact: a smaller plot, still in the card. Overview: a thumbnail.
  const slider = page.locator('.jp-Epi-detail input');
  await slider.fill('1');
  await expect.poll(width).toBeLessThan(full);
  await expect.poll(width).toBeLessThanOrEqual(341);
  await slider.fill('0');
  await expect(plot).toHaveCount(0);
  await expect(card.locator('.jp-Epi-miniature svg')).toBeVisible();
  await slider.fill('2');

  // A drag on a scatter plot selects a box: the rows in both ranges.
  const area = (await plot.boundingBox())!;
  await page.mouse.move(area.x + area.width * 0.3, area.y + area.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.7, area.y + area.height * 0.7, {
    steps: 10
  });
  await page.mouse.up();
  const caption = popover(page).locator('.jp-Epi-caption', { hasText: 'rows' });
  await expect(caption).toHaveText(/^\d+ rows/, { timeout: 30000 });
  const rows = Number((await caption.textContent())!.match(/^\d+/)![0]);
  expect(rows).toBeGreaterThan(0);
  expect(rows).toBeLessThan(20);
  const brush = (await card.locator('.jp-Epi-brush').boundingBox())!;
  expect(brush.height).toBeLessThan(area.height * 0.6);
  await popover(page).locator('.jp-Epi-close').click();

  // A selection asks a question, so outputs have copy buttons: printed text
  // copies as text, and a plot as a picture too.
  const printed = page.locator('.jp-Epi-cell[data-cell-id="cell-2"]');
  await printed.locator('.jp-Epi-textoutput').hover();
  const copyText = printed.getByRole('button', { name: 'Copy this text' });
  await expect(copyText).toHaveCSS('opacity', '1');
  await copyText.click();
  await expect(copyText).toHaveClass(/jp-mod-copied/);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('copy me');
  await plot.hover();
  const copyPlot = card.getByRole('button', { name: 'Copy this output' });
  await copyPlot.click();
  await expect(copyPlot).toHaveClass(/jp-mod-copied/);
  const types = await page.evaluate(async () =>
    (await navigator.clipboard.read()).flatMap(item => [...item.types])
  );
  expect(types).toContain('image/png');

  // A thumbnail opens the cell's details, which name the cell; a click on
  // "Show in the view" shows the cell in the current view and flashes it.
  await slider.fill('0');
  await card.locator('.jp-Epi-miniature').click();
  await expect(page.locator('.jp-Epi-details-head')).toContainText('[2]');
  await expect(
    page.locator('.jp-Epi-details-output.jp-mod-opened svg.jp-Epi-plot')
  ).toBeVisible();
  const link = page.locator('.jp-Epi-details-links button', {
    hasText: 'Show in the view'
  });
  await link.click();
  await expect(card).toHaveClass(/jp-mod-flash/);
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  await link.click();
  await expect(
    page.locator('.jp-Epi-linear-cell[data-cell-id="cell-1"]')
  ).toHaveClass(/jp-mod-flash/);
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await link.click();
  const node = page.locator('.jp-Epi-map-cell[data-cell-id="cell-1"]');
  await expect(node).toHaveClass(/jp-mod-flash/);
  const view = (await page.locator('.jp-Epi-map-viewport').boundingBox())!;
  const box = (await node.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(view.x);
  expect(box.x + box.width).toBeLessThanOrEqual(view.x + view.width);
  // Full again. Galata mocks the settings of each test, so the next test starts from the defaults anyway.
  await page.locator('.jp-Epi-views [data-value="bench"]').click();
  await slider.fill('2');
});

test('moves and zooms the map, also when it fits the view', async ({
  page,
  tmpPath
}) => {
  await newNotebook(page, `${tmpPath}/map.ipynb`, ['x = 1', 'y = x + 1']);
  await openInWhybook(page, `${tmpPath}/map.ipynb`);
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  const viewport = page.locator('.jp-Epi-map-viewport');
  const canvas = page.locator('.jp-Epi-map-canvas');
  const transform = () => canvas.evaluate(node => node.style.transform);
  const view = (await viewport.boundingBox())!;
  const map = (await canvas.boundingBox())!;
  expect(map.width).toBeLessThan(view.width);
  expect(map.height).toBeLessThan(view.height);
  await expect.poll(transform).toBe('translate(0px, 0px) scale(1)');

  // Space+drag, from a spot with no cell.
  const x = view.x + view.width - 150;
  const y = view.y + 40;
  await page.mouse.move(x, y);
  await page.keyboard.down(' ');
  await page.mouse.down();
  await page.mouse.move(x - 100, y + 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up(' ');
  await expect.poll(transform).toBe('translate(-100px, 60px) scale(1)');

  // A middle-button drag, then the wheel.
  await page.mouse.move(x, y + 100);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x + 40, y + 80, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await expect.poll(transform).toBe('translate(-60px, 40px) scale(1)');
  await page.mouse.wheel(0, 100);
  await expect.poll(transform).toBe('translate(-60px, -60px) scale(1)');

  // Ctrl+wheel zooms around the pointer; the percentage resets.
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  const level = page.locator('.jp-Epi-map-zoom .jp-mod-level');
  await expect(level).toHaveText('149%');
  await level.click();
  await expect.poll(transform).toBe('translate(0px, 0px) scale(1)');

  // The map fills its column, which does not scroll: no white shows around it.
  const main = page.locator('.jp-Epi-main');
  const scroll = await main.evaluate(node => [
    node.scrollWidth - node.clientWidth,
    node.scrollHeight - node.clientHeight
  ]);
  expect(scroll).toEqual([0, 0]);
  const column = (await main.boundingBox())!;
  const hint = (await page.locator('.jp-Epi-map-hint').boundingBox())!;
  const after = (await viewport.boundingBox())!;
  expect(after.width).toBeCloseTo(column.width, 0);
  expect(after.y + after.height).toBeCloseTo(hint.y, 0);
});

test('waits for a branch before a cell that uses what it makes', async ({
  page,
  tmpPath
}) => {
  // The branch runs in a subshell; the cell after it needs its result.
  const cell = (id: string, source: string, whybook?: object) => ({
    cell_type: 'code',
    execution_count: null,
    id,
    metadata: whybook ? { whybook } : {},
    outputs: [],
    source
  });
  const notebook = {
    cells: [
      cell('first', 'x = 1'),
      cell('slow', 'import time\ntime.sleep(3)\nbranch_value = x + 1', {
        branch: { of: 'first', letter: 'b' }
      }),
      cell('after', 'branch_value * 2')
    ],
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
  const file = `${tmpPath}/branch.ipynb`;
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('[data-cell-id="after"] .jp-Epi-textoutput')
  ).toHaveText('4', { timeout: 60000 });
  await expect(
    page.locator('[data-cell-id="after"] .jp-Epi-error')
  ).toHaveCount(0);
});

test('asks about a cell when a variable is dropped on its code', async ({
  page,
  tmpPath
}) => {
  await newNotebook(page, `${tmpPath}/code-drop.ipynb`, [
    'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2]})',
    'y = 2'
  ]);
  await openInWhybook(page, `${tmpPath}/code-drop.ipynb`);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const row = page.locator('.jp-Epi-variable', { hasText: 'df' });
  await expect(row).toBeVisible({ timeout: 60000 });
  const second = page.locator('[data-cell-id="cell-1"]');
  await second
    .locator('.jp-Epi-cell-actions button', { hasText: 'Show code' })
    .click();
  const editor = second.locator('.jp-Epi-editor .cm-content');
  await expect(editor).toBeVisible();
  await drag(page, row, editor, { dy: 8 });
  await expect(popover(page)).toBeVisible();
  // The editor would have inserted "df" where the pointer was.
  const source = await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    return model.cells.get(1).sharedModel.getSource();
  });
  expect(source).toBe('y = 2');
});

test('keeps the variables of the last run through a restart', async ({
  page,
  tmpPath
}) => {
  await newNotebook(page, `${tmpPath}/restore.ipynb`, [
    'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2], "b": [3, 4]})'
  ]);
  await openInWhybook(page, `${tmpPath}/restore.ipynb`);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('.jp-Epi-variable:not(.jp-mod-stale)', { hasText: 'df' })
  ).toBeVisible({ timeout: 60000 });
  // The notebook keeps df with the cell that makes it. The first listing
  // comes before the kernel's analysis of the cell, so df gets its cell
  // when the analysis comes. A restart before then cancels the analysis.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const kept: { name: string; cell: string | null }[] =
          (
            window as any
          ).jupyterapp.shell.currentWidget.context.model.getMetadata('whybook')
            ?.variables ?? [];
        return kept.find(variable => variable.name === 'df')?.cell;
      })
    )
    .toBe('cell-0');

  await page.evaluate(() =>
    (
      window as any
    ).jupyterapp.shell.currentWidget.context.sessionContext.restartKernel()
  );
  await kernelIdle(page);
  // The view lists the variables of the new kernel, which has no df: df
  // stays, stale, until its cell runs.
  await page.evaluate(() =>
    (window as any).jupyterapp.shell.currentWidget.content.model.refresh()
  );
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  const node = page.locator('.jp-Epi-map-frame', { hasText: 'df' });
  await expect(node).toHaveClass(/jp-mod-stale/);
  await expect(
    page.locator('.jp-Epi-variable.jp-mod-stale', { hasText: 'df' })
  ).toBeVisible();
  await expect(
    page.locator('.jp-Epi-variables .jp-Epi-stale-note')
  ).toContainText('from the last run');

  // Touching it offers to run the cells that make it.
  await node.click();
  await expect(popover(page)).toContainText('df is not in the kernel');
  await popover(page).locator('.jp-Epi-missing-actions button').first().click();
  await expect(node).not.toHaveClass(/jp-mod-stale/, { timeout: 60000 });
});

test('offers to run the cells that a cell uses before its questions edit it', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/inputs.ipynb`;
  await newNotebook(page, file, MODEL_CELLS, { whybook: { outcome: 'y' } });
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('.jp-Epi-cell[data-cell-id="cell-2"] .jp-Epi-label')
  ).toHaveText('[3]', { timeout: 60000 });
  await idle(page);
  // After a restart only the first cell runs again: the model's cell uses
  // data, which the kernel lacks.
  await page.evaluate(() =>
    (
      window as any
    ).jupyterapp.shell.currentWidget.context.sessionContext.restartKernel()
  );
  await kernelIdle(page);
  await page
    .locator(
      '.jp-Epi-cell[data-cell-id="cell-0"] .jp-Epi-cell-actions button',
      {
        hasText: 'Run'
      }
    )
    .click();
  const df = page.locator('.jp-Epi-variable[data-variable="df"]');
  await expect(df).not.toHaveClass(/jp-mod-stale/, { timeout: 60000 });
  await idle(page);
  await df.click();
  await drag(
    page,
    page.locator('.jp-Epi-column', { hasText: 'z' }).first(),
    page.locator('.jp-Epi-cell[data-cell-id="cell-2"]')
  );
  await expect(popover(page)).toContainText(
    '[3] uses data, which is not in the kernel.'
  );
  const run = popover(page).locator('.jp-Epi-missing-actions button').first();
  await expect(run).toHaveText('Run [2] first');
  await run.click();
  // Once [2] ran, the questions come, and the edit in place runs without an error.
  const covariate = popover(page).locator('.jp-Epi-option', {
    hasText: 'Add z as a covariate'
  });
  await expect(covariate).toBeVisible({ timeout: 60000 });
  await covariate.click();
  const strip = page.locator(
    '.jp-Epi-cell[data-cell-id="cell-2"] .jp-Epi-strip'
  );
  await expect(strip.locator('.jp-Epi-strip-action')).toHaveText(
    'Edited [3] in place',
    { timeout: 60000 }
  );
  await idle(page);
  await expect(strip).not.toHaveClass(/jp-mod-error/);
  await expect(
    page.locator('.jp-Epi-cell[data-cell-id="cell-2"] .jp-Epi-formula')
  ).toContainText('y ~ x + z');
});

test('starts a new Whybook from the launcher and the data next to it, and offers the choice its load left open', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadContent(
    'patient_id,visit,crp\nP1,1,3.2\nP2,1,5.1\n',
    'text',
    `${tmpPath}/visits.csv`
  );
  await page.evaluate(() =>
    (window as any).jupyterapp.commands
      .execute('launcher:create')
      .then(() => null)
  );
  // Galata opens a launcher too: in the one in view, the first card of the
  // Whybook section, the default kernel's (design iteration 1.72).
  const tile = page
    .locator('.jp-LauncherCard[data-category="Whybook"]:visible')
    .first();
  await expect(tile).toBeVisible();
  await expect(tile.locator('svg image')).toHaveAttribute(
    'href',
    /^data:image\//
  );

  // The command of the tiles, in the test's folder, with the default kernel.
  await page.evaluate(
    cwd =>
      (window as any).jupyterapp.commands
        .execute('whybook:new-epinotebook', { cwd })
        .then(() => null),
    tmpPath
  );
  const start = page.locator('.jp-Epi-start');
  await expect(start).toContainText('Start from your data');
  await start.locator('button', { hasText: 'Show databases' }).click();
  await expect(page.locator('#epi-databases')).toBeVisible();
  await start.locator('.jp-Epi-start-file', { hasText: 'visits.csv' }).click();
  await popover(page)
    .locator('.jp-Epi-option', { hasText: 'Load visits.csv' })
    .first()
    .click();
  await expect(
    page.locator('.jp-Epi-title', { hasText: 'Load visits.csv as visits' })
  ).toBeVisible();
  // The analyst chose the file: the chip of its path is theirs, with no AI tag.
  const fileChip = page.locator('.jp-Epi-chip', { hasText: 'visits.csv' });
  await expect(fileChip.first()).toBeVisible({ timeout: 30000 });
  await expect(fileChip.first()).not.toHaveClass(/jp-mod-open/);
  await expect(fileChip.first().locator('.jp-Epi-ai')).toHaveCount(0);
  // The first cell took the place of the new notebook's empty one.
  const cells = await page.evaluate(
    () =>
      (window as any).jupyterapp.shell.currentWidget.context.model.cells.length
  );
  expect(cells).toBe(1);
  // The kernel has data now: Worth asking next says why it has no question,
  // where it said "Suggestions appear once the kernel has data." The header
  // that read_csv takes by default is no question: the frame of the load
  // looks right, and the chip of the header shows the default.
  const next = page.locator('.jp-Epi-exploration .jp-Epi-block', {
    hasText: 'Worth asking next'
  });
  await expect(next).toContainText(
    'No suggestions yet: no cell leaves a choice open',
    { timeout: 30000 }
  );
  await expect(next.locator('.jp-Epi-next')).toHaveCount(0);
  await expect(
    page.locator('.jp-Epi-chip.jp-mod-open', { hasText: 'header infer' })
  ).toBeVisible();
});

test('opens the later demo with its map, panels and labels before a run', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadFile(
    path.join(DEMO, 'pain_diary_cohort_6h.ipynb'),
    `${tmpPath}/pain_diary_cohort_6h.ipynb`
  );
  await openInWhybook(page, `${tmpPath}/pain_diary_cohort_6h.ipynb`);
  await kernelIdle(page);
  await expect(
    page.locator('.jp-Epi-variables .jp-Epi-stale-note')
  ).toContainText('from the last run');
  // The fresh kernel's analysis of a cell that has not run lacks the names
  // it uses: the kept analysis stays, and the notebook is not modified. The
  // view reads a fresh kernel once a cell runs, or before a request that
  // sends its variables: the test asks for that read, and waits for its end.
  await page.evaluate(() =>
    (window as any).jupyterapp.shell.currentWidget.content.model.refresh()
  );
  const kept = await page.evaluate(() => {
    const model = (window as any).jupyterapp.shell.currentWidget.context.model;
    const lmm = [...model.cells].find((cell: any) => cell.id === 'lmm');
    return {
      dirty: model.dirty,
      uses: lmm.getMetadata('whybook').analysis.uses
    };
  });
  expect(kept.dirty).toBe(false);
  expect(kept.uses).toContain('weekly');
  await expect
    .poll(() => page.locator('.jp-Epi-variable.jp-mod-stale').count())
    .toBeGreaterThan(30);
  // Without room, tables are tiles with the labels the notebook keeps. A
  // card far from the window lays out its tables when it comes near.
  await page.setViewportSize({ width: 900, height: 1000 });
  await page
    .locator('.jp-Epi-cell[data-cell-id="screen"]')
    .scrollIntoViewIfNeeded();
  const screen = page.locator('[data-cell-id="screen"] .jp-Epi-tabletile');
  await expect(screen.last()).toContainText('protein screen');
  await expect(screen.last()).toContainText('1 pass FDR');
  // The demo's generator wrote them from the numbers, and the tag says so.
  await expect(
    screen.last().locator('.jp-Epi-tabletile-headline .jp-Epi-aitag')
  ).toHaveAttribute(
    'title',
    "Written by scripts/examples/pain_diary/make_later.py from the table's numbers, in place of an AI model"
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await expect(page.locator('.jp-Epi-map-frame.jp-mod-stale')).toHaveCount(4);
  await expect(page.locator('.jp-Epi-map-cell')).toHaveCount(19);
});

/** Upload the demo after six more hours, with its prep module, and open it. */
async function openLater(
  page: IJupyterLabPageFixture,
  tmpPath: string
): Promise<void> {
  await page.contents.uploadFile(
    path.join(DEMO, 'prep.py'),
    `${tmpPath}/prep.py`
  );
  await page.contents.uploadFile(
    path.join(DEMO, 'pain_diary_cohort_6h.ipynb'),
    `${tmpPath}/pain_diary_cohort_6h.ipynb`
  );
  await openInWhybook(page, `${tmpPath}/pain_diary_cohort_6h.ipynb`);
  await kernelIdle(page);
}

test('shows short printed outputs as printed, and a warning as its message', async ({
  page,
  tmpPath
}) => {
  await openLater(page, tmpPath);
  await expect(
    page.locator('[data-cell-id="lmm_checks"] .jp-Epi-textoutput')
  ).toHaveText('Residual SD 0.72; 3 residuals beyond 3');
  const warning = page.locator(
    '[data-cell-id="dropout_model"] .jp-Epi-textoutput.jp-mod-stderr'
  );
  await expect(warning).toHaveText(
    'ConvergenceWarning: Maximum Likelihood optimization failed to converge. Check mle_retvals'
  );
  // A click shows the warning as printed, with its file and line.
  await warning.click();
  await expect(
    page.locator('[data-cell-id="dropout_model"] .jp-Epi-pinned')
  ).toContainText('discrete_model.py:268');
  await expect(
    page.locator('[data-cell-id="ordinal"] .jp-Epi-textoutput')
  ).toContainText('Name: arm B × month (log odds)');
});

test('shows more than ten printed lines as a tile, and hides the history database messages', async ({
  page,
  tmpPath
}) => {
  const lines = Array.from({ length: 12 }, (_, i) => `epoch ${i + 1}\n`);
  const notebook = {
    cells: [
      {
        cell_type: 'code',
        execution_count: 1,
        id: 'train',
        metadata: {},
        outputs: [{ output_type: 'stream', name: 'stdout', text: lines }],
        source: 'train()'
      },
      {
        cell_type: 'code',
        execution_count: 2,
        id: 'history',
        metadata: {},
        outputs: [
          {
            output_type: 'stream',
            name: 'stdout',
            text: [
              "The history saving thread hit an unexpected error (OperationalError('attempt to write a readonly database')).History will not be written to the database.\n"
            ]
          }
        ],
        source: 'x = 1'
      }
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  };
  const file = `${tmpPath}/log.ipynb`;
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
  await openInWhybook(page, file);
  const tile = page.locator('[data-cell-id="train"] .jp-Epi-logtile');
  await expect(tile).toContainText('12 lines');
  await expect(tile).toContainText('epoch 12');
  // IPython's own message about its history database is not shown.
  await expect(page.locator('[data-cell-id="history"]')).toBeVisible();
  await expect(
    page.locator('[data-cell-id="history"] .jp-Epi-miniatures > *')
  ).toHaveCount(0);
});

test('draws bars below zero, and asks about the bars picked', async ({
  page,
  tmpPath
}) => {
  test.setTimeout(240000);
  await openLater(page, tmpPath);
  // Cell [19]: every estimate is below zero. At Full, the default level of
  // detail, a plot is drawn in its card.
  const effects = page.locator('.jp-Epi-cell[data-cell-id="effects"]');
  const bars = effects.locator(
    '.jp-Epi-plotout svg.jp-Epi-plot rect:not(.jp-Epi-brush)'
  );
  await expect(bars).toHaveCount(5);
  for (const bar of await bars.all()) {
    expect(Number(await bar.getAttribute('height'))).toBeGreaterThan(5);
    expect(Number(await bar.getAttribute('width'))).toBeGreaterThan(10);
  }

  // A click on a label picks its bar.
  await effects
    .locator('.jp-Epi-bar-label', {
      hasText: 'Mixed model'
    })
    .click();
  await expect(popover(page)).toContainText('analysis Mixed model');
  await popover(page).locator('.jp-Epi-close').click();

  // A click on a bar of [17] asks; the cells that make the frame run first.
  const arms = page.locator(
    '.jp-Epi-cell[data-cell-id="analgesics"] .jp-Epi-plotout svg.jp-Epi-plot rect:not(.jp-Epi-brush)'
  );
  await expect(arms).toHaveCount(2);
  await arms.first().scrollIntoViewIfNeeded();
  const first = (await arms.first().boundingBox())!;
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await expect(popover(page)).toContainText('treatment_arm A');
  await popover(page)
    .locator('button', { hasText: /^Run \[/ })
    .click();
  const welch = popover(page).locator('.jp-Epi-option', {
    hasText:
      'Is treatment_arm A different from treatment_arm B by more than chance?'
  });
  await expect(welch).toBeVisible({ timeout: 180000 });
  await expect(popover(page)).toContainText('in treatment_arm B.');
  await welch.click();
  await expect(
    page.locator('.jp-Epi-textoutput', {
      hasText: 'Welch t-test on per-patient means'
    })
  ).toBeVisible({ timeout: 120000 });
});

test('questions the text of a markdown cell, and words selected in it', async ({
  page,
  tmpPath
}) => {
  await openLater(page, tmpPath);
  await expect(page.locator('.jp-Epi-bench > .jp-Epi-note')).toContainText(
    'Does treatment arm B change how pain evolves'
  );
  const summary = page.locator('[data-cell-id="summary"]');
  await summary.locator('button', { hasText: 'Question this text' }).click();
  // The numbers of the text, each with the outputs that show it.
  await expect(popover(page)).toContainText('[5] shows -0.318');
  await expect(popover(page)).toContainText('[9] shows 0.26');
  await expect(popover(page)).toContainText('Not checked: 12.');
  const recompute = popover(page).locator('.jp-Epi-option', {
    hasText: 'Can each number in this text be recomputed from the data?'
  });
  await expect(recompute).toContainText('needs AI');
  await expect(recompute).toContainText('new cell after §8 Summary');
  await popover(page).locator('.jp-Epi-close').click();

  // Words selected in the text are the subject of the questions.
  await summary.evaluate(node => {
    const words = 'by 0.32 points more per month';
    const walker = document.createTreeWalker(
      node.querySelector('.jp-Epi-note-text')!,
      NodeFilter.SHOW_TEXT
    );
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const at = text.textContent!.indexOf(words);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + words.length);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        const box = range.getBoundingClientRect();
        text.parentElement!.dispatchEvent(
          new MouseEvent('mouseup', {
            bubbles: true,
            clientX: box.right,
            clientY: box.bottom
          })
        );
        return;
      }
    }
  });
  await expect(popover(page)).toContainText(
    'Can each number in “by 0.32 points more per month” be recomputed from the data?'
  );
  // Selecting the words asks about them, so the questions offer a copy.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const copy = popover(page).getByRole('button', {
    name: 'Copy the words selected'
  });
  await copy.click();
  // The copy ends after the click: read the clipboard once it has.
  await expect(copy).toHaveClass(/jp-mod-copied/);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('by 0.32 points more per month');
  await popover(page).locator('.jp-Epi-close').click();

  // The map shows both texts, and a click on one asks about it.
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await expect(page.locator('.jp-Epi-map-note')).toHaveCount(2);
  await page.locator('.jp-Epi-map-zoom button', { hasText: 'Fit' }).click();
  await page.locator('.jp-Epi-map-note', { hasText: 'Pain falls' }).click();
  await expect(popover(page)).toContainText('The numbers in this text');
});

test('adds a code cell between two cells and a text at the end in the Code view', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/insert.ipynb`;
  await newNotebook(page, file, ['x = 1', 'y = x + 1']);
  await openInWhybook(page, file);
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  const sources = () =>
    page.evaluate(() => {
      const model = (window as any).jupyterapp.shell.currentWidget.context
        .model;
      const found: string[] = [];
      for (let i = 0; i < model.cells.length; i++) {
        const cell = model.cells.get(i);
        found.push(`${cell.type}:${cell.sharedModel.getSource()}`);
      }
      return found;
    });
  // Between the two cells the bar shows on hover.
  const between = page.locator('.jp-Epi-insert:not(.jp-mod-last)');
  await expect(between).toHaveCount(1);
  await expect(between).toHaveCSS('opacity', '0');
  await between.hover();
  await expect(between).toHaveCSS('opacity', '1');
  await between.getByRole('button', { name: 'Code' }).click();
  // The new cell's editor takes the cursor: the keys go into it.
  const focused = page.locator('.jp-Epi-linear .cm-editor.cm-focused');
  await expect(focused).toHaveCount(1);
  await page.keyboard.type('z = 3');
  await expect
    .poll(sources)
    .toEqual(['code:x = 1', 'code:z = 3', 'code:y = x + 1']);
  // After the last cell the bar always shows; a text opens in its editor.
  // The editor that had the cursor keeps its focused look for a moment, so
  // the test waits for the text's own editor.
  const last = page.locator('.jp-Epi-insert.jp-mod-last');
  await last.getByRole('button', { name: 'Text' }).click();
  await expect(
    page.locator('.jp-Epi-linear-cell.jp-mod-markdown .cm-editor.cm-focused')
  ).toHaveCount(1);
  await page.keyboard.type('Notes');
  await expect
    .poll(sources)
    .toEqual(['code:x = 1', 'code:z = 3', 'code:y = x + 1', 'markdown:Notes']);
  await expect(page.locator('.jp-Epi-note.jp-mod-editing')).toHaveCount(1);
});

test('outlines the type badges of cells in their colour, readable, and lights one type from a badge or the Exploration panel', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/types.ipynb`;
  const cells: [string, Record<string, string> | null][] = [
    ['x = 1', null],
    ['x + 1', { id: 'q1', text: 'What is x plus one?', type: 'descriptive' }],
    ['x * 2', { id: 'q2', text: 'Is x related to y?', type: 'association' }],
    ['x - 1', { id: 'q3', text: 'What is x minus one?', type: 'descriptive' }]
  ];
  const notebook = {
    cells: cells.map(([source, question], index) => ({
      cell_type: 'code',
      execution_count: null,
      id: `cell-${index}`,
      metadata: question ? { whybook: { question } } : {},
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
  await openInWhybook(page, file);
  const ring = (locator: Locator) =>
    locator.evaluate(node => getComputedStyle(node).boxShadow);
  // Filled: the badge has the colour of its type behind white text.
  const filled = (locator: Locator) =>
    locator.evaluate(
      node => getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)'
    );
  // The contrast of the badge's text with the card behind it, as WCAG
  // measures it, from the colours as the browser draws them.
  const contrast = (locator: Locator) =>
    locator.evaluate(node => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      const rgb = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      const luminance = ([r, g, b]: number[]) => {
        const channel = (value: number) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const card = node.closest('.jp-Epi-cell, .jp-Epi-linear-cell')!;
      const text = luminance(rgb(getComputedStyle(node).color));
      const back = luminance(rgb(getComputedStyle(card).backgroundColor));
      return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
    });

  // On the bench, a badge of a cell is its type's colour at full opacity,
  // as an outline and a text that reads at 4.5:1 at least.
  const bench = page.locator('.jp-Epi-bench');
  const badges = bench.locator('.jp-Epi-cell-head .jp-Epi-type');
  await expect(badges).toHaveText([
    'Descriptive',
    'Association',
    'Descriptive'
  ]);
  for (const badge of await badges.all()) {
    await expect(badge).toHaveCSS('opacity', '1');
    await expect(badge).toHaveCSS('border-top-style', 'solid');
    await expect.poll(() => filled(badge)).toBe(false);
    await expect.poll(() => contrast(badge)).toBeGreaterThanOrEqual(4.5);
  }

  // The pointer on one descriptive badge lights both, and rings their cells.
  await badges.first().hover();
  await expect.poll(() => filled(badges.nth(2))).toBe(true);
  await expect.poll(() => filled(badges.nth(1))).toBe(false);
  const described = bench.locator(
    '.jp-Epi-cell[data-question-type="descriptive"]'
  );
  await expect(described).toHaveCount(2);
  for (const cell of await described.all()) {
    await expect.poll(() => ring(cell)).not.toBe('none');
  }
  await expect
    .poll(() =>
      ring(bench.locator('.jp-Epi-cell[data-question-type="association"]'))
    )
    .toBe('none');
  await page.mouse.move(0, 0);
  await expect(page.locator('.jp-Epi-document[data-lit-type]')).toHaveCount(0);

  // In the Code view, the bar of a type in the Exploration panel lights its cells.
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  const related = page.locator(
    '.jp-Epi-linear-cell[data-question-type="association"]'
  );
  await expect(related).toHaveCount(1);
  await expect.poll(() => ring(related)).toBe('none');
  await page
    .locator('.jp-Epi-right .jp-Epi-typebar', {
      has: page.locator('.jp-Epi-type.jp-mod-association')
    })
    .hover();
  await expect.poll(() => ring(related)).not.toBe('none');
  await expect.poll(() => filled(related.locator('.jp-Epi-type'))).toBe(true);
  await page.mouse.move(0, 0);
  await expect.poll(() => ring(related)).toBe('none');
  await expect.poll(() => filled(related.locator('.jp-Epi-type'))).toBe(false);
});

test('shows every cell as the notebook does in the Code view, and edits a text in either view', async ({
  page,
  tmpPath
}) => {
  await openLater(page, tmpPath);
  // On the bench, and in the Code view, a cell far from the window is not
  // laid out or painted until it comes near: the view opens a long notebook
  // without laying out every cell (content-visibility).
  const skipped = (locator: Locator) =>
    locator.evaluate(
      node =>
        !(node.firstElementChild as any).checkVisibility({
          contentVisibilityAuto: true
        })
    );
  const lastCard = page.locator('.jp-Epi-bench .jp-Epi-cell').last();
  await expect(lastCard).toHaveCSS('content-visibility', 'auto');
  await expect.poll(() => skipped(lastCard)).toBe(true);
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  const linear = page.locator('.jp-Epi-linear');
  const lastCell = linear.locator('.jp-Epi-linear-cell').last();
  await expect(lastCell).toHaveCSS('content-visibility', 'auto');
  await expect.poll(() => skipped(lastCell)).toBe(true);
  await lastCell.scrollIntoViewIfNeeded();
  await expect.poll(() => skipped(lastCell)).toBe(false);
  await page.locator('.jp-Epi-main').evaluate(node => (node.scrollTop = 0));
  // Text renders as markdown, headings included, between the code cells.
  await expect(
    linear
      .locator('[data-cell-id="title"]')
      .getByRole('heading', { level: 1, name: 'Pain diary cohort' })
  ).toBeVisible();
  await expect(
    linear
      .locator('[data-cell-id="section-shape"]')
      .getByRole('heading', { level: 2, name: 'Shape' })
  ).toBeVisible();
  // A code cell has its code in an editor and its outputs in full.
  const weekly = linear.locator('.jp-Epi-linear-cell[data-cell-id="weekly"]');
  await expect(weekly.locator('.jp-Epi-editor .cm-content')).toContainText(
    'weekly = ('
  );
  await expect(weekly.locator('.jp-Epi-fullplot svg').first()).toBeVisible();
  // The code of prep.py that the cell calls is folded under its editor, and
  // opens read only, with the line of the constant it depends on marked.
  const files = weekly.locator('.jp-Epi-filesfold');
  await expect(files.locator('.jp-Epi-filesfold-toggle')).toContainText(
    'Code from prep.py: drop_sparse()'
  );
  await expect(files.locator('.jp-Epi-attachment')).toHaveCount(0);
  await files.locator('.jp-Epi-filesfold-toggle').click();
  await expect(
    files.locator('.jp-Epi-attachment-body .jp-mod-highlight')
  ).toContainText('MIN_DAYS = 14');
  const reshape = linear.locator('.jp-Epi-linear-cell[data-cell-id="reshape"]');
  await expect(reshape.locator('.jp-Epi-linear-outputs table')).toBeVisible();

  // Edit shows on hover; Shift+Enter renders the text again.
  const summary = linear.locator('[data-cell-id="summary"]');
  await expect(summary.locator('.jp-Epi-note-edit')).toHaveCSS('opacity', '0');
  await summary.hover();
  await summary.locator('.jp-Epi-note-edit').click();
  await expect(summary.locator('.cm-content')).toBeFocused();
  // Line numbers follow the notebook settings: off by default, as in
  // JupyterLab, and on for code alone when the code cell setting says so.
  await expect(summary.locator('.cm-lineNumbers')).toHaveCount(0);
  await expect(weekly.locator('.cm-lineNumbers')).toHaveCount(0);
  const lineNumbers = (on: boolean) =>
    page.evaluate(async on => {
      const registry = await (window as any).galata.getPlugin(
        '@jupyterlab/apputils-extension:settings'
      );
      await registry.set(
        '@jupyterlab/notebook-extension:tracker',
        'codeCellConfig',
        { lineNumbers: on, lineWrap: false }
      );
    }, on);
  await lineNumbers(true);
  await expect(weekly.locator('.cm-lineNumbers')).toHaveCount(1);
  await expect(summary.locator('.cm-lineNumbers')).toHaveCount(0);
  await lineNumbers(false);
  await expect(weekly.locator('.cm-lineNumbers')).toHaveCount(0);
  await summary.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Checked in 1:1.');
  await page.keyboard.press('Shift+Enter');
  await expect(summary.locator('.jp-Epi-note-text')).toContainText(
    'Checked in 1:1.'
  );
  expect(
    await page.evaluate(
      () =>
        (
          window as any
        ).jupyterapp.shell.currentWidget.context.model.sharedModel.cells.find(
          (cell: any) => cell.id === 'summary'
        ).source
    )
  ).toContain('Checked in 1:1.');
  await expect(popover(page)).toHaveCount(0);

  // On the bench, a double-click opens the editor and Escape closes it.
  await page.locator('.jp-Epi-views [data-value="bench"]').click();
  const intro = page.locator('.jp-Epi-bench > .jp-Epi-note');
  await intro.locator('.jp-Epi-note-text').dblclick();
  await expect(intro.locator('.cm-content')).toBeFocused();
  await expect(popover(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(intro.locator('.jp-Epi-note-text')).toContainText(
    'Does treatment arm B change how pain evolves'
  );
});

// These two need ipywidgets, tqdm and plotly in the kernel's environment:
// the `plots` extra.
test('shows widgets live, the bar of tqdm, and a Plotly chart in its card or as a thumbnail', async ({
  page,
  tmpPath
}) => {
  await newNotebook(page, `${tmpPath}/libraries.ipynb`, [
    'import ipywidgets as widgets\nwidgets.IntSlider(value=3, max=10, description="knots")',
    'import time\nfrom tqdm.auto import tqdm\n\nfor _ in tqdm(range(10), desc="bootstrap"):\n    time.sleep(0.05)',
    'import plotly.express as px\npx.scatter(x=[1, 2, 3], y=[3, 1, 2])',
    'from tqdm import tqdm as text_tqdm\n\nfor _ in text_tqdm(range(5), desc="text"):\n    time.sleep(0.1)'
  ]);
  await openInWhybook(page, `${tmpPath}/libraries.ipynb`);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await idle(page);
  // A widget is live on the bench, as in the notebook: a slider is a slider.
  const slider = page.locator('[data-cell-id="cell-0"] .jp-Epi-widgetoutput');
  await expect(slider.locator('.widget-slider')).toBeVisible();
  await expect(slider).toContainText('knots');
  // tqdm.auto draws its own bar, and the card adds no second one.
  const loop = page.locator('.jp-Epi-cell[data-cell-id="cell-1"]');
  await expect(loop.locator('.jp-Epi-widgetoutput')).toContainText(
    /bootstrap:\s+100%/
  );
  await expect(loop.locator('.jp-Epi-job')).toHaveCount(0);
  // At Full, Plotly draws its chart in the card. At Overview the chart is a
  // thumbnail, and Plotly draws it in full on a click.
  await expect(
    page.locator('[data-cell-id="cell-2"] .jp-Epi-plotout .jp-RenderedPlotly')
  ).toBeVisible();
  const detail = page.locator('.jp-Epi-detail input');
  await detail.fill('0');
  try {
    const chart = page.locator(
      '[data-cell-id="cell-2"] .jp-Epi-miniature.jp-mod-chart'
    );
    await expect(chart).toBeVisible();
    await chart.click();
    await expect(
      page.locator('[data-cell-id="cell-2"] .jp-Epi-pinned .jp-RenderedPlotly')
    ).toBeVisible();
  } finally {
    // Back to the default. Galata mocks the settings of each test, so the next test starts from the defaults anyway.
    await detail.fill('2');
  }
  // Plain tqdm redraws its bar on stderr, in the same output: the bench
  // shows the last bar, not the first.
  await expect(
    page.locator('[data-cell-id="cell-3"] .jp-Epi-textoutput')
  ).toContainText(/text: 100%/);
});

test('asks about the rows in a box selected on a Plotly chart', async ({
  page,
  tmpPath
}) => {
  await newNotebook(page, `${tmpPath}/plotly.ipynb`, [
    'import pandas as pd\nimport plotly.express as px\n\nvisits = pd.DataFrame({"week": list(range(10)) * 2, "pain": [float(i % 5) for i in range(20)], "arm": ["A"] * 10 + ["B"] * 10})\npx.scatter(visits, x="week", y="pain", color="arm")'
  ]);
  await openInWhybook(page, `${tmpPath}/plotly.ipynb`);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await idle(page);
  await expect(
    page.locator('.jp-Epi-variable', { hasText: 'visits' })
  ).toBeVisible();
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  const cell = page.locator('.jp-Epi-linear-cell[data-cell-id="cell-0"]');
  // Plotly draws the chart over its saved picture when the pointer enters,
  // and the view starts it in Box Select: a drag draws a box.
  await cell.locator('.jp-RenderedPlotly').hover();
  const select = cell.locator(
    '.modebar-btn[data-attr="dragmode"][data-val="select"]'
  );
  await expect(select).toHaveClass(/active/);
  // A box over the whole chart: every row of visits, found by its columns.
  const area = (await cell.locator('.nsewdrag').first().boundingBox())!;
  await page.mouse.move(area.x + 5, area.y + 5);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width - 5, area.y + area.height - 5, {
    steps: 10
  });
  await page.mouse.up();
  await expect(popover(page)).toContainText(/week [\d.-]+–[\d.]+, pain/);
  await expect(popover(page)).toContainText('20 rows');
  await expect(popover(page)).toContainText('Keep selection as a variable');
});

test.describe('the pain diary demo', () => {
  // Each test runs the whole demo first, about a minute.
  test.describe.configure({ timeout: 300000 });

  test('drags a column onto a model cell and edits it in place', async ({
    page,
    tmpPath
  }) => {
    await openDemo(page, tmpPath);
    // Run all makes no cell the one the analyst worked on last: no button
    // leads back to the last cell once the bench is at the top. The button
    // shows only for that cell, once it is out of the window.
    await page.locator('.jp-Epi-main').evaluate(main => (main.scrollTop = 0));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).jupyterapp.shell.currentWidget.content.model
              .currentCell
        )
      )
      .toBeNull();
    await expect(page.locator('.jp-Epi-backtocell')).toHaveCount(0);
    const model = page.locator('.jp-Epi-cell', { hasText: 'Mixed model' });
    await expect(model.locator('.jp-Epi-chip').first()).toContainText('reml');

    await page.locator('.jp-Epi-variable', { hasText: 'olink' }).click();
    await page.locator('.jp-Epi-contents .jp-Epi-search input').fill('IL6');
    await drag(
      page,
      page.locator('.jp-Epi-column', { hasText: 'IL6' }).first(),
      model
    );
    await expect(popover(page)).toContainText('joined on patient_id');
    await popover(page)
      .locator('.jp-Epi-option', { hasText: 'Add IL6 as a covariate' })
      .click();
    await idle(page);
    await expect(model.locator('.jp-Epi-formula')).toContainText('+ IL6');
    await expect(model.locator('.jp-Epi-strip-action')).toHaveText(
      /^Edited \[\d+\] in place$/
    );

    await model.locator('.jp-Epi-strip button', { hasText: 'Undo' }).click();
    await idle(page);
    await expect(model.locator('.jp-Epi-formula')).not.toContainText('IL6');
  });

  test('asks about a map cell and about a rectangle of cells', async ({
    page,
    tmpPath
  }) => {
    await openDemo(page, tmpPath);
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    const model = page.locator('.jp-Epi-map-cell', { hasText: 'Mixed model' });
    await model.click();
    await expect(popover(page)).toContainText('ranked for this cell');
    await popover(page).locator('.jp-Epi-close').click();

    const first = (await page
      .locator('.jp-Epi-map-cell', { hasText: 'Weekly pain' })
      .boundingBox())!;
    const last = (await model.boundingBox())!;
    const map = (await page.locator('.jp-Epi-map').boundingBox())!;
    await page.mouse.move(map.x + 6, first.y - 8);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width + 10, last.y + last.height + 8, {
      steps: 12
    });
    await page.mouse.up();
    await expect(popover(page)).toContainText('2 cells selected');
  });

  test('brushes a plot and keeps the selection as a variable', async ({
    page,
    tmpPath
  }) => {
    await openDemo(page, tmpPath);
    // At Overview a plot is a thumbnail, and a click shows it in the cell's
    // details, where a brush opens the questions to the left of the panel.
    const slider = page.locator('.jp-Epi-detail input');
    await slider.fill('0');
    const weekly = page.locator('.jp-Epi-cell', { hasText: 'Weekly pain' });
    await weekly.locator('.jp-Epi-miniature').first().click();
    // Full again. Galata mocks the settings of each test, so the next test starts from the defaults anyway.
    await slider.fill('2');
    const plot = page.locator(
      '.jp-Epi-details-output.jp-mod-opened svg.jp-Epi-plot'
    );
    const area = (await plot.boundingBox())!;
    const panel = (await page.locator('.jp-Epi-details').boundingBox())!;
    expect(area.x + area.width).toBeLessThanOrEqual(panel.x + panel.width + 1);

    await page.mouse.move(
      area.x + area.width * 0.55,
      area.y + area.height * 0.4
    );
    await page.mouse.down();
    await page.mouse.move(
      area.x + area.width * 0.85,
      area.y + area.height * 0.4,
      { steps: 10 }
    );
    await page.mouse.up();
    await expect(popover(page)).toContainText(/\d rows/);
    // The brush selects rows, and no text of the axis labels.
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      ''
    );
    const box = (await popover(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x);

    await popover(page).locator('.jp-Epi-keep').click();
    await expect(
      page.locator('.jp-Epi-variable', { hasText: /^sel_week/ })
    ).toBeVisible({ timeout: 60000 });
  });

  test('explores in parallel with Alt, and branches with Shift', async ({
    page,
    tmpPath
  }) => {
    await openDemo(page, tmpPath);
    const weekly = page.locator('.jp-Epi-cell', { hasText: 'Weekly pain' });
    await drag(
      page,
      page.locator('.jp-Epi-variable', { hasText: 'MIN_DAYS' }),
      weekly.first(),
      { alt: true }
    );
    await expect(popover(page)).toContainText('parallel exploration');
    await popover(page).locator('.jp-Epi-parallel-foot button').click();
    await idle(page);
    const sweep = page.locator('.jp-Epi-cell.jp-mod-branch', {
      hasText: 'What changes if MIN_DAYS'
    });
    await expect(sweep.locator('.jp-Epi-chip')).toContainText([
      /min_days_values \[7, 14, 21\]/
    ]);

    await page.locator('.jp-Epi-variable', { hasText: 'patients' }).click();
    const model = page.locator('.jp-Epi-cell', { hasText: 'Mixed model' });
    await drag(
      page,
      page.locator('.jp-Epi-column', { hasText: 'age' }).first(),
      model.first(),
      { shift: true }
    );
    const tags = popover(page).locator('.jp-Epi-placement');
    await expect(tags.first()).toBeVisible();
    for (const tag of await tags.allInnerTexts()) {
      expect(tag).toMatch(/^branch of/);
    }
  });

  test('marks the questions that need AI in Worth asking next, and leaves them unchecked in a parallel exploration, when no model answers', async ({
    page,
    tmpPath
  }) => {
    // The test server has no model that answers: its CLI does not exist.
    await openDemo(page, tmpPath);
    await page
      .locator('.jp-Epi-tabs button', { hasText: 'Exploration' })
      .click();
    const steps = page.locator('.jp-Epi-next');
    await expect(steps.first()).toBeVisible({ timeout: 30000 });
    // The first suggestion is one that runs. It was a greyed one that needs
    // AI, and the demo has more than three that run.
    await expect(steps.first().locator('button[disabled]')).toHaveCount(0);
    // A suggestion without code says "needs AI", as the note above it and
    // the popover do: it had only a pale Ask button.
    const needy = steps.filter({ has: page.locator('button[disabled]') });
    // Soft checks: the parallel exploration below is checked either way.
    for (const step of await needy.all()) {
      await expect
        .soft(step.locator('.jp-Epi-needs'))
        .toHaveText(' · needs AI');
    }
    for (const step of await steps
      .filter({ hasNot: page.locator('button[disabled]') })
      .all()) {
      await expect.soft(step.locator('.jp-Epi-needs')).toHaveCount(0);
    }
    // The questions that run come first, then one line, then the ones that
    // need AI. Those came first, and did nothing.
    const kinds = (items: Locator) =>
      items.evaluateAll(nodes =>
        nodes.map(node =>
          node.classList.contains('jp-Epi-needs-line')
            ? 'line'
            : node.matches('[aria-disabled="true"], :has(button[disabled])')
              ? 'ai'
              : 'run'
        )
      );
    const grouped = (list: string[]) => [
      ...list.filter(kind => kind === 'run'),
      ...(list.includes('ai') ? ['line'] : []),
      ...list.filter(kind => kind === 'ai')
    ];
    const suggested = await kinds(
      page.locator(
        '.jp-Epi-exploration .jp-Epi-next, .jp-Epi-exploration .jp-Epi-needs-line'
      )
    );
    expect(suggested).toEqual(grouped(suggested));

    // Alt+drop: the question that needs AI stays in the checklist,
    // unchecked. It was checked, counted in "Start 3 branches", and
    // started as a branch that failed. The three that are checked run
    // without a model, and the first asks whether the arm's effect differs
    // by IL6 (design iteration 1.94): its branch joins IL6 to the model's
    // frame on the patient.
    await page.locator('.jp-Epi-variable', { hasText: 'olink' }).click();
    await page.locator('.jp-Epi-contents .jp-Epi-search input').fill('IL6');
    const model = page.locator('.jp-Epi-cell', { hasText: 'Mixed model' });
    await drag(
      page,
      page.locator('.jp-Epi-column', { hasText: 'IL6' }).first(),
      model.first(),
      { alt: true }
    );
    await expect(popover(page)).toContainText('parallel exploration');
    const mediate = popover(page).locator('.jp-Epi-option', {
      hasText: 'Could IL6 mediate'
    });
    await expect(mediate).toHaveAttribute('aria-disabled', 'true');
    await expect(mediate).toHaveAttribute('aria-pressed', 'false');
    await expect(
      popover(page).locator('.jp-Epi-parallel-foot button')
    ).toHaveText('Start 3 branches');
    const interaction = popover(page).locator('.jp-Epi-option', {
      hasText: 'Does the effect of treatment_arm on pain_score differ by IL6?'
    });
    await expect(interaction).toHaveAttribute('aria-pressed', 'true');
    await expect(interaction).not.toHaveAttribute('aria-disabled', 'true');
    const checklist = await kinds(
      popover(page).locator('.jp-Epi-option, .jp-Epi-needs-line')
    );
    expect(checklist).toContain('ai');
    expect(checklist).toEqual(grouped(checklist));
    await popover(page).locator('.jp-Epi-close').click();
  });

  test('previews a self-drop and keeps it after the last cell that ran', async ({
    page,
    tmpPath
  }) => {
    await openDemo(page, tmpPath);
    const diary = page.locator('.jp-Epi-variable').filter({
      has: page.locator('.jp-Epi-item-name', { hasText: /^diary$/ })
    });
    await drag(page, diary, diary, { dx: 60, dy: 8 });
    // The learned order puts other questions first; the profile is a preview.
    await popover(page)
      .locator('.jp-Epi-option', { hasText: /^Profile diary/ })
      .click();
    await expect(page.locator('.jp-Epi-preview table')).toBeVisible({
      timeout: 60000
    });

    await page.locator('button', { hasText: 'Keep as a cell' }).click();
    // The view draws the new cell on the next frame: read the order until it is there.
    await expect
      .poll(
        async () => {
          // The text, and not innerText, which is empty in a card far
          // from the window: the card is not laid out.
          const titles = await page
            .locator('.jp-Epi-cell .jp-Epi-title')
            .allTextContents();
          const kept = titles.indexOf(
            'Profile diary: types, missingness, duplicates'
          );
          // The kept cell runs now, so it goes after the last cell that ran,
          // the demo's last after Run all, and not right after the cell that
          // makes diary: the notebook runs from the top (design iteration 1.74).
          return kept >= 0 && kept === titles.length - 1;
        },
        { timeout: 60000 }
      )
      .toBe(true);
    await idle(page);
  });

  test('asks by clicking, also from the keyboard', async ({
    page,
    tmpPath
  }) => {
    await openDemo(page, tmpPath);
    const questions = page.locator('.jp-Epi-questions');
    await questions.locator('.jp-Epi-toggle [data-value="click"]').click();
    // A click on a variable shows it, and Pick in Contents picks it; the
    // questions open in the popover beside the target, and only there
    // (design iteration 1.77).
    await page.locator('.jp-Epi-variable', { hasText: 'patients' }).click();
    await page.locator('.jp-Epi-contents-pick').click();
    const model = page.locator('.jp-Epi-cell', { hasText: 'Mixed model' });
    await model.locator('.jp-Epi-dropzone').click();
    await expect(popover(page).locator('.jp-Epi-option').first()).toBeVisible();
    await expect(questions.locator('.jp-Epi-ask-block')).toHaveCount(0);

    await popover(page).locator('.jp-Epi-close').first().click();
    // From the keyboard: Enter on a variable shows it, and Enter on Pick
    // picks it.
    await page.locator('.jp-Epi-variable', { hasText: 'weekly' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.jp-Epi-picked')).toHaveCount(0);
    await page.locator('.jp-Epi-contents-pick').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.jp-Epi-picked')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.jp-Epi-picked')).toHaveCount(0);
  });

  test('offers to run what a plot needs when its rows are not in the kernel', async ({
    page,
    tmpPath
  }) => {
    // The notebook's outputs are saved, but nothing has run in this kernel.
    await openDemo(page, tmpPath, { run: false });
    const weekly = page.locator('.jp-Epi-cell', { hasText: 'Weekly pain' });
    const plot = weekly.locator('.jp-Epi-plotout svg.jp-Epi-plot').first();
    await plot.scrollIntoViewIfNeeded();
    const area = (await plot.boundingBox())!;
    await page.mouse.move(area.x + area.width * 0.55, area.y + area.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      area.x + area.width * 0.85,
      area.y + area.height / 2,
      {
        steps: 8
      }
    );
    await page.mouse.up();
    await expect(popover(page)).toContainText('weekly is not in the kernel');
    const plan = popover(page)
      .locator('.jp-Epi-missing-actions button')
      .first();
    await expect(plan).toContainText('Run');
    await plan.click();
    // Once the cells ran, the same selection gets its answer.
    await expect(popover(page)).toContainText(/\d rows/, { timeout: 180000 });
  });

  test('asks about a data node of the map, with its columns in either place', async ({
    page,
    tmpPath
  }) => {
    await openDemo(page, tmpPath);
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    await page.locator('.jp-Epi-map-frame', { hasText: 'patients' }).click();
    await expect(popover(page)).toContainText('patients (itself)');
    await expect(page.locator('.jp-Epi-contents')).toContainText('patients');
    await popover(page).locator('.jp-Epi-close').click();

    await page.locator('.jp-Epi-mapcolumns [data-value="popover"]').click();
    await page.locator('.jp-Epi-map-frame', { hasText: 'olink' }).click();
    await popover(page).locator('.jp-Epi-columnfilter input').fill('IL6');
    await popover(page)
      .locator('.jp-Epi-columnfilter-list button', { hasText: 'IL6' })
      .first()
      .click();
    await expect(popover(page)).toContainText('IL6 (itself)');
  });

  test('has context menus for variables and cells', async ({
    page,
    tmpPath
  }) => {
    await openDemo(page, tmpPath);
    await page
      .locator('.jp-Epi-variable', { hasText: 'weekly' })
      .click({ button: 'right' });
    const menu = page.locator('.lm-Menu');
    await expect(menu).toContainText('Show in Variables');
    await expect(menu).toContainText('Copy name');
    await menu.locator('.lm-Menu-item', { hasText: 'Ask about it' }).click();
    await expect(popover(page)).toContainText('weekly (itself)');
    await popover(page).locator('.jp-Epi-close').click();

    await page
      .locator('.jp-Epi-cell', { hasText: 'Mixed model' })
      .locator('.jp-Epi-title')
      .click({ button: 'right' });
    await menu
      .locator('.lm-Menu-item', { hasText: 'Show in the notebook' })
      .click();
    await expect(page.locator('.jp-NotebookPanel')).toBeVisible();
  });
});

test('opens a notebook without the start of an empty one, and shows a text in Cell details', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/texts.ipynb`;
  const cell = (id: string, type: string, source: string) => ({
    cell_type: type,
    id,
    metadata: {},
    source,
    ...(type === 'code' ? { execution_count: null, outputs: [] } : {})
  });
  const notebook = {
    cells: [
      cell('title', 'markdown', '# Visits'),
      cell('load', 'code', 'visits = [3, 5, 8]'),
      cell('methods', 'markdown', '## Methods'),
      cell('why', 'markdown', 'We count the visits of each week.'),
      cell('count', 'code', 'total = sum(visits)')
    ],
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
  // The start of an empty notebook must not show, not even while the file loads.
  await page.evaluate(() => {
    (window as any).startSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('.jp-Epi-start')) {
        (window as any).startSeen = true;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await openInWhybook(page, file);
  const text = page.locator('.jp-Epi-note[data-cell-id="why"]');
  await expect(text).toBeVisible();
  expect(await page.evaluate(() => (window as any).startSeen)).toBe(false);

  // A click on the text makes it the cell of Cell details, as a click on code does.
  await text.click();
  await page
    .locator('#epi-exploration')
    .getByRole('tab', { name: 'Cell details' })
    .click();
  const head = page.locator('#epi-exploration .jp-Epi-details-head');
  await expect(head.locator('.jp-Epi-label')).toHaveText('Text');
  await expect(head).toContainText('We count the visits of each week.');
  const details = page.locator('#epi-exploration .jp-Epi-details');
  // The code cell before the heading is §0: Methods is the first section.
  await expect(details).toContainText('A text in §1 Methods.');
  await expect(details.locator('.jp-Epi-cell-link')).toHaveText([
    /visits = \[3, 5, 8\]/,
    /total = sum\(visits\)/
  ]);
  await expect(
    details.getByRole('button', { name: 'Questions about this text' })
  ).toBeVisible();
  // Nothing that only code has: no outputs and no run.
  await expect(details.locator('.jp-Epi-details-toggle')).toHaveText([
    'Text',
    'Source'
  ]);

  // A code cell names the cell that makes each name it uses, and the cells
  // that use each name it makes: the analysis reads the names in the kernel.
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  await idle(page);
  await page
    .locator('.jp-Epi-bench .jp-Epi-cell[data-cell-id="count"]')
    .click({ position: { x: 20, y: 12 } });
  await expect(head).toContainText('[2]');
  const uses = details.locator('.jp-Epi-details-names', { hasText: 'Uses' });
  await expect(uses).toContainText('visits from [1]');
  await uses.locator('.jp-Epi-cell-link').click();
  await expect(head).toContainText('[1]');
  await expect(
    details.locator('.jp-Epi-details-names', { hasText: 'Defines' })
  ).toContainText('visits, used in [2]');
});

test.describe('With the minimap on', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:plugin': { minimap: true }
    }
  });

  test('keeps the minimap of a long notebook short until it is pointed at', async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/long.ipynb`;
    const cells: Record<string, unknown>[] = [];
    for (let part = 1; part <= 10; part++) {
      cells.push({
        cell_type: 'markdown',
        id: `part-${part}`,
        metadata: {},
        source: `## Part ${part}`
      });
      for (let step = 1; step <= 8; step++) {
        cells.push({
          cell_type: 'code',
          execution_count: null,
          id: `step-${part}-${step}`,
          // One cell answers a question: its bar takes the colour of its type.
          metadata:
            part === 1 && step === 1
              ? {
                  whybook: {
                    question: { id: 'q1', text: 'Fit it', type: 'model' }
                  }
                }
              : {},
          outputs: [],
          source: `value_${part}_${step} = ${step}`
        });
      }
    }
    const notebook = {
      cells,
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
    await openInWhybook(page, file);
    const minimap = page.locator('.jp-Epi-minimap');
    await expect(minimap.locator('.jp-Epi-minimap-band')).toHaveCount(10);
    await expect(minimap.locator('.jp-Epi-minimap-cell')).toHaveCount(80);
    const height = async () => (await minimap.boundingBox())!.height;
    const view = (await page.locator('.jp-Epi-main').boundingBox())!.height;

    // At rest, 80 bars of 6 px would be taller than the view; the minimap is
    // at most 120 px, and at most a fifth of the view.
    await page.mouse.move(10, 10);
    await expect.poll(height).toBeLessThanOrEqual(Math.min(120, view / 5) + 1);
    const rest = await height();
    expect(rest).toBeGreaterThan(60);

    // The bar of the cell that answers a question has its type's colour,
    // muted at rest and full when the minimap is pointed at.
    const typed = minimap.locator('.jp-Epi-minimap-cell[data-type="model"]');
    await expect(typed).toHaveCount(1);
    const colour = () =>
      typed.evaluate(bar => getComputedStyle(bar).backgroundColor);
    const muted = await colour();

    // Pointed at, it grows, up to 60% of the view: its bars grow for 120 ms,
    // and the height is read once no transition runs.
    await minimap.hover();
    await expect.poll(height).toBeGreaterThan(rest + 100);
    await expect.poll(colour).not.toBe(muted);
    await expect
      .poll(() =>
        minimap.evaluate(node => node.getAnimations({ subtree: true }).length)
      )
      .toBe(0);
    expect(await height()).toBeLessThanOrEqual(view * 0.6 + 1);
    // A click still opens the map.
    await minimap.click();
    await expect(page.locator('.jp-Epi-map')).toBeVisible();
  });
});

test('titles cells with a model: in the background when the notebook opens, and after a pause in typing', async ({
  page,
  tmpPath
}) => {
  // The test server turns the remote model off; these routes answer in its place.
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true, describe_tables: true }
    });
  });
  const asked: any[] = [];
  await page.route(/\/whybook\/cells\/title/, async route => {
    const body = route.request().postDataJSON();
    asked.push(body);
    // Slow enough for the pulsing bar to show.
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({
          type: 'result',
          model: 'claude-test',
          cells: body.cells.map((cell: any) => ({
            id: cell.id,
            title: cell.code.includes('weekly')
              ? 'Visits per week'
              : 'Visits of each patient'
          }))
        }) + '\n'
    });
  });
  await newNotebook(page, `${tmpPath}/titles.ipynb`, [
    'visits = [3, 5, 8]',
    'print(sum(visits))',
    'import math\nfrom statistics import mean'
  ]);
  await openInWhybook(page, `${tmpPath}/titles.ipynb`);
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  const cell = page.locator('.jp-Epi-linear-cell[data-cell-id="cell-0"]');
  const title = cell.locator('.jp-Epi-title');
  await expect(title).toHaveText('visits = [3, 5, 8]');

  // Soon after the notebook opens, the first-line titles go to the model in
  // one request, with a pulsing bar in place of each title meanwhile.
  await expect(cell.locator('.jp-Epi-title-skeleton')).toBeVisible({
    timeout: 10000
  });
  await expect(title).toContainText('Visits of each patient', {
    timeout: 10000
  });
  await expect(title.locator('.jp-Epi-aitag')).toBeVisible();
  expect(asked).toHaveLength(1);
  // The default of Labels and captions: the fastest model of the connected provider.
  expect(asked[0].model).toBe('remote:fastest');
  expect(asked[0].cells.map((item: any) => item.id)).toEqual([
    'cell-0',
    'cell-1'
  ]);
  // A cell that only imports names its modules, and no model titles it.
  const imports = page.locator(
    '.jp-Epi-linear-cell[data-cell-id="cell-2"] .jp-Epi-title'
  );
  await expect(imports).toHaveText('Imports: math and statistics');
  await expect(imports.locator('.jp-Epi-aitag')).toHaveCount(0);

  // An edit asks again for the new code once the typing pauses.
  await cell.locator('.jp-Epi-editor .cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\nweekly = sum(visits)');
  expect(asked).toHaveLength(1);
  await expect(title).toContainText('Visits per week', { timeout: 10000 });
  expect(asked).toHaveLength(2);
  expect(asked[1].cells).toHaveLength(1);
  expect(asked[1].cells[0].code).toContain('weekly = sum(visits)');
  expect(asked[1].cells[0].title).toBe('Visits of each patient');
  const meta = await cellMetas(page);
  expect(meta[0].title_note.title).toBe('Visits per week');
  expect(meta[0].title_note.by.model).toBe('claude-test');

  // The bench shows the same title; a run with the same code asks nothing.
  await page.locator('.jp-Epi-views [data-value="bench"]').click();
  await expect(
    page.locator(
      '.jp-Epi-bench .jp-Epi-cell[data-cell-id="cell-0"] .jp-Epi-title'
    )
  ).toContainText('Visits per week');
  await page.locator('.jp-Epi-runall').click();
  await idle(page);
  expect(asked).toHaveLength(2);
});

/** The element right after a provider's row in the AI models panel: the provider's models, once they open. */
function underRow(row: Locator): Locator {
  return row.locator('xpath=following-sibling::*[1]');
}

test('connects a model in the AI panel: a server on this machine, Hugging Face after a sign-in, Mistral AI with a key, and OpenRouter', async ({
  page,
  tmpPath
}) => {
  // The test answers every route of the connection and of the sign-ins, and
  // catches the tab that a sign-in opens: no request reaches a model,
  // openrouter.ai, huggingface.co or mistral.ai.
  // The default of a server without --Whybook.claude_code_login: no model connected.
  let saved: any = {
    provider: 'none',
    model: null,
    base_url: null,
    local: false
  };
  const signedIn: Record<string, boolean> = {
    openrouter: false,
    huggingface: false,
    mistral: false
  };
  const posted: any[] = [];
  const keys: any[] = [];
  const labels: Record<string, string> = {
    ollama: 'Ollama',
    huggingface: 'Hugging Face',
    mistral: 'Mistral AI',
    openrouter: 'OpenRouter'
  };
  const readiness = () =>
    saved.provider === 'none'
      ? {
          available: false,
          cli: null,
          credential: null,
          reason: 'no model is connected',
          setup: 'Connect one in the AI models panel.',
          provider: 'none',
          model: null,
          label: 'No model connected',
          local: false
        }
      : {
          available: true,
          cli: null,
          credential: labels[saved.provider],
          reason: null,
          setup: null,
          provider: saved.provider,
          model: saved.model,
          label: `${labels[saved.provider]}: ${saved.model}`,
          local: saved.provider === 'ollama'
        };
  const provider = (id: string, signin: string | null) => ({
    id,
    label: labels[id],
    local: id === 'ollama',
    base_url: null,
    signin,
    needs_key: id !== 'ollama',
    dev_only: false,
    signed_in: !!signedIn[id],
    key_from: signedIn[id] ? (signin ?? 'typed') : null,
    saved: null,
    installed: true
  });
  const state = () => ({
    connection: saved,
    readiness: readiness(),
    providers: [
      provider('openrouter', 'openrouter'),
      provider('huggingface', 'huggingface'),
      provider('mistral', null),
      provider('ollama', null)
    ],
    huggingface_signin: true,
    models_installed: true
  });
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body)
  });
  await page
    .context()
    .route(/openrouter\.ai|huggingface\.co|mistral\.ai/, route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'stub' })
    );
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    const remote = readiness();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: remote.available,
        claude: remote,
        remote_model: remote.provider === 'none' ? null : remote.label
      }
    });
  });
  await page.route(/\/whybook\/connection(\?.*)?$/, async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      posted.push(body);
      saved = { ...body, local: body.provider === 'ollama' };
    }
    await route.fulfill(json(state()));
  });
  await page.route(/\/whybook\/connection\/local/, route =>
    route.fulfill(
      json({
        servers: [
          {
            provider: 'ollama',
            label: 'Ollama',
            base_url: 'http://127.0.0.1:11434/v1',
            models: [
              { id: 'qwen3:8b', label: 'qwen3:8b', note: '5.2 GB' },
              { id: 'gpt-oss:20b', label: 'gpt-oss:20b', note: '13.8 GB' }
            ]
          }
        ]
      })
    )
  );
  const openRouterModels = Array.from({ length: 40 }, (_, i) => ({
    id: `vendor/model-${i}`,
    label: `Vendor: Model ${i}`,
    note: null
  }));
  openRouterModels.push({
    id: 'anthropic/claude-sonnet-5',
    label: 'Anthropic: Claude Sonnet 5',
    note: '$3 in, $15 out per million tokens'
  });
  // The router lists each open model once for each company that serves it.
  const routerModels = ['novita', 'ovhcloud', 'scaleway'].flatMap(company =>
    Array.from({ length: 12 }, (_, i) => ({
      id: `Qwen/Model-${i}:${company}`,
      label: `Qwen/Model-${i} on ${company}`,
      note: null
    }))
  );
  routerModels.push({
    id: 'Qwen/Qwen3.8-27B:ovhcloud',
    label: 'Qwen/Qwen3.8-27B on OVHcloud',
    note: '$0.47 in, $3.19 out per million tokens'
  });
  await page.route(/\/whybook\/connection\/models/, route => {
    // The view lists a server's models with a POST of the provider and the URL.
    const which = route.request().postDataJSON()?.provider;
    const models =
      which === 'ollama'
        ? [
            { id: 'qwen3:8b', label: 'qwen3:8b', note: '5.2 GB' },
            { id: 'gpt-oss:20b', label: 'gpt-oss:20b', note: '13.8 GB' }
          ]
        : which === 'huggingface'
          ? routerModels
          : which === 'mistral'
            ? [
                {
                  id: 'mistral-medium-latest',
                  label: 'mistral-medium-latest',
                  note: null
                },
                {
                  id: 'mistral-large-latest',
                  label: 'mistral-large-latest',
                  note: null
                }
              ]
            : openRouterModels;
    return route.fulfill(json({ models }));
  });
  let polls = 0;
  await page.route(/\/whybook\/auth\/huggingface(\?|$)/, route =>
    route.fulfill(
      json({
        flow: 'f1',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://huggingface.co/oauth/device',
        verification_uri_complete:
          'https://huggingface.co/oauth/device?user_code=WDJB-MJHT',
        expires_in: 900,
        interval: 1
      })
    )
  );
  await page.route(/\/whybook\/auth\/huggingface\/poll/, route => {
    polls += 1;
    if (polls >= 2) {
      signedIn.huggingface = true;
      return route.fulfill(json({ status: 'done' }));
    }
    return route.fulfill(json({ status: 'pending', interval: 1 }));
  });
  await page.route(/\/whybook\/auth\/key(\?|$)/, route => {
    const body = route.request().postDataJSON();
    keys.push(body);
    signedIn[body.provider] = true;
    return route.fulfill(json(state()));
  });
  await page.route(/\/whybook\/auth\/openrouter(\?|$)/, route =>
    route.fulfill(
      json({ state: 's1', url: 'https://openrouter.ai/auth?x=1', mode: 'code' })
    )
  );
  await page.route(/\/whybook\/auth\/openrouter\/code/, route => {
    expect(route.request().postDataJSON()).toEqual({
      state: 's1',
      code: 'pasted-code'
    });
    signedIn.openrouter = true;
    return route.fulfill(json(state()));
  });

  await newNotebook(page, `${tmpPath}/connect.ipynb`, ['x = 1']);
  await openInWhybook(page, `${tmpPath}/connect.ipynb`);
  await page.locator('.jp-Epi-aibutton').click();
  const panel = page.locator('.jp-Epi-aipanel');
  const section = panel.locator('.jp-Epi-connection');
  await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
    'No model connected'
  );
  // With no model connected nothing is wrong: one line says what waits for a
  // model, each task that waits says so in grey, no line in the panel is red,
  // and the status bar says it once.
  await expect(section.locator('.jp-Epi-connection-note').first()).toHaveText(
    '"Cells and answers", "More questions" and "Labels and captions" wait for a model. A local model can do "More questions" and "Labels and captions": choose it below.'
  );
  await expect(
    panel.locator('.jp-Epi-aipanel-note:not(.jp-mod-waiting)')
  ).toHaveCount(0);
  const waits = panel.locator('.jp-Epi-aipanel-note.jp-mod-waiting');
  await expect(waits).toHaveText([
    'Waits for a connected model',
    'Waits for a connected model',
    'Waits for a connected model'
  ]);
  // Each spans its task's row, as the other notes do, so the tasks stay in line.
  const row = await panel.evaluate(
    element => element.getBoundingClientRect().width
  );
  for (const width of await waits.evaluateAll(notes =>
    notes.map(note => note.getBoundingClientRect().width)
  )) {
    expect(width).toBeGreaterThan(row * 0.8);
  }
  await expect(page.locator('.jp-Epi-status-models')).toHaveText(
    'AI: no model connected'
  );

  // A server found on this machine, and one of its models. The Claude Code
  // login is not among the choices: the server does not list it.
  await section.getByRole('button', { name: 'Connect a model' }).click();
  await expect(
    section.locator('.jp-Epi-provider', { hasText: 'Claude Code login' })
  ).toHaveCount(0);
  const ollama = section.locator('.jp-Epi-provider', { hasText: 'Ollama' });
  await expect(ollama).toContainText('2 models at http://127.0.0.1:11434/v1');
  const choose = ollama.getByRole('button', { name: 'Choose' });
  await choose.click();
  // A provider's models open under its own row. A press of a button of the
  // row leaves the focus on that button.
  const picker = section.locator('.jp-Epi-modelpicker');
  await expect(underRow(ollama)).toHaveAttribute(
    'aria-label',
    'Models of Ollama'
  );
  await expect(picker.getByLabel('Model of Ollama')).toBeVisible();
  await expect(choose).toBeFocused();
  await picker.getByLabel('Model of Ollama').selectOption('qwen3:8b');
  await picker.getByRole('button', { name: 'Use this model' }).click();
  await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
    'Ollama: qwen3:8b'
  );
  await expect(section).toContainText(
    'Runs on this machine: it reads the data as the local models do.'
  );
  expect(posted[0]).toEqual({
    provider: 'ollama',
    model: 'qwen3:8b',
    base_url: 'http://127.0.0.1:11434/v1'
  });
  // The tasks set to the remote model now name the model on this machine.
  await expect(
    panel.locator('#jp-Epi-quick-cells option[value="remote"]')
  ).toHaveText('Ollama: qwen3:8b, on this machine');

  // Sign in with Hugging Face: the code to approve, then the router's
  // models, each with the company that serves it.
  await section.getByRole('button', { name: 'Change' }).click();
  const huggingFace = section.locator('.jp-Epi-provider', {
    hasText: 'Hugging Face'
  });
  await huggingFace.getByRole('button', { name: 'Sign in' }).click();
  const code = section.locator('.jp-Epi-devicecode');
  await expect(code).toContainText(
    'Approve the code WDJB-MJHT at huggingface.co/oauth/device'
  );
  await expect(code.getByRole('link')).toHaveAttribute(
    'href',
    'https://huggingface.co/oauth/device?user_code=WDJB-MJHT'
  );
  const routerPicker = section.locator('.jp-Epi-modelpicker', {
    hasText: 'Models of Hugging Face'
  });
  await expect(routerPicker).toBeVisible({ timeout: 10000 });
  await expect(code).toHaveCount(0);
  // The list opens under the row of Hugging Face, with the focus in its
  // filter, which the example of its placeholder finds models with, as it is
  // written.
  await expect(underRow(huggingFace)).toHaveAttribute(
    'aria-label',
    'Models of Hugging Face'
  );
  const routerFilter = routerPicker.getByLabel('Model of Hugging Face');
  await expect(routerFilter).toBeFocused();
  await expect(routerFilter).toHaveAttribute(
    'placeholder',
    'Filter 37 models, such as Qwen Scaleway'
  );
  await routerFilter.fill('Qwen Scaleway');
  await expect(routerPicker.getByRole('option')).toHaveCount(12);
  await expect(routerPicker.getByRole('option').first()).toContainText(
    'Qwen/Model-0 on scaleway'
  );
  await routerFilter.fill('qwen3.8 ovhcloud');
  const routed = routerPicker.getByRole('option', {
    name: /Qwen\/Qwen3.8-27B on OVHcloud/
  });
  await expect(routed).toContainText('$0.47 in, $3.19 out per million tokens');
  await routed.click();
  await routerPicker.getByRole('button', { name: 'Use this model' }).click();
  await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
    'Hugging Face: Qwen/Qwen3.8-27B:ovhcloud'
  );

  // Mistral AI with a pasted key, which the server checks, then its models.
  await section.getByRole('button', { name: 'Change' }).click();
  const mistral = section.locator('.jp-Epi-provider', {
    hasText: 'Mistral AI'
  });
  await expect(mistral).toContainText('Mistral models');
  await mistral.getByRole('button', { name: 'Paste key' }).click();
  const keyForm = section.getByRole('form', { name: 'Key of Mistral AI' });
  await expect(keyForm.getByRole('link')).toHaveAttribute(
    'href',
    'https://console.mistral.ai/api-keys'
  );
  await keyForm.getByLabel(/A Mistral AI API key/).fill(' mistral-key ');
  await keyForm.getByRole('button', { name: 'Save key' }).click();
  const mistralPicker = section.locator('.jp-Epi-modelpicker', {
    hasText: 'Models of Mistral AI'
  });
  // Its models open under its row, with the focus that the key's form had.
  await expect(underRow(mistral)).toHaveAttribute(
    'aria-label',
    'Models of Mistral AI'
  );
  await expect(mistralPicker.getByLabel('Model of Mistral AI')).toBeFocused();
  await mistralPicker
    .getByLabel('Model of Mistral AI')
    .selectOption('mistral-medium-latest');
  await mistralPicker.getByRole('button', { name: 'Use this model' }).click();
  await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
    'Mistral AI: mistral-medium-latest'
  );
  expect(keys).toEqual([{ provider: 'mistral', key: 'mistral-key' }]);

  // Sign in with OpenRouter where it cannot send the browser back: a pasted
  // code, then a filter over its long list of models.
  await section.getByRole('button', { name: 'Change' }).click();
  const tab = page.context().waitForEvent('page');
  const openRouter = section.locator('.jp-Epi-provider', {
    hasText: 'OpenRouter'
  });
  await openRouter.getByRole('button', { name: 'Sign in' }).click();
  await (await tab).close();
  await section.getByLabel(/paste the code it shows/).fill('pasted-code');
  await section
    .locator('.jp-Epi-pastecode')
    .getByRole('button', { name: 'Sign in' })
    .click();
  const openRouterPicker = section.locator('.jp-Epi-modelpicker', {
    hasText: 'Models of OpenRouter'
  });
  await expect(underRow(openRouter)).toHaveAttribute(
    'aria-label',
    'Models of OpenRouter'
  );
  const openRouterFilter = openRouterPicker.getByLabel('Model of OpenRouter');
  await expect(openRouterFilter).toBeFocused();
  await expect(openRouterFilter).toHaveAttribute(
    'placeholder',
    'Filter 41 models, such as Claude Sonnet'
  );
  await openRouterFilter.fill('Claude Sonnet');
  const option = openRouterPicker.getByRole('option', {
    name: /Anthropic: Claude Sonnet 5/
  });
  await expect(option).toContainText('$3 in, $15 out per million tokens');
  await option.click();
  await openRouterPicker
    .getByRole('button', { name: 'Use this model' })
    .click();
  await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
    'OpenRouter: anthropic/claude-sonnet-5'
  );
  expect(posted.map(body => [body.provider, body.model])).toEqual([
    ['ollama', 'qwen3:8b'],
    ['huggingface', 'Qwen/Qwen3.8-27B:ovhcloud'],
    ['mistral', 'mistral-medium-latest'],
    ['openrouter', 'anthropic/claude-sonnet-5']
  ]);
  await expect(
    panel.locator('#jp-Epi-quick-cells option[value="remote"]')
  ).toHaveText('Remote AI model: OpenRouter: anthropic/claude-sonnet-5');
});

/**
 * Answer the routes of the AI models panel: no model connected, Ollama on
 * this machine when `ollama` is set, 41 models of OpenRouter, and a sign-in
 * with OpenRouter that comes back through its callback once
 * `signedIn.openrouter` is set. A save waits for `hold`. The tab of the
 * sign-in gets a stub page: no request reaches openrouter.ai or a model.
 */
async function answerConnection(
  page: IJupyterLabPageFixture,
  options: { ollama?: boolean; hold?: Promise<void> } = {}
): Promise<{ signedIn: Record<string, boolean>; posted: any[] }> {
  const signedIn: Record<string, boolean> = { openrouter: false };
  const posted: any[] = [];
  let saved: any = {
    provider: 'none',
    model: null,
    base_url: null,
    local: false
  };
  const labels: Record<string, string> = {
    openrouter: 'OpenRouter',
    huggingface: 'Hugging Face',
    ollama: 'Ollama'
  };
  const state = () => ({
    connection: saved,
    readiness:
      saved.provider === 'none'
        ? {
            available: false,
            cli: null,
            credential: null,
            reason: 'no model is connected',
            setup: 'Connect one in the AI models panel.',
            provider: 'none',
            model: null,
            label: 'No model connected',
            local: false
          }
        : {
            available: true,
            cli: null,
            credential: labels[saved.provider],
            reason: null,
            setup: null,
            provider: saved.provider,
            model: saved.model,
            label: `${labels[saved.provider]}: ${saved.model}`,
            local: saved.provider === 'ollama'
          },
    providers: Object.keys(labels).map(id => ({
      id,
      label: labels[id],
      local: id === 'ollama',
      base_url: null,
      signin: id === 'ollama' ? null : id,
      needs_key: id !== 'ollama',
      dev_only: false,
      signed_in: !!signedIn[id],
      key_from: signedIn[id] ? id : null,
      saved: null,
      installed: true
    })),
    huggingface_signin: false,
    models_installed: true
  });
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body)
  });
  const ollama = [
    { id: 'qwen3:8b', label: 'qwen3:8b', note: '5.2 GB' },
    { id: 'gpt-oss:20b', label: 'gpt-oss:20b', note: '13.8 GB' }
  ];
  const openRouterModels = Array.from({ length: 40 }, (_, i) => ({
    id: `vendor/model-${i}`,
    label: `Vendor: Model ${i}`,
    note: null as string | null
  }));
  openRouterModels.push({
    id: 'anthropic/claude-sonnet-5',
    label: 'Anthropic: Claude Sonnet 5',
    note: '$3 in, $15 out per million tokens'
  });
  await page
    .context()
    .route(/openrouter\.ai/, route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'stub' })
    );
  await page.route(/\/whybook\/connection(\?.*)?$/, async route => {
    if (route.request().method() === 'POST') {
      await options.hold;
      const body = route.request().postDataJSON();
      posted.push(body);
      saved = { ...body, local: body.provider === 'ollama' };
    }
    await route.fulfill(json(state()));
  });
  await page.route(/\/whybook\/connection\/local/, route =>
    route.fulfill(
      json({
        servers: options.ollama
          ? [
              {
                provider: 'ollama',
                label: 'Ollama',
                base_url: 'http://127.0.0.1:11434/v1',
                models: ollama
              }
            ]
          : []
      })
    )
  );
  await page.route(/\/whybook\/connection\/models/, route => {
    // The view lists a server's models with a POST of the provider and the URL.
    const which = route.request().postDataJSON()?.provider;
    return route.fulfill(
      json({ models: which === 'ollama' ? ollama : openRouterModels })
    );
  });
  await page.route(/\/whybook\/auth\/openrouter(\?|$)/, route =>
    route.fulfill(
      json({
        state: 's1',
        url: 'https://openrouter.ai/auth?x=1',
        mode: 'callback'
      })
    )
  );
  await page.route(/\/whybook\/auth\/signout/, route => {
    signedIn[route.request().postDataJSON().provider] = false;
    return route.fulfill(json(state()));
  });
  return { signedIn, posted };
}

test('opens the models of OpenRouter under its row once its sign-in comes back, with the focus in them unless the analyst types elsewhere', async ({
  page,
  tmpPath
}) => {
  const fake = await answerConnection(page);
  await newNotebook(page, `${tmpPath}/signin.ipynb`, ['x = 1']);
  await openInWhybook(page, `${tmpPath}/signin.ipynb`);
  await page.locator('.jp-Epi-aibutton').click();
  const section = page.locator('.jp-Epi-aipanel .jp-Epi-connection');
  await section.getByRole('button', { name: 'Connect a model' }).click();
  const openRouter = section.locator('.jp-Epi-provider', {
    hasText: 'OpenRouter'
  });
  const models = section.locator('.jp-Epi-modelpicker');
  // OpenRouter sends the browser back to the server, and the panel asks the
  // server every 2 seconds whether the key is there.
  const signIn = async () => {
    const tab = page.context().waitForEvent('page');
    await openRouter.getByRole('button', { name: 'Sign in' }).click();
    await (await tab).close();
    await expect(section).toContainText('Approve Whybook on openrouter.ai');
  };
  await signIn();
  await expect(models).toHaveCount(0);
  fake.signedIn.openrouter = true;

  // The list opens by itself under the row of OpenRouter, in view, with the
  // focus in its filter: the sign-in left the focus on that row. It sat at
  // the bottom of the panel, below the fold, and the focus stayed on the row.
  await expect(underRow(openRouter)).toHaveAttribute(
    'aria-label',
    'Models of OpenRouter',
    { timeout: 10000 }
  );
  await expect(models).toHaveCount(1);
  const filter = models.getByLabel('Model of OpenRouter');
  await expect(filter).toBeFocused();
  await expect(models).toBeInViewport({ ratio: 1 });
  // The keyboard does the rest: the example of the placeholder, as it is
  // written, then the model, then the button.
  await expect(filter).toHaveAttribute(
    'placeholder',
    'Filter 41 models, such as Claude Sonnet'
  );
  await page.keyboard.type('Claude Sonnet');
  const use = models.getByRole('button', { name: 'Use this model' });
  await expect(use).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(
    models.getByRole('option', { name: /Anthropic: Claude Sonnet 5/ })
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(use).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(use).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
    'OpenRouter: anthropic/claude-sonnet-5'
  );
  expect(fake.posted).toEqual([
    {
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-5',
      base_url: null
    }
  ]);

  // Once: the list does not open again by itself. "Models" opens it under
  // the row, and signing out closes it, since no model can be listed then.
  await section.getByRole('button', { name: 'Change' }).click();
  await expect(
    openRouter.getByRole('button', { name: 'Models' })
  ).toBeVisible();
  await expect(models).toHaveCount(0);
  await openRouter.getByRole('button', { name: 'Models' }).click();
  await expect(underRow(openRouter)).toHaveAttribute(
    'aria-label',
    'Models of OpenRouter'
  );
  await openRouter.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    openRouter.getByRole('button', { name: 'Sign in' })
  ).toBeVisible();
  await expect(models).toHaveCount(0);

  // A sign-in that comes back while the analyst types in another field opens
  // the list, and leaves the focus in that field.
  await signIn();
  const url = section.getByPlaceholder('http://gpu-server:8000/v1');
  await url.click();
  await page.keyboard.type('http://gpu');
  fake.signedIn.openrouter = true;
  await expect(underRow(openRouter)).toHaveAttribute(
    'aria-label',
    'Models of OpenRouter',
    { timeout: 10000 }
  );
  await expect(filter).toBeVisible();
  await expect(url).toBeFocused();
  await page.keyboard.type('-server:8000/v1');
  await expect(url).toHaveValue('http://gpu-server:8000/v1');
  await expect(filter).toHaveValue('');
});

test('draws "Use this model" in the blue of the primary actions once a model is chosen, and grey while none is or while the server checks it', async ({
  page,
  tmpPath
}) => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>(resolve => {
    release = () => resolve();
  });
  const fake = await answerConnection(page, { ollama: true, hold });
  await newNotebook(page, `${tmpPath}/button.ipynb`, ['x = 1']);
  await openInWhybook(page, `${tmpPath}/button.ipynb`);
  await page.locator('.jp-Epi-aibutton').click();
  const section = page.locator('.jp-Epi-aipanel .jp-Epi-connection');
  const look = (button: Locator) =>
    button.evaluate(node => {
      const style = getComputedStyle(node);
      return {
        background: style.backgroundColor,
        color: style.color,
        height: node.getBoundingClientRect().height
      };
    });
  // The primary action of the panel, "Connect a model", gives the blue. The
  // pointer stays away from the buttons, whose colour changes under it.
  const connect = section.getByRole('button', { name: 'Connect a model' });
  await page.mouse.move(0, 0);
  const primary = await look(connect);
  await connect.click();
  const ollama = section.locator('.jp-Epi-provider', { hasText: 'Ollama' });
  await ollama.getByRole('button', { name: 'Choose' }).click();
  const picker = underRow(ollama);
  await expect(picker).toHaveAttribute('aria-label', 'Models of Ollama');
  const use = picker.getByRole('button', { name: 'Use this model' });
  await page.mouse.move(0, 0);

  // No model chosen: grey, and it cannot be pressed.
  await expect(use).toBeDisabled();
  await expect(use).not.toHaveClass(/jp-mod-accept/);
  const grey = await look(use);
  expect(grey.background).not.toBe(primary.background);

  // A model chosen: the blue of "Connect a model", at the height of the grey
  // button. It stayed grey.
  await picker.getByLabel('Model of Ollama').selectOption('qwen3:8b');
  await expect(use).toBeEnabled();
  await expect(use).toHaveClass(/jp-mod-accept/);
  const blue = await look(use);
  expect(blue.background).toBe(primary.background);
  expect(blue.color).toBe(primary.color);
  expect(blue.height).toBe(grey.height);

  // While the server checks the model: grey again, and it cannot be pressed.
  await use.click();
  const checking = picker.getByRole('button', { name: 'Checking…' });
  await expect(checking).toBeDisabled();
  await expect(checking).not.toHaveClass(/jp-mod-accept/);
  release();
  await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
    'Ollama: qwen3:8b'
  );
  expect(fake.posted).toEqual([
    {
      provider: 'ollama',
      model: 'qwen3:8b',
      base_url: 'http://127.0.0.1:11434/v1'
    }
  ]);
});

test('offers to look again for model servers, in a link the size of the note around it', async ({
  page,
  tmpPath
}) => {
  // No server answers on this machine: the route says so, and counts the looks.
  let looks = 0;
  await page.route(/\/whybook\/connection\/local/, route => {
    looks += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ servers: [] })
    });
  });
  await newNotebook(page, `${tmpPath}/servers.ipynb`, ['x = 1']);
  await openInWhybook(page, `${tmpPath}/servers.ipynb`);
  await page.locator('.jp-Epi-aibutton').click();
  const section = page.locator('.jp-Epi-aipanel .jp-Epi-connection');
  await section.locator('.jp-Epi-connection-head .jp-Epi-link').click();
  const note = section.locator('.jp-Epi-connection-note', {
    hasText: 'No model server answers on this machine.'
  });
  await expect(note).toHaveText(
    'No model server answers on this machine. Start Ollama, LM Studio, llama.cpp or vLLM, then look again.'
  );
  const link = note.getByRole('button', { name: 'look again' });
  const font = (element: Element) => {
    const style = getComputedStyle(element);
    return [style.fontFamily, style.fontSize, style.fontWeight];
  };
  expect(await link.evaluate(font)).toEqual(await note.evaluate(font));

  const before = looks;
  await link.click();
  await expect.poll(() => looks).toBe(before + 1);
});

test('names a cell in a question by its id, and shows its current label once it has run again', async ({
  page,
  tmpPath
}) => {
  // A file with semicolons, read with the comma of read_csv: its frame has
  // one column, so the header that the read leaves at its default is an
  // open assumption, which Worth asking next asks about.
  await page.contents.uploadContent(
    'k;v\n1;3\n2;4\n',
    'text',
    `${tmpPath}/semi.csv`
  );
  const file = `${tmpPath}/labels.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd',
    'semi = pd.read_csv("semi.csv")\nsemi'
  ]);
  await openInWhybook(page, file);
  await kernelIdle(page);
  await page.locator('.jp-Epi-runall').click();
  const card = page.locator('.jp-Epi-cell').nth(1);
  await expect(card.locator('.jp-Epi-label')).toHaveText('[2]', {
    timeout: 60000
  });
  // Worth asking next asks whether the read's default header changes [2].
  const next = page
    .locator('.jp-Epi-exploration .jp-Epi-next', {
      hasText: 'change the result of [2]'
    })
    .first();
  await expect(next).toBeVisible({ timeout: 30000 });
  const text = (await next.locator('.jp-Epi-next-text').textContent())!.trim();
  await next.locator('button', { hasText: 'Ask' }).click();
  const branch = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-label', { hasText: '[2b]' })
  });
  await expect(branch.locator('.jp-Epi-title')).toHaveText(text, {
    timeout: 60000
  });
  // The notebook keeps the id of the cell beside the label that names it.
  const id = await page.evaluate(
    () =>
      (window as any).jupyterapp.shell.currentWidget.context.model.cells.get(1)
        .id
  );
  const written = (await cellMetas(page)).find(meta => meta.branch);
  expect(written.question.refs).toEqual({ '[2]': id });

  // [2] runs again under a new count: the branch's title shows that count.
  await card.locator('.jp-Epi-cell-actions button', { hasText: 'Run' }).click();
  // While the cell runs its label is "[ ]"; then it has its new count.
  await expect(card.locator('.jp-Epi-label')).toHaveText(/^\[(?!2\])\d+\]$/, {
    timeout: 30000
  });
  const label = (await card.locator('.jp-Epi-label').textContent())!.trim();
  const renamed = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-label', { hasText: label.replace(']', 'b]') })
  });
  await expect(renamed.locator('.jp-Epi-title')).toHaveText(
    text.replace('[2]', label)
  );
});

test('greys a count from an earlier run, and marks a label that two cells show', async ({
  page,
  tmpPath
}) => {
  // Two cells kept [2] from two earlier runs, and a question names the second.
  const file = `${tmpPath}/shared-label.ipynb`;
  const code = (
    id: string,
    count: number | null,
    source: string,
    metadata = {}
  ) => ({
    cell_type: 'code',
    execution_count: count,
    id,
    metadata,
    outputs: [],
    source
  });
  const notebook = {
    cells: [
      code('cell-0', 2, 'x = 1'),
      code('cell-1', 2, 'y = 2'),
      code('cell-2', null, 'z = y * 2', {
        whybook: {
          question: {
            id: 'q1',
            text: 'Does y change the result of [2]?',
            type: 'descriptive',
            refs: { '[2]': 'cell-1' }
          }
        }
      })
    ],
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
  await openInWhybook(page, file);
  await kernelIdle(page);
  const card = (id: string) =>
    page.locator(`.jp-Epi-cell[data-cell-id="${id}"]`);
  const label = (id: string) =>
    card(id).locator('.jp-Epi-cell-head > .jp-Epi-label');

  // Neither [2] ran in this kernel, so both are greyed.
  await expect(label('cell-0')).toHaveClass(/jp-mod-lastrun/);
  await expect(label('cell-1')).toHaveClass(/jp-mod-lastrun/);
  // The question's [2] carries a mark: the pointer gives the title of the
  // cell it names, and a click flashes that cell.
  const ref = card('cell-2').locator('.jp-Epi-title .jp-Epi-labelref');
  await expect(ref).toHaveText('[2]');
  await expect(ref).toHaveAttribute('title', '[2]: y = 2');
  await ref.click();
  await expect(card('cell-1')).toHaveClass(/jp-mod-flash/);

  // The first cell runs in this kernel: its count is not greyed, and no
  // other cell shows [2], so the mark goes.
  await card('cell-0')
    .locator('.jp-Epi-cell-actions button', { hasText: 'Run' })
    .click();
  await idle(page);
  await expect(label('cell-0')).toHaveText('[1]');
  await expect(label('cell-0')).not.toHaveClass(/jp-mod-lastrun/);
  await expect(label('cell-1')).toHaveClass(/jp-mod-lastrun/);
  await expect(card('cell-2').locator('.jp-Epi-labelref')).toHaveCount(0);
});
