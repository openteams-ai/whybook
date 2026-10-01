/**
 * Places of the view that a plugin of its own adds to: the check-up of the
 * notebook (../checkup.ts) adds a section at the end of the Exploration
 * panel. Each place draws what the plugins registered, in the order they
 * did; with no plugin, it draws nothing, and the view is as it was.
 */
import type { EpiModel } from '../model/epimodel';

export interface IViewExtensions {
  /** Blocks after the last block of the Exploration panel, by id. */
  exploration: Map<string, (model: EpiModel) => JSX.Element | null>;
}

export const viewExtensions: IViewExtensions = {
  exploration: new Map()
};
