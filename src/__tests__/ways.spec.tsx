/**
 * The screen "Three ways to use models" (design iteration 1.131): what each
 * way's button sets, where the AI models panel opens after it, when the
 * screen shows by itself, the hold on the requests that a model reads while
 * it is open, and the screen and the panel as they draw. No model is called,
 * and nothing downloads: the routes are mocked.
 */
import './fakes/quiet';

import type { ServerConnection } from '@jupyterlab/services';
import * as React from 'react';

import type { ILocalModel, IServerStatus } from '../model/api';
import { Api } from '../model/api';
import { ModelGate, modelGate } from '../model/gate';
import type { ModelChoices } from '../model/models';
import { DEFAULT_MODELS } from '../model/models';
import type { IScreenSettings } from '../model/ways';
import {
  blockedReason,
  currentWay,
  LOCAL_EXTRA,
  needsOf,
  nextStep,
  readScreenSettings,
  savedWaySettings,
  screenShows,
  serverDecides,
  waySettings
} from '../model/ways';
import { requestAPI, streamAPI } from '../request';
import { AIButton } from '../ui/aipanel';
import { DataPolicyToggle, dataPolicyFixed } from '../ui/datapolicy';
import { showThreeWays, ThreeWays } from '../ui/ways';
import welcomeSchema from '../../schema/welcome.json';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

jest.mock('../request', () => ({
  requestAPI: jest.fn(),
  streamAPI: jest.fn()
}));

const request = requestAPI as jest.Mock;
const stream = streamAPI as jest.Mock;
const server = {} as ServerConnection.ISettings;

beforeEach(() => {
  // No server runs in the tests: a request fails at once.
  request.mockReset();
  request.mockRejectedValue(new Error('no server'));
  stream.mockReset();
  stream.mockResolvedValue(undefined);
});

/** Gemma 4 E2B, whose file is not on this machine yet. */
const GEMMA_MISSING: ILocalModel = {
  id: 'gemma-4-e2b',
  label: 'Gemma 4 E2B',
  kind: 'local',
  tier: 'recommended',
  size_mb: 2841,
  note: 'a note',
  repo: 'ggml-org/gemma-4-E2B-it-GGUF',
  available: false,
  reason:
    'not downloaded: hf download ggml-org/gemma-4-E2B-it-GGUF gemma-4-E2B-it-Q4_0.gguf',
  downloadable: true,
  tasks: null,
  decision: false
};

const GEMMA_HERE: ILocalModel = {
  ...GEMMA_MISSING,
  available: true,
  reason: null,
  downloadable: false
};

const MINISTRAL_HERE: ILocalModel = {
  ...GEMMA_HERE,
  id: 'ministral-3-3b',
  label: 'Ministral 3 3B',
  size_mb: 2147
};

/** A decision model on this machine: user questions and their order alone. */
const JEVK5_HERE: ILocalModel = {
  ...GEMMA_HERE,
  id: 'jevk5-4b',
  label: 'JevK5 v0.3 (4B)',
  tier: 'decision',
  tasks: ['typed', 'ranking'],
  decision: true
};

/** The server's status: the connected model, the local models, and what the server fixes. */
function serverStatus(
  options: {
    connected?: 'hosted' | 'here' | null;
    local?: ILocalModel[];
    runtime?: boolean;
    keep?: boolean;
    way?: string;
  } = {}
): IServerStatus {
  const connected = options.connected ?? null;
  return {
    ranker: 'heuristic',
    claude_available: connected !== null,
    claude: {
      available: connected !== null,
      cli: null,
      credential: null,
      reason: connected ? null : 'no model is connected',
      setup: connected ? null : 'Connect one in the AI models panel.',
      provider:
        connected === 'hosted'
          ? 'openrouter'
          : connected === 'here'
            ? 'ollama'
            : 'none',
      model: connected ? 'a-model' : null,
      label:
        connected === 'hosted'
          ? 'OpenRouter: anthropic/claude-sonnet-5'
          : connected === 'here'
            ? 'Ollama: qwen3.8:27b'
            : 'No model connected',
      local: connected === 'here'
    },
    local_models: options.local ?? [GEMMA_MISSING],
    local_runtime: options.runtime ?? true,
    keep_data_local: options.keep ?? false,
    way_to_use_models: options.way ?? ''
  } as IServerStatus;
}

