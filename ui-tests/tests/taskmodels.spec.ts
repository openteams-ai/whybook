/**
 * A remote model for each task (design iteration 1.81), in the AI models
 * panel, against the built extension. The status, the connection and
 * OpenRouter's list of models are answered in the page as a server with a
 * model connected through OpenRouter answers them, with the fast models of
 * whybook/server/tiers.py. No model runs: the test answers the model routes
 * it reads, and the fixture aborts the others.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

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

const TIERS = {
  fast: [
    {
      id: 'openai/gpt-6-luna',
      label: 'GPT-6 Luna',
      note: 'questions in about 7 s in the demo'
    },
    {
      id: 'z-ai/glm-5.3-flash',
      label: 'GLM 5.3 Flash',
      note: 'questions in about 12 s in the demo'
    }
  ],
  fastest: []
};

const LISTED = [
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', note: null },
  { id: 'openai/gpt-6-nano', label: 'GPT-6 Nano', note: null },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', note: null }
];

/** Answer the status, the connection and OpenRouter's models as the server would with OpenRouter connected. */
async function serve(page: Page): Promise<void> {
  await page.route(/\/whybook\/status(\?.*)?$/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: true,
        claude: CONNECTED,
        remote_model: CONNECTED.label,
        describe_tables: true,
        remote_tiers: TIERS
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
          provider: 'openrouter',
          model: CONNECTED.model,
          base_url: null,
          local: false
        },
        readiness: CONNECTED,
        providers: body.providers.map((provider: any) =>
          provider.id === 'openrouter'
            ? { ...provider, signed_in: true, key_from: 'openrouter' }
            : provider
        )
      }
    });
  });
  await page.route(/\/whybook\/connection\/models/, route =>
    route.fulfill({ json: { models: LISTED } })
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
  await expect(page.locator('.jp-Epi-bench')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0, {
    timeout: 30000
  });
}

/** A notebook whose one cell shows a saved table, wide enough to be a tile: no kernel is needed. */
async function tableNotebook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const head = Array.from({ length: 30 }, (_, c) => `<th>col_${c}</th>`);
  const rows = Array.from(
    { length: 3 },
    (_, r) =>
      `<tr><th>${r}</th>${head.map(() => '<td>a wide value</td>').join('')}</tr>`
  );
  const html =
    '<div><table border="1" class="dataframe">' +
    `<thead><tr><th></th>${head.join('')}</tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table></div>`;
  const notebook = {
    cells: [
      {
        cell_type: 'code',
        execution_count: 1,
        id: 'wide',
        metadata: {},
        source: '# wide',
        outputs: [
          {
            output_type: 'execute_result',
            execution_count: 1,
            metadata: {},
            data: { 'text/html': html, 'text/plain': 'col_0 col_1 ...' }
          }
        ]
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
}

test("offers the fast model for More questions, and a model from the provider's list for a task", async ({
  page,
  tmpPath
}) => {
  await serve(page);
  const file = `${tmpPath}/tasks.ipynb`;
  await tableNotebook(page, file);
  await openInWhybook(page, file);
  await page.locator('.jp-Epi-aibutton').click();
  const panel = page.locator('.jp-Epi-aipanel');
  await expect(panel.locator('.jp-Epi-connection')).toContainText(
    CONNECTED.label
  );

  // More questions take the fast model by default; code and answers keep the connected one.
  const questions = panel.locator('#jp-Epi-quick-questions');
  await expect(questions).toHaveValue('remote:fast');
  await expect(questions.locator('option:checked')).toHaveText(
    'GPT-6 Luna, fast'
  );
  // The fast models of the provider, in a group of their own.
  await expect(
    questions.locator('optgroup[label="Faster models of OpenRouter"] option')
  ).toHaveText(['GPT-6 Luna, fast', 'GLM 5.3 Flash, fast']);
  await expect(panel.locator('#jp-Epi-quick-cells option')).toHaveText([
    'Remote AI model: OpenRouter: anthropic/claude-sonnet-5',
    'Off'
  ]);

  // Labels and captions take a model from OpenRouter's list.
  const labels = panel.locator('#jp-Epi-quick-labels');
  await labels.selectOption('pick-remote-model');
  const picker = panel.locator('.jp-Epi-taskpicker[data-task="labels"]');
  await expect(picker).toContainText(
    'Models of OpenRouter for Labels and captions'
  );
  // The choice stays until a model is picked.
  await expect(labels).toHaveValue('remote');
  await picker.locator('select').selectOption('openai/gpt-6-nano');
  await picker
    .getByRole('button', { name: 'Use for Labels and captions' })
    .click();
  await expect(picker).toHaveCount(0);
  await expect(labels).toHaveValue('remote:openrouter:openai/gpt-6-nano');
  await expect(labels.locator('option:checked')).toHaveText(
    'openai/gpt-6-nano, OpenRouter'
  );
  const saved = await page.evaluate(async () => {
    const settings = await (
      window as any
    ).jupyterapp.serviceManager.settings.fetch('whybook:plugin');
    return settings.raw as string;
  });
  expect(saved).toContain('remote:openrouter:openai/gpt-6-nano');
});

test.describe('With a model of the provider chosen for labels', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:plugin': {
        models: {
          cells: 'remote',
          questions: 'remote:fast',
          labels: 'remote:openrouter:openai/gpt-6-nano',
          typed: 'rules',
          speech: 'off',
          ranking: 'rules'
        }
      }
    }
  });

  test("asks the task's model for the labels of a table, and shows its words", async ({
    page,
    tmpPath
  }) => {
    await serve(page);
    const asked: any[] = [];
    await page.route(/\/whybook\/tables\/describe/, async route => {
      const body = route.request().postDataJSON();
      asked.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body:
          JSON.stringify({
            type: 'result',
            elapsed: 0.2,
            tables: body.tables.map((table: { id: string }) => ({
              id: table.id,
              description: 'wide sample',
              headline: ''
            })),
            model: 'openrouter:openai/gpt-6-nano',
            cost_usd: 0.0001
          }) + '\n'
      });
    });
    const file = `${tmpPath}/labels.ipynb`;
    await tableNotebook(page, file);
    await openInWhybook(page, file);
    await expect
      .poll(() => asked.length, { timeout: 30000 })
      .toBeGreaterThan(0);
    expect(asked[0].model).toBe('remote:openrouter:openai/gpt-6-nano');
    await expect(
      page.locator('[data-cell-id="wide"] .jp-Epi-tabletile-description')
    ).toContainText('wide sample');
  });
});
