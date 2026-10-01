import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import * as React from 'react';

import type { Api, IServerStatus } from '../model/api';
import { readCustomModels } from '../model/custommodels';
import type { ModelChoices } from '../model/models';
import {
  choiceOf,
  isRemote,
  modelAvailable,
  modelName,
  noModelConnected,
  otherProviderReason,
  readModels,
  WAITING
} from '../model/models';

/** The name of the setting, as the settings editor and its box show it. */
export const FIND_DEFAULTS = 'Find more defaults with AI';

/**
 * What the setting "Find more defaults with AI" says under its box when no
 * model can pick the defaults, as the other options that need AI say it:
 * the model of More questions waits for a connected model, or cannot run,
 * and why. Null when that model can run.
 */
export function findDefaultsNote(
  status: IServerStatus | null,
  models: ModelChoices
): string | null {
  const choice = choiceOf(models, 'questions');
  if (modelAvailable(status, choice, 'questions')) {
    return null;
  }
  if (choice === 'off') {
    return 'Needs an AI model: AI is off for More questions in the AI models panel.';
  }
  if (isRemote(choice) && noModelConnected(status)) {
    return `${WAITING}: connect one in the AI models panel.`;
  }
  if (!status) {
    return 'Needs an AI model: the server did not answer.';
  }
  const reason = isRemote(choice)
    ? (otherProviderReason(status, choice) ??
      status.claude?.reason ??
      'no AI model is set up on the server')
    : (status.local_models?.find(model => model.id === choice)?.reason ??
      `${modelName(status, choice)} cannot run`);
  return `Needs an AI model: ${reason.replace(/\.$/, '')}.`;
}

/** The props of a field renderer of JupyterLab's settings editor that this one reads. */
interface IFieldProps {
  formContext: { settings: ISettingRegistry.ISettings };
}

/**
 * The setting in JupyterLab's settings editor: its box, and under it what
 * the setting needs while no model can pick the defaults. The editor puts
 * the schema's description under the field.
 */
export function findDefaultsFieldRenderer(
  api: Api
): (props: IFieldProps) => JSX.Element {
  return props => <FindDefaultsField {...props} api={api} />;
}

function FindDefaultsField(props: IFieldProps & { api: Api }): JSX.Element {
  const { api } = props;
  const settings = props.formContext.settings;
  const read = React.useCallback(
    () => ({
      checked: settings.composite.findDefaults !== false,
      models: readModels(settings.composite.models, settings.user.models)
    }),
    [settings]
  );
  const [state, setState] = React.useState(read);
  // Undefined until the server answers, so that no note shows before.
  const [status, setStatus] = React.useState<IServerStatus | null>();
  React.useEffect(() => {
    api
      .status(readCustomModels(settings.composite.customLocalModels))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [api, settings]);
  React.useEffect(() => {
    const update = () => setState(read());
    settings.changed.connect(update);
    return () => {
      settings.changed.disconnect(update);
    };
  }, [settings, read]);
  const note =
    status === undefined ? null : findDefaultsNote(status, state.models);
  return (
    <div className="jp-Epi-finddefaultsfield">
      <label htmlFor="jp-Epi-settings-findDefaults">
        <input
          type="checkbox"
          id="jp-Epi-settings-findDefaults"
          checked={state.checked}
          onChange={event => {
            const value = event.currentTarget.checked;
            setState(current => ({ ...current, checked: value }));
            void settings.set('findDefaults', value);
          }}
        />
        {FIND_DEFAULTS}
      </label>
      {note && <div className="jp-Epi-finddefaults-note">{note}</div>}
    </div>
  );
}