/** The analyst's models after an earlier choice of the second way: a local model for labels. */
const LOCAL_LABELS: ModelChoices = { ...DEFAULT_MODELS, labels: 'gemma-4-e2b' };

describe('What each way sets', () => {
  it('Frontier models for everything lets the data leave and gives the three tasks of the remote model back to it', () => {
    const before: ModelChoices = {
      ...LOCAL_LABELS,
      cells: 'off',
      questions: 'qwen3-4b',
      typed: 'gemma-4-e2b',
      ranking: 'rules',
      speech: 'browser-local'
    };
    expect(waySettings('remote', serverStatus(), before)).toEqual({
      keepDataLocal: false,
      models: {
        cells: 'remote',
        questions: 'remote:fast',
        labels: 'remote:fastest',
        // The analyst's other choices stay.
        typed: 'gemma-4-e2b',
        ranking: 'rules',
        speech: 'browser-local'
      }
    });
    // A remote choice of the analyst's own stays.
    const own: ModelChoices = {
      ...DEFAULT_MODELS,
      questions: 'remote:openrouter:z-ai/glm-5.3-flash'
    };
    expect(waySettings('remote', serverStatus(), own).models.questions).toBe(
      'remote:openrouter:z-ai/glm-5.3-flash'
    );
  });

  it('Data stays on this machine keeps the data here, gives labels and captions Gemma 4 E2B, and leaves the code to the connected model', () => {
    const before: ModelChoices = { ...DEFAULT_MODELS, cells: 'off' };
    expect(waySettings('data-stays-here', serverStatus(), before)).toEqual({
      keepDataLocal: true,
      models: {
        ...DEFAULT_MODELS,
        cells: 'remote',
        labels: 'gemma-4-e2b'
      }
    });
  });

  it('takes a local model that is on this machine already, so that nothing needs a download', () => {
    const labels = (local: ILocalModel[], models = DEFAULT_MODELS) =>
      waySettings('data-stays-here', serverStatus({ local }), models).models
        .labels;
    // Gemma first when it is here, then any other one that is here.
    expect(labels([MINISTRAL_HERE, GEMMA_HERE])).toBe('gemma-4-e2b');
    expect(labels([GEMMA_MISSING, MINISTRAL_HERE])).toBe('ministral-3-3b');
    // The analyst's own local choice, when it is here.
    expect(
      labels([GEMMA_HERE, MINISTRAL_HERE], {
        ...DEFAULT_MODELS,
        labels: 'ministral-3-3b'
      })
    ).toBe('ministral-3-3b');
    // A decision model writes no labels.
    expect(labels([JEVK5_HERE, GEMMA_MISSING])).toBe('gemma-4-e2b');
    // With none here, the analyst's own local choice still, else Gemma.
    expect(
      labels([GEMMA_MISSING, { ...MINISTRAL_HERE, available: false }], {
        ...DEFAULT_MODELS,
        labels: 'ministral-3-3b'
      })
    ).toBe('ministral-3-3b');
    expect(labels([])).toBe('gemma-4-e2b');
  });

  it('All local also gives user questions and their order back to the rules where a decision model of OpenRouter had them', () => {
    const before: ModelChoices = {
      ...DEFAULT_MODELS,
      typed: 'decision:jev',
      ranking: 'decision:clef'
    };
    expect(waySettings('all-local', serverStatus(), before)).toEqual({
      keepDataLocal: true,
      models: {
        ...DEFAULT_MODELS,
        labels: 'gemma-4-e2b',
        typed: 'rules',
        ranking: 'rules'
      }
    });
    // A decision model on this machine stays.
    const here: ModelChoices = { ...DEFAULT_MODELS, typed: 'jevk5-4b' };
    expect(waySettings('all-local', serverStatus(), here).models.typed).toBe(
      'jevk5-4b'
    );
  });

  it('reads the settings saved in the registry, with the defaults, for the screen with no view open', () => {
    expect(savedWaySettings({}, null)).toEqual({
      keepDataLocal: false,
      models: DEFAULT_MODELS
    });
    expect(
      savedWaySettings(
        {
          keepDataLocal: true,
          models: { ...DEFAULT_MODELS, labels: 'qwen3-4b' }
        },
        { models: { labels: 'qwen3-4b' } }
      )
    ).toEqual({
      keepDataLocal: true,
      models: { ...DEFAULT_MODELS, labels: 'qwen3-4b' }
    });
  });
});

