import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Button, HTMLSelect } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { Api, IServerStatus } from '../model/api';
import { readCustomModels } from '../model/custommodels';
import type { IModelChoice, ModelChoices, Task } from '../model/models';
import {
  cannotRun,
  WAITING,
  choicesFor,
  PICK_MODEL,
  readModels,
  shownChoice,
  TASKS,
  withDataPolicy
} from '../model/models';
import { HelpButton, ProgressBar } from './common';
import { ModelOptions } from './modeloptions';
import { TaskModelPicker } from './taskmodels';

/** The props of a field renderer of JupyterLab's settings editor that this one reads. */
interface IFieldProps {
  schema: { title?: string; description?: string };
  formContext: { settings: ISettingRegistry.ISettings };
}

/**
 * The model of each task, in JupyterLab's settings editor: a choice per task,
 * the reason a model cannot run, and Download for a local model that is missing.
 */
export function modelsFieldRenderer(
  api: Api
): (props: IFieldProps) => JSX.Element {
  return props => <ModelsField {...props} api={api} />;
}

/** A download in progress: the share done, null while unknown, or the error. */
type Download = number | null | { error: string };

function ModelsField(props: IFieldProps & { api: Api }): JSX.Element {
  const { api } = props;
  const settings = props.formContext.settings;
  const [models, setModels] = React.useState<ModelChoices>(() =>
    readModels(settings.composite.models, settings.user.models)
  );
  const [keepLocal, setKeepLocal] = React.useState(
    settings.composite.keepDataLocal === true
  );
  const [status, setStatus] = React.useState<IServerStatus | null>(null);
  const [downloads, setDownloads] = React.useState<Record<string, Download>>(
    {}
  );
  // The task whose select opened the list of the provider's models.
  const [picking, setPicking] = React.useState<Task | null>(null);
  const refresh = React.useCallback(() => {
    // The models of the settings as this editor holds them, which may be newer than the view's copy.
    api
      .status(readCustomModels(settings.composite.customLocalModels))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [api, settings]);
  React.useEffect(refresh, [refresh]);
  React.useEffect(() => {
    let custom = JSON.stringify(settings.composite.customLocalModels ?? []);
    const update = () => {
      setModels(readModels(settings.composite.models, settings.user.models));
      setKeepLocal(settings.composite.keepDataLocal === true);
      // The server lists the models of the settings as the status request sends them.
      const next = JSON.stringify(settings.composite.customLocalModels ?? []);
      if (next !== custom) {
        custom = next;
        refresh();
      }
    };
    settings.changed.connect(update);
    return () => {
      settings.changed.disconnect(update);
    };
  }, [settings, refresh]);

  const choose = (task: Task, id: string) => {
    const next = { ...models, [task]: id };
    setModels(next);
    void settings.set('models', next);
  };

  const download = (task: Task, id: string) => {
    const set = (value: Download | undefined) =>
      setDownloads(current => {
        const next = { ...current };
        if (value === undefined) {
          delete next[id];
        } else {
          next[id] = value;
        }
        return next;
      });
    set(null);
    // A speech engine's model comes through its own route: whybook/server/speech.py.
    const fetchModel =
      task === 'speech'
        ? api.downloadSpeech.bind(api)
        : api.downloadModel.bind(api);
    fetchModel(id, event => {
      if (event.type === 'progress') {
        set(event.progress ?? null);
      } else if (event.type === 'error') {
        set({ error: event.message ?? 'the download failed' });
      } else {
        set(undefined);
        refresh();
      }
    }).catch(error => set({ error: String(error) }));
  };

  return (
    <fieldset className="jp-Epi-modelsfield">
      <legend>{props.schema.title}</legend>
      <p className="field-description">
        Which model does each task. A local model runs on this machine; the
        remote model gets the data its task needs.
      </p>
      {TASKS.map(task => {
        const policy = withDataPolicy(status, keepLocal);
        const saved = models[task.id];
        const choices = choicesFor(policy, task.id, saved);
        // A tier that the provider has no model of shows as the connected model.
        const value = saved && shownChoice(policy, saved);
        const chosen = choices.find(choice => choice.id === value);
        return (
          <div className="jp-Epi-modelsfield-task" key={task.id}>
            <TaskLabel task={task} />
            <HTMLSelect
              id={`jp-Epi-model-${task.id}`}
              value={value}
              onChange={event => {
                const next = event.currentTarget.value;
                // The provider's list opens; the choice stays until a model is picked.
                if (next === PICK_MODEL) {
                  setPicking(task.id);
                } else {
                  choose(task.id, next);
                }
              }}
            >
              <ModelOptions choices={choices} value={value} />
            </HTMLSelect>
            {chosen && (
              <ChoiceNote
                choice={chosen}
                download={downloads[chosen.id]}
                onDownload={() => download(task.id, chosen.id)}
              />
            )}
            {picking === task.id && (
              <TaskModelPicker
                api={api}
                task={task}
                onPick={next => {
                  choose(task.id, next);
                  setPicking(null);
                }}
                onCancel={() => setPicking(null)}
              />
            )}
          </div>
        );
      })}
      {!!status?.custom_model_problems?.length && (
        <div className="jp-Epi-modelsfield-note jp-mod-error">
          Left out of the custom local models:{' '}
          {status.custom_model_problems.join('; ')}.
        </div>
      )}
      {status?.json_check_warning &&
        settings.composite.localJsonCheck !== 'standard' && (
          <div className="jp-Epi-modelsfield-note jp-mod-warning">
            {status.json_check_warning}
          </div>
        )}
    </fieldset>
  );
}

function ChoiceNote(props: {
  choice: IModelChoice;
  download: Download | undefined;
  onDownload: () => void;
}): JSX.Element {
  const { choice, download } = props;
  if (download !== undefined) {
    if (download !== null && typeof download === 'object') {
      return (
        <div className="jp-Epi-modelsfield-note jp-mod-error">
          {download.error}
        </div>
      );
    }
    return (
      <div className="jp-Epi-modelsfield-note">
        Downloading {choice.label.replace(', local', '')}{' '}
        <ProgressBar value={download} label="Download" />
      </div>
    );
  }
  if (!choice.available && choice.download !== null) {
    return (
      <div className="jp-Epi-modelsfield-note">
        Not downloaded.{' '}
        <Button
          small
          className="jp-Epi-button jp-mod-styled jp-mod-accept"
          onClick={props.onDownload}
        >
          Download
          {choice.download === 0
            ? ''
            : choice.download >= 1000
              ? ` ${(choice.download / 1000).toFixed(1)} GB`
              : ` ${choice.download} MB`}
        </Button>
        {choice.from
          ? ` from ${choice.from}`
          : choice.source
            ? ` from ${choice.source} on Hugging Face`
            : ''}
      </div>
    );
  }
  if (choice.waiting) {
    return (
      <div className="jp-Epi-modelsfield-note">
        {WAITING}: connect one in the AI models panel.
      </div>
    );
  }
  return (
    <div
      className={`jp-Epi-modelsfield-note${choice.reason ? ' jp-mod-error' : ''}`}
    >
      {choice.reason ? cannotRun(choice) : choice.note}
    </div>
  );
}

/**
 * A task's name with its help icon; the help shows as the tooltip, and under
 * the task after a click.
 */
function TaskLabel(props: { task: (typeof TASKS)[number] }): JSX.Element {
  const { task } = props;
  const [help, setHelp] = React.useState(false);
  return (
    <>
      <span className="jp-Epi-tasklabel">
        <label
          className="jp-Epi-modelsfield-label"
          htmlFor={`jp-Epi-model-${task.id}`}
        >
          {task.label}
        </label>
        <HelpButton
          label={task.label}
          text={task.help}
          open={help}
          onToggle={() => setHelp(!help)}
        />
      </span>
      {help && <div className="jp-Epi-help-text jp-mod-field">{task.help}</div>}
    </>
  );
}
