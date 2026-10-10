import type { IServerStatus, LocalTier } from './api';
import { ENGINES, speechEngine } from './speech/registry';

/** The tasks that ask a model for something, each with its own choice of model. */
export type Task =
  'cells' | 'questions' | 'labels' | 'typed' | 'speech' | 'ranking';

/**
 * The model of each task: 'off', 'remote', or the id of a local model. The
 * typed questions have 'rules', the keywords and first words alone, and
 * 'jev', Jev from TypeSafe, in place of 'remote' and 'off'. Spoken questions
 * have 'off' or the id of a speech engine (speech/registry.ts); they came
 * later, so a stored object may lack them, and then they are off. In place
 * of 'remote', the connected model, a task can name a faster model of the
 * connected provider: a tier, 'remote:fast' or 'remote:fastest', or one of
 * its models, 'remote:<provider>:<model>' (whybook/server/tiers.py).
 */
export type ModelChoices = Record<
  Exclude<Task, 'speech' | 'ranking'>,
  string
> & {
  speech?: string;
  /** The order of offered questions: 'rules', 'remote', a local model or 'jev'. */
  ranking?: string;
};

export const DEFAULT_MODELS: ModelChoices = {
  cells: 'remote',
  // A fast model of the connected provider, when it has one (design iteration 1.81).
  questions: 'remote:fast',
  // The fastest model of the connected provider, when it has one: labels and
  // titles come at once (research/model_access/demo-model.md).
  labels: 'remote:fastest',
  typed: 'rules',
  speech: 'off',
  ranking: 'rules'
};

/** A task's choice, with the default for one that the choices lack. */
export function choiceOf(models: ModelChoices, task: Task): string {
  return models[task] ?? DEFAULT_MODELS[task] ?? 'off';
}

/**
 * The tiers of the connected provider's models, for the tasks that need
 * speed more than depth: questions need a fast model, labels the fastest.
 */
export type RemoteTier = 'fast' | 'fastest';

export const REMOTE_TIERS: RemoteTier[] = ['fast', 'fastest'];

/** The tasks whose remote model can be a tier, or another model of the connected provider. */
const TIERED_TASKS: Task[] = ['questions', 'labels', 'ranking'];

/**
 * The choice of a task's select that opens the list of the connected
 * provider's models: no model has this id.
 */
export const PICK_MODEL = 'pick-remote-model';

/** Whether a task's choice is the connected provider: its model, a tier, or one of its models. */
export function isRemote(choice: string | undefined): boolean {
  return (
    choice === 'remote' ||
    (!!choice && choice.startsWith('remote:') && choice.length > 7)
  );
}

/**
 * What a remote choice names: a tier, or one model of a provider. Null for
 * the connected model, and for a choice that is not remote.
 */
export function remoteChoice(
  choice: string | undefined
): { tier: RemoteTier } | { provider: string; model: string } | null {
  if (!isRemote(choice) || choice === 'remote') {
    return null;
  }
  const rest = choice!.slice('remote:'.length);
  if ((REMOTE_TIERS as string[]).includes(rest)) {
    return { tier: rest as RemoteTier };
  }
  const colon = rest.indexOf(':');
  const model = colon > 0 ? rest.slice(colon + 1).trim() : '';
  return model ? { provider: rest.slice(0, colon), model } : null;
}

/** The choice of one model of a provider: 'remote:openrouter:z-ai/glm-5.3-flash'. */
export function remoteModelChoice(provider: string, model: string): string {
  return `remote:${provider}:${model}`;
}

/**
 * The choice that a task's select shows: a tier for which the connected
 * provider has no model shows as the connected model, which answers it.
 */
export function shownChoice(
  status: IServerStatus | null,
  choice: string
): string {
  const named = remoteChoice(choice);
  return named && 'tier' in named && !status?.remote_tiers?.[named.tier]?.length
    ? 'remote'
    : choice;
}

/**
 * Why a task cannot use the model of another provider that it names: the
 * analyst connected a model of another provider since. Null otherwise.
 */
export function otherProviderReason(
  status: IServerStatus | null,
  choice: string | undefined
): string | null {
  const named = remoteChoice(choice);
  const connected = status?.claude?.provider;
  if (!named || !('provider' in named) || !connected) {
    return null;
  }
  return named.provider === connected
    ? null
    : `${named.model} is a model of ${providerName(named.provider)}, and the connected model is not: choose another`;
}