describe('Where the AI models panel opens after a way', () => {
  it('opens at the Download of the local model when its file is not here, before anything else', () => {
    const status = serverStatus();
    for (const way of ['data-stays-here', 'all-local'] as const) {
      const { models } = waySettings(way, status, DEFAULT_MODELS);
      expect(nextStep(way, status, models)).toEqual({
        kind: 'download',
        task: 'labels'
      });
    }
  });

  it('opens at the list of providers when the way needs a model that is not connected', () => {
    const here = [GEMMA_HERE];
    const at = (
      way: 'remote' | 'data-stays-here' | 'all-local',
      connected: 'hosted' | 'here' | null
    ) => {
      const status = serverStatus({ connected, local: here });
      return nextStep(
        way,
        status,
        waySettings(way, status, DEFAULT_MODELS).models
      );
    };
    expect([
      at('remote', null),
      at('remote', 'hosted'),
      at('remote', 'here'),
      at('data-stays-here', null),
      at('data-stays-here', 'hosted'),
      at('data-stays-here', 'here'),
      at('all-local', null),
      at('all-local', 'hosted'),
      at('all-local', 'here')
    ]).toEqual([
      { kind: 'connect', here: false },
      null,
      // A hosted frontier model in place of the model on this machine.
      { kind: 'connect', here: false },
      { kind: 'connect', here: false },
      null,
      // A model on this machine may read the data too.
      null,
      { kind: 'connect', here: true },
      // The code would go to the hosted model: a model on this machine instead.
      { kind: 'connect', here: true },
      null
    ]);
  });
});

describe('A way that cannot be chosen', () => {
  it('shows the line that installs the local models in place of the button of the two local ways', () => {
    const status = serverStatus({ runtime: false });
    expect(blockedReason('remote', status)).toBeNull();
    expect(blockedReason('data-stays-here', status)).toBe(LOCAL_EXTRA);
    expect(blockedReason('all-local', status)).toBe(LOCAL_EXTRA);
    expect(LOCAL_EXTRA).toBe(
      'Needs the local extra on the server: pip install "whybook[local]", then a restart. pip builds llama-cpp-python with a C++ compiler, in about 4 minutes.'
    );
    // An older server that does not say leaves the buttons as they are.
    const older = serverStatus();
    delete older.local_runtime;
    expect(blockedReason('data-stays-here', older)).toBeNull();
  });

  it('says that the server keeps the data here, or sets another way, for every user', () => {
    expect(blockedReason('remote', serverStatus({ keep: true }))).toBe(
      'The server keeps the data on this machine for every user: c.Whybook.keep_data_local.'
    );
    expect(
      blockedReason('data-stays-here', serverStatus({ keep: true }))
    ).toBeNull();
    const remote = serverStatus({ way: 'remote' });
    expect(blockedReason('remote', remote)).toBeNull();
    expect(blockedReason('all-local', remote)).toBe(
      'The server sets the way for every user: c.Whybook.way_to_use_models = "remote".'
    );
    // All local on the server keeps the data here too, and greys both other ways.
    const allLocal = serverStatus({ way: 'all-local', keep: true });
    expect([
      blockedReason('remote', allLocal),
      blockedReason('data-stays-here', allLocal),
      blockedReason('all-local', allLocal)
    ]).toEqual([
      'The server sets the way for every user: c.Whybook.way_to_use_models = "all-local".',
      'The server sets the way for every user: c.Whybook.way_to_use_models = "all-local".',
      null
    ]);
  });
});

