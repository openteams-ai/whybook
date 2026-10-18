/**
 * The screen "Three ways to use models" (design iteration 1.131), against the
 * built extension. The test server leaves it out by default
 * (jupyter_server_test_config.py), as Binder does: these tests turn it on in
 * their settings. The status is answered in the page as a server with the
 * local models' runtime and Gemma 4 E2B not downloaded. No model runs and
 * nothing downloads: the tests answer the model routes they read, and the
 * fixture aborts the others.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

const NO_MODEL = {
  available: false,
  cli: null,
  credential: null,
  reason: 'no model is connected',
  setup: 'Connect one in the AI models panel.',
  provider: 'none',
  model: null,
  label: 'No model connected',
  local: false
};

const CONNECTED = {
  available: true,
  cli: null,
  credential: 'OpenRouter',
  reason: null,
  setup: null,
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet-5',
  label: 'OpenRouter: anthropic/claude-sonnet-5',
  local: false,
  priced: true
};

/** A hosted model saved before the server set All local: the server refuses it. */
const REFUSED = {
  ...CONNECTED,
  available: false,
  credential: null,
  reason: 'OpenRouter runs outside this machine and its network',
  setup:
    'The server sets c.Whybook.way_to_use_models = "all-local": in the AI models panel, connect a model server on this machine or in its network.'
};

const GEMMA = {
  id: 'gemma-4-e2b',
  label: 'Gemma 4 E2B',
  kind: 'local',
  tier: 'recommended',
  size_mb: 2841,
  note: 'descriptions right for 25 of 32 test tables',
  repo: 'ggml-org/gemma-4-E2B-it-GGUF',
  path: null,
  available: false,
  reason:
    'not downloaded: hf download ggml-org/gemma-4-E2B-it-GGUF gemma-4-E2B-it-Q4_0.gguf',
  downloadable: true,
  tasks: null,
  decision: false
};

/**
 * Answer the status as a server whose local models can run, with Gemma 4
 * E2B not downloaded and `claude` as the connected model, and the
 * connection's state to match. `extra` changes what the server fixes, and
 * `state` what the connection's state says besides.
 */
async function serve(
  page: Page,
  claude: typeof NO_MODEL | typeof CONNECTED | typeof REFUSED = NO_MODEL,
  extra: Record<string, unknown> = {},
  state: Record<string, unknown> = {}
): Promise<void> {
  await page.route(/\/whybook\/status(\?.*)?$/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: claude.available,
        claude,
        remote_model: claude.available ? claude.label : null,
        describe_tables: true,
        remote_tiers: { fast: [], fastest: [] },
        local_runtime: true,
        local_models: [GEMMA],
        keep_data_local: false,
        way_to_use_models: '',
        ...extra
      }
    });
  });
  await page.route(/\/whybook\/connection(\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') {
      return route.fallback();
    }
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        connection: {
          provider: claude.provider,
          model: claude.model,
          base_url: null,
          local: false
        },
        readiness: claude,
        ...state
      }
    });
  });
  await page.route(/\/whybook\/connection\/local/, route =>
    route.fulfill({ json: { servers: [] } })
  );
}

/** A notebook of one code cell that ran, with no output: no kernel is needed. */
async function notebook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  await page.contents.uploadContent(
    JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          execution_count: 1,
          id: 'weights',
          metadata: {},
          source:
            'weights = [70.5, 81.2, 64.0]\nmean = sum(weights) / len(weights)',
          outputs: []
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
    }),
    'text',
    file
  );
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
  await expect(page.locator('.jp-Epi-bench:visible')).toBeVisible({
    timeout: 30000
  });
}

/** The settings of a plugin as the analyst saved them, read from their JSON5 by the server. */
async function saved(page: Page, plugin: string): Promise<any> {
  return await page.evaluate(async (plugin: string) => {
    const settings = await (
      window as any
    ).jupyterapp.serviceManager.settings.fetch(plugin);
    return settings.settings ?? {};
  }, plugin);
}

