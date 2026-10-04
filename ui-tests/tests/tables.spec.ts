import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

/*
 * Questions from a table of a data frame: a click on a header asks about
 * its column, Shift+click on a second header about both, and row labels
 * picked with a click, a drag or Shift+click ask about those rows.
 */

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

function popover(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-popover');
}

/** Write a notebook with these code cells, and open it in the view. */
async function openNotebook(
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
  await openInWhybook(page, file);
  await kernelIdle(page);
}

/** Run every cell, and wait for the kernel's variables to list these. */
async function runAll(
  page: IJupyterLabPageFixture,
  names: string[]
): Promise<void> {
  await page.locator('.jp-Epi-runall').click();
  await page.sidebar.openTab('epi-variables');
  for (const name of names) {
    await expect(
      page.locator(`.jp-Epi-variable[data-variable="${name}"]`)
    ).toBeVisible({ timeout: 120000 });
  }
  await idle(page);
}

const FRAME = [
  'import pandas as pd',
  'df = pd.DataFrame({',
  '    "arm": ["A", "B", "B", "A", "A"],',
  '    "age": [34, 51, 45, 62, 29],',
  '    "pain": [3.1, 7.2, 6.9, 3.3, 2.8],',
  '})',
  'df.head()'
].join('\n');

/** The table of a cell's output on the bench, shown in full. */
function benchTable(page: IJupyterLabPageFixture, cellId: string): Locator {
  return page.locator(
    `[data-cell-id="${cellId}"] .jp-Epi-tableoutput.jp-mod-inline table`
  );
}

test('asks about a column, then two, from the headers of a table', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, `${tmpPath}/columns.ipynb`, [FRAME]);
  await runAll(page, ['df']);
  const table = benchTable(page, 'cell-0');
  await expect(table).toBeVisible();
  const header = (label: string) =>
    table.locator('th.jp-Epi-askhead', { hasText: new RegExp(`^${label}$`) });

  // A header asks what the column dropped onto itself asks.
  await header('pain').click();
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    'pain (itself)'
  );
  await expect(popover(page).locator('.jp-Epi-option').first()).toContainText(
    'Summarise pain: distribution and missingness'
  );
  await expect(header('pain')).toHaveClass(/jp-mod-picked/);
  await popover(page)
    .locator('.jp-Epi-option', { hasText: 'Summarise pain' })
    .click();
  // Its answer runs in the sidebar, and becomes a cell that runs.
  const keep = page.locator('.jp-Epi-preview button', {
    hasText: 'Keep as a cell'
  });
  await expect(keep).toBeVisible({ timeout: 60000 });
  await keep.click();
  await expect(
    page.locator('.jp-Epi-title', {
      hasText: 'Summarise pain: distribution and missingness'
    })
  ).toBeVisible();
  await idle(page);
  const summary = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-title', { hasText: 'Summarise pain' })
  });
  await expect(summary.locator('.jp-Epi-label')).toHaveText(/\[\d+\]/);
  await expect(summary.locator('.jp-Epi-error')).toHaveCount(0);

  // Shift+click on a second header asks about the two columns together.
  await header('age').click();
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    'age (itself)'
  );
  await header('pain').click({ modifiers: ['Shift'] });
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    /age [+→] pain/
  );
  await expect(header('age')).toHaveClass(/jp-mod-picked/);
  await expect(header('pain')).toHaveClass(/jp-mod-picked/);
  await popover(page)
    .locator('.jp-Epi-option', { hasText: 'Are age and pain associated?' })
    .click();
  const pair = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-title', {
      hasText: 'Are age and pain associated?'
    })
  });
  await expect(pair).toBeVisible();
  await idle(page);
  // The cell ran, and shows the correlation of the two columns.
  await expect(pair.locator('.jp-Epi-tableoutput table')).toContainText('pain');
  await expect(pair.locator('.jp-Epi-label')).toHaveText(/\[\d+\]/);

  // The Code view shows the table as the notebook does, and its headers ask too.
  await page.locator('.jp-Epi-views [data-value="linear"]').click();
  await page
    .locator('.jp-Epi-linear-cell[data-cell-id="cell-0"] th.jp-Epi-askhead', {
      hasText: /^age$/
    })
    .click();
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    'age (itself)'
  );
});

