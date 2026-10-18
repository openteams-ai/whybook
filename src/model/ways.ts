/**
 * The three ways to use models, as the website names them ("Three ways to
 * use models" in website/index.html): what each sets, what it needs, what
 * leaves the machine, and when the screen that offers them shows by itself
 * (../welcome.ts, ../ui/ways.tsx).
 */
import type { ILocalModel, IServerStatus } from './api';
import type { ModelChoices, ModelsPanelStep } from './models';
import { DEFAULT_MODELS, isDecision, isRemote, readModels } from './models';

/** A way's id, as `c.Whybook.way_to_use_models` names it too. */
export type WayId = 'remote' | 'data-stays-here' | 'all-local';

/**
 * When the screen shows by itself, once for each user: when a notebook
 * first opens in Whybook, before the first request that a model reads, or
 * never. The command palette and the AI models panel open it at any time.
 */
export type ScreenWhen = 'notebook' | 'call' | 'never';

/** What a way is, in the website's words, shortened for the screen. */
export interface IWay {
  id: WayId;
  name: string;
  /** The machine that it suits. */
  machine: string;
  /** What reads the data, and what writes the code. */
  summary: string;
  /** Who it is for. */
  audience: string;
  /** What leaves this machine. */
  leaves: string;
}

export const WAYS: IWay[] = [
  {
    id: 'remote',
    name: 'Frontier models for everything',
    machine: 'Any laptop, even a Chromebook',
    summary:
      'A hosted frontier model reads what each task needs and writes the code.',
    audience:
      'Students and small labs, where the data may go to a model provider.',
    leaves:
      'The code of the cells, tables, pictures and variables, as each task needs them.'
  },
  {
    id: 'data-stays-here',
    name: 'Data stays on this machine',
    machine: 'A 16 GB laptop or a Mac mini',
    summary:
      'Local models read the tables and describe them. A frontier model writes the code from those descriptions and the names, kinds and sizes of the variables.',
    audience:
      'Companies, hospitals and government, where the data must stay but its descriptions may go out.',
    leaves:
      'Descriptions, code, questions and the text of markdown cells. Never the rows of a table, a printed output or a picture.'
  },
  {
    id: 'all-local',
    name: 'All local',
    machine: 'An AI PC or a small server',
    summary:
      'Local models read the data and write the code. Nothing leaves the building, and the work goes on with no internet.',
    audience:
      'Large companies and government, where nothing may leave the building.',
    leaves:
      'Nothing, when the model that writes the code runs on this machine. With a model server in your network, its prompts go there and no further.'
  }
];

/** The local model that the two local ways give labels and captions, when no other is on this machine. */
export const LABEL_MODEL = 'gemma-4-e2b';

/** The command that installs the local models: README.md, the `local` extra. */
export const LOCAL_EXTRA_COMMAND = 'pip install "whybook[local]"';

/** What the local ways need when llama-cpp-python is missing, in place of their button. */
export const LOCAL_EXTRA = `Needs the local extra on the server: ${LOCAL_EXTRA_COMMAND}, then a restart. pip builds llama-cpp-python with a C++ compiler, in about 4 minutes.`;

/** The local models that can write labels and captions: not a decision model, and not one that leaves labels out. */
function labelModels(status: IServerStatus | null): ILocalModel[] {
  return (status?.local_models ?? []).filter(
    model => !model.decision && (!model.tasks || model.tasks.includes('labels'))
  );
}

/**
 * The local model that the two local ways choose for labels and captions:
 * the analyst's own local choice when it is on this machine, then Gemma 4
 * E2B, then any other on this machine, so that nothing needs a download
 * when a model is there. With none there, the analyst's own local choice,
 * else Gemma 4 E2B, which the AI models panel then offers to download.
 */