const SCREEN = '.jp-Epi-ways-dialog';

test.describe('With the screen at its default, when the first notebook opens', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:welcome': { when: 'notebook' }
    }
  });

  test('shows three ways once, and "Decide later" does not change a setting', async ({
    page,
    tmpPath
  }) => {
    await serve(page);
    await notebook(page, `${tmpPath}/first.ipynb`);
    await notebook(page, `${tmpPath}/second.ipynb`);
    await openInWhybook(page, `${tmpPath}/first.ipynb`);
    const screen = page.locator(SCREEN);
    await expect(screen).toBeVisible({ timeout: 30000 });
    await expect(screen.locator('.jp-Dialog-header')).toContainText(
      'Three ways to use models'
    );
    await expect(screen.locator('.jp-Epi-way-button')).toHaveText([
      'Frontier models for everything',
      'Data stays on this machine',
      'All local'
    ]);
    // "Decide later" has the focus, so that no way has it; the first way is
    // the way of the settings as they are.
    await expect(
      screen.getByRole('button', { name: 'Decide later' })
    ).toBeFocused();
    await expect(
      screen.locator('[data-way="remote"] .jp-Epi-way-mark')
    ).toHaveText(['Now']);
    await expect(screen.locator('.jp-Epi-way-mark')).toHaveCount(1);
    await expect(screen.locator('[data-way="remote"]')).toContainText(
      'The code of the cells, tables, pictures and variables'
    );
    await expect(screen.locator('[data-way="data-stays-here"]')).toContainText(
      'Gemma 4 E2B for labels and captions, a download of 2.8 GB'
    );
    await expect(screen.locator('[data-way="all-local"]')).toContainText(
      'A model server for the code, on this machine or in your network'
    );
    const before = await saved(page, 'whybook:plugin');

    await screen.getByRole('button', { name: 'Decide later' }).click();
    await expect(screen).toHaveCount(0);
    expect(await saved(page, 'whybook:plugin')).toEqual(before);
    // The show is recorded for this user, whatever the browser.
    expect(await saved(page, 'whybook:welcome')).toEqual({
      when: 'notebook',
      shown: true
    });

    // Another notebook opens: the screen stays away.
    await openInWhybook(page, `${tmpPath}/second.ipynb`);
    await expect(
      page.locator('.lm-TabBar-tab.jp-mod-current', { hasText: 'second.ipynb' })
    ).toBeVisible();
    await expect(page.locator('.jp-Epi-aibutton:visible')).toHaveCount(1);
    await expect(page.locator(SCREEN)).toHaveCount(0);
  });

  test('"Data stays on this machine" sets its settings and opens the AI models panel at the Download, which starts only when pressed', async ({
    page,
    tmpPath
  }) => {
    await serve(page);
    const downloads: unknown[] = [];
    await page.route(/\/whybook\/models\/download/, async route => {
      downloads.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body:
          JSON.stringify({
            type: 'result',
            model: 'gemma-4-e2b',
            elapsed: 0.1
          }) + '\n'
      });
    });
    await notebook(page, `${tmpPath}/local.ipynb`);
    await openInWhybook(page, `${tmpPath}/local.ipynb`);
    const screen = page.locator(SCREEN);
    await expect(screen).toBeVisible({ timeout: 30000 });
    await screen
      .getByRole('button', { name: 'Data stays on this machine' })
      .click();
    await expect(screen).toHaveCount(0);

    const panel = page.locator('.jp-Epi-aipanel');
    await expect(panel).toBeVisible();
    const download = panel.getByRole('button', { name: 'Download 2.8 GB' });
    await expect(download).toBeFocused();
    await expect(panel.locator('#jp-Epi-quick-keepDataLocal')).toBeChecked();
    await expect(panel.locator('#jp-Epi-quick-labels')).toHaveValue(
      'gemma-4-e2b'
    );
    const settings = await saved(page, 'whybook:plugin');
    expect(settings.keepDataLocal).toBe(true);
    expect(settings.models.labels).toBe('gemma-4-e2b');
    expect(settings.models.cells).toBe('remote');
    expect(downloads).toEqual([]);

    await download.click();
    await expect.poll(() => downloads).toEqual([{ model: 'gemma-4-e2b' }]);
  });

  test('does not show when the server keeps the data on this machine for every user', async ({
    page,
    tmpPath
  }) => {
    await serve(page, NO_MODEL, { keep_data_local: true });
    const answered: string[] = [];
    page.on('requestfinished', request => {
      if (/\/whybook\/status/.test(request.url())) {
        answered.push(request.url());
      }
    });
    const writes: string[] = [];
    page.on('request', request => {
      if (
        request.method() === 'PUT' &&
        request.url().includes('whybook%3Awelcome')
      ) {
        writes.push(request.url());
      }
    });
    await notebook(page, `${tmpPath}/fixed.ipynb`);
    await openInWhybook(page, `${tmpPath}/fixed.ipynb`);
    // The view reads the status, and the screen's plugin reads it too
    // before it decides.
    await expect.poll(() => answered.length).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.jp-Epi-aibutton').first()).toBeVisible();
    await expect(page.locator(SCREEN)).toHaveCount(0);
    expect(writes).toEqual([]);
  });
});

