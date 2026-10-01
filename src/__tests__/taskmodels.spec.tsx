/**
 * A remote model for each task (design iteration 1.81): a task takes the
 * connected model, a tier of faster models of its provider, or one model
 * that the provider lists, with the same key. Code and answers keep the
 * connected model; More questions take the fast tier by default.
 */
import './fakes/quiet';

import * as React from 'react';

import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Signal } from '@lumino/signaling';

import type { Api, IConnectionState, IServerStatus } from '../model/api';
import {
  aiSummary,
  choicesFor,
  choiceOf,
  DEFAULT_MODELS,
  isRemote,
  modelAvailable,
  PICK_MODEL,
  readModels,
  remoteChoice,
  shownChoice
} from '../model/models';
import { requestAPI, streamAPI } from '../request';
import { AIButton } from '../ui/aipanel';
import { modelsFieldRenderer } from '../ui/modelsfield';
import { benchModel } from './fakes/bench-fake';
import type { IMounted } from './fakes/bench-render';
import { mount as mountView, settle, step } from './fakes/bench-render';

jest.mock('../request', () => ({
  requestAPI: jest.fn(),
  streamAPI: jest.fn()
}));

const request = requestAPI as jest.Mock;
const stream = streamAPI as jest.Mock;

const LUNA = {
  id: 'openai/gpt-6-luna',
  label: 'GPT-6 Luna',
  note: 'questions in about 7 s in the demo'
};
const GLM = {
  id: 'z-ai/glm-5.3-flash',
  label: 'GLM 5.3 Flash',
  note: 'questions in about 12 s in the demo'
};

/** A model connected through a provider, with the provider's models of each tier. */
function statusOf(
  provider = 'openrouter',
  tiers: IServerStatus['remote_tiers'] = { fast: [LUNA, GLM], fastest: [] }
): IServerStatus {
  return {
    ranker: 'heuristic',
    jev_configured: false,
    claude_available: true,
    claude: {
      available: true,
      cli: null,
      credential: provider,
      reason: null,
      setup: null,
      provider,
      model: 'anthropic/claude-sonnet-5',
      label: 'OpenRouter: anthropic/claude-sonnet-5',
      local: false,
      priced: true
    },
    describe_tables: true,
    remote_model: 'OpenRouter: anthropic/claude-sonnet-5',
    local_models: [],
    remote_tiers: tiers
  };
}

const STATE: IConnectionState = {
  connection: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5',
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
      signed_in: true,
      key_from: 'openrouter',
      saved: null,
      installed: true
    }
  ],
  huggingface_signin: false,
  models_installed: true
};

/** OpenRouter's list of models, as the panel's request reads it. */
const LISTED = [
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', note: null },
  { id: 'openai/gpt-6-nano', label: 'GPT-6 Nano', note: '$0.05 in' },
  LUNA
];

function answer(status: IServerStatus): void {
  request.mockImplementation(async (route: string) =>
    route === 'status'
      ? status
      : route === 'connection'
        ? STATE
        : route === 'connection/models'
          ? { models: LISTED }
          : route === 'connection/local'
            ? { servers: [] }
            : {}
  );
}

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

/** The labels of a select's options, and of the group of each. */
function optionsOf(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map(option => {
    const group = option.parentElement as HTMLOptGroupElement;
    return group.tagName === 'OPTGROUP'
      ? `${group.label} / ${option.text}`
      : option.text;
  });
}