export function localLabelModel(
  status: IServerStatus | null,
  models: ModelChoices
): string {
  const local = labelModels(status);
  const own = local.find(model => model.id === models.labels);
  const ready =
    (own?.available ? own : undefined) ??
    local.find(model => model.id === LABEL_MODEL && model.available) ??
    local.find(model => model.available);
  return ready?.id ?? own?.id ?? LABEL_MODEL;
}

/** The settings that a way sets: "Keep data on this machine" and the model of each task. */
export interface IWaySettings {
  keepDataLocal: boolean;
  models: ModelChoices;
}

/**
 * What a way's button sets. Frontier models for everything: the data may
 * leave, and the remote model does cells and answers, more questions, and
 * labels and captions, with the tiers of the defaults where a task had no
 * remote model. The two local ways keep the data on this machine, give
 * labels and captions a local model, and leave cells and answers to the
 * connected model; All local also gives user questions and the order of
 * questions back to the rules where a decision model through OpenRouter
 * had them. The other choices stay as the analyst made them.
 */
export function waySettings(
  way: WayId,
  status: IServerStatus | null,
  models: ModelChoices
): IWaySettings {
  if (way === 'remote') {
    return {
      keepDataLocal: false,
      models: {
        ...models,
        cells: 'remote',
        questions: isRemote(models.questions)
          ? models.questions
          : DEFAULT_MODELS.questions,
        labels: isRemote(models.labels) ? models.labels : DEFAULT_MODELS.labels
      }
    };
  }
  const next: ModelChoices = {
    ...models,
    cells: 'remote',
    labels: localLabelModel(status, models)
  };
  if (way === 'all-local') {
    // A decision model of OpenRouter reads the question elsewhere.
    if (isDecision(next.typed)) {
      next.typed = 'rules';
    }
    if (isDecision(next.ranking)) {
      next.ranking = 'rules';
    }
  }
  return { keepDataLocal: true, models: next };
}

/**
 * Where the AI models panel opens after a way's button: at the Download of
 * the local model for labels and captions, when its file is not here; else
 * at the list of providers, when the way needs a model that is not
 * connected (a model on this machine for All local, a hosted one for
 * Frontier models for everything); else at its top, with null.
 */
export function nextStep(
  way: WayId,
  status: IServerStatus | null,
  models: ModelChoices
): ModelsPanelStep | null {
  if (way !== 'remote') {
    const labels = labelModels(status).find(
      model => model.id === models.labels
    );
    if (labels && !labels.available && labels.downloadable) {
      return { kind: 'download', task: 'labels' };
    }
  }
  const remote = status?.claude;
  if (way === 'all-local') {
    return remote?.local && status?.claude_available
      ? null
      : { kind: 'connect', here: true };
  }
  const ready = !!status?.claude_available && remote?.provider !== 'none';
  if (way === 'remote' && remote?.local) {
    return { kind: 'connect', here: false };
  }
  return ready ? null : { kind: 'connect', here: false };
}

/**
 * What the server decides for every user, so that the screen does not show
 * by itself: the way to use models, or the data kept on this machine. Null
 * when each user chooses.
 */
export function serverDecides(status: IServerStatus | null): string | null {
  if (status?.way_to_use_models) {
    return `c.Whybook.way_to_use_models = "${status.way_to_use_models}"`;
  }
  if (status?.keep_data_local) {
    return 'c.Whybook.keep_data_local';
  }
  return null;
}

/**
 * Why a way's button cannot be pressed, or null: the server sets another
 * way, or keeps the data here for the first way, or the local models
 * cannot run for the other two.
 */
export function blockedReason(
  way: WayId,
  status: IServerStatus | null
): string | null {
  const server = status?.way_to_use_models;
  if (server && server !== way) {
    return `The server sets the way for every user: c.Whybook.way_to_use_models = "${server}".`;
  }
  if (way === 'remote' && status?.keep_data_local) {
    return 'The server keeps the data on this machine for every user: c.Whybook.keep_data_local.';
  }
  if (way !== 'remote' && status?.local_runtime === false) {
    return LOCAL_EXTRA;
  }
  return null;
}