describe('What a way needs, on this server', () => {
  it('names the model to connect and the download with its size', () => {
    const status = serverStatus();
    expect(needsOf('remote', status, DEFAULT_MODELS)).toEqual([
      'A hosted model: sign in to OpenRouter, or paste the key of a provider',
      'No download'
    ]);
    expect(needsOf('data-stays-here', status, DEFAULT_MODELS)).toEqual([
      'Gemma 4 E2B for labels and captions, a download of 2.8 GB',
      'A hosted model for the code: a sign-in or a key'
    ]);
    expect(needsOf('all-local', status, DEFAULT_MODELS)).toEqual([
      'Gemma 4 E2B for labels and captions, a download of 2.8 GB',
      'A model server for the code, on this machine or in your network, such as Ollama, with a larger model'
    ]);
  });

  it('names what is here already', () => {
    const hosted = serverStatus({ connected: 'hosted', local: [GEMMA_HERE] });
    expect(needsOf('remote', hosted, DEFAULT_MODELS)[0]).toBe(
      'OpenRouter: anthropic/claude-sonnet-5, connected'
    );
    expect(needsOf('data-stays-here', hosted, DEFAULT_MODELS)).toEqual([
      'Gemma 4 E2B for labels and captions, on this machine',
      'OpenRouter: anthropic/claude-sonnet-5 for the code, connected'
    ]);
    const here = serverStatus({ connected: 'here', local: [GEMMA_HERE] });
    expect(needsOf('all-local', here, DEFAULT_MODELS)[1]).toBe(
      'Ollama: qwen3.8:27b for the code, on this machine'
    );
  });

  it('names the local extra first when the local models cannot run', () => {
    const status = serverStatus({ runtime: false });
    expect(needsOf('data-stays-here', status, DEFAULT_MODELS)).toEqual([
      'The local extra on the server',
      'Gemma 4 E2B for labels and captions, a download of 2.8 GB',
      'A hosted model for the code: a sign-in or a key'
    ]);
    expect(needsOf('remote', status, DEFAULT_MODELS)).toEqual([
      'A hosted model: sign in to OpenRouter, or paste the key of a provider',
      'No download'
    ]);
  });
});

describe('The way that the settings make true now', () => {
  it('is the first way with the defaults, and follows the settings', () => {
    const here = serverStatus({ connected: 'here', local: [GEMMA_HERE] });
    expect(currentWay(serverStatus(), false, DEFAULT_MODELS)).toBe('remote');
    expect(currentWay(serverStatus(), true, LOCAL_LABELS)).toBe(
      'data-stays-here'
    );
    expect(currentWay(here, true, LOCAL_LABELS)).toBe('all-local');
    // The data kept here with labels by the remote model fits no way.
    expect(currentWay(serverStatus(), true, DEFAULT_MODELS)).toBeNull();
    // Nor does a remote model kept off cells and answers.
    expect(
      currentWay(serverStatus(), false, { ...DEFAULT_MODELS, cells: 'off' })
    ).toBeNull();
    // The server's lock keeps the data here, whatever the setting.
    expect(currentWay(serverStatus({ keep: true }), false, LOCAL_LABELS)).toBe(
      'data-stays-here'
    );
  });
});