test.describe('With the screen off, as on Binder', () => {
  test('the command palette and the AI models panel open it, and Enter presses a way', async ({
    page,
    tmpPath
  }) => {
    await serve(page);
    await notebook(page, `${tmpPath}/later.ipynb`);
    await openInWhybook(page, `${tmpPath}/later.ipynb`);
    await expect(page.locator('.jp-Epi-aibutton').first()).toBeVisible();
    await expect(page.locator(SCREEN)).toHaveCount(0);

    // The command palette, in the category Whybook.
    await page.evaluate(() =>
      (window as any).jupyterapp.commands
        .execute('apputils:activate-command-palette')
        .then(() => null)
    );
    const search = page.locator('#command-palette .lm-CommandPalette-input');
    await expect(search).toBeVisible();
    await search.fill('three ways');
    const item = page.locator('#command-palette .lm-CommandPalette-item', {
      hasText: 'Three ways to use models'
    });
    await expect(item).toHaveCount(1);
    await expect(
      page.locator('#command-palette .lm-CommandPalette-header', {
        hasText: 'Whybook'
      })
    ).toHaveCount(1);
    await item.click();
    const screen = page.locator(SCREEN);
    await expect(screen).toBeVisible();
    // The dialog gives "Decide later" the focus as it opens. Wait for that, so
    // that the focus moved to a way below is not taken back before Enter.
    await expect(
      screen.getByRole('button', { name: 'Decide later' })
    ).toBeFocused();

    // Enter on a way presses it: no model is connected, so the AI models
    // panel opens at the list of providers.
    const frontier = screen.getByRole('button', {
      name: 'Frontier models for everything'
    });
    await frontier.focus();
    await expect(frontier).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(screen).toHaveCount(0);
    const panel = page.locator('.jp-Epi-aipanel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.jp-Epi-connection-group')).toHaveText([
      'On this machine',
      'Sign in',
      'With an API key',
      'Other'
    ]);
    const settings = await saved(page, 'whybook:plugin');
    expect(settings.keepDataLocal).toBe(false);
    expect(settings.models.labels).toBe('remote:fastest');

    // The link at the end of the AI models panel; Escape decides later.
    await panel
      .getByRole('button', { name: 'Three ways to use models' })
      .click();
    await expect(panel).toHaveCount(0);
    await expect(screen).toBeVisible();
    // The dialog takes the focus once the panel has given it back.
    await expect(
      screen.getByRole('button', { name: 'Decide later' })
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(screen).toHaveCount(0);
    expect(await saved(page, 'whybook:plugin')).toEqual(settings);
  });
});