/** "2.8 GB" for 2841 MB, "142 MB" below a gigabyte. */
function sizeText(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/** What a way needs that this machine has or lacks: the model to connect, and a download with its size. */
export function needsOf(
  way: WayId,
  status: IServerStatus | null,
  models: ModelChoices
): string[] {
  const remote = status?.claude;
  const connected =
    !!status?.claude_available && !!remote && remote.provider !== 'none';
  const hosted = connected && !remote?.local ? remote?.label : null;
  if (way === 'remote') {
    return [
      hosted
        ? `${hosted}, connected`
        : 'A hosted model: sign in to OpenRouter, or paste the key of a provider',
      'No download'
    ];
  }
  const id = localLabelModel(status, models);
  const model = labelModels(status).find(entry => entry.id === id);
  const labels = !model
    ? 'A local model for labels and captions'
    : model.available
      ? `${model.label} for labels and captions, on this machine`
      : model.size_mb
        ? `${model.label} for labels and captions, a download of ${sizeText(model.size_mb)}`
        : `${model.label} for labels and captions`;
  // Without llama-cpp-python, the local extra comes first.
  const extra =
    status?.local_runtime === false ? ['The local extra on the server'] : [];
  if (way === 'data-stays-here') {
    return [
      ...extra,
      labels,
      hosted
        ? `${hosted} for the code, connected`
        : 'A hosted model for the code: a sign-in or a key'
    ];
  }
  const here = connected && remote?.local ? remote.label : null;
  return [
    ...extra,
    labels,
    here
      ? `${here} for the code, on this machine`
      : 'A model server for the code, on this machine or in your network, such as Ollama, with a larger model'
  ];
}

/**
 * The way that the settings make true now, if any: the first way when the
 * data may leave and the remote model does the three tasks of the remote
 * model; the second when the data stays and a local model writes labels and
 * captions; the third when, besides, the connected model runs here.
 */
export function currentWay(
  status: IServerStatus | null,
  keepDataLocal: boolean,
  models: ModelChoices
): WayId | null {
  if (!keepDataLocal && !status?.keep_data_local) {
    return models.cells === 'remote' &&
      isRemote(models.questions) &&
      isRemote(models.labels)
      ? 'remote'
      : null;
  }
  if (!labelModels(status).some(model => model.id === models.labels)) {
    return null;
  }
  return status?.claude?.local && status.claude_available
    ? 'all-local'
    : 'data-stays-here';
}

/**
 * The settings that a way sets, as the analyst saved them in the settings
 * registry, with the defaults: for the screen when no view is open.
 */
export function savedWaySettings(
  composite: { keepDataLocal?: unknown; models?: unknown },
  user: { models?: unknown } | null
): IWaySettings {
  return {
    keepDataLocal: composite.keepDataLocal === true,
    models: readModels(composite.models, user?.models)
  };
}

/** The settings of the screen, as schema/welcome.json describes them. */
export interface IScreenSettings {
  when: ScreenWhen;
  /** Whether the screen has shown by itself for this user. */
  shown: boolean;
}

/** The screen's settings from what JupyterLab gives the plugin, with the defaults. */
export function readScreenSettings(composite: {
  when?: unknown;
  shown?: unknown;
}): IScreenSettings {
  const when = composite.when;
  return {
    when: when === 'call' || when === 'never' ? when : 'notebook',
    shown: composite.shown === true
  };
}

/**
 * Whether the screen shows by itself now: at the moment its setting names,
 * when it has not shown before, and when the server answered and leaves
 * the choice to each user.
 */
export function screenShows(
  moment: 'notebook' | 'call',
  settings: IScreenSettings,
  status: IServerStatus | null
): boolean {
  return (
    !settings.shown &&
    settings.when === moment &&
    status !== null &&
    serverDecides(status) === null
  );
}
