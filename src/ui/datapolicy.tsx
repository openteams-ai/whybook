import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import * as React from 'react';

import type { Api, IServerStatus } from '../model/api';
import { HelpButton } from './common';

/**
 * What the setting does, for its help icon in the AI models panel. The
 * settings editor shows the schema's description (schema/plugin.json),
 * which is a short form of this text.
 */
export const DATA_POLICY_HELP =
  'Only models on this machine read outputs and variables: the local models, and a connected model that runs here. A hosted model and Jev get names, kinds and what the local models wrote about the data, and write code: no values, tables, printed outputs or pictures leave the machine. Labels and captions then need a model on this machine, and a question about a picture cannot be asked.';

/** Why the setting cannot change, when the server fixes it. */
export const DATA_POLICY_FIXED =
  'Fixed on the server: c.Whybook.keep_data_local';

/** The name of the setting zeroDataRetention, as its schema titles it. */
export const RETENTION_LABEL = 'Zero data retention (OpenRouter)';

/**
 * What zero data retention does, for its help icon in the AI models panel.
 * The settings editor shows the schema's description, a short form of it.
 */
export const RETENTION_HELP =
  'OpenRouter sends each request to one of the companies that serve the model. With this on, it sends it only to those that keep neither the prompt nor the answer, and the list of models leaves out a model that no such company serves. With it off, any of them can get the request, and some keep it.';

/** Why zero data retention cannot change, when the server pins it. */
export const RETENTION_FIXED = 'Fixed on the server: c.Whybook.openrouter_zdr';

/** The props of a setting's check box that the server can fix. */
interface IToggleProps {
  id: string;
  checked: boolean;
  fixed: boolean;
  onChange: (value: boolean) => void;
  /** False where the description shows under the box anyway, as in the settings editor. */
  help?: boolean;
}

/**
 * A setting's check box with a help icon. When the server fixes the setting
 * for every user, the box shows as checked and cannot change, with the
 * reason under it.
 */
function PolicyToggle(
  props: IToggleProps & {
    className: string;
    label: string;
    text: string;
    fixedNote: string;
  }
): JSX.Element {
  const [help, setHelp] = React.useState(false);
  // The box changes on the click: the settings answer on a later frame, and
  // until then React would put a controlled box back.
  const [checked, setChecked] = React.useState(props.checked);
  React.useEffect(() => setChecked(props.checked), [props.checked]);
  return (
    <div className={props.className}>
      <span className="jp-Epi-tasklabel">
        <label htmlFor={props.id}>
          <input
            type="checkbox"
            id={props.id}
            checked={checked || props.fixed}
            disabled={props.fixed}
            onChange={event => {
              const value = event.currentTarget.checked;
              setChecked(value);
              props.onChange(value);
            }}
          />
          {props.label}
        </label>
        {props.help !== false && (
          <HelpButton
            label={props.label}
            text={props.text}
            open={help}
            onToggle={() => setHelp(!help)}
          />
        )}
      </span>
      {props.fixed && (
        <div className="jp-Epi-aipanel-note">{props.fixedNote}</div>
      )}
      {help && <div className="jp-Epi-help-text">{props.text}</div>}
    </div>
  );
}

/**
 * "Keep data on this machine": checked and greyed when the server keeps the
 * data on the machine for every user (c.Whybook.keep_data_local).
 */
export function DataPolicyToggle(props: IToggleProps): JSX.Element {
  return (
    <PolicyToggle
      {...props}
      className="jp-Epi-datapolicy"
      label="Keep data on this machine"
      text={DATA_POLICY_HELP}
      fixedNote={DATA_POLICY_FIXED}
    />
  );
}

/**
 * "Zero data retention (OpenRouter)": checked and greyed when the server
 * pins it for every user (c.Whybook.openrouter_zdr).
 */
export function RetentionToggle(props: IToggleProps): JSX.Element {
  return (
    <PolicyToggle
      {...props}
      className="jp-Epi-retention"
      label={RETENTION_LABEL}
      text={RETENTION_HELP}
      fixedNote={RETENTION_FIXED}
    />
  );
}

/** The props of a field renderer of JupyterLab's settings editor that this one reads. */
interface IFieldProps {
  formContext: { settings: ISettingRegistry.ISettings };
}

/** A setting that the server can fix, as its field in the settings editor draws it. */
interface IPolicyField {
  /** The key in schema/plugin.json. */
  key: 'keepDataLocal' | 'zeroDataRetention';
  /** Its value when the analyst saved none: the schema's default. */
  byDefault: boolean;
  className: string;
  /** Whether the server fixes it, from the status. */
  fixed: (status: IServerStatus | null) => boolean;
  toggle: (props: IToggleProps) => JSX.Element;
}

const DATA_POLICY_FIELD: IPolicyField = {
  key: 'keepDataLocal',
  byDefault: false,
  className: 'jp-Epi-datapolicyfield',
  fixed: status => !!status?.keep_data_local,
  toggle: DataPolicyToggle
};

const RETENTION_FIELD: IPolicyField = {
  key: 'zeroDataRetention',
  byDefault: true,
  className: 'jp-Epi-retentionfield',
  fixed: status => !!status?.openrouter_zdr,
  toggle: RetentionToggle
};

/**
 * "Keep data on this machine" in JupyterLab's settings editor, with the
 * server's lock: it shows whether or not the server fixes it. The check box
 * alone, as the editor draws its other check boxes: the editor puts the
 * schema's description under it.
 */
export function dataPolicyFieldRenderer(
  api: Api
): (props: IFieldProps) => JSX.Element {
  return props => (
    <PolicyField {...props} api={api} field={DATA_POLICY_FIELD} />
  );
}

/**
 * "Zero data retention (OpenRouter)" in the settings editor: read only, and
 * on, while the server pins it (c.Whybook.openrouter_zdr).
 */
export function retentionFieldRenderer(
  api: Api
): (props: IFieldProps) => JSX.Element {
  return props => <PolicyField {...props} api={api} field={RETENTION_FIELD} />;
}

function PolicyField(
  props: IFieldProps & { api: Api; field: IPolicyField }
): JSX.Element {
  const { field } = props;
  const settings = props.formContext.settings;
  const read = () => {
    const value = settings.composite[field.key];
    return typeof value === 'boolean' ? value : field.byDefault;
  };
  const [checked, setChecked] = React.useState(read);
  const [status, setStatus] = React.useState<IServerStatus | null>(null);
  React.useEffect(() => {
    props.api
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [props.api]);
  React.useEffect(() => {
    const update = () => setChecked(read());
    settings.changed.connect(update);
    return () => {
      settings.changed.disconnect(update);
    };
  }, [settings]);
  const Toggle = field.toggle;
  return (
    <div className={field.className}>
      <Toggle
        id={`jp-Epi-settings-${field.key}`}
        checked={checked}
        fixed={field.fixed(status)}
        help={false}
        onChange={value => {
          setChecked(value);
          void settings.set(field.key, value);
        }}
      />
    </div>
  );
}

/**
 * A setting that a newer one replaced, in JupyterLab's settings editor: the
 * view still reads a saved value, and the form shows nothing of it. The
 * editor draws the schema's description under any field, so a rule of
 * style/base.css hides the row that holds this marker.
 */
export function replacedFieldRenderer(): JSX.Element {
  return <span className="jp-Epi-replacedsetting" hidden />;
}
