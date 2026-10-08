/**
 * Zero data retention on OpenRouter as the analyst's choice (design
 * iteration 1.80), in the AI models panel and the settings editor, against
 * the built extension. The status and the connection are answered in the
 * page as a server with a model connected through OpenRouter answers them,
 * with or without the server's lock (c.Whybook.openrouter_zdr). No model
 * runs: the test answers the model routes it reads, and the fixture aborts
 * the others.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

/** The connected model through OpenRouter, as whybook/server/connection.py reads it. */
const OPENROUTER = {
  available: true,
  cli: null,
  credential: 'OpenRouter',
  reason: null,
  setup: null,
  provider: 'openrouter',
  model: 'openai/gpt-6',
  label: 'OpenRouter: openai/gpt-6',
  local: false,
  priced: true
};

const ANTHROPIC = {
  ...OPENROUTER,
  credential: 'Anthropic',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  label: 'Anthropic: claude-sonnet-5'
};

/**
 * Answer the status and the connection as the server would with this model
 * connected, OpenRouter signed in when the model is OpenRouter's, and zero
 * data retention pinned when `fixed` is set. Each body that the view sends
 * for OpenRouter's models is kept.
 */
async function serve(
  page: Page,
  server: { connected: typeof OPENROUTER; fixed: boolean },
  listed: any[] = []
): Promise<void> {
  await page.route(/\/whybook\/status(\?.*)?$/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: true,
        claude: server.connected,
        remote_model: server.connected.label,
        describe_tables: true,
        openrouter_zdr: server.fixed
      }
    });
  });
  await page.route(/\/whybook\/connection(\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') {
      return route.fallback();
    }
    const response = await route.fetch();
    const body = await response.json();
    const openRouter = server.connected.provider === 'openrouter';
    await route.fulfill({
      response,
      json: {
        ...body,
        connection: {
          provider: server.connected.provider,
          model: server.connected.model,
          base_url: null,
          local: false
        },
        readiness: server.connected,
        providers: body.providers.map((provider: any) =>
          provider.id === server.connected.provider ||
          (provider.id === 'openrouter' && openRouter)
            ? {
                ...provider,
                signed_in: true,
                key_from: provider.id === 'openrouter' ? 'openrouter' : 'typed'
              }
            : provider
        )
      }
    });
  });
  await page.route(/\/whybook\/connection\/models/, async route => {
    listed.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        models: [{ id: 'openai/gpt-6', label: 'GPT-6', note: null }]
      }
    });
  });
}

async function newNotebook(
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
  await expect(page.locator('.jp-Epi-bench')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0, {
    timeout: 30000
  });
}

/** The AI models panel, open, once it shows the connected model. */
async function openPanel(page: IJupyterLabPageFixture, label: string) {
  await page.locator('.jp-Epi-aibutton').click();
  const panel = page.locator('.jp-Epi-aipanel');
  await expect(panel.locator('.jp-Epi-connection')).toContainText(label);
  return panel;
}

/** A setting of the view, saved as the panel saves it. */
async function setSetting(
  page: IJupyterLabPageFixture,
  key: string,
  value: unknown
): Promise<void> {
  await page.evaluate(
    ([key, value]) =>
      (window as any).jupyterapp.shell.currentWidget.content.model.settings.set(
        key,
        value
      ),
    [key, value] as [string, unknown]
  );
}

