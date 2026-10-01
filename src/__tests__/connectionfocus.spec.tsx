/**
 * Where the keyboard focus goes after an action in the Connected model
 * section replaces the button that had it (src/ui/connection.tsx). The AI
 * models panel closes when the focus next leaves it (useDismiss), so the
 * focus has to stay in the section.
 */
import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { Signal } from '@lumino/signaling';

import { DEFAULT_MODELS } from '../model/models';
import { ConnectionSection } from '../ui/connection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function stateOf(signedIn: boolean, connected = true): any {
  return {
    connection: connected
      ? {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          base_url: null,
          local: false
        }
      : { provider: 'none', model: null, base_url: null, local: false },
    readiness: {
      available: connected && signedIn,
      cli: null,
      credential: signedIn ? 'Anthropic' : null,
      reason: signedIn ? null : 'no Anthropic API key is saved',
      setup: signedIn
        ? null
        : 'Paste an Anthropic API key in the AI models panel.',
      provider: connected ? 'anthropic' : 'none',
      model: connected ? 'claude-sonnet-5' : null,
      label: connected ? 'Anthropic: claude-sonnet-5' : 'No model connected',
      local: false
    },
    providers: [
      {
        id: 'anthropic',
        label: 'Anthropic',
        local: false,
        base_url: null,
        signin: null,
        needs_key: true,
        dev_only: false,
        signed_in: signedIn,
        key_from: signedIn ? 'typed' : null,
        saved: null,
        installed: true
      }
    ],
    huggingface_signin: false,
    models_installed: true
  };
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

/** Press a button with the keyboard: it has the focus, and Enter clicks it. */
async function press(text: string): Promise<void> {
  const pressed = button(text);
  pressed.focus();
  await act(async () => {
    pressed.click();
  });
  await settle();
}

function focused(): string {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !host.contains(active)) {
    return `outside the section, on ${active?.tagName ?? 'nothing'}`;
  }
  return active.getAttribute('aria-label') ?? active.textContent?.trim() ?? '';
}

describe('the focus in the Connected model section', () => {
  it('goes to Paste key after Forget key', async () => {
    await mount({
      connection: async () => stateOf(true),
      signOut: async () => stateOf(false)
    });
    await press('Change');
    await press('Forget key');
    expect(focused()).toBe('Paste key');
  });

  it('goes to the button that closes the list after Connect a model', async () => {
    await mount({ connection: async () => stateOf(false, false) });
    await press('Connect a model');
    expect(focused()).toBe('Close');
    await press('Close');
    expect(focused()).toBe('Connect a model');
  });

  it('goes to the models of the provider after Save key, while they load', async () => {
    let list: (models: unknown) => void = () => undefined;
    await mount({
      connection: async () => stateOf(false),
      saveKey: async () => stateOf(true),
      // The provider lists its models later.
      connectionModels: () => new Promise(resolve => (list = resolve))
    });
    await press('Connect a model');
    await press('Paste key');
    const field = host.querySelector<HTMLInputElement>(
      '#jp-Epi-key-anthropic'
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )!.set!;
      setter.call(field, 'sk-ant-test');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Save key');
    expect(focused()).toBe('Models of Anthropic');
    await act(async () =>
      list({
        models: [
          { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
          { id: 'claude-haiku-5', label: 'Claude Haiku 5' }
        ]
      })
    );
    await settle();
    expect(focused()).toBe('Model of Anthropic');
  });

  it('goes to the button that opens the list after Use this model', async () => {
    await mount({
      connection: async () => stateOf(true),
      connectionModels: async () => ({
        models: [
          { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
          { id: 'claude-haiku-5', label: 'Claude Haiku 5' }
        ]
      }),
      saveConnection: async () => stateOf(true)
    });
    await press('Change');
    await press('Models');
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Model of Anthropic"]'
    )!;
    await act(async () => {
      select.value = 'claude-haiku-5';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await press('Use this model');
    expect(focused()).toBe('Change');
  });
});