describe('The choice of a task', () => {
  it('names the connected model, a tier, or a model of a provider', () => {
    expect(isRemote('remote')).toBe(true);
    expect(isRemote('remote:fast')).toBe(true);
    expect(isRemote('remote:openrouter:z-ai/glm-5.3-flash')).toBe(true);
    expect(isRemote('remote:')).toBe(false);
    expect(isRemote('gemma-4-e2b')).toBe(false);
    expect(remoteChoice('remote')).toBeNull();
    expect(remoteChoice('remote:fastest')).toEqual({ tier: 'fastest' });
    expect(
      remoteChoice('remote:huggingface:Qwen/Qwen3.8-27B:ovhcloud')
    ).toEqual({ provider: 'huggingface', model: 'Qwen/Qwen3.8-27B:ovhcloud' });
  });

  it('is the fast tier for More questions by default, the fastest for labels, and the connected model for code and answers', () => {
    expect(DEFAULT_MODELS.questions).toBe('remote:fast');
    expect(readModels({}).questions).toBe('remote:fast');
    expect(readModels({}).cells).toBe('remote');
    expect(readModels({}).labels).toBe('remote:fastest');
    // A choice that the analyst saved stays.
    expect(readModels({ questions: 'remote' }).questions).toBe('remote');
  });

  it('shows a tier that the provider has no model of as the connected model, which answers it', () => {
    const none = statusOf('anthropic', { fast: [], fastest: [] });
    expect(shownChoice(none, 'remote:fast')).toBe('remote');
    expect(shownChoice(statusOf(), 'remote:fast')).toBe('remote:fast');
    expect(shownChoice(statusOf(), 'remote:fastest')).toBe('remote');
    expect(shownChoice(statusOf(), 'gemma-4-e2b')).toBe('gemma-4-e2b');
    expect(modelAvailable(none, 'remote:fast', 'questions')).toBe(true);
  });
});

describe('The choices of a task', () => {
  it("offer the provider's faster models, and its whole list, to the tasks that need speed", () => {
    const ids = (task: 'questions' | 'labels' | 'ranking' | 'cells') =>
      choicesFor(statusOf(), task).map(choice => choice.id);
    expect(ids('questions')).toEqual([
      'remote',
      'remote:fast',
      'remote:openrouter:z-ai/glm-5.3-flash',
      'off',
      PICK_MODEL
    ]);
    expect(ids('labels')).toEqual(ids('questions'));
    expect(ids('ranking')).toEqual([
      'rules',
      'remote',
      'remote:fast',
      'remote:openrouter:z-ai/glm-5.3-flash',
      'jev',
      PICK_MODEL
    ]);
    // Code and answers keep the connected model.
    expect(ids('cells')).toEqual(['remote', 'off']);
    const fast = choicesFor(statusOf(), 'questions')[1];
    expect(fast.label).toBe('GPT-6 Luna, fast');
    expect(fast.group).toBe('Faster models of OpenRouter');
    expect(fast.note).toContain('questions in about 7 s in the demo');
    expect(fast.note).toContain('leave the machine');
  });

  it('offer a model that the analyst picked from the list, and say when it belongs to another provider', () => {
    const picked = 'remote:openrouter:openai/gpt-6-nano';
    const nano = choicesFor(statusOf(), 'questions', picked).find(
      choice => choice.id === picked
    )!;
    expect(nano.label).toBe('openai/gpt-6-nano, OpenRouter');
    expect(nano.available).toBe(true);
    // The analyst connected Anthropic since: the choice cannot run.
    const anthropic = statusOf('anthropic', { fast: [], fastest: [] });
    const other = choicesFor(anthropic, 'questions', picked).find(
      choice => choice.id === picked
    )!;
    expect(other.available).toBe(false);
    expect(other.reason).toBe(
      'openai/gpt-6-nano is a model of OpenRouter, and the connected model is not: choose another'
    );
    expect(modelAvailable(anthropic, picked, 'questions')).toBe(false);
    expect(aiSummary(anthropic, { ...DEFAULT_MODELS, questions: picked })).toBe(
      'AI: remote · 1 cannot run'
    );
    // A provider without tiers still offers its list; the Claude Code login has none.
    expect(choicesFor(anthropic, 'questions').map(choice => choice.id)).toEqual(
      ['remote', 'off', PICK_MODEL]
    );
    const login = statusOf('claude-code', { fast: [], fastest: [] });
    expect(choicesFor(login, 'questions').map(choice => choice.id)).toEqual([
      'remote',
      'off'
    ]);
  });
});