/** A provider by the name that the AI models panel gives it. */
function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** The names of the providers, as whybook/server/connection.py labels them. */
const PROVIDER_NAMES: Record<string, string> = {
  'claude-code': 'the Claude Code login',
  openrouter: 'OpenRouter',
  huggingface: 'Hugging Face',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  mistral: 'Mistral AI',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp server',
  vllm: 'vLLM',
  'openai-compatible': 'an OpenAI-compatible server'
};

/** Whether the connected provider lists its models, so that a task can take another of them. */
function listsModels(status: IServerStatus | null): boolean {
  const provider = status?.claude?.provider;
  return !!provider && provider !== 'none' && provider !== 'claude-code';
}

/**
 * The remote choices of a task beside the connected model: the models of
 * each tier that the connected provider has, the first as the tier itself,
 * a model of the provider that the analyst picked, and the choice that
 * opens the list of the provider's models.
 */
function tierChoices(
  status: IServerStatus | null,
  task: Task,
  remote: IModelChoice,
  value: string | undefined
): { tiers: IModelChoice[]; pick: IModelChoice[] } {
  if (!TIERED_TASKS.includes(task)) {
    return { tiers: [], pick: [] };
  }
  const info = TASKS.find(entry => entry.id === task)!;
  // What the task sends, after what was measured of the model, if anything.
  const sends = remoteSends(status, info.sends);
  const provider = status?.claude?.provider ?? '';
  const name = providerName(provider);
  const tiers: IModelChoice[] = [];
  const shown = new Set<string>();
  for (const tier of REMOTE_TIERS) {
    const models = status?.remote_tiers?.[tier] ?? [];
    models.forEach((model, index) => {
      // The first model of a tier is the tier itself, which follows the
      // server's list; the others are each a model of the provider.
      const id =
        index === 0 ? `remote:${tier}` : remoteModelChoice(provider, model.id);
      shown.add(id);
      tiers.push({
        ...remote,
        id,
        label: `${model.label}, ${tier}`,
        note: model.note ? `${model.note}; ${sends}` : sends,
        group:
          tier === 'fast'
            ? `Faster models of ${name}`
            : `Fastest models of ${name}`
      });
    });
  }
  const named = remoteChoice(value);
  if (named && 'provider' in named && !shown.has(value!)) {
    const reason = otherProviderReason(status, value) ?? remote.reason;
    tiers.push({
      ...remote,
      id: value!,
      label: `${named.model}, ${providerName(named.provider)}`,
      note: sends,
      available: reason === null,
      reason,
      group: `Other models of ${providerName(named.provider)}`
    });
  }
  const pick: IModelChoice[] = listsModels(status)
    ? [
        {
          id: PICK_MODEL,
          label: `Another model of ${name}…`,
          note: `the models that ${name} lists`,
          available: true,
          reason: null,
          download: null,
          source: null
        }
      ]
    : [];
  return { tiers, pick };
}

