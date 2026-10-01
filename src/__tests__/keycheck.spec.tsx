/**
 * A key is checked before it is saved (design iteration 1.57), in the AI
 * models panel (src/ui/connection.tsx): a key that no request can carry
 * stays in the page; the field is locked while the server checks the key;
 * a refused key, or one the provider could not check, gets Try again and
 * Save anyway, or Save without a check; a saved key has Replace key; a key
 * typed with a server's URL is checked with the list of the server's models
 * and saved with the connection. The fake API stands in for the server.
 */
import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { Signal } from '@lumino/signaling';

import type { IConnectionState, IProviderInfo } from '../model/api';
import {
  connectedKeyLine,
  dayOf,
  keyCheckOf,
  keyCheckText,
  keyProblem,
  keyWords
} from '../model/connection';
import { DEFAULT_MODELS } from '../model/models';
import { RequestError } from '../request';
import { ConnectionSection } from '../ui/connection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Days of this year, so that the panel writes them without a year.
const YEAR = new Date().getFullYear();
const SAVED = `${YEAR}-09-27T12:00:00Z`;
const TODAY = `${YEAR}-09-30T12:00:00Z`;
const GPU = 'http://gpu-server:8000/v1';

function mistral(key: Partial<IProviderInfo> = {}): IProviderInfo {
  return {
    id: 'mistral',
    label: 'Mistral AI',
    local: false,
    base_url: 'https://api.mistral.ai',
    signin: null,
    needs_key: true,
    dev_only: false,
    signed_in: false,
    key_from: null,
    saved: null,
    checked: null,
    refused: null,
    installed: true,
    ...key
  };
}

/** A saved key of Mistral AI, as the server lists it. */
const SAVED_KEY: Partial<IProviderInfo> = {
  signed_in: true,
  key_from: 'typed',
  saved: SAVED,
  checked: true
};

function stateOf(
  provider: IProviderInfo,
  more: Partial<IConnectionState> = {}
): IConnectionState {
  return {
    connection: { provider: 'none', model: null, base_url: null, local: false },
    readiness: {
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
    connected_key: null,
    providers: [provider],
    huggingface_signin: false,
    models_installed: true,
    ...more
  };
}

/** An answer of the server to a check that failed: whybook/server/routes.py, check_failed. */
function failure(
  message: string,
  check: 'refused' | 'unchecked',
  saved: string | null = null
): RequestError {
  return new RequestError(new Response(null, { status: 409 }), message, {
    message,
    check,
    saved
  });
}

let root: Root | null = null;
let host: HTMLElement;

beforeAll(() => {
  // jsdom lays nothing out: the list of models scrolls into view.
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function mount(api: Record<string, unknown>): Promise<void> {
  const model: any = {
    refreshStatus: () => undefined,
    settings: { models: { ...DEFAULT_MODELS } },
    api: { localServers: async () => ({ servers: [] }), ...api },
    signIns: {
      changed: new Signal({}),
      signedIn: null,
      openRouter: null,
      huggingFace: null,
      error: null
    }
  };
  host = document.createElement('div');
  host.className = 'jp-Epi-aipanel';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<ConnectionSection model={model} />);
  });
  await settle();
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(
    item => item.textContent?.trim() === text
  );
  if (!found) {
    throw new Error(`no button "${text}"`);
  }
  return found;
}

function buttons(within: Element): string[] {
  return Array.from(within.querySelectorAll('button')).map(
    item => item.textContent?.trim() ?? ''
  );
}

