/**
 * Design iteration 1.132, in the browser against the built extension: a
 * review guard that the server fixes (c.Whybook.review_guard) also fixes the
 * notebook's mark of synthetic data and "Allow for this session". The status
 * says that the server fixes the guard to reject.
 *
 * No model runs: the test answers the agent's route with the events that
 * the server's guard sends when it holds back the agent's first prompt
 * (whybook/server/guard/review.py), and the session's route itself.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 180000 });

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};
const LOAD =
  'import pandas as pd\ndiary = pd.DataFrame({"patient_id": ["P042", "P187"], "age": [67, 29], "pain": [5.0, 6.5]})';
const QUESTION = 'Who has the most pain?';
const FLAGS = [
  ['identifier', 'P042'],
  ['age', 'aged 67'],
  ['health', 'diabetes']
].map(([kind, text]) => ({
  kind,
  text,
  rule: 'an identifier next to age, health',
  level: 'reject',
  by: 'rules'
}));
const HELD = {
  guard: 'privacy',
  what: 'the question and the notebook',
  flags: FLAGS,
  reason: 'an identifier next to age, health',
  masked: true
};

/** A notebook whose metadata marks its data as synthetic, opened in Whybook. */
async function openSynthetic(
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
      kernelspec: KERNELSPEC,
      whybook: { guard: { synthetic: true } }
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

/** The status says that the server fixes the guard to reject, and that a model is set up; no model runs. */
async function fixedToReject(page: IJupyterLabPageFixture): Promise<void> {
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, review_guard: 'reject', claude_available: true }
    });
  });
}

function ndjson(events: object[]): string {
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}

test.describe('1.132 a guard that the server fixes', () => {
  test('shows the notebook\'s box "synthetic" off and greyed, with "Fixed on the server", and the notebook keeps its mark', async ({
    page,
    tmpPath
  }) => {
    await fixedToReject(page);
    await openSynthetic(page, `${tmpPath}/synthetic.ipynb`);
    await page.locator('.jp-Epi-aibutton').first().click();
    const section = page.locator('.jp-Epi-guard-section');
    await expect(section).toContainText(
      'Fixed on the server, with both guards on: c.Whybook.review_guard'
    );
    const box = section.locator('#jp-Epi-guard-synthetic');
    await expect(box).not.toBeChecked();
    await expect(box).toBeDisabled();
    await expect(
      section.locator('label[for="jp-Epi-guard-synthetic"]')
    ).toHaveText(
      'The data of this notebook is synthetic: its identifiers and values may leave this machine.Fixed on the server: c.Whybook.review_guard treats the data of every notebook as real.'
    );
    // The mark stays in the notebook: it counts again on a server that does not fix the guard.
    expect(
      await page.evaluate(
        () =>
          (window as any).jupyterapp.shell.currentWidget.content.model
            .guardSynthetic
      )
    ).toBe(true);
  });

  test('offers no "Allow for this session", in the agent\'s run or in the panel\'s list of held items', async ({
    page,
    tmpPath
  }) => {
    await fixedToReject(page);
    const sessions: any[] = [];
    await page.route(/\/whybook\/guard\/session/, async route => {
      sessions.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        json: { answers: [], held: [{ ...HELD, time: Date.now() / 1000 }] }
      });
    });
    await page.route(/\/whybook\/agent(\?.*)?$/, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjson([
          { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
          { type: 'guard_held', ...HELD, background: false },
          {
            type: 'result',
            answer: 'P187 has the most pain.',
            cells: [],
            follow_up: [],
            model: 'x',
            cost_usd: 0,
            elapsed: 1
          }
        ])
      })
    );
    await openSynthetic(page, `${tmpPath}/synthetic.ipynb`);
    const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
    await own.fill(QUESTION);
    await own.press('Enter');

    const held = page.locator('.jp-Epi-agentrun-held li');
    await expect(held).toHaveCount(1, { timeout: 60000 });
    await expect(held.locator('.jp-Epi-agentrun-heldtext')).toHaveText(
      'The review guard masked parts of the question and the notebook before it went to the model: an identifier next to age, health.'
    );
    await expect(page.locator('.jp-Epi-agentrun')).toContainText(
      'P187 has the most pain.'
    );
    await expect(held.getByRole('button')).toHaveCount(0);
    await expect(held.locator('.jp-Epi-agentrun-heldallowed')).toHaveCount(0);

    await page.locator('.jp-Epi-aibutton').first().click();
    const section = page.locator('.jp-Epi-guard-section');
    await section
      .locator('.jp-Epi-guard-memory button', { hasText: '1 item held back' })
      .click();
    const listed = section.locator('.jp-Epi-guard-list li');
    await expect(listed).toHaveCount(1);
    await expect(listed).toHaveText(
      'The review guard masked parts of the question and the notebook before it went to the model: an identifier next to age, health.'
    );
    await expect(listed.getByRole('button')).toHaveCount(0);
    expect(sessions.filter(body => body.allow)).toEqual([]);
  });
});