export const TASKS: {
  id: Task;
  label: string;
  /** What the setting controls, in the words of its help icon. */
  help: string;
  /** What the task sends to the remote model. */
  sends: string;
  /** Whether a local model can do it: then the server's five and the models of the settings can. */
  local: boolean;
  /**
   * What was measured of a local model on this task, in place of its note,
   * which is about labels. A model with no note here was not measured on it.
   */
  notes?: Record<string, string>;
}[] = [
  {
    id: 'cells',
    label: 'Cells and answers',
    help: 'Writes a cell when no template answers a question: an option marked "needs AI", or a question typed in a "Your own question" box. The cell comes with its summary, assumptions and follow-up questions. Only the remote model can do this; with Off, those questions stay unanswered.',
    sends:
      'the question, the code of nearby cells and summaries of the variables',
    local: false
  },
  {
    id: 'questions',
    label: 'More questions',
    help: 'Writes more questions about what you dropped or clicked when you press "More questions from AI", and, with "Questions from a model" at always, the default, next to the templates each time you drag or click. Suggests other values of a constant whose kind no rule knows, from its chip. With "Find more defaults with AI" on, picks the library defaults that can change a cell\'s result, from the signatures of the functions it calls, for its chips. In the Check-up, answers "What would a reviewer ask?" when you press Ask. The questions that templates offer, and the values of a count of days or a threshold, need no model.',
    sends:
      'what the questions are about, with summaries of the variables, the name and code of a constant, and the signatures of library functions',
    local: true,
    notes: {
      'gemma-4-e2b':
        'five questions in about 45 s on 4 CPU threads; their types are less reliable'
    }
  },
  {
    id: 'labels',
    label: 'Labels and captions',
    help: 'Writes a description of one to three words and a headline for a table shown as a tile, one sentence about a data frame in Contents, and a title for a code cell whose title is its first line, when the notebook opens and after a pause in typing. With Off, a tile shows only its size, and a cell its first line.',
    sends:
      'each table as the notebook shows it with the code of its cell, the name, size and column names and types of a frame, and the code of a cell with the title it shows',
    local: true
  },
  {
    id: 'typed',
    label: 'Typed questions',
    help: 'Gives a question typed in a "Your own question" box its type: descriptive, association, causal, model check or data quality. The type shows on the question, counts in Questions asked, and goes to the model that writes the cell. With the keywords alone, words such as "cause", "missing" or "residual" set the type, and a question without them counts as descriptive. A local model reads the question when no keyword matches, and Jev also chooses where its cell goes.',
    sends: 'the question you type, and the first 20 lines of its cell',
    local: true,
    notes: {
      'gemma-4-e2b':
        'the type when the keywords do not match: 69% of 120 test questions right, against 45%; about 0.5 s a question'
    }
  },
  {
    id: 'ranking',
    label: 'Question order',
    help: 'Orders the questions offered for what you drag or click, for cells, for a text, and under "Worth asking next". The rules score each question at once, from its type, the data and the questions asked so far, and the list shows in their order. A model then scores the questions again, and the list takes its order when the answer comes, with the model named above it. While the pointer is on the list, the questions stay where they are, and the note above them shows the model\'s order on a click. Questions about a table, a plot or a picture keep the rules\' order. With a local model, no data leaves the machine.',
    sends:
      'the offered questions, the names and sizes of the variables selected, the titles of the last 20 cells and the questions asked so far',
    local: true,
    notes: {
      'gemma-4-e2b':
        "picks the next question among the offered ones, read once after the notebook's state; on 60 cells of public notebooks, asked again by dragging the variables they use, the first question had the type of the analyst's next question for 45% of them, against 57% with the rules, built in",
      'gemma-4-e4b':
        "picks the next question among the offered ones, read once after the notebook's state; on 60 cells of public notebooks, asked again by dragging the variables they use, the first question had the type of the analyst's next question for 43% of them, against 57% with the rules, built in"
    }
  },
  {
    id: 'speech',
    label: 'Spoken questions',
    help: 'Turns on the microphone of a "Your own question" box: click it, say the question, and click again or press Escape. The words fill the box, with their type and place as for typed text, and nothing is asked until you press Enter. The names of the variables, and of what you dropped, are favoured. The browser keeps the audio on this computer, where it can; a model in the Jupyter server needs moonshine-voice and its download.',
    sends: 'no audio: the words go with the question when you press Enter',
    local: false
  }
];

/** What a local model's note says on a task that it was not measured on. */
export const NOT_MEASURED = 'not measured on this task';

/**
 * The heading of each group of local models in a select: the three best for
 * the target laptop, one step down, one step up, and those of the settings.
 */
export const LOCAL_GROUPS: Record<LocalTier, string> = {
  recommended: 'Local, for a laptop with 16 GB',
  smaller: 'Local, smaller, for 8 GB',
  larger: 'Local, larger, for 24 GB or more',
  custom: 'Local, added in the settings'
};

/**
 * Local models that the view no longer offers, and the one that takes the
 * choice. Qwen3.5 0.8B is no longer offered: it described 2 of 12
 * held-out tables right (research/local-models.md), and typed questions
 * gained 4 points with it over the keywords.
 */
const DROPPED: Record<string, string> = { 'qwen3.5-0.8b': 'minicpm5-2b' };

/** A model that a task can use, as the settings list it. */
export interface IModelChoice {
  /** 'off', 'remote', or the id of a local model. */
  id: string;
  label: string;
  /** What the choice means for speed, quality or data. */
  note: string;
  available: boolean;
  /** Why it cannot run, when it cannot. */
  reason: string | null;
  /** A local model whose file the server can fetch, with its size in MB, or 0 when the size is not known. */
  download: number | null;
  /** The heading that the choice goes under in a select: LOCAL_GROUPS. */
  group?: string;
  /** The Hugging Face repository the file comes from. */
  source: string | null;
  /** Where the file comes from, when it is not a Hugging Face repository. */
  from?: string;
  /** How to set the model up on the server, when it cannot run for want of it. */
  setup?: string | null;
  /**
   * The remote choice before the analyst connects a model: nothing is wrong,
   * and the task waits for a model.
   */
  waiting?: boolean;
  /**
   * How the choice did when it was measured, in sentences: the last
   * paragraph of the task's help in the settings editor while it is chosen.
   */
  measured?: string;
}

