/**
 * Design iteration 1.45, the review guard, in the browser against the built
 * extension: the dialog that asks before a prompt leaves this machine, the
 * box of an agent's run in reject mode, and the guard's section of the AI
 * models panel.
 *
 * No model runs: each test answers the agent's route with the events that
 * the server's guard sends (whybook/server/guard/review.py), and the answer
 * and session routes itself.
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
  'import pandas as pd\ndiary = pd.DataFrame({"patient_id": ["P042", "P187"], "age": [41, 29], "pain": [5.0, 6.5]})';
const QUESTION = 'Who has the most pain?';
const AGE_FLAGS = [
  {
    kind: 'identifier',
    text: 'P042',
    rule: 'an identifier next to age',
    level: 'reject',
    by: 'rules'
  },
  {
    kind: 'age',
    text: 'age 41',
    rule: 'an identifier next to age',
    level: 'reject',
    by: 'rules'
  }
];

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
    metadata: { kernelspec: KERNELSPEC },
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

function ndjson(events: object[]): string {
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}

async function ask(page: IJupyterLabPageFixture): Promise<void> {
  const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
  await own.fill(QUESTION);
  await own.press('Enter');
}

test.describe('1.45 the review guard', () => {
  test('asks before a prompt leaves this machine, with the flagged parts marked and no line numbers, and posts the answer', async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const bodies: any[] = [];
    const answers: any[] = [];
    await page.route(/\/whybook\/guard\/answer/, async route => {
      answers.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, json: { ok: true } });
    });
    await page.route(/\/whybook\/agent(\?.*)?$/, route => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjson([
          { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
          {
            type: 'guard',
            id: 'q1',
            guard: 'privacy',
            what: 'the result of [2]',
            decision: 'reject',
            flags: AGE_FLAGS,
            reason: 'an identifier next to age',
            text: '{"status": "ok", "text": "P042, age 41"}',
            masked: '{"status": "ok", "text": "[identifier], [age]"}',
            sandboxed: false,
            choices: ['send', 'mask', 'stop'],
            to: 'OpenRouter: x'
          },
          {
            type: 'result',
            answer: 'P042 has the most pain.',
            cells: [],
            follow_up: [],
            model: 'x',
            cost_usd: 0,
            elapsed: 1
          }
        ])
      });
    });
    await openNotebook(page, `${tmpPath}/guard.ipynb`);
    await ask(page);

    const dialog = page.locator('.jp-Dialog');
    await expect(dialog.locator('.jp-Dialog-header')).toHaveText(
      'Send this to a model on another machine?'
    );
    await expect(dialog.locator('.jp-Epi-guard-lead')).toContainText(
      'The result of [2] would go to OpenRouter: x, a model on another machine.'
    );
    await expect(dialog.locator('.jp-Epi-guard-findings li')).toHaveText([
      'Likely wrong: an identifier next to age. Flagged: P042, age 41. Found by the rules.'
    ]);
    await expect(dialog.locator('mark')).toHaveText(['P042', 'age 41']);
    // The text shows as it would leave, without line numbers.
    await expect(dialog.locator('.jp-Epi-guard-text')).toHaveText(
      '{"status": "ok", "text": "P042, age 41"}'
    );
    await expect(dialog.locator('.jp-Epi-lineno')).toHaveCount(0);
    await dialog
      .locator('.jp-Epi-guard-why textarea')
      .fill('These are study IDs of outliers');
    await dialog
      .getByRole('button', { name: 'Send without the marked parts' })
      .click();
    await expect
      .poll(() => answers)
      .toEqual([
        {
          id: 'q1',
          answer: 'mask',
          note: 'These are study IDs of outliers'
        }
      ]);
    await expect(dialog).toHaveCount(0);
    // The request carried the guard's choices and the notebook's kernel.
    expect(bodies[0].guard).toMatchObject({
      mode: 'ask',
      privacy: true,
      execution: true,
      sandboxed: false
    });
    expect(bodies[0].guard.session).toMatch(/^view-/);
  });

  test("in reject mode, lists what the guard held back in the run's strip, and allows it for the session", async ({
    page,
    tmpPath
  }) => {
    await connected(page);
    const sessions: any[] = [];
    await page.route(/\/whybook\/guard\/session/, async route => {
      sessions.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, json: { answers: [], held: [] } });
    });
    await page.route(/\/whybook\/agent(\?.*)?$/, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjson([
          { type: 'started', run: 'r1', keep_local: false, elapsed: 0 },
          {
            type: 'guard_held',
            guard: 'execution',
            what: 'a cell',
            flags: [
              {
                kind: 'network',
                text: 'pd.read_csv("https://data.example.org/norms.csv")',
                rule: 'reaches the network',
                level: 'reject',
                by: 'rules'
              }
            ],
            reason: 'reaches the network',
            masked: false
          },
          {
            type: 'result',
            answer: 'Without the norms.',
            cells: [],
            follow_up: [],
            model: 'x',
            cost_usd: 0,
            elapsed: 1
          }
        ])
      })
    );
    await openNotebook(page, `${tmpPath}/guard.ipynb`);
    await page.evaluate(() =>
      (
        window as any
      ).jupyterapp.shell.currentWidget.content.model.settings.setGuard({
        mode: 'reject'
      })
    );
    await ask(page);

    const held = page.locator('.jp-Epi-agentrun-held li');
    await expect(held).toHaveCount(1, { timeout: 60000 });
    await expect(held.locator('.jp-Epi-agentrun-heldtext')).toHaveText(
      'The review guard did not run a cell: it reaches the network.'
    );
    // A notice says so too.
    await expect(
      page.locator('.Toastify__toast', { hasText: 'did not run a cell' })
    ).toBeVisible();
    await held.getByRole('button', { name: 'Allow for this session' }).click();
    await expect(held.locator('.jp-Epi-agentrun-heldallowed')).toHaveText(
      'Allowed for this session'
    );
    const allowed = sessions.find(body => body.allow);
    expect(allowed.allow.guard).toBe('execution');
    expect(allowed.allow.flags[0].text).toBe(
      'pd.read_csv("https://data.example.org/norms.csv")'
    );
  });

  test('the AI models panel says what each choice of the guard does, and keeps the mode', async ({
    page,
    tmpPath
  }) => {
    await openNotebook(page, `${tmpPath}/guard.ipynb`);
    await page.locator('.jp-Epi-aibutton').first().click();
    const section = page.locator('.jp-Epi-guard-section');
    await expect(section.locator('.jp-Epi-guard-mode')).toHaveText(
      'Ask: the guard shows you what it flagged, and the work waits for your answer.'
    );
    await expect(section.locator('legend')).toHaveText([
      'Data privacy: what leaves this machine',
      'Execution safety: code that the AI wrote'
    ]);
    await expect(
      section.locator('label[for="jp-Epi-guard-privacy"]')
    ).toContainText(
      'Check every prompt before it goes to a model on another machine.'
    );
    // The notebook's kernel runs outside the sandbox: the guard says so.
    await expect(section.locator('.jp-Epi-guard-kernel')).toContainText(
      'runs outside the sandbox'
    );
    await section.getByRole('radio', { name: 'Reject' }).click();
    await expect(section.locator('.jp-Epi-guard-mode')).toContainText(
      'Reject: the guard holds back what it flagged'
    );
    expect(
      await page.evaluate(
        () =>
          (window as any).jupyterapp.shell.currentWidget.content.model.settings
            .guard.mode
      )
    ).toBe('reject');
  });

  test('a mode that the server sets keeps both guards on, and the panel locks their check boxes', async ({
    page,
    tmpPath
  }) => {
    await page.route(/\/whybook\/status/, async route => {
      const response = await route.fetch();
      const status = await response.json();
      await route.fulfill({
        response,
        json: { ...status, review_guard: 'reject' }
      });
    });
    await openNotebook(page, `${tmpPath}/guard.ipynb`);
    // The analyst turned both guards off before the server set the mode.
    await page.evaluate(() =>
      (
        window as any
      ).jupyterapp.shell.currentWidget.content.model.settings.setGuard({
        privacy: false,
        execution: false
      })
    );
    await page.locator('.jp-Epi-aibutton').first().click();
    const section = page.locator('.jp-Epi-guard-section');
    await expect(section.locator('.jp-Epi-guard-mode')).toContainText(
      'Reject: the guard holds back what it flagged'
    );
    await expect(section).toContainText(
      'Fixed on the server, with both guards on: c.Whybook.review_guard'
    );
    for (const id of ['#jp-Epi-guard-privacy', '#jp-Epi-guard-execution']) {
      await expect(section.locator(id)).toBeChecked();
      await expect(section.locator(id)).toBeDisabled();
    }
  });
});