describe('When the screen shows by itself', () => {
  const first: IScreenSettings = { when: 'notebook', shown: false };

  it('shows once, at the moment its setting names, unless the server decides', () => {
    const status = serverStatus();
    expect(screenShows('notebook', first, status)).toBe(true);
    expect(screenShows('call', first, status)).toBe(false);
    expect(screenShows('notebook', { ...first, shown: true }, status)).toBe(
      false
    );
    expect(screenShows('call', { when: 'call', shown: false }, status)).toBe(
      true
    );
    expect(
      screenShows('notebook', { when: 'never', shown: false }, status)
    ).toBe(false);
    // A server that does not answer: nothing to choose from.
    expect(screenShows('notebook', first, null)).toBe(false);
    expect(screenShows('notebook', first, serverStatus({ keep: true }))).toBe(
      false
    );
    for (const way of ['remote', 'data-stays-here', 'all-local']) {
      expect(screenShows('notebook', first, serverStatus({ way }))).toBe(false);
    }
    expect(serverDecides(serverStatus({ way: 'remote' }))).toBe(
      'c.Whybook.way_to_use_models = "remote"'
    );
    expect(serverDecides(serverStatus({ way: 'all-local', keep: true }))).toBe(
      'c.Whybook.way_to_use_models = "all-local"'
    );
    expect(serverDecides(serverStatus({ keep: true }))).toBe(
      'c.Whybook.keep_data_local'
    );
    expect(serverDecides(status)).toBeNull();
  });

  it('reads its settings with the defaults of schema/welcome.json', () => {
    expect(
      readScreenSettings({
        when: welcomeSchema.properties.when.default,
        shown: welcomeSchema.properties.shown.default
      })
    ).toEqual(first);
    expect(readScreenSettings({})).toEqual(first);
    expect(readScreenSettings({ when: 'call', shown: true })).toEqual({
      when: 'call',
      shown: true
    });
    expect(readScreenSettings({ when: 'often' }).when).toBe('notebook');
  });
});

describe('"Keep data on this machine" when the server fixes it', () => {
  it('names the setting of the server that fixes it', async () => {
    const way = serverStatus({ way: 'data-stays-here', keep: true });
    const view = await mount(
      <DataPolicyToggle
        id="jp-Epi-test-keepDataLocal"
        checked={false}
        fixed
        fixedNote={dataPolicyFixed(way)}
        onChange={() => undefined}
      />
    );
    const box = view.host.querySelector('input')!;
    const found = {
      checked: box.checked,
      disabled: box.disabled,
      note: view.host.querySelector('.jp-Epi-aipanel-note')?.textContent
    };
    await view.unmount();
    expect(found).toEqual({
      checked: true,
      disabled: true,
      note: 'Fixed on the server: c.Whybook.way_to_use_models = "data-stays-here"'
    });
    expect(dataPolicyFixed(serverStatus({ keep: true }))).toBe(
      'Fixed on the server: c.Whybook.keep_data_local'
    );
    expect(
      dataPolicyFixed(serverStatus({ way: 'all-local', keep: true }))
    ).toBe('Fixed on the server: c.Whybook.way_to_use_models = "all-local"');
  });
});

describe('The hold on the requests that a model reads', () => {
  it('lets a request go at once while open, and holds every one until the screen closes', async () => {
    const hold = new ModelGate<string>();
    expect(hold.wait('a')).toBeNull();
    let close!: () => void;
    const held = hold.hold(new Promise<void>(resolve => (close = resolve)));
    expect(hold.wait('a')).toBe(held);
    expect(hold.wait('b')).toBe(held);
    close();
    await held;
    expect(hold.wait('a')).toBeNull();
  });

  it('shows the screen at the first request when armed, once, with the view that asks', async () => {
    const hold = new ModelGate<string>();
    const asked: string[] = [];
    let close!: () => void;
    hold.arm(view => {
      asked.push(view);
      return new Promise<void>(resolve => (close = resolve));
    });
    const first = hold.wait('view 1');
    const second = hold.wait('view 2');
    expect(asked).toEqual(['view 1']);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(hold.armed).toBe(false);
    close();
    await first;
    expect(hold.wait('view 3')).toBeNull();
    expect(asked).toEqual(['view 1']);
  });

  it('holds a request of the API client, and sends it with the settings of the moment it goes', async () => {
    const hold = new ModelGate<null>();
    let keep = false;
    const api = new Api(server, {
      keepDataLocal: () => keep,
      beforeModel: () => hold.wait(null)
    });
    let close!: () => void;
    void hold.hold(new Promise<void>(resolve => (close = resolve)));
    const sent = api.describeTables(
      { model: 'remote:fastest', tables: [] },
      () => undefined
    );
    // A request that no model reads goes at once.
    void api.drop({ source: {} }).catch(() => undefined);
    await Promise.resolve();
    expect(stream).not.toHaveBeenCalled();
    expect(request.mock.calls.map(call => call[0])).toEqual(['drop']);
    // The analyst chose "Data stays on this machine" meanwhile.
    keep = true;
    close();
    await sent;
    expect(stream.mock.calls.map(call => [call[0], call[2]])).toEqual([
      [
        'tables/describe',
        { model: 'remote:fastest', tables: [], keep_data_local: true }
      ]
    ]);
  });

  it('holds the requests of a notebook in Whybook with the one hold of the application', async () => {
    const { model } = benchModel([{ id: 'a', source: 'x = 1', count: 1 }]);
    let close!: () => void;
    const held = modelGate.hold(
      new Promise<void>(resolve => (close = resolve))
    );
    const sent = model.api.titleCells(
      { model: 'remote:fastest', cells: [] },
      () => undefined
    );
    await Promise.resolve();
    const before = stream.mock.calls.length;
    close();
    await held;
    await sent;
    const after = stream.mock.calls.map(call => call[0]);
    model.dispose();
    expect(before).toBe(0);
    expect(after).toEqual(['cells/title']);
  });
});