describe('The AI models panel', () => {
  async function openPanel(status: IServerStatus) {
    answer(status);
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
    const panel = document.body.querySelector<HTMLElement>('.jp-Epi-aipanel')!;
    return { model, panel };
  }

  it("shows the fast model for More questions, and takes another of the provider's models from its list", async () => {
    const { model, panel } = await openPanel(statusOf());
    const select = panel.querySelector<HTMLSelectElement>(
      '#jp-Epi-quick-questions'
    )!;
    expect(select.value).toBe('remote:fast');
    expect(optionsOf(select)).toEqual([
      'Remote AI model: OpenRouter: anthropic/claude-sonnet-5',
      'Faster models of OpenRouter / GPT-6 Luna, fast',
      'Faster models of OpenRouter / GLM 5.3 Flash, fast',
      'Off',
      'Another model of OpenRouter…'
    ]);
    // Code and answers keep the connected model alone.
    expect(
      optionsOf(panel.querySelector<HTMLSelectElement>('#jp-Epi-quick-cells')!)
    ).toEqual([
      'Remote AI model: OpenRouter: anthropic/claude-sonnet-5',
      'Off'
    ]);

    await step(() => {
      select.value = PICK_MODEL;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    // The choice stays until a model is picked.
    expect(choiceOf(model.settings.models, 'questions')).toBe('remote:fast');
    const picker = panel.querySelector<HTMLElement>(
      '.jp-Epi-taskpicker[data-task="questions"]'
    )!;
    expect(picker.textContent).toContain(
      'Models of OpenRouter for More questions'
    );
    const list = picker.querySelector<HTMLSelectElement>('select')!;
    expect(Array.from(list.options).map(option => option.text)).toEqual([
      'Choose a model',
      'Claude Sonnet 5',
      'GPT-6 Nano ($0.05 in)',
      'GPT-6 Luna (questions in about 7 s in the demo)'
    ]);
    await step(() => {
      list.value = 'openai/gpt-6-nano';
      list.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const use = Array.from(picker.querySelectorAll('button')).find(
      button => button.textContent === 'Use for More questions'
    )!;
    await step(() => use.click());
    await settle();
    expect(choiceOf(model.settings.models, 'questions')).toBe(
      'remote:openrouter:openai/gpt-6-nano'
    );
    expect(panel.querySelector('.jp-Epi-taskpicker')).toBeNull();
    expect(select.value).toBe('remote:openrouter:openai/gpt-6-nano');
    expect(select.selectedOptions[0].text).toBe(
      'openai/gpt-6-nano, OpenRouter'
    );
  });

  it('shows the connected model for the fast tier of a provider that has no faster model', async () => {
    const { panel } = await openPanel(
      statusOf('anthropic', { fast: [], fastest: [] })
    );
    const select = panel.querySelector<HTMLSelectElement>(
      '#jp-Epi-quick-questions'
    )!;
    expect(select.value).toBe('remote');
    expect(select.selectedOptions[0].text).toBe(
      'Remote AI model: OpenRouter: anthropic/claude-sonnet-5'
    );
  });
});

describe('The field of the settings editor', () => {
  it('offers the same choices, and the list of the provider', async () => {
    answer(statusOf());
    const saved: [string, unknown][] = [];
    const settings = {
      composite: { models: {}, keepDataLocal: false, customLocalModels: [] },
      user: { models: {} },
      changed: new Signal({}),
      set: async (key: string, value: unknown) => {
        saved.push([key, value]);
      }
    } as unknown as ISettingRegistry.ISettings;
    const api = {
      status: async () => statusOf(),
      connection: async () => STATE,
      connectionModels: async () => ({ models: LISTED })
    } as unknown as Api;
    const Field = modelsFieldRenderer(api);
    const view = await mount(
      <Field
        schema={{ title: 'AI models by task' }}
        formContext={{ settings }}
      />
    );
    await settle();
    const select = view.host.querySelector<HTMLSelectElement>(
      '#jp-Epi-model-labels'
    )!;
    expect(select.value).toBe('remote');
    expect(optionsOf(select)).toContain(
      'Faster models of OpenRouter / GPT-6 Luna, fast'
    );
    await step(() => {
      select.value = 'remote:fast';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(saved[saved.length - 1][1]).toMatchObject({
      labels: 'remote:fast'
    });
    await step(() => {
      select.value = PICK_MODEL;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(
      view.host.querySelector('.jp-Epi-taskpicker[data-task="labels"]')
        ?.textContent
    ).toContain('Models of OpenRouter for Labels and captions');
  });
});