test('asks about rows picked by their labels', async ({ page, tmpPath }) => {
  await openNotebook(page, `${tmpPath}/rows.ipynb`, [FRAME]);
  await runAll(page, ['df']);
  const table = benchTable(page, 'cell-0');
  const label = (text: string) =>
    table.locator('tbody th.jp-Epi-askrow', { hasText: text });

  // A drag across two row labels picks both rows.
  const from = (await label('1').boundingBox())!;
  const to = (await label('2').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 5
  });
  await page.mouse.up();
  const ask = popover(page);
  await expect(ask.locator('.jp-Epi-ask-head')).toContainText(
    'rows 1 and 2 of df'
  );
  await expect(ask).toContainText('2 of 5 rows of df');
  await expect(ask.locator('.jp-Epi-seen')).toHaveText(
    'Compared with the other 3 rows: mean pain 7.05 against 3.07; arm B in 100% against 0%.'
  );
  await expect(ask.locator('.jp-Epi-option').first()).toContainText(
    'What sets rows 1 and 2 apart from the other rows of df?'
  );
  await expect(ask.locator('.jp-Epi-keep')).toHaveText(
    'Keep these rows as a variable'
  );
  await expect(table.locator('tbody tr.jp-mod-picked')).toHaveCount(2);

  // Click, then Shift+click, picks the same rows.
  await label('1').click();
  await expect(ask.locator('.jp-Epi-ask-head')).toContainText('row 1 of df');
  await label('2').click({ modifiers: ['Shift'] });
  await expect(ask.locator('.jp-Epi-ask-head')).toContainText(
    'rows 1 and 2 of df'
  );

  // The question's cell runs: the mean of each column, here and elsewhere.
  await ask
    .locator('.jp-Epi-option', { hasText: 'What sets rows 1 and 2 apart' })
    .click();
  const apart = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-title', { hasText: 'What sets rows 1 and 2' })
  });
  await expect(apart).toBeVisible();
  await idle(page);
  await expect(apart.locator('.jp-Epi-tableoutput table')).toContainText(
    'difference in SD'
  );

  // A drag that starts in the text of a cell selects the text, and asks nothing.
  const value = table.locator('td', { hasText: '51' });
  const box = (await value.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 5
  });
  await page.mouse.up();
  expect(
    await page.evaluate(() => window.getSelection()?.toString())
  ).toContain('51');
  await expect(popover(page)).toBeHidden();
});

test('says when it cannot tell the frame, and leaves other tables alone', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, `${tmpPath}/unknown.ipynb`, [
    'import pandas as pd\nTHRESHOLD = 3',
    'pd.DataFrame({"x": [1, 2], "y": [3, 4]})',
    'pd.DataFrame({"z": [5]}).style'
  ]);
  await runAll(page, ['THRESHOLD']);
  const made = benchTable(page, 'cell-1');
  await made.locator('th.jp-Epi-askhead', { hasText: 'x' }).click();
  const ask = popover(page);
  await expect(ask.locator('.jp-Epi-joinnote')).toHaveText(
    'Whybook cannot tell which frame pd.DataFrame({"x": [1, 2], "y": [3, 4]}) shows: no frame in the kernel has its columns.'
  );
  // Kept as a variable, the table is a frame the view can read.
  await ask
    .locator('.jp-Epi-option', { hasText: 'Keep this table as a variable' })
    .click();
  const kept = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-title', {
      hasText: 'Keep this table as a variable'
    })
  });
  await expect(kept).toBeVisible();
  await expect(
    page.locator('.jp-Epi-variable[data-variable="table_2"]')
  ).toBeVisible({ timeout: 60000 });
  await idle(page);
  await kept
    .locator('.jp-Epi-tableoutput table th.jp-Epi-askhead', { hasText: 'y' })
    .click();
  await expect(ask.locator('.jp-Epi-ask-head')).toContainText('y (itself)');
  await page.keyboard.press('Escape');

  // A styled table asks nothing: its headers are not marked, and a click on
  // one opens no questions.
  const styled = page.locator('[data-cell-id="cell-2"] table');
  await expect(styled).toBeVisible();
  await expect(styled.locator('.jp-Epi-askhead')).toHaveCount(0);
  await styled.locator('th', { hasText: 'z' }).click();
  await expect(popover(page)).toBeHidden();
});

test('asks from a table in the cell details, and says what its rows are', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, `${tmpPath}/describe.ipynb`, [
    FRAME.replace('df.head()', 'df.describe()')
  ]);
  await runAll(page, ['df']);
  // Eight rows: a miniature on the bench, which a click shows in full.
  await page
    .locator('[data-cell-id="cell-0"] .jp-Epi-tableoutput-frame[role="button"]')
    .click();
  const panel = page.locator('.jp-Epi-details-outputs');
  const table = panel.locator('table');
  await expect(table).toBeVisible();
  await table.locator('th.jp-Epi-askhead', { hasText: 'age' }).click();
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    'age (itself)'
  );
  // The rows of describe() are statistics, not rows of the frame.
  await table.locator('th.jp-Epi-askrow', { hasText: 'mean' }).click();
  await expect(popover(page).locator('.jp-Epi-joinnote')).toHaveText(
    'The rows of this table are statistics of the columns of df, not rows of df.'
  );
  await popover(page)
    .locator('.jp-Epi-tableask-frame', { hasText: 'Questions about df' })
    .click();
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    'df (itself)'
  );
});

