/**
 * Zero data retention on OpenRouter as the analyst's choice (design iteration
 * 1.80): the setting, the box in the AI models panel beside "Keep data on
 * this machine", the field of the settings editor, and the flag that the
 * requests carry. The server can pin it on (c.Whybook.openrouter_zdr): the
 * box then shows on, greyed, with the reason.
 */
import './fakes/quiet';

import * as React from 'react';

import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import type { ServerConnection } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';

import type { IConnectionState, IServerStatus } from '../model/api';
import { Api } from '../model/api';
import { usesOpenRouter } from '../model/connection';
import { readSettings } from '../model/settings';
import { requestAPI, streamAPI } from '../request';
import { AIButton } from '../ui/aipanel';
import {
  RETENTION_FIXED,
  RetentionToggle,
  retentionFieldRenderer
} from '../ui/datapolicy';
import { benchModel } from './fakes/bench-fake';
import type { IMounted } from './fakes/bench-render';
import { mount as mountView, settle, step } from './fakes/bench-render';

jest.mock('../request', () => ({
  requestAPI: jest.fn(),
  streamAPI: jest.fn()
}));

const request = requestAPI as jest.Mock;
const stream = streamAPI as jest.Mock;
const server = {} as ServerConnection.ISettings;

/** A model connected through OpenRouter, as the server's status says it. */
function statusOf(extra: Partial<IServerStatus> = {}): IServerStatus {
  return {
    ranker: 'heuristic',
    jev_configured: false,
    claude_available: true,
    claude: {
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
    },
    describe_tables: true,
    remote_model: 'OpenRouter: openai/gpt-6',
    local_models: [],
    keep_data_local: false,
    openrouter_zdr: false,
    ...extra
  };
}

/** The connection's state: the provider connected, and whether OpenRouter has a key. */
function stateOf(provider: string, openRouterKey: boolean): IConnectionState {
  return {
    connection: {
      provider,
      model: provider === 'none' ? null : 'a-model',
      base_url: null,
      local: false
    },
    readiness: statusOf().claude!,
    connected_key: null,
    providers: [
      {
        id: 'openrouter',
        label: 'OpenRouter',
        local: false,
        base_url: null,
        signin: 'openrouter',
        needs_key: true,
        dev_only: false,
        signed_in: openRouterKey,
        key_from: openRouterKey ? 'openrouter' : null,
        saved: null,
        installed: true
      }
    ],
    huggingface_signin: false,
    models_installed: true
  };
}

/** The server's answers: the status and the connection's state. */
function answer(status: IServerStatus, state: IConnectionState): void {
  request.mockImplementation(async (route: string) =>
    route === 'status'
      ? status
      : route === 'connection'
        ? state
        : route === 'connection/local'
          ? { servers: [] }
          : {}
  );
}

/** What a test drew, and the view models it made: gone after each test, even one that fails. */
let views: IMounted[] = [];
let models: { dispose(): void }[] = [];

async function mount(element: React.ReactElement): Promise<IMounted> {
  const view = await mountView(element);
  views.push(view);
  return view;
}

beforeEach(() => {
  request.mockReset();
  stream.mockReset();
  stream.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const view of views) {
    await view.unmount();
  }
  for (const model of models) {
    model.dispose();
  }
  views = [];
  models = [];
  document.body.innerHTML = '';
});

describe('The setting', () => {
  it('is on unless the analyst turns it off', () => {
    expect(readSettings({}, null).zeroDataRetention).toBe(true);
    expect(
      readSettings({ zeroDataRetention: true }, null).zeroDataRetention
    ).toBe(true);
    expect(
      readSettings({ zeroDataRetention: false }, { zeroDataRetention: false })
        .zeroDataRetention
    ).toBe(false);
  });
});

describe('The requests', () => {
  it('say that zero data retention is off only when the analyst turned it off', async () => {
    const off = new Api(server, { zeroDataRetention: () => false });
    await off.solve({ question: { text: 'q' } }, () => {});
    await off.claudeQuestions({ model: 'remote' }, () => {});
    await off.titleCells({ model: 'remote', cells: [] }, () => {});
    await off.agent({ question: { text: 'q' } }, () => {});
    // The list of OpenRouter's models, and the check of a model before it is saved.
    await off.connectionModels('openrouter');
    await off.saveConnection({ provider: 'openrouter', model: 'a/b' });
    const on = new Api(server, { zeroDataRetention: () => true });
    await on.solve({ question: { text: 'q' } }, () => {});
    await on.connectionModels('openrouter');
    await new Api(server).solve({ question: { text: 'q' } }, () => {});
    const streamed = stream.mock.calls.map(call => call[2]);
    const requested = request.mock.calls.map(call => JSON.parse(call[2].body));
    expect(streamed.map(body => body.zero_data_retention)).toEqual([
      false,
      false,
      false,
      false,
      undefined,
      undefined
    ]);
    expect(requested.map(body => body.zero_data_retention)).toEqual([
      false,
      false,
      undefined
    ]);
  });
});

describe('Whether the panel offers it', () => {
  it('shows with an OpenRouter connection: the connected model, or a key of OpenRouter', () => {
    const elsewhere = statusOf({
      claude: { ...statusOf().claude!, provider: 'anthropic' }
    });
    expect(usesOpenRouter(statusOf(), null)).toBe(true);
    expect(usesOpenRouter(elsewhere, null)).toBe(false);
    expect(usesOpenRouter(elsewhere, stateOf('anthropic', false))).toBe(false);
    expect(usesOpenRouter(elsewhere, stateOf('anthropic', true))).toBe(true);
    expect(usesOpenRouter(elsewhere, stateOf('openrouter', false))).toBe(true);
    expect(usesOpenRouter(null, null)).toBe(false);
  });
});