test('the box is on by default and usable while the server leaves it to the analyst, and the requests follow it', async ({
  page,
  tmpPath
}) => {
  const listed: any[] = [];
  await serve(page, { connected: OPENROUTER, fixed: false }, listed);
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
  const file = `${tmpPath}/zdr.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  const panel = await openPanel(page, 'OpenRouter: openai/gpt-6');
  const box = panel.locator('#jp-Epi-quick-zeroDataRetention');
  // Beside "Keep data on this machine", in its block.
  await expect(
    panel.locator('.jp-Epi-policies input[type="checkbox"]')
  ).toHaveCount(2);
  await expect(box).toBeChecked();
  await expect(box).toBeEnabled();
  await expect(panel).not.toContainText('c.Whybook.openrouter_zdr');

  // OpenRouter's models, listed with zero data retention.
  await panel.getByRole('button', { name: 'Change' }).click();
  await panel
    .locator('.jp-Epi-provider[data-provider="openrouter"]')
    .getByRole('button', { name: 'Models' })
    .click();
  await expect.poll(() => listed.length).toBe(1);
  expect(listed[0]).not.toHaveProperty('zero_data_retention');

  // Turned off: the setting is saved, and the list of models is read again
  // without the filter.
  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect.poll(() => listed.length).toBe(2);
  expect(listed[1].zero_data_retention).toBe(false);
  const saved = await page.evaluate(async () => {
    const settings = await (
      window as any
    ).jupyterapp.serviceManager.settings.fetch('whybook:plugin');
    return settings.raw as string;
  });
  // The saved text holds comments: the key is read from it as text.
  expect(saved).toMatch(/"zeroDataRetention":\s*false/);
  await page.keyboard.press('Escape');

  // A question for one cell asks for every provider.
  await setSetting(page, 'answers', 'cell');
  const own = page.locator('.jp-Epi-exploration .jp-Epi-own textarea');
  await own.fill('What is twice x?');
  await own.press('Enter');
  // The view reads the kernel's packages before its first request to a model.
  await expect.poll(() => solved.length, { timeout: 60000 }).toBe(1);
  expect(solved[0].zero_data_retention).toBe(false);
});

test('the box is on and greyed, with the reason, while the server pins it, in the panel and in the settings editor', async ({
  page,
  tmpPath
}) => {
  const listed: any[] = [];
  await serve(page, { connected: OPENROUTER, fixed: true }, listed);
  const file = `${tmpPath}/zdr-fixed.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  // The analyst's setting says off: the server's lock has the last word.
  await setSetting(page, 'zeroDataRetention', false);
  const panel = await openPanel(page, 'OpenRouter: openai/gpt-6');
  const box = panel.locator('#jp-Epi-quick-zeroDataRetention');
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  await expect(panel.locator('.jp-Epi-retention')).toContainText(
    'Fixed on the server: c.Whybook.openrouter_zdr'
  );
  // OpenRouter's models, listed with zero data retention all the same.
  await panel.getByRole('button', { name: 'Change' }).click();
  await panel
    .locator('.jp-Epi-provider[data-provider="openrouter"]')
    .getByRole('button', { name: 'Models' })
    .click();
  await expect.poll(() => listed.length).toBe(1);
  expect(listed[0]).not.toHaveProperty('zero_data_retention');
  await page.keyboard.press('Escape');

  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('settingeditor:open', {
      query: 'Whybook'
    });
  });
  const field = page.locator('#jp-Epi-settings-zeroDataRetention');
  // The editor lists the plugins that match; the view's settings open on a click.
  const entry = page
    .locator('.jp-PluginList-entry', { hasText: 'Whybook' })
    .first();
  await expect(field.or(entry).first()).toBeVisible({ timeout: 30000 });
  if (!(await field.isVisible())) {
    await entry.click();
  }
  await expect(field).toBeChecked({ timeout: 30000 });
  await expect(field).toBeDisabled();
  await expect(page.locator('.jp-Epi-retentionfield')).toContainText(
    'Fixed on the server: c.Whybook.openrouter_zdr'
  );
  // Its name once, on the box, and the schema's description under it.
  const form = page.locator('.jp-SettingsForm', { has: field });
  await expect(
    form.getByText('Zero data retention (OpenRouter)', { exact: true })
  ).toHaveCount(1);
  await expect(
    form.getByText(/keep neither the prompt nor the answer/)
  ).toHaveCount(1);
});

test('the box is not in the panel without an OpenRouter connection', async ({
  page,
  tmpPath
}) => {
  await serve(page, { connected: ANTHROPIC, fixed: false });
  const file = `${tmpPath}/zdr-elsewhere.ipynb`;
  await newNotebook(page, file, ['x = 21']);
  await openInWhybook(page, file);
  const panel = await openPanel(page, 'Anthropic: claude-sonnet-5');
  await expect(panel.locator('#jp-Epi-quick-keepDataLocal')).toBeVisible();
  await expect(panel.locator('#jp-Epi-quick-zeroDataRetention')).toHaveCount(0);
});