const POLARS_FRAME = [
  'import polars as pl',
  'df = pl.DataFrame({',
  '    "arm": ["A", "B", "B", "A", "A"],',
  '    "age": [34, 51, 45, 62, 29],',
  '    "pain": [3.1, 7.2, 6.9, 3.3, 2.8],',
  '})',
  'df'
].join('\n');

test('asks from the headers and the rows of a polars table', async ({
  page,
  tmpPath
}) => {
  await openNotebook(page, `${tmpPath}/polars.ipynb`, [
    POLARS_FRAME,
    'df.group_by("arm", maintain_order=True).agg(pl.col("pain").mean())',
    'df.filter(pl.col("age") > 40)'
  ]);
  await runAll(page, ['df']);
  // Five rows show in full, as the same pandas frame does.
  const table = benchTable(page, 'cell-0');
  await expect(table).toBeVisible();

  // A header asks about its column; the dtypes under the headers ask nothing.
  await table.locator('th.jp-Epi-askhead', { hasText: /^pain$/ }).click();
  await expect(popover(page).locator('.jp-Epi-ask-head')).toContainText(
    'pain (itself)'
  );
  await expect(
    table.locator('thead td.jp-Epi-askhead, thead td.jp-Epi-askrow')
  ).toHaveCount(0);
  await page.keyboard.press('Escape');

  // polars writes no row labels: the first cell of a row picks the row, and
  // a row is found by its place. A drag across two picks both.
  const first = (of: Locator, row: number) =>
    of.locator('tbody tr').nth(row).locator('td.jp-Epi-askrow');
  const from = (await first(table, 1).boundingBox())!;
  const to = (await first(table, 2).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 5
  });
  await page.mouse.up();
  const ask = popover(page);
  await expect(ask.locator('.jp-Epi-ask-head')).toContainText(
    'rows 1 and 2 of df'
  );
  await expect(ask).toContainText('2 of 5 rows of df');
  await expect(ask.locator('.jp-Epi-seen')).toHaveText(
    'Compared with the other 3 rows: mean pain 7.05 against 3.07; arm B in 100% against 0%.'
  );
  await expect(table.locator('tbody tr.jp-mod-picked')).toHaveCount(2);
  // The question's cell is polars code, and runs.
  await ask
    .locator('.jp-Epi-option', { hasText: 'What sets rows 1 and 2 apart' })
    .click();
  const apart = page.locator('.jp-Epi-cell', {
    has: page.locator('.jp-Epi-title', { hasText: 'What sets rows 1 and 2' })
  });
  await expect(apart).toBeVisible();
  await idle(page);
  await expect(apart.locator('.jp-Epi-tableoutput table')).toContainText(
    'difference in SD'
  );
  await expect(apart.locator('.jp-Epi-error')).toHaveCount(0);

  // Click, then Shift+click, picks the same rows, and keeps them with a filter.
  await first(table, 1).click();
  await first(table, 2).click({ modifiers: ['Shift'] });
  await expect(ask.locator('.jp-Epi-ask-head')).toContainText(
    'rows 1 and 2 of df'
  );
  await ask.locator('.jp-Epi-keep').click();
  await expect(
    page.locator('.jp-Epi-variable[data-variable="df_rows_1_2"]')
  ).toBeVisible({ timeout: 60000 });
  await idle(page);

  // A group of a group_by is found by the value of its key.
  await first(benchTable(page, 'cell-1'), 1).click();
  await expect(ask.locator('.jp-Epi-ask-head')).toContainText('arm B of df');
  await expect(ask).toContainText('2 of 5 rows of df');

  // After a filter a row's place is not its place in df: the view says so,
  // and offers to keep the table as a variable.
  await first(benchTable(page, 'cell-2'), 0).click();
  await expect(ask.locator('.jp-Epi-joinnote')).toHaveText(
    "Whybook cannot tell which rows of df these are. A polars table has no row labels, and after filter() a row's place in the table is not its place in df."
  );
  await expect(
    ask.locator('.jp-Epi-option', {
      hasText: 'Keep this table as a variable'
    })
  ).toBeVisible();
});