describe('The box', () => {
  it('changes with a click while the server leaves it to the analyst', async () => {
    const changes: boolean[] = [];
    const view = await mount(
      <RetentionToggle
        id="box"
        checked={true}
        fixed={false}
        onChange={value => changes.push(value)}
      />
    );
    const box = view.host.querySelector<HTMLInputElement>('#box')!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(view.host.textContent).toContain('Zero data retention (OpenRouter)');
    expect(view.host.textContent).not.toContain(RETENTION_FIXED);
    await step(() => box.click());
    expect(box.checked).toBe(false);
    expect(changes).toEqual([false]);
  });

  it('shows on and greyed, with the reason, while the server pins it', async () => {
    const changes: boolean[] = [];
    const view = await mount(
      <RetentionToggle
        id="box"
        checked={false}
        fixed={true}
        onChange={value => changes.push(value)}
      />
    );
    const box = view.host.querySelector<HTMLInputElement>('#box')!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(view.host.textContent).toContain(
      'Fixed on the server: c.Whybook.openrouter_zdr'
    );
    await step(() => box.click());
    expect(changes).toEqual([]);
  });
});

describe('The AI models panel', () => {
  async function openPanel(status: IServerStatus, state: IConnectionState) {
    answer(status, state);
    const { model } = benchModel([{ id: 'a' }]);
    models.push(model);
    const view = await mount(
      <AIButton model={model} openSettings={() => undefined} />
    );
    await settle();
    await step(() =>
      view.host.querySelector<HTMLButtonElement>('.jp-Epi-aibutton')!.click()
    );
    await settle();
    const panel = document.body.querySelector('.jp-Epi-aipanel')!;
    return { model, panel };
  }

  it('offers the box beside "Keep data on this machine", on by default, and the requests follow it', async () => {
    const { model, panel } = await openPanel(
      statusOf(),
      stateOf('openrouter', true)
    );
    const box = panel.querySelector<HTMLInputElement>(
      '#jp-Epi-quick-zeroDataRetention'
    )!;
    expect(box).not.toBeNull();
    // In the block of "Keep data on this machine", after it.
    const policies = panel.querySelector('.jp-Epi-policies')!;
    expect(
      Array.from(policies.querySelectorAll('input')).map(input => input.id)
    ).toEqual(['jp-Epi-quick-keepDataLocal', 'jp-Epi-quick-zeroDataRetention']);
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    await step(() => box.click());
    await settle();
    expect(model.settings.zeroDataRetention).toBe(false);
    expect(box.checked).toBe(false);
    stream.mockClear();
    await model.api.solve({ question: { text: 'q' } }, () => {});
    expect(stream.mock.calls[0][2].zero_data_retention).toBe(false);
  });

  it('shows the box on and greyed, with the reason, while the server pins it, whatever the setting says', async () => {
    const { model, panel } = await openPanel(
      statusOf({ openrouter_zdr: true }),
      stateOf('openrouter', true)
    );
    await step(() => model.settings.set('zeroDataRetention', false));
    await settle();
    const box = panel.querySelector<HTMLInputElement>(
      '#jp-Epi-quick-zeroDataRetention'
    )!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(panel.textContent).toContain(
      'Fixed on the server: c.Whybook.openrouter_zdr'
    );
    // The requests do not ask for every provider: the server would refuse it anyway.
    stream.mockClear();
    await model.api.solve({ question: { text: 'q' } }, () => {});
    expect(stream.mock.calls[0][2]).not.toHaveProperty('zero_data_retention');
  });

  it('leaves the box out without an OpenRouter connection', async () => {
    const elsewhere = statusOf({
      claude: { ...statusOf().claude!, provider: 'anthropic' }
    });
    const { panel } = await openPanel(elsewhere, stateOf('anthropic', false));
    expect(panel.querySelector('#jp-Epi-quick-keepDataLocal')).not.toBeNull();
    expect(panel.querySelector('#jp-Epi-quick-zeroDataRetention')).toBeNull();
  });
});

describe('The field of the settings editor', () => {
  function settingsOf(value: boolean) {
    const saved: [string, unknown][] = [];
    const settings = {
      composite: { zeroDataRetention: value },
      user: {},
      changed: new Signal({}),
      set: async (key: string, next: unknown) => {
        saved.push([key, next]);
      }
    } as unknown as ISettingRegistry.ISettings;
    return { settings, saved };
  }

  it('is read only and on while the server pins it', async () => {
    answer(statusOf({ openrouter_zdr: true }), stateOf('openrouter', true));
    const Field = retentionFieldRenderer(new Api(server));
    const { settings, saved } = settingsOf(false);
    const view = await mount(<Field formContext={{ settings }} />);
    await settle();
    const box = view.host.querySelector<HTMLInputElement>(
      '#jp-Epi-settings-zeroDataRetention'
    )!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(view.host.textContent).toContain(RETENTION_FIXED);
    await step(() => box.click());
    expect(saved).toEqual([]);
  });

  it("saves the analyst's choice while the server leaves it to them", async () => {
    answer(statusOf(), stateOf('openrouter', true));
    const Field = retentionFieldRenderer(new Api(server));
    const { settings, saved } = settingsOf(true);
    const view = await mount(<Field formContext={{ settings }} />);
    await settle();
    const box = view.host.querySelector<HTMLInputElement>(
      '#jp-Epi-settings-zeroDataRetention'
    )!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    await step(() => box.click());
    expect(saved).toEqual([['zeroDataRetention', false]]);
    expect(box.checked).toBe(false);
  });
});
