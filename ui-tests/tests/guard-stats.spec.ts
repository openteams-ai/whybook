/**
 * Design iteration 1.96, a privacy guard that tells a table of statistics
 * from a person, in the browser against the built extension. The server's
 * rules count a number next to a column's name as the column's value only
 * when the column can hold it, so the view sends the range and the tag of
 * each column that the kernel lists with every request that can reach a
 * model. The rules themselves are checked in pytest
 * (whybook/server/tests/test_guard_statistics.py).
 *
 * No model runs: the test answers the agent's route itself.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 180000 });

// The first rows of NHEFS, as the video's notebook loads them.
const LOAD = [
  'import pandas as pd',
  'nhefs = pd.DataFrame({',
  '    "seqn": [233, 235, 244],',
  '    "age": [42, 36, 56],',
  '    "sex": [0, 0, 1],',
  '    "income": [19.0, 18.0, None],',
  '    "visit": pd.to_datetime(["1971-01-04", "1971-02-01", "1971-03-01"]),',
  '})'
].join('\n');

async function openNotebook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const notebook = {
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        id: 'load',
        metadata: {},
        outputs: [],
        source: LOAD
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
  await page.evaluate(async (file: string) => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: file,
      factory: 'Whybook'
    });
  }, file);
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

test.describe('1.96 a privacy guard that tells a table of statistics from a person', () => {
  test("an agent's request carries the range and the tag of each column that the kernel lists", async ({
    page,
    tmpPath
  }) => {
    // The status says that a model is set up; no model runs.
    await page.route(/\/whybook\/status/, async route => {
      const response = await route.fetch();
      const status = await response.json();
      await route.fulfill({
        response,
        json: { ...status, claude_available: true }
      });
    });
    const bodies: any[] = [];
    await page.route(/\/whybook\/agent(\?.*)?$/, route => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body:
          [
            { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
            {
              type: 'result',
              answer: 'Age and sex differ between the groups.',
              cells: [],
              follow_up: [],
              model: 'x',
              cost_usd: 0,
              elapsed: 1
            }
          ]
            .map(event => JSON.stringify(event))
            .join('\n') + '\n'
      });
    });
    await openNotebook(page, `${tmpPath}/nhefs.ipynb`);
    await page.evaluate(async () => {
      const model = (window as any).jupyterapp.shell.currentWidget.content
        .model;
      model.settings.set('answers', 'agent');
      await model.runAll();
    });
    // The view lists the frame once the kernel has run its cell.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).jupyterapp.shell.currentWidget.content.model
              .variables()
              .find((variable: any) => variable.name === 'nhefs')?.columns
              ?.length ?? 0
        )
      )
      .toBe(5);

    const own = page
      .locator('.jp-Epi-exploration .jp-Epi-own')
      .getByRole('textbox');
    await own.fill('What else could explain both qsmk and wt82_71?');
    await own.press('Enter');
    await expect.poll(() => bodies.length).toBe(1);

    const columns = Object.fromEntries(
      bodies[0].guard.dataset.columns.map((column: any) => [
        column.name,
        column
      ])
    );
    expect(columns.seqn).toEqual({
      name: 'seqn',
      tag: 'int',
      min: 233,
      max: 244
    });
    expect(columns.age).toEqual({ name: 'age', tag: 'int', min: 36, max: 56 });
    expect(columns.sex).toEqual({ name: 'sex', tag: 'int', min: 0, max: 1 });
    expect(columns.income).toEqual({
      name: 'income',
      tag: 'num',
      min: 18,
      max: 19
    });
    // A date's range is text, and stays out: the rules compare numbers.
    expect(columns.visit.tag).toBe('date');
    expect(columns.visit).not.toHaveProperty('min');
    expect(columns.visit).not.toHaveProperty('max');
  });
});
