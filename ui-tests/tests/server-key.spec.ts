/**
 * Design iteration 1.133, in the browser against the built extension and
 * the test server: a key typed for a model server can be forgotten, with
 * Forget key under the connected model. The test saves a connection to a
 * server at a URL where nothing listens, with a key typed for it and no
 * check, as "Save without a check" does; no request reaches a model or a
 * model server.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};
// Nothing listens on port 9 of this machine.
const SERVER = 'http://127.0.0.1:9/v1';

async function openInWhybook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const notebook = {
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        id: 'cell-0',
        metadata: {},
        outputs: [],
        source: 'x = 1'
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
  await expect(page.locator('.jp-Epi-bench')).toBeVisible({ timeout: 30000 });
}

test.describe('1.133 a key typed for a model server', () => {
  test('shows under the connected model with Forget key, which deletes it on the server', async ({
    page,
    tmpPath
  }) => {
    // The test server's own requests, past the page: the connection and the
    // key go to the server's data folder, and the server asks no model
    // server, since the key is saved without a check.
    const saved = await page.request.post('/whybook/connection', {
      data: {
        provider: 'openai-compatible',
        base_url: SERVER,
        local: true,
        model: 'qwen3-8b',
        key: 'sk-galata-typed-0000000000000000',
        check: false
      }
    });
    expect(saved.ok()).toBe(true);
    try {
      await openInWhybook(page, `${tmpPath}/key.ipynb`);
      await page.locator('.jp-Epi-aibutton').first().click();
      const section = page.locator('.jp-Epi-aipanel .jp-Epi-connection');
      await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
        `Server at ${SERVER}: qwen3-8b`
      );
      const key = section.locator('.jp-Epi-connection-key');
      await expect(key.locator('.jp-Epi-provider-note')).toHaveText(
        /^Key saved on \d{1,2} [A-Z][a-z]{2}$/
      );
      // The key was saved without a check: the line under it says so, as before.
      await expect(section).toContainText(
        'The saved key is not checked yet: the first answer checks it.'
      );
      await key.getByRole('button', { name: 'Forget key' }).click();
      await expect(key).toHaveCount(0);
      // The server stays connected, without a key, and the focus goes to Change.
      await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
        `Server at ${SERVER}: qwen3-8b`
      );
      await expect(section).not.toContainText('The saved key');
      await expect(
        section.locator('.jp-Epi-connection-head button', { hasText: 'Change' })
      ).toBeFocused();
      const state = await (
        await page.request.get('/whybook/connection')
      ).json();
      expect(state.connection.base_url).toBe(SERVER);
      expect(state.connected_key).toBeNull();
    } finally {
      // The other tests of the run were written for the Claude Code login.
      await page.request.post('/whybook/auth/signout', {
        data: { provider: 'openai-compatible', base_url: SERVER }
      });
      await page.request.post('/whybook/connection', {
        data: { provider: 'claude-code', model: null }
      });
    }
  });
});
