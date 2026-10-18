/**
 * Places of the view that a plugin of its own adds to: the check-up of the
 * notebook (../checkup.ts) adds a section at the end of the Exploration
 * panel, and the screen "Three ways to use models" (../welcome.ts) a link at
 * the end of the AI models panel. Each place draws what the plugins
 * registered, in the order they did; with no plugin, it draws nothing, and
 * the view is as it was.
 */
import type { EpiModel } from '../model/epimodel';

export interface IViewExtensions {
  /** Blocks after the last block of the Exploration panel, by id. */
  exploration: Map<string, (model: EpiModel) => JSX.Element | null>;
  /**
   * Links after "All AI settings" at the end of the AI models panel, by id.
   * `close` closes the panel.
   */
  modelsPanel: Map<
    string,
    (model: EpiModel, close: () => void) => JSX.Element | null
  >;
}

export const viewExtensions: IViewExtensions = {
  exploration: new Map(),
  modelsPanel: new Map()
};