/** What a task that waits for a connected model says under its select. */
export const WAITING = 'Waits for a connected model';

/** Whether the analyst has not connected a model yet: the provider of the connection is none. */
export function noModelConnected(status: IServerStatus | null): boolean {
  return status?.claude?.provider === 'none';
}

/**
 * A choice as its select lists it: a model that cannot run says so, unless
 * it is the chosen one, whose reason shows under the select in full rather
 * than cut at the select's edge.
 */
export function choiceLabel(
  choice: IModelChoice,
  chosen: string | undefined
): string {
  return choice.available || choice.id === chosen
    ? choice.label
    : `${choice.label} (cannot run)`;
}

/** Why the chosen model cannot run, as the line under its select says it. */
export function cannotRun(choice: IModelChoice): string {
  const reason = (choice.reason ?? 'it is not set up').replace(/\.$/, '');
  return `Cannot run: ${reason}.${choice.setup ? ` ${choice.setup}` : ''}`;
}

/** How to set the remote model up, when the server's status reports that it cannot answer. */
function remoteSetup(status: IServerStatus | null): string | null {
  return status && !status.claude_available
    ? (status.claude?.setup ?? null)
    : null;
}

/**
 * The choices of each task in the settings, with the defaults filled in:
 * `value` from JupyterLab's composite settings, which hold every default of
 * the schema, and `own` from the analyst's own settings, which hold what
 * they saved. A replaced key is read from `own`: in the composite, its
 * replacement always has the schema's default. Choices without the schema's
 * defaults can come alone, as `value`.
 */
export function readModels(value: unknown, own: unknown = value): ModelChoices {
  const record = (item: unknown): Record<string, unknown> =>
    item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
  const stored = record(value);
  const saved = record(own);
  const models = { ...DEFAULT_MODELS };
  for (const task of TASKS) {
    const choice = stored[task.id];
    if (typeof choice === 'string') {
      models[task.id] = DROPPED[choice] ?? choice;
    }
  }
  // Older versions kept the labels for tables only, under another key.
  if (
    typeof saved.labels !== 'string' &&
    typeof saved.tableLabels === 'string'
  ) {
    models.labels = DROPPED[saved.tableLabels] ?? saved.tableLabels;
  }
  // An engine dropped since the settings were saved leaves the microphone off.
  if (models.speech !== 'off' && !speechEngine(models.speech)) {
    models.speech = 'off';
  }
  return models;
}

function remoteReason(status: IServerStatus | null, task: Task): string | null {
  if (!status) {
    return 'the server did not answer';
  }
  if (!status.claude_available) {
    return status.claude?.reason ?? 'no AI model is set up on the server';
  }
  // A connected model on this machine reads tables as a local model does.
  const local = status.claude?.local === true;
  if (task === 'labels' && status.keep_data_local && !local) {
    return 'the data stays on this machine, and the remote model would read the table: choose a local model';
  }
  if (task === 'labels' && status.describe_tables === false && !local) {
    return 'turned off on the server: c.Whybook.describe_tables';
  }
  return null;
}

/**
 * The connected model as the selects name it: a hosted model, or a model
 * that a server on this machine runs, such as Ollama. whybook/server/connection.py.
 */
export function remoteLabel(status: IServerStatus | null): string {
  const remote = status?.claude;
  if (remote?.local && remote.label) {
    // The name first: a select cuts the end of a long label.
    return `${remote.label}, on this machine`;
  }
  return status?.remote_model
    ? `Remote AI model: ${status.remote_model}`
    : 'Remote AI model';
}

/** Where what the connected model reads goes: off the machine, unless the model runs on it. */
function remoteSends(status: IServerStatus | null, sends: string): string {
  return status?.claude?.local
    ? `${sends} stay on this machine`
    : `${sends} leave the machine`;
}

/**
 * The status with the data policy in force: the server keeps the data on
 * the machine for every user, or else the user's setting decides.
 */
export function withDataPolicy(
  status: IServerStatus | null,
  keepLocal: boolean
): IServerStatus | null {
  return status && keepLocal && !status.keep_data_local
    ? { ...status, keep_data_local: true }
    : status;
}