describe('The screen', () => {
  /** The cards as the screen draws them: the name, whether it can be pressed, its marks, its needs and why not. */
  async function draw(
    status: IServerStatus | null,
    keepDataLocal = false,
    models: ModelChoices = DEFAULT_MODELS
  ) {
    const chosen: string[] = [];
    const view = await mount(
      <ThreeWays
        status={status}
        keepDataLocal={keepDataLocal}
        models={models}
        onChoose={way => chosen.push(way)}
      />
    );
    const cards = Array.from(view.host.querySelectorAll('.jp-Epi-way')).map(
      card => ({
        name: card.querySelector('button')!.textContent,
        enabled: !card.querySelector('button')!.disabled,
        marks: Array.from(card.querySelectorAll('.jp-Epi-way-mark')).map(
          mark => mark.textContent
        ),
        needs: Array.from(card.querySelectorAll('li')).map(
          item => item.textContent
        ),
        leaves: card.querySelector('dd:last-of-type')?.textContent,
        blocked: card.querySelector('.jp-Epi-way-blocked')?.textContent ?? null
      })
    );
    return { view, cards, chosen };
  }

  it('offers three large buttons, and marks the way of the settings as they are', async () => {
    const { view, cards, chosen } = await draw(serverStatus());
    const lead = view.host.querySelector('.jp-Epi-ways-lead')!.textContent;
    const note = view.host.querySelector('.jp-Epi-ways-note')!.textContent;
    const facts = Array.from(
      view.host.querySelectorAll('.jp-Epi-way[data-way="all-local"] dt')
    ).map(term => term.textContent);
    await step(() =>
      Array.from(view.host.querySelectorAll('button'))
        .find(button => button.textContent === 'Data stays on this machine')!
        .click()
    );
    await view.unmount();
    expect(lead).toBe(
      "Choose where models run, and what leaves this machine. A way sets Whybook's AI settings, then the AI models panel shows what is left to do. Nothing downloads, and no model is called, until you ask there."
    );
    expect(note).toBe(
      'Decide later does not change a setting. The AI models panel and the command palette open this screen again.'
    );
    expect(cards.map(card => [card.name, card.enabled, card.marks])).toEqual([
      ['Frontier models for everything', true, ['Now']],
      ['Data stays on this machine', true, []],
      ['All local', true, []]
    ]);
    expect(cards[1].needs).toEqual([
      'Gemma 4 E2B for labels and captions, a download of 2.8 GB',
      'A hosted model for the code: a sign-in or a key'
    ]);
    expect(facts).toEqual(['For', 'Needs', 'Leaves this machine']);
    // The code of the cells goes out with the first way.
    expect(cards[0].leaves).toBe(
      'The code of the cells, tables, pictures and variables, as each task needs them.'
    );
    expect(chosen).toEqual(['data-stays-here']);
  });

  it('shows the install line in place of the button of the two local ways when the local models cannot run', async () => {
    const { view, cards } = await draw(serverStatus({ runtime: false }));
    const commands = Array.from(
      view.host.querySelectorAll('.jp-Epi-way-blocked code')
    ).map(code => code.textContent);
    await view.unmount();
    expect(cards.map(card => [card.enabled, card.blocked])).toEqual([
      [true, null],
      [false, LOCAL_EXTRA],
      [false, LOCAL_EXTRA]
    ]);
    expect(commands).toEqual([
      'pip install "whybook[local]"',
      'pip install "whybook[local]"'
    ]);
  });

  it('greys the first way when the server keeps the data here, and marks the way of the settings', async () => {
    const { view, cards } = await draw(
      serverStatus({ keep: true, local: [GEMMA_HERE] }),
      false,
      LOCAL_LABELS
    );
    await view.unmount();
    expect(cards.map(card => [card.enabled, card.marks])).toEqual([
      [false, []],
      [true, ['Now']],
      [true, []]
    ]);
  });

  it('opens in a dialog: Enter on a way presses it, and "Decide later" chooses none', async () => {
    const state = {
      status: serverStatus(),
      keepDataLocal: false,
      models: DEFAULT_MODELS
    };
    const findButton = async (text: string) => {
      for (let tries = 0; tries < 50; tries++) {
        const found = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('button')
        ).find(button => button.textContent?.trim() === text);
        if (found) {
          return found;
        }
        await settle(10);
      }
      throw new Error(`no button "${text}"`);
    };
    const pressed = showThreeWays(state);
    const way = await findButton('All local');
    const title = document.body.querySelector('.jp-Dialog-header')?.textContent;
    // "Decide later" has the focus, so no way has it.
    for (
      let tries = 0;
      tries < 50 &&
      document.activeElement?.textContent?.trim() !== 'Decide later';
      tries++
    ) {
      await settle(10);
    }
    const focused = document.activeElement?.textContent?.trim();
    way.focus();
    way.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    const first = await pressed;
    const later = showThreeWays(state);
    const decide = await findButton('Decide later');
    await step(() => decide.click());
    const second = await later;
    expect(title).toContain('Three ways to use models');
    expect(focused).toBe('Decide later');
    expect(first).toBe('all-local');
    expect(second).toBeNull();
    expect(document.body.querySelector('.jp-Epi-ways')).toBeNull();
  });
});

