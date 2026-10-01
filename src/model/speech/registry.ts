import { browserLocal } from './browser';
import type { ISpeechEngine } from './engine';
import { moonshineMedium } from './moonshine-medium';
import { moonshineSmall } from './moonshine-small';

/**
 * The speech engines, in the order the settings list them after "Off". To
 * drop one, delete its module and its line here, and its choice in the oneOf
 * of `models.speech` in schema/plugin.json; an engine of the Jupyter server
 * also has an entry in ENGINES of whybook/server/speech.py.
 */
export const ENGINES: ISpeechEngine[] = [
  browserLocal,
  moonshineMedium,
  moonshineSmall
];

/** The engine of a value of `models.speech`, or undefined for 'off' and a value no engine has. */
export function speechEngine(
  id: string | undefined
): ISpeechEngine | undefined {
  return ENGINES.find(engine => engine.id === id);
}