/** Whether the server can run a task's model: 'off' never runs, and the rules always do. */
export function modelAvailable(
  status: IServerStatus | null,
  model: string,
  task: Task = 'labels'
): boolean {
  if (model === 'off') {
    return false;
  }
  if (task === 'speech') {
    return !!speechEngine(model)?.choice(status).available;
  }
  if (model === 'rules') {
    return true;
  }
  if (model === 'jev') {
    // Jev orders questions through TypeSafe or, as before, through Cloudflare.
    return (
      !!status?.jev?.available ||
      (task === 'ranking' && !!status?.jev_configured)
    );
  }
  if (isRemote(model)) {
    // A tier or another model of the connected provider, with its key.
    return (
      remoteReason(status, task) === null &&
      otherProviderReason(status, model) === null
    );
  }
  return !!status?.local_models?.find(entry => entry.id === model)?.available;
}

/** Whether a task will ask its model, with the settings and the server as they are. */
export function aiReady(
  status: IServerStatus | null,
  models: ModelChoices,
  task: Task
): boolean {
  return modelAvailable(status, choiceOf(models, task), task);
}

/**
 * The local models a task can use, as the server lists them: its five, the
 * three for the target laptop first, then those of the settings.
 */
function localChoices(
  status: IServerStatus | null,
  task: Task
): IModelChoice[] {
  const info = TASKS.find(entry => entry.id === task)!;
  if (!info.local) {
    return [];
  }
  return (status?.local_models ?? []).map(model => {
    const tier = model.tier ?? 'recommended';
    // A preset's own note is about labels; a model of the settings has the note written there.
    const note =
      info.notes?.[model.id] ??
      (task === 'labels' || tier === 'custom' ? model.note : NOT_MEASURED);
    const size =
      model.size_mb !== null && model.size_mb !== undefined
        ? `${(model.size_mb / 1000).toFixed(1)} GB; `
        : '';
    return {
      id: model.id,
      label: `${model.label}, local`,
      note: `${size}${note}`,
      available: model.available,
      reason: model.reason,
      download: model.downloadable ? (model.size_mb ?? 0) : null,
      source: model.repo ?? null,
      group: LOCAL_GROUPS[tier]
    };
  });
}

/**
 * The choices for typed questions: the keywords and first words alone, a
 * local model for the type, or Jev for the type and the place.
 */
function typedChoices(status: IServerStatus | null): IModelChoice[] {
  return [
    {
      id: 'rules',
      label: 'Keywords, built in',
      note: 'right for 45% of the types and 84% of the places of 120 test questions',
      available: true,
      reason: null,
      download: null,
      source: null
    },
    ...localChoices(status, 'typed'),
    {
      id: 'jev',
      label: 'Jev by TypeSafe, remote',
      note: 'the type, and the place when no first word gives it; the question and the first 20 lines of its cell leave the machine; on 120 test questions, the type was right for 76%, against 45% with the keywords alone, and the place for 65%, against 84% with the first words alone',
      available: !!status?.jev?.available,
      reason: status
        ? (status.jev?.reason ?? null)
        : 'the server did not answer',
      download: null,
      source: null
    }
  ];
}

/**
 * The choices for the order of offered questions: the rules, which always
 * run first, then a model that orders them again.
 */
function rankingChoices(
  status: IServerStatus | null,
  value?: string
): IModelChoice[] {
  const reason = remoteReason(status, 'ranking');
  const info = TASKS.find(entry => entry.id === 'ranking')!;
  const jev = modelAvailable(status, 'jev', 'ranking');
  const remote: IModelChoice = {
    id: 'remote',
    label: remoteLabel(status),
    note: `asked which question you will ask next: on 300 cells of public notebooks, asked again by dragging the variables they use, the first question had the type of the analyst's next question for 61% of them, against 57% with the rules, built in; ${remoteSends(status, info.sends)}`,
    available: reason === null,
    reason,
    download: null,
    source: null,
    setup: remoteSetup(status)
  };
  const { tiers, pick } = tierChoices(status, 'ranking', remote, value);
  return [
    {
      id: 'rules',
      label: 'Rules, built in',
      note: 'Rules, then a learned order of the types of question.',
      measured:
        "Measured on 4,790 cells of public notebooks, asked again by dragging the variables they use: the first question had the type of the analyst's next question for 52.4% of them, against 33.9% with the rules alone and 26.5% in a random order.",
      available: true,
      reason: null,
      download: null,
      source: null
    },
    remote,
    ...tiers,
    ...localChoices(status, 'ranking'),
    {
      id: 'jev',
      label: 'Jev by TypeSafe, remote',
      note: `one yes-or-no question per offered question; ${info.sends} leave the machine; on 300 cells of public notebooks, asked again by dragging the variables they use, the first question had the type of the analyst's next question for 40% of them, against 57% with the rules, built in`,
      available: jev,
      reason: jev
        ? null
        : status
          ? 'needs a TypeSafe API key on the server: TYPESAFE_API_KEY'
          : 'the server did not answer',
      download: null,
      source: null
    },
    ...pick
  ];
}

