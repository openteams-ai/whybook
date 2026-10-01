/**
 * A key is checked before it is saved (design iteration 1.57), in the AI
 * models panel, against the built extension. Each test answers the routes
 * of the connection and of the keys itself, with the server's own words: no
 * key leaves the page for a provider, and no model is called.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator, Route } from '@playwright/test';

import { expect, test } from './fixtures';

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

// Days of this year, so that the panel writes them without a year.
const YEAR = new Date().getFullYear();
const SAVED = `${YEAR}-09-27T12:00:00Z`;
const TODAY = `${YEAR}-09-30T12:00:00Z`;
const GPU = 'http://gpu-server:8000/v1';

/** Write a notebook of code cells with the ids `cell-0`, `cell-1` and so on. */
async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  sources: string[]
): Promise<void> {
  const notebook = {
    cells: sources.map((source, index) => ({
      cell_type: 'code',
      execution_count: null,
      id: `cell-${index}`,
      metadata: {},
      outputs: [],
      source
    })),
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
  // A machine busy with other builds can take longer than the default 5 s
  // to show a view.
  await expect(page.locator('.jp-Epi-bench')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0, {
    timeout: 30000
  });
}

/** A provider with a pasted key, as whybook/server/routes.py lists it. */
interface IKey {
  saved: string;
  checked: boolean;
  refused: string | null;
}

/** An answer that a test gives to one request, held until `hold` resolves. */
interface IAnswer {
  status: number;
  json: unknown;
  hold?: Promise<void>;
}

/**
 * The server's side of the panel: the connection, the keys of Mistral AI
 * and of a server at a URL, and the answers the test queues for each POST.
 * Each request's body is kept, by route.
 */
class FakeServer {
  mistral: IKey | null = null;
  connection: Record<string, unknown> = {
    provider: 'none',
    model: null,
    base_url: null,
    local: false
  };
  connectedKey: IKey | null = null;
  sent: Record<string, any[]> = { key: [], models: [], connection: [] };
  queued: Record<string, IAnswer[]> = { key: [], models: [], connection: [] };

  state(): unknown {
    const connected = this.connection.provider !== 'none';
    const label =
      this.connection.provider === 'openai-compatible'
        ? `Server at ${this.connection.base_url as string}: ${this.connection.model as string}`
        : `Mistral AI: ${this.connection.model as string}`;
    return {
      connection: this.connection,
      readiness: connected
        ? {
            available: true,
            cli: null,
            credential: 'x',
            reason: null,
            setup: null,
            provider: this.connection.provider,
            model: this.connection.model,
            label,
            local: false
          }
        : {
            available: false,
            cli: null,
            credential: null,
            reason: 'no model is connected',
            setup: 'Connect one in the AI models panel.',
            provider: 'none',
            model: null,
            label: 'No model connected',
            local: false
          },
      connected_key: this.connectedKey,
      providers: [
        {
          id: 'mistral',
          label: 'Mistral AI',
          local: false,
          base_url: 'https://api.mistral.ai',
          signin: null,
          needs_key: true,
          dev_only: false,
          signed_in: !!this.mistral,
          key_from: this.mistral ? 'typed' : null,
          saved: this.mistral?.saved ?? null,
          checked: this.mistral ? this.mistral.checked : null,
          refused: this.mistral?.refused ?? null,
          installed: true
        }
      ],
      huggingface_signin: false,
      models_installed: true
    };
  }

  async install(page: IJupyterLabPageFixture): Promise<void> {
    const answer = async (route: Route, name: string) => {
      const body = route.request().postDataJSON();
      this.sent[name].push(body);
      const next = this.queued[name].shift() ?? {
        status: 500,
        json: { message: `the test queued no answer for ${name}` }
      };
      await next.hold;
      await route.fulfill({ status: next.status, json: next.json });
    };
    await page.route(/\/whybook\/connection(\?.*)?$/, route =>
      route.request().method() === 'POST'
        ? answer(route, 'connection')
        : route.fulfill({ json: this.state() })
    );
    await page.route(/\/whybook\/connection\/models/, route =>
      answer(route, 'models')
    );
    await page.route(/\/whybook\/connection\/local/, route =>
      route.fulfill({ json: { servers: [] } })
    );
    await page.route(/\/whybook\/auth\/key(\?|$)/, route =>
      answer(route, 'key')
    );
  }

  /** Queue an answer, which the server's state gives when `state` is set. */
  queue(name: string, answer: IAnswer): void {
    this.queued[name].push(answer);
  }
}

/** A check of a key that failed, as check_failed in whybook/server/routes.py answers it. */
function failed(
  message: string,
  check: 'refused' | 'unchecked',
  saved: string | null = null
): IAnswer {
  return { status: 409, json: { message, check, saved } };
}

/** A promise that the test resolves, for an answer that waits on the test. */
function gate(): { closed: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const closed = new Promise<void>(resolve => (open = resolve));
  return { closed, open };
}

async function openPanel(
  page: IJupyterLabPageFixture,
  tmpPath: string
): Promise<Locator> {
  await newNotebook(page, `${tmpPath}/keys.ipynb`, ['x = 1']);
  await openInWhybook(page, `${tmpPath}/keys.ipynb`);
  await page.locator('.jp-Epi-aibutton').click();
  const section = page.locator('.jp-Epi-aipanel .jp-Epi-connection');
  await section.locator('.jp-Epi-connection-head button').last().click();
  await expect(section.locator('.jp-Epi-ownserver')).toBeVisible();
  return section;
}

function row(section: Locator, provider: string): Locator {
  return section.locator(`.jp-Epi-provider[data-provider="${provider}"]`);
}

test("checks a new key before it takes the saved key's place: locked while checked, refused with Try again and Save anyway", async ({
  page,
  tmpPath
}) => {
  const fake = new FakeServer();
  fake.mistral = { saved: SAVED, checked: true, refused: null };
  await fake.install(page);
  const section = await openPanel(page, tmpPath);
  const mistral = row(section, 'mistral');
  await expect(mistral).toContainText('Mistral models: key saved on 27 Sep');
  await expect(mistral.getByRole('button')).toHaveText([
    'Models',
    'Replace key',
    'Forget key'
  ]);

  // A new key, which the provider refuses at first: it made it a minute ago.
  const check = gate();
  fake.queue('key', {
    ...failed('Mistral AI refused this key (HTTP 401)', 'refused', SAVED),
    hold: check.closed
  });
  await mistral.getByRole('button', { name: 'Replace key' }).click();
  const form = section.getByRole('form', { name: 'Key of Mistral AI' });
  const field = form.getByLabel(/A new Mistral AI API key/);
  await field.fill('made-a-minute-ago');
  await form.getByRole('button', { name: 'Save key' }).click();
  // While it is checked: the field is locked, and nothing is saved yet.
  await expect(form.getByRole('status')).toHaveText(
    'Checking the key with Mistral AI: it lists its models with it, at no cost. Nothing is saved until the check passes, and the key saved on 27 Sep stays in use.'
  );
  await expect(field).not.toBeEditable();
  await expect(form.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  await expect
    .poll(() => fake.sent.key)
    .toEqual([{ provider: 'mistral', key: 'made-a-minute-ago' }]);
  check.open();

  // Refused: the key stays in the field, and the saved key in use.
  await expect(form.getByRole('alert')).toHaveText(
    'Mistral AI refused this key (HTTP 401). Nothing changed: the key saved on 27 Sep stays in use.'
  );
  await expect(field).toHaveValue('made-a-minute-ago');
  await expect(field).toBeEditable();
  await expect(form.getByRole('button')).toHaveText([
    'Try again',
    'Save anyway'
  ]);
  await expect(mistral).toContainText('Mistral models: key saved on 27 Sep');

  // A minute later the provider takes it: the row says when it was saved,
  // and the models open under the row.
  fake.queue('models', {
    status: 200,
    json: {
      models: [
        {
          id: 'mistral-medium-latest',
          label: 'mistral-medium-latest',
          note: null
        }
      ]
    }
  });
  fake.mistral = { saved: TODAY, checked: true, refused: null };
  fake.queue('key', { status: 200, json: fake.state() });
  await form.getByRole('button', { name: 'Try again' }).click();
  await expect(mistral).toContainText('Mistral models: key saved on 30 Sep');
  await expect(form).toHaveCount(0);
  await expect(
    section.locator('.jp-Epi-modelpicker[data-provider="mistral"]')
  ).toBeVisible();
  expect(fake.sent.key).toEqual([
    { provider: 'mistral', key: 'made-a-minute-ago' },
    { provider: 'mistral', key: 'made-a-minute-ago' }
  ]);
});

test('saves a key without a check when the provider does not answer, and the row says so', async ({
  page,
  tmpPath
}) => {
  const fake = new FakeServer();
  await fake.install(page);
  const section = await openPanel(page, tmpPath);
  const mistral = row(section, 'mistral');
  await mistral.getByRole('button', { name: 'Paste key' }).click();
  const form = section.getByRole('form', { name: 'Key of Mistral AI' });
  const field = form.getByLabel(/A Mistral AI API key/);

  // A key with a space stays in the page.
  await field.fill('mistral key');
  await form.getByRole('button', { name: 'Save key' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'The key holds a space. Paste it on one line, with no spaces.'
  );
  expect(fake.sent.key).toEqual([]);

  // The train goes into a tunnel.
  fake.queue(
    'key',
    failed('api.mistral.ai did not answer in 15 s', 'unchecked')
  );
  await field.fill('mistral-key');
  await form.getByRole('button', { name: 'Save key' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'api.mistral.ai did not answer in 15 s. The key is not checked, and not saved.'
  );
  await expect(form.getByRole('button')).toHaveText([
    'Try again',
    'Save without a check'
  ]);
  fake.mistral = { saved: TODAY, checked: false, refused: null };
  fake.queue('key', { status: 200, json: fake.state() });
  await form.getByRole('button', { name: 'Save without a check' }).click();
  await expect(mistral).toContainText('Mistral models: key saved, not checked');
  // The list of models would check the key at once: it waits for Models.
  await expect(form).toHaveCount(0);
  await expect(section.locator('.jp-Epi-modelpicker')).toHaveCount(0);
  await expect(mistral.getByRole('button', { name: 'Models' })).toBeFocused();
  expect(fake.sent.key).toEqual([
    { provider: 'mistral', key: 'mistral-key' },
    { provider: 'mistral', key: 'mistral-key', check: false }
  ]);
});

test('says that a saved key is wrong once a provider refused it', async ({
  page,
  tmpPath
}) => {
  const fake = new FakeServer();
  fake.mistral = { saved: SAVED, checked: true, refused: TODAY };
  fake.connection = {
    provider: 'mistral',
    model: 'mistral-medium-latest',
    base_url: null,
    local: false
  };
  fake.connectedKey = { saved: SAVED, checked: true, refused: TODAY };
  await fake.install(page);
  await newNotebook(page, `${tmpPath}/wrong.ipynb`, ['x = 1']);
  await openInWhybook(page, `${tmpPath}/wrong.ipynb`);
  await page.locator('.jp-Epi-aibutton').click();
  const section = page.locator('.jp-Epi-aipanel .jp-Epi-connection');
  const line = section.locator('.jp-Epi-connection-now + .jp-Epi-aipanel-note');
  await expect(line).toHaveText(
    'Mistral AI refused the saved key on 30 Sep. The key is wrong: replace it.'
  );
  await section.getByRole('button', { name: 'Change' }).click();
  const note = row(section, 'mistral').locator('.jp-Epi-provider-note');
  await expect(note).toHaveText(
    'Mistral models: the key is wrong, Mistral AI refused it on 30 Sep'
  );
  // In the colour of the other faults of the panel.
  const colours = await page.evaluate(() => {
    const [note, line] = [
      document.querySelector('.jp-Epi-provider-note.jp-mod-wrong'),
      document.querySelector('.jp-Epi-connection-now + .jp-Epi-aipanel-note')
    ];
    return [note, line].map(node => getComputedStyle(node!).color);
  });
  expect(colours[0]).toBe(colours[1]);
});

test("lists a new server's models with the typed key, saves nothing, then saves the key and the connection together", async ({
  page,
  tmpPath
}) => {
  const fake = new FakeServer();
  await fake.install(page);
  const section = await openPanel(page, tmpPath);
  const server = section.locator('.jp-Epi-ownserver');
  await server.locator('#jp-Epi-ownserver-url').fill(GPU);
  const key = server.getByLabel('Its API key, if it asks for one');
  await key.fill('gpu-key');
  const check = gate();
  fake.queue('models', {
    status: 200,
    json: {
      models: ['llama-3.3-70b', 'qwen3-32b', 'qwen3-coder-30b'].map(id => ({
        id,
        label: id,
        note: null
      })),
      key_check: 'accepted',
      saved: null
    },
    hold: check.closed
  });
  await server.getByRole('button', { name: 'List its models' }).click();
  const picker = section.locator('.jp-Epi-modelpicker');
  await expect(picker.getByRole('status')).toHaveText(
    `Checking the key with the server at ${GPU}: it lists its models with it. Nothing is saved yet.`
  );
  await expect(key).not.toBeEditable();
  await expect
    .poll(() => fake.sent.models)
    .toEqual([
      { provider: 'openai-compatible', base_url: GPU, key: 'gpu-key' }
    ]);
  check.open();
  await expect(picker.getByRole('status')).toHaveText(
    `The server at ${GPU} took the key and lists 3 models. Nothing is saved yet: the key goes with this URL once you use one of them.`
  );
  await expect(key).toBeEditable();
  expect(fake.sent.connection).toEqual([]);
  await picker
    .getByLabel('Model of openai-compatible')
    .selectOption('qwen3-32b');
  fake.connection = {
    provider: 'openai-compatible',
    model: 'qwen3-32b',
    base_url: GPU,
    local: false
  };
  fake.connectedKey = { saved: TODAY, checked: true, refused: null };
  fake.queue('connection', { status: 200, json: fake.state() });
  await picker.getByRole('button', { name: 'Use this model' }).click();
  await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
    `Server at ${GPU}: qwen3-32b`
  );
  expect(fake.sent.connection).toEqual([
    {
      provider: 'openai-compatible',
      model: 'qwen3-32b',
      base_url: GPU,
      local: false,
      key: 'gpu-key'
    }
  ]);
});

test('does not save a key for a server that asks for none', async ({
  page,
  tmpPath
}) => {
  const fake = new FakeServer();
  await fake.install(page);
  const section = await openPanel(page, tmpPath);
  const server = section.locator('.jp-Epi-ownserver');
  await server.locator('#jp-Epi-ownserver-url').fill(GPU);
  await server.getByLabel('Its API key, if it asks for one').fill('any-key');
  // vLLM started without --api-key lists its models with any key, and without one.
  fake.queue('models', {
    status: 200,
    json: {
      models: [{ id: 'qwen3-32b', label: 'qwen3-32b', note: null }],
      key_check: 'not needed',
      saved: null
    }
  });
  await server.getByRole('button', { name: 'List its models' }).click();
  const picker = section.locator('.jp-Epi-modelpicker');
  await expect(picker.getByRole('status')).toHaveText(
    `The server at ${GPU} lists its models without a key too: it needs none, so the key is not saved.`
  );
  fake.connection = {
    provider: 'openai-compatible',
    model: 'qwen3-32b',
    base_url: GPU,
    local: false
  };
  fake.queue('connection', { status: 200, json: fake.state() });
  await picker.getByRole('button', { name: 'Use this model' }).click();
  await expect(section.locator('.jp-Epi-connection-now')).toHaveText(
    `Server at ${GPU}: qwen3-32b`
  );
  expect(fake.sent.connection).toEqual([
    {
      provider: 'openai-compatible',
      model: 'qwen3-32b',
      base_url: GPU,
      local: false
    }
  ]);
});

test("offers Try again, and Save anyway with the model's name, for a key that a server refuses", async ({
  page,
  tmpPath
}) => {
  const fake = new FakeServer();
  await fake.install(page);
  const section = await openPanel(page, tmpPath);
  const server = section.locator('.jp-Epi-ownserver');
  await server.locator('#jp-Epi-ownserver-url').fill(GPU);
  await server
    .getByLabel('Its API key, if it asks for one')
    .fill('new-gpu-key');
  const refused = failed(
    `The server at ${GPU} refused this key (HTTP 401)`,
    'refused'
  );
  fake.queue('models', refused);
  await server.getByRole('button', { name: 'List its models' }).click();
  const picker = section.locator('.jp-Epi-modelpicker');
  await expect(picker.getByRole('alert')).toHaveText(
    `The server at ${GPU} refused this key (HTTP 401). Nothing is saved.`
  );
  await expect(picker.getByRole('button')).toHaveText([
    'Try again',
    'Save anyway'
  ]);
  // The focus stays in the panel, which closes when it leaves.
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .querySelector('.jp-Epi-aipanel')!
          .contains(document.activeElement)
      )
    )
    .toBe(true);
  const saveAnyway = picker.getByRole('button', { name: 'Save anyway' });
  await expect(saveAnyway).toBeDisabled();
  fake.queue('models', refused);
  await picker.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => fake.sent.models.length).toBe(2);
  await expect(picker.getByRole('alert')).toBeVisible();
  await picker.getByLabel('Model of openai-compatible').fill('qwen3-32b');
  fake.connection = {
    provider: 'openai-compatible',
    model: 'qwen3-32b',
    base_url: GPU,
    local: false
  };
  fake.connectedKey = { saved: TODAY, checked: false, refused: null };
  fake.queue('connection', { status: 200, json: fake.state() });
  await saveAnyway.click();
  await expect(section.locator('.jp-Epi-connection-now + div')).toHaveText(
    'The saved key is not checked yet: the first answer checks it.'
  );
  expect(fake.sent.connection).toEqual([
    {
      provider: 'openai-compatible',
      model: 'qwen3-32b',
      base_url: GPU,
      local: false,
      key: 'new-gpu-key',
      check: false
    }
  ]);
});