test.describe('With the server at All local', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:welcome': { when: 'notebook' }
    }
  });

  test('the screen does not show by itself and greys the other ways, and the AI models panel says why a hosted model cannot run', async ({
    page,
    tmpPath
  }) => {
    await serve(
      page,
      REFUSED,
      { keep_data_local: true, way_to_use_models: 'all-local' },
      { network_only: true }
    );
    await notebook(page, `${tmpPath}/all-local.ipynb`);
    await openInWhybook(page, `${tmpPath}/all-local.ipynb`);
    await expect(page.locator('.jp-Epi-aibutton').first()).toBeVisible();
    await expect(page.locator(SCREEN)).toHaveCount(0);

    // The command palette opens it: the server sets the way.
    await page.evaluate(() => {
      void (window as any).jupyterapp.commands.execute('whybook:three-ways');
    });
    const screen = page.locator(SCREEN);
    await expect(screen).toBeVisible();
    await expect(screen.locator('.jp-Epi-way-button:disabled')).toHaveText([
      'Frontier models for everything',
      'Data stays on this machine'
    ]);
    await expect(
      screen.locator('[data-way="remote"] .jp-Epi-way-blocked')
    ).toHaveText(
      'The server sets the way for every user: c.Whybook.way_to_use_models = "all-local".'
    );
    await expect(
      screen.getByRole('button', { name: 'Decide later' })
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(screen).toHaveCount(0);

    // The AI models panel: why the hosted model cannot run, and only the
    // servers on this machine or in its network to choose from.
    await page.locator('.jp-Epi-aibutton:visible').first().click();
    const panel = page.locator('.jp-Epi-aipanel');
    await expect(panel).toContainText(
      'Cannot run: OpenRouter runs outside this machine and its network.'
    );
    await expect(panel.locator('#jp-Epi-quick-keepDataLocal')).toBeDisabled();
    await expect(panel).toContainText(
      'Fixed on the server: c.Whybook.way_to_use_models = "all-local"'
    );
    await panel
      .locator('.jp-Epi-connection-head')
      .getByRole('button', { name: 'Connect a model' })
      .click();
    await expect(panel.locator('.jp-Epi-connection-group')).toHaveText([
      'On this machine',
      'Other'
    ]);
    await expect(panel.locator('.jp-Epi-connection-network')).toContainText(
      'Sign-ins and API keys of hosted providers are off'
    );
  });
});

test.describe('With the screen before the first call to a model', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:welcome': { when: 'call' }
    }
  });

  test('holds the first call until a way is chosen, and the call goes with that way', async ({
    page,
    tmpPath
  }) => {
    await serve(page, CONNECTED);
    const titles: any[] = [];
    await page.route(/\/whybook\/cells\/title/, async route => {
      const body = route.request().postDataJSON();
      titles.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body:
          JSON.stringify({
            type: 'result',
            elapsed: 0.1,
            titles: body.cells.map((cell: { id: string }) => ({
              id: cell.id,
              title: 'Mean of three weights'
            })),
            model: 'openrouter:google/gemini-3.5-flash-lite',
            cost_usd: 0.0001
          }) + '\n'
      });
    });
    await notebook(page, `${tmpPath}/call.ipynb`);
    await openInWhybook(page, `${tmpPath}/call.ipynb`);
    // The view asks for the title of the cell a moment after it opens: the
    // screen shows first, and the request waits for it.
    const screen = page.locator(SCREEN);
    await expect(screen).toBeVisible({ timeout: 30000 });
    expect(titles).toEqual([]);
    expect(await saved(page, 'whybook:welcome')).toEqual({
      when: 'call',
      shown: true
    });

    await screen
      .getByRole('button', { name: 'Data stays on this machine' })
      .click();
    await expect.poll(() => titles.length).toBe(1);
    // The request goes with the data policy of the way chosen.
    expect(titles[0].keep_data_local).toBe(true);
  });
});