/** The choices for spoken questions: off, then each speech engine of the registry. */
function speechChoices(status: IServerStatus | null): IModelChoice[] {
  return [
    {
      id: 'off',
      label: 'Off',
      note: 'the microphone stays off',
      available: true,
      reason: null,
      download: null,
      source: null
    },
    ...ENGINES.map(engine => engine.choice(status))
  ];
}

/** The choices of one task: off, the remote model, and the local models when the task can use them. */
export function choicesFor(
  status: IServerStatus | null,
  task: Task,
  /** The task's choice, so that a model of the provider that the analyst picked is offered too. */
  value?: string
): IModelChoice[] {
  if (task === 'typed') {
    return typedChoices(status);
  }
  if (task === 'speech') {
    return speechChoices(status);
  }
  if (task === 'ranking') {
    return rankingChoices(status, value);
  }
  const info = TASKS.find(entry => entry.id === task)!;
  const reason = remoteReason(status, task);
  const remote: IModelChoice = {
    id: 'remote',
    label: remoteLabel(status),
    note: remoteSends(status, info.sends),
    available: reason === null,
    reason,
    download: null,
    source: null,
    setup: remoteSetup(status),
    waiting: noModelConnected(status)
  };
  // Code and answers keep the connected model; the other tasks can take a
  // faster model of its provider.
  const { tiers, pick } = tierChoices(status, task, remote, value);
  const choices: IModelChoice[] = [remote, ...tiers];
  choices.push(...localChoices(status, task));
  choices.push({
    id: 'off',
    label: 'Off',
    note: 'nothing is asked',
    available: true,
    reason: null,
    download: null,
    source: null
  });
  choices.push(...pick);
  return choices;
}

/** The name of a task's model, short. */
export function modelName(
  status: IServerStatus | null,
  model: string | undefined
): string {
  if (model === undefined || model === 'off') {
    return 'off';
  }
  if (model === 'rules') {
    return 'rules';
  }
  if (model === 'jev') {
    return 'Jev';
  }
  if (isRemote(model)) {
    // A tier by the model it takes, and a model of the provider by its id.
    const named = remoteChoice(shownChoice(status, model));
    if (named && 'tier' in named) {
      return status?.remote_tiers?.[named.tier]?.[0]?.label ?? 'remote AI';
    }
    return named ? named.model : 'remote AI';
  }
  const engine = speechEngine(model);
  if (engine) {
    return engine.choice(status).label;
  }
  const local = status?.local_models?.find(entry => entry.id === model);
  return `${local?.label ?? model}, local`;
}

/**
 * The status bar's summary: where the tasks' data goes, and whether a chosen
 * model cannot run.
 */
export function aiSummary(
  status: IServerStatus | null,
  models: ModelChoices
): string {
  // The rules are no model; Jev runs away from the machine, as the remote model does.
  const remote = (id: string) => isRemote(id) || id === 'jev';
  const used = TASKS.map(task => choiceOf(models, task.id)).filter(
    id => id !== 'off' && id !== 'rules'
  );
  // A task set to the remote model while no model is connected waits: the
  // bar says so once, and does not count it as a model that cannot run.
  const waiting = noModelConnected(status) && used.some(isRemote);
  const kinds = [
    used.some(id => remote(id) && !(waiting && isRemote(id))) ? 'remote' : null,
    used.some(id => !remote(id)) ? 'local' : null
  ].filter(Boolean);
  const text = waiting
    ? kinds.length
      ? `AI: ${kinds.join(' and ')} · no model connected`
      : 'AI: no model connected'
    : (kinds.length ? `AI: ${kinds.join(' and ')}` : 'AI: off') +
      (status?.keep_data_local && kinds.includes('remote')
        ? ', data stays here'
        : '');
  const stuck = status
    ? TASKS.filter(task => {
        const choice = choiceOf(models, task.id);
        return (
          choice !== 'off' &&
          !(waiting && isRemote(choice)) &&
          !modelAvailable(status, choice, task.id)
        );
      }).length
    : 0;
  return stuck ? `${text} · ${stuck} cannot run` : text;
}
