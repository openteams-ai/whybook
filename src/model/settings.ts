import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';

import type { AgentView } from './agent';
import type { EpiSettings, MapColumns, Placement } from './epimodel';
import { readCustomModels } from './custommodels';
import { exploredOrder } from './exploredorder';
import { readModels } from './models';
import { readModelQuestions } from './rulesfirst';
import type { Detail, Interaction, MapDetail } from '../tokens';

/** The settings that the plugin gives the view from JupyterLab's settings. */
export type SettingsRead = Parameters<EpiSettings['update']>[0];

/**
 * The plugin's settings, as schema/plugin.json describes them: JupyterLab
 * checks `composite` against the schema. A key typed `unknown` is read with
 * a check of its own.
 */
interface IPluginSettings {
  interaction?: Interaction;
  variablesPlacement?: Placement;
  explorationPlacement?: Placement;
  subshellCapacity?: number;
  mapColumns?: MapColumns;
  outputDetail?: Detail;
  mapDetail?: MapDetail;
  mapOutputs?: boolean;
  detailFollowsSpace?: unknown;
  minimap?: unknown;
  guessFirst?: boolean;
  offeredQuestions?: number;
  resultStrips?: 'elsewhere' | 'manual';
  models?: unknown;
  localJsonCheck?: unknown;
  keepDataLocal?: unknown;
  zeroDataRetention?: unknown;
  customLocalModels?: unknown;
  answers?: unknown;
  agentView?: unknown;
  showCost?: unknown;
  modelQuestions?: unknown;
  /** Replaced by modelQuestions on 30 September 2026: a saved false reads as never. */
  aiWhenNoTemplate?: unknown;
  findDefaults?: unknown;
  exploredOrder?: unknown;
}

/**
 * The view's settings, from the plugin's settings as JupyterLab gives them:
 * `composite` holds every default of the schema, and `user` only what the
 * analyst saved. A replaced key is read from `user`, since its replacement
 * always has a value in `composite`: `mapOutputs: false` reads as no outputs
 * on the map while `mapDetail` was never saved, and `aiWhenNoTemplate: false`
 * as no questions from a model while `modelQuestions` was never saved.
 */
export function readSettings(
  composite: ReadonlyPartialJSONObject,
  user: ReadonlyPartialJSONObject | null
): SettingsRead {
  const all = composite as IPluginSettings;
  const own = (user ?? {}) as IPluginSettings;
  return {
    interaction: all.interaction ?? 'drag',
    variablesPlacement: all.variablesPlacement ?? 'sidebar',
    explorationPlacement: all.explorationPlacement ?? 'sidebar',
    capacity: all.subshellCapacity ?? 8,
    mapColumns: all.mapColumns ?? 'contents',
    detail: all.outputDetail ?? 'full',
    // The switch of earlier versions: off reads as no outputs.
    mapDetail:
      own.mapDetail === undefined && own.mapOutputs === false
        ? 'none'
        : (all.mapDetail ?? 'minimal'),
    // A trial, off unless the analyst turns it on.
    detailFollowsSpace: all.detailFollowsSpace === true,
    // Off unless the analyst turns it on.
    minimap: all.minimap === true,
    guessFirst: all.guessFirst ?? true,
    offeredQuestions: all.offeredQuestions ?? 12,
    stripsClose: all.resultStrips ?? 'elsewhere',
    models: readModels(all.models, own.models),
    jsonCheck: all.localJsonCheck === 'standard' ? 'standard' : 'fast',
    keepDataLocal: all.keepDataLocal === true,
    // On, unless the analyst turns it off.
    zeroDataRetention: all.zeroDataRetention !== false,
    customLocalModels: readCustomModels(all.customLocalModels),
    answers: all.answers === 'cell' ? 'cell' : 'agent',
    agentView: agentViewOf(all.agentView),
    showCost: all.showCost === true,
    // Always, unless the analyst chose otherwise, or turned off the switch it replaced.
    modelQuestions: readModelQuestions(all.modelQuestions, own),
    // On since 1 October 2026, unless the analyst turns it off.
    findDefaults: all.findDefaults !== false,
    exploredOrder: exploredOrder(all.exploredOrder).id
  };
}

function agentViewOf(value: unknown): AgentView {
  return value === 'card' || value === 'sidebar' ? value : 'strip';
}
