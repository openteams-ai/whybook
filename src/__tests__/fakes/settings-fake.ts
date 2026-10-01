/**
 * The settings that JupyterLab gives the plugin for a saved text: `user`
 * holds what the analyst saved, and `composite` the same with every default
 * of the schema filled in, as the settings registry's validator makes them.
 */
import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { DefaultSchemaValidator } from '@jupyterlab/settingregistry';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';

import schema from '../../../schema/plugin.json';

export function composed(raw: string): {
  composite: ReadonlyPartialJSONObject;
  user: ReadonlyPartialJSONObject;
} {
  const plugin: ISettingRegistry.IPlugin = {
    id: 'whybook:plugin',
    raw,
    schema: schema as ISettingRegistry.ISchema,
    version: '0.1.0',
    data: { composite: {}, user: {} }
  };
  const errors = new DefaultSchemaValidator().validateData(plugin, true);
  if (errors) {
    throw new Error(
      `The settings do not fit the schema: ${JSON.stringify(errors)}`
    );
  }
  return plugin.data;
}