async function press(text: string): Promise<void> {
  const pressed = button(text);
  pressed.focus();
  await act(async () => {
    pressed.click();
  });
  await settle();
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function row(provider: string): HTMLElement {
  return host.querySelector<HTMLElement>(
    `.jp-Epi-provider[data-provider="${provider}"]`
  )!;
}

function keyForm(): HTMLFormElement {
  return host.querySelector<HTMLFormElement>('.jp-Epi-keyform')!;
}

function warning(within: Element = host): string {
  return within.querySelector('.jp-mod-warning')?.textContent ?? '';
}

describe('the rules of the panel for keys', () => {
  it('refuses a key with a line break, a space or another character that keys do not have', () => {
    expect(keyProblem('sk-ant-api03-abc\ndef')).toBe(
      'The key holds a line break. Paste it on one line.'
    );
    expect(keyProblem('sk-ant api03')).toBe(
      'The key holds a space. Paste it on one line, with no spaces.'
    );
    expect(keyProblem('sk-ant-api03…')).toBe(
      'The key holds a character that keys do not have. Copy it again.'
    );
    expect(keyProblem('sk-ant-api03-abc_DEF.123')).toBeNull();
  });

  it('writes the day a key was saved, with the year when it is not this one', () => {
    expect(dayOf(SAVED)).toBe('27 Sep');
    expect(dayOf('2025-03-02T12:00:00Z', new Date(SAVED))).toBe('2 Mar 2025');
    expect(dayOf(null)).toBeNull();
  });

  it('says what became of the key, and of the key saved before it', () => {
    const refused = keyCheckOf(
      failure('Mistral AI refused this key (HTTP 401)', 'refused', SAVED)
    );
    expect(keyCheckText(refused)).toBe(
      'Mistral AI refused this key (HTTP 401). Nothing changed: the key saved on 27 Sep stays in use.'
    );
    expect(keyCheckText({ ...refused, saved: null })).toBe(
      'Mistral AI refused this key (HTTP 401). Nothing is saved.'
    );
    const unchecked = keyCheckOf(
      failure(
        `An OpenAI-compatible server: nothing answered at ${GPU}: is the server running?`,
        'unchecked'
      )
    );
    expect(keyCheckText(unchecked)).toBe(
      `An OpenAI-compatible server: nothing answered at ${GPU}: is the server running? The key is not checked, and not saved.`
    );
    // Another failure, or an error with no body, is its message alone.
    expect(keyCheckOf(new Error('Error: the server is down'))).toEqual({
      message: 'the server is down',
      check: null,
      saved: null
    });
  });

  it('names what the row knows of a saved key', () => {
    expect(keyWords(mistral(SAVED_KEY))).toBe('key saved on 27 Sep');
    expect(keyWords(mistral({ ...SAVED_KEY, checked: false }))).toBe(
      'key saved, not checked'
    );
    expect(keyWords(mistral({ ...SAVED_KEY, refused: TODAY }))).toBe(
      'the key is wrong, Mistral AI refused it on 30 Sep'
    );
    expect(keyWords(mistral({ signed_in: true, saved: null }), 'token')).toBe(
      'token saved on the server'
    );
  });
});

describe('a key pasted for a company', () => {
  it('stays in the page when it holds a space', async () => {
    const saveKey = jest.fn();
    await mount({ connection: async () => stateOf(mistral()), saveKey });
    await press('Connect a model');
    await press('Paste key');
    await type(keyForm().querySelector('input')!, 'abc def');
    await press('Save key');
    expect(saveKey).not.toHaveBeenCalled();
    expect(warning(keyForm())).toBe(
      'The key holds a space. Paste it on one line, with no spaces.'
    );
  });

  it('is checked in a locked field while a saved key stays in use, then saved, and the row says when', async () => {
    let answer: (state: IConnectionState) => void = () => undefined;
    const saveKey = jest.fn(
      () => new Promise<IConnectionState>(resolve => (answer = resolve))
    );
    await mount({
      connection: async () => stateOf(mistral(SAVED_KEY)),
      saveKey,
      connectionModels: () => new Promise(() => undefined)
    });
    await press('Connect a model');
    // Replace key beside Forget key, for a saved key.
    expect(buttons(row('mistral'))).toEqual([
      'Models',
      'Replace key',
      'Forget key'
    ]);
    expect(row('mistral').textContent).toContain(
      'Mistral models: key saved on 27 Sep'
    );
    await press('Replace key');
    expect(keyForm().querySelector('label')!.textContent).toBe(
      'A new Mistral AI API key, from console.mistral.ai/api-keys. It stays on the server, in a file only you can read.'
    );
    const field = keyForm().querySelector('input')!;
    await type(field, ' new-key ');
    await press('Save key');
    expect(saveKey).toHaveBeenCalledWith('mistral', 'new-key', true);
    expect(field.readOnly).toBe(true);
    expect(keyForm().querySelector('[role="status"]')!.textContent).toBe(
      'Checking the key with Mistral AI: it lists its models with it, at no cost. Nothing is saved until the check passes, and the key saved on 27 Sep stays in use.'
    );
    expect(button('Checking…').disabled).toBe(true);
    await act(async () =>
      answer(stateOf(mistral({ ...SAVED_KEY, saved: TODAY })))
    );
    await settle();
    expect(keyForm()).toBeNull();
    expect(row('mistral').textContent).toContain(
      'Mistral models: key saved on 30 Sep'
    );
    // Its models open under its row, as after any key the provider took.
    expect(
      host.querySelector('.jp-Epi-modelpicker[data-provider="mistral"]')
    ).not.toBeNull();
  });

  it('keeps a refused key in the field, with Try again and Save anyway, and the saved key in use', async () => {
    const saveKey = jest
      .fn()
      .mockRejectedValueOnce(
        failure('Mistral AI refused this key (HTTP 401)', 'refused', SAVED)
      )
      .mockRejectedValueOnce(
        failure('Mistral AI refused this key (HTTP 401)', 'refused', SAVED)
      )
      .mockResolvedValueOnce(
        stateOf(mistral({ ...SAVED_KEY, saved: TODAY, checked: false }))
      );
    const connectionModels = jest.fn();
    await mount({
      connection: async () => stateOf(mistral(SAVED_KEY)),
      saveKey,
      connectionModels
    });
    await press('Connect a model');
    await press('Replace key');
    const field = keyForm().querySelector('input')!;
    await type(field, 'made-a-minute-ago');
    await press('Save key');
    expect(warning(keyForm())).toBe(
      'Mistral AI refused this key (HTTP 401). Nothing changed: the key saved on 27 Sep stays in use.'
    );
    expect(field.value).toBe('made-a-minute-ago');
    expect(field.readOnly).toBe(false);
    expect(buttons(keyForm())).toEqual(['Try again', 'Save anyway']);
    // The form lost the focus to its locked button: Try again takes it.
    expect(document.activeElement).toBe(button('Try again'));
    await press('Try again');
    expect(saveKey).toHaveBeenLastCalledWith(
      'mistral',
      'made-a-minute-ago',
      true
    );
    await press('Save anyway');
    expect(saveKey).toHaveBeenLastCalledWith(
      'mistral',
      'made-a-minute-ago',
      false
    );
    // Saved, marked as not checked: the list of models, which would check
    // the key at once, waits for the analyst, who has the focus on Models.
    expect(keyForm()).toBeNull();
    expect(row('mistral').textContent).toContain(
      'Mistral models: key saved, not checked'
    );
    expect(connectionModels).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Models'));
  });

  it('offers Save without a check when the provider does not answer', async () => {
    const saveKey = jest
      .fn()
      .mockRejectedValueOnce(
        failure('api.mistral.ai did not answer in 15 s', 'unchecked')
      )
      .mockResolvedValueOnce(
        stateOf(mistral({ ...SAVED_KEY, saved: TODAY, checked: false }))
      );
    await mount({ connection: async () => stateOf(mistral()), saveKey });
    await press('Connect a model');
    await press('Paste key');
    await type(keyForm().querySelector('input')!, 'mistral-key');
    await press('Save key');
    expect(warning(keyForm())).toBe(
      'api.mistral.ai did not answer in 15 s. The key is not checked, and not saved.'
    );
    expect(buttons(keyForm())).toEqual(['Try again', 'Save without a check']);
    await press('Save without a check');
    expect(saveKey).toHaveBeenLastCalledWith('mistral', 'mistral-key', false);
    expect(row('mistral').textContent).toContain(
      'Mistral models: key saved, not checked'
    );
  });
});

describe('the mark of a key saved without a check', () => {
  it('shows under the connected model, and says that a refused key is wrong', async () => {
    const connected: Partial<IConnectionState> = {
      connection: {
        provider: 'mistral',
        model: 'mistral-medium-latest',
        base_url: null,
        local: false
      },
      readiness: {
        available: true,
        cli: null,
        credential: 'Mistral AI',
        reason: null,
        setup: null,
        provider: 'mistral',
        model: 'mistral-medium-latest',
        label: 'Mistral AI: mistral-medium-latest',
        local: false
      }
    };
    const unchecked = stateOf(mistral({ ...SAVED_KEY, checked: false }), {
      ...connected,
      connected_key: { saved: SAVED, checked: false, refused: null }
    });
    expect(connectedKeyLine(unchecked)).toEqual({
      text: 'The saved key is not checked yet: the first answer checks it.',
      wrong: false
    });
    const refused = stateOf(mistral({ ...SAVED_KEY, refused: TODAY }), {
      ...connected,
      connected_key: { saved: SAVED, checked: true, refused: TODAY }
    });
    await mount({ connection: async () => refused });
    const line = host.querySelector('.jp-Epi-connection-now + div')!;
    expect(line.textContent).toBe(
      'Mistral AI refused the saved key on 30 Sep. The key is wrong: replace it.'
    );
    expect(line.className).toBe('jp-Epi-aipanel-note');
    await press('Change');
    const note = row('mistral').querySelector('.jp-Epi-provider-note')!;
    expect(note.textContent).toBe(
      'Mistral models: the key is wrong, Mistral AI refused it on 30 Sep'
    );
    expect(note.classList.contains('jp-mod-wrong')).toBe(true);
  });
});

describe('a key typed with a server of your own', () => {
  async function listWith(key: string, api: Record<string, unknown>) {
    await mount({ connection: async () => stateOf(mistral()), ...api });
    await press('Connect a model');
    const form = host.querySelector<HTMLFormElement>('.jp-Epi-ownserver')!;
    const [url, typedKey] = Array.from(form.querySelectorAll('input'));
    await type(url, GPU);
    await type(typedKey, key);
    await press('List its models');
    return form;
  }

  it('stays in the page when it holds a space', async () => {
    const connectionModels = jest.fn();
    const form = await listWith('gpu key', { connectionModels });
    expect(connectionModels).not.toHaveBeenCalled();
    expect(warning(form)).toBe(
      'The key holds a space. Paste it on one line, with no spaces.'
    );
  });

  it('goes with the list of its models, which saves nothing, then with the connection', async () => {
    let answer: (listed: unknown) => void = () => undefined;
    const connectionModels = jest.fn(
      () => new Promise(resolve => (answer = resolve))
    );
    const saveConnection = jest.fn(async () => stateOf(mistral()));
    const form = await listWith('gpu-key', {
      connectionModels,
      saveConnection
    });
    expect(connectionModels).toHaveBeenCalledWith(
      'openai-compatible',
      GPU,
      'gpu-key'
    );
    // The form is locked while the server checks the key.
    const inputs = Array.from(form.querySelectorAll('input'));
    expect(inputs.map(input => input.readOnly || input.disabled)).toEqual([
      true,
      true,
      true
    ]);
    const picker = host.querySelector('.jp-Epi-modelpicker')!;
    expect(picker.querySelector('[role="status"]')!.textContent).toBe(
      `Checking the key with the server at ${GPU}: it lists its models with it. Nothing is saved yet.`
    );
    await act(async () =>
      answer({
        models: ['llama-3.3-70b', 'qwen3-32b', 'qwen3-coder-30b'].map(id => ({
          id,
          label: id,
          note: null
        })),
        key_check: 'accepted',
        saved: SAVED
      })
    );
    await settle();
    expect(form.querySelector('input')!.readOnly).toBe(false);
    expect(picker.querySelector('[role="status"]')!.textContent).toBe(
      `The server at ${GPU} took the key and lists 3 models. Nothing is saved yet: the key goes with this URL once you use one of them, in place of the key saved on 27 Sep.`
    );
    const select = picker.querySelector('select')!;
    await act(async () => {
      select.value = 'qwen3-32b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await press('Use this model');
    expect(saveConnection).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'qwen3-32b',
      base_url: GPU,
      local: false,
      key: 'gpu-key'
    });
  });

  it('is not saved for a server that lists its models without a key', async () => {
    const saveConnection = jest.fn(async () => stateOf(mistral()));
    await listWith('any-key', {
      connectionModels: async () => ({
        models: [{ id: 'qwen3-32b', label: 'qwen3-32b', note: null }],
        key_check: 'not needed',
        saved: null
      }),
      saveConnection
    });
    const picker = host.querySelector('.jp-Epi-modelpicker')!;
    expect(picker.querySelector('[role="status"]')!.textContent).toBe(
      `The server at ${GPU} lists its models without a key too: it needs none, so the key is not saved.`
    );
    await press('Use this model');
    expect(saveConnection).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'qwen3-32b',
      base_url: GPU,
      local: false,
      key: undefined
    });
  });

  it('that the server refuses gets Try again, and Save anyway with the name of the model', async () => {
    const refused = failure(
      `The server at ${GPU} refused this key (HTTP 401)`,
      'refused'
    );
    const connectionModels = jest.fn().mockRejectedValue(refused);
    const saveConnection = jest.fn(async () => stateOf(mistral()));
    await listWith('a-typo', { connectionModels, saveConnection });
    const picker = host.querySelector('.jp-Epi-modelpicker')!;
    expect(warning(picker)).toBe(
      `The server at ${GPU} refused this key (HTTP 401). Nothing is saved.`
    );
    expect(buttons(picker)).toEqual(['Try again', 'Save anyway']);
    // The focus stays in the panel, which closes when it leaves: on List its
    // models, or, where the browser took it from the locked button, on the
    // field of the model's name.
    expect(host.contains(document.activeElement)).toBe(true);
    const name = picker.querySelector('input')!;
    expect(name.getAttribute('aria-label')).toBe('Model of openai-compatible');
    expect(button('Save anyway').disabled).toBe(true);
    await press('Try again');
    expect(connectionModels).toHaveBeenCalledTimes(2);
    await type(picker.querySelector('input')!, 'qwen3-32b');
    await press('Save anyway');
    expect(saveConnection).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'qwen3-32b',
      base_url: GPU,
      local: false,
      key: 'a-typo',
      check: false
    });
  });
});
