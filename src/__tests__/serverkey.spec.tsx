/**
 * A key typed for a model server can be forgotten (design iteration 1.133).
 * Under the connected model, the AI models panel (src/ui/connection.tsx)
 * shows when the key typed with the server's URL was saved, with Forget key,
 * which asks the server to delete the key kept for that URL. A provider's
 * key has its own row with Sign out or Forget key, and no such line.
 */
import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { Signal } from '@lumino/signaling';

import type { IConnectionState, IKeyState } from '../model/api';
import { serverKeyWords } from '../model/connection';
import { DEFAULT_MODELS } from '../model/models';
import { ConnectionSection } from '../ui/connection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A day of this year, so that the panel writes it without a year.
const YEAR = new Date().getFullYear();
const SAVED = `${YEAR}-09-27T12:00:00Z`;
const GPU = 'http://gpu-server:8000/v1';

/** The state of a connection to `provider`, with the saved key `key`, as the server sends it. */
function stateOf(
  provider: string,
  key: IKeyState | null,
  base_url: string | null = null
): IConnectionState {
  const label =
    provider === 'openai-compatible'
      ? `Server at ${base_url}: qwen3-32b`
      : 'Mistral AI: mistral-medium-latest';
  return {
    connection: { provider, model: 'qwen3-32b', base_url, local: false },
    readiness: {
      available: true,
      cli: null,
      credential: null,
      reason: null,
      setup: null,
      provider,
      model: 'qwen3-32b',
      label,
      local: false
    },
    connected_key: key,
    providers: [],
    huggingface_signin: false,
    models_installed: true
  };
}

const SERVER_KEY: IKeyState = {
  saved: SAVED,
  checked: true,
  refused: null,
  typed_for: GPU
};

let root: Root | null = null;
let host: HTMLElement;

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

function keyLine(): HTMLElement | null {
  return host.querySelector<HTMLElement>('.jp-Epi-connection-key');
}

describe('the key typed for the connected server', () => {
  it('is named by the day it was saved, and only for a server', () => {
    expect(serverKeyWords(stateOf('openai-compatible', SERVER_KEY, GPU))).toBe(
      'Key saved on 27 Sep'
    );
    expect(
      serverKeyWords(
        stateOf('openai-compatible', { ...SERVER_KEY, saved: null }, GPU)
      )
    ).toBe('Key saved on the server');
    expect(
      serverKeyWords(stateOf('mistral', { ...SERVER_KEY, typed_for: null }))
    ).toBeNull();
    expect(serverKeyWords(stateOf('openai-compatible', null, GPU))).toBeNull();
  });

  it('shows under the connected model with Forget key, which deletes it on the server', async () => {
    const signOut = jest.fn(async () =>
      stateOf('openai-compatible', null, GPU)
    );
    await mount({
      connection: async () => stateOf('openai-compatible', SERVER_KEY, GPU),
      signOut
    });
    const line = keyLine()!;
    expect(line.previousElementSibling!.className).toContain(
      'jp-Epi-connection-now'
    );
    expect(line.querySelector('.jp-Epi-provider-note')!.textContent).toBe(
      'Key saved on 27 Sep'
    );
    const forget = Array.from(line.querySelectorAll('button')).find(
      item => item.textContent === 'Forget key'
    )!;
    forget.focus();
    await act(async () => forget.click());
    await settle();
    expect(signOut).toHaveBeenCalledWith('openai-compatible', GPU);
    expect(keyLine()).toBeNull();
    // The server stays connected; the focus goes to the button that changes the model.
    expect(host.querySelector('.jp-Epi-connection-now')!.textContent).toBe(
      `Server at ${GPU}: qwen3-32b`
    );
    expect(document.activeElement?.textContent).toBe('Change');
  });

  it("keeps the line about a key that is not checked, under the key's own line", async () => {
    await mount({
      connection: async () =>
        stateOf('openai-compatible', { ...SERVER_KEY, checked: false }, GPU)
    });
    expect(keyLine()!.nextElementSibling!.textContent).toBe(
      'The saved key is not checked yet: the first answer checks it.'
    );
  });

  it("does not show for a provider's key, which its own row forgets", async () => {
    await mount({
      connection: async () =>
        stateOf('mistral', { ...SERVER_KEY, typed_for: null })
    });
    expect(host.querySelector('.jp-Epi-connection-now')).not.toBeNull();
    expect(keyLine()).toBeNull();
  });
});