describe('The AI models panel at the step that a way leaves', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => undefined;
    (globalThis as any).ResizeObserver = class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  });
  afterAll(() => {
    delete (globalThis as any).ResizeObserver;
  });

  /** A notebook in Whybook after "Data stays on this machine", with the panel of its toolbar. */
  async function panelAfterTheWay(status: IServerStatus) {
    const { model } = benchModel([{ id: 'a', source: 'x = 1', count: 1 }]);
    await settle();
    (model.api as any).status = async () => status;
    model.status = status;
    const next = waySettings('data-stays-here', status, DEFAULT_MODELS);
    model.settings.keepDataLocal = next.keepDataLocal;
    model.settings.models = next.models;
    const downloads: string[] = [];
    (model.api as any).downloadModel = async (id: string) => {
      downloads.push(id);
    };
    const toolbar = await mount(
      <AIButton model={model} openSettings={() => undefined} />
    );
    return {
      model,
      downloads,
      panel: () => document.body.querySelector<HTMLElement>('.jp-Epi-aipanel'),
      close: async () => {
        await toolbar.unmount();
        model.dispose();
      },
      next
    };
  }

  it('opens with the focus on the Download of the local model, which starts nothing until it is pressed', async () => {
    const { model, downloads, panel, close, next } =
      await panelAfterTheWay(serverStatus());
    await step(() =>
      model.requestModelsPanel(
        nextStep('data-stays-here', model.status, next.models)
      )
    );
    await settle();
    const focused = document.activeElement as HTMLElement | null;
    const found = {
      focus: focused?.textContent,
      line: focused?.closest('.jp-Epi-aipanel-note')?.textContent,
      before: [...downloads]
    };
    await step(() => focused?.click());
    found.before.push(...downloads.map(id => `pressed: ${id}`));
    const opened = !!panel();
    await close();
    expect(opened).toBe(true);
    expect(found).toEqual({
      focus: 'Download 2.8 GB',
      line: 'Not downloaded. Download 2.8 GB from ggml-org/gemma-4-E2B-it-GGUF on Hugging Face',
      before: ['pressed: gemma-4-e2b']
    });
  });

  it('opens the list of providers when the way needs a model that is not connected', async () => {
    const status = serverStatus({ local: [GEMMA_HERE] });
    const { model, panel, close } = await panelAfterTheWay(status);
    (model.api as any).connection = async () => ({
      connection: {
        provider: 'none',
        model: null,
        base_url: null,
        local: false
      },
      readiness: { ...status.claude, label: 'No model connected' },
      providers: [],
      huggingface_signin: false,
      models_installed: true
    });
    (model.api as any).localServers = async () => ({ servers: [] });
    await step(() =>
      model.requestModelsPanel(
        nextStep('data-stays-here', status, model.settings.models)
      )
    );
    await settle();
    const groups = Array.from(
      panel()?.querySelectorAll('.jp-Epi-connection-group') ?? []
    ).map(group => group.textContent);
    await close();
    expect(groups).toEqual([
      'On this machine',
      'Sign in',
      'With an API key',
      'Other'
    ]);
  });

  it('offers only servers on this machine or in its network when the server sets All local, and says why a hosted model cannot run', async () => {
    const status = serverStatus({
      way: 'all-local',
      keep: true,
      local: [GEMMA_HERE]
    });
    const { model, panel, close } = await panelAfterTheWay(status);
    // A hosted model connected before the server set All local: the server
    // refuses it (whybook/server/connection.py, outside).
    (model.api as any).connection = async () => ({
      connection: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5',
        base_url: null,
        local: false
      },
      readiness: {
        ...status.claude,
        available: false,
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5',
        label: 'OpenRouter: anthropic/claude-sonnet-5',
        reason: 'OpenRouter runs outside this machine and its network',
        setup:
          'The server sets c.Whybook.way_to_use_models = "all-local": in the AI models panel, connect a model server on this machine or in its network.'
      },
      providers: [
        {
          id: 'openrouter',
          label: 'OpenRouter',
          local: false,
          base_url: 'https://openrouter.ai/api/v1',
          signin: 'openrouter',
          needs_key: true,
          dev_only: false,
          signed_in: true,
          key_from: 'openrouter',
          saved: null,
          installed: true
        }
      ],
      huggingface_signin: true,
      models_installed: true,
      network_only: true
    });
    (model.api as any).localServers = async () => ({ servers: [] });
    await step(() =>
      model.requestModelsPanel(
        nextStep('all-local', status, model.settings.models)
      )
    );
    await settle();
    const found = {
      groups: Array.from(
        panel()?.querySelectorAll('.jp-Epi-connection-group') ?? []
      ).map(group => group.textContent),
      note: panel()?.querySelector('.jp-Epi-connection-network')?.textContent,
      refused: Array.from(
        panel()?.querySelectorAll('.jp-Epi-aipanel-note') ?? []
      )
        .map(line => line.textContent ?? '')
        .find(line => line.startsWith('Cannot run')),
      signIn: Array.from(panel()?.querySelectorAll('button') ?? []).some(
        button => button.textContent === 'Sign in'
      )
    };
    await close();
    expect(found).toEqual({
      groups: ['On this machine', 'Other'],
      note: 'Sign-ins and API keys of hosted providers are off on this server (c.Whybook.way_to_use_models = "all-local"). A model server in your network goes under Other, at its URL.',
      refused:
        'Cannot run: OpenRouter runs outside this machine and its network. The server sets c.Whybook.way_to_use_models = "all-local": in the AI models panel, connect a model server on this machine or in its network.',
      signIn: false
    });
  });
});
