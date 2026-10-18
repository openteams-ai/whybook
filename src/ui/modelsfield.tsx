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
export type Download = number | null | { error: string };

/**
 * The downloads that a form started, by the model's id, and the function
 * that starts one: a speech engine's model through its own route
 * (whybook/server/speech.py), any other through models/download. `done`
 * runs when a download ends well, so that the form reads the status again.
 */
export function useDownloads(
  api: Api,
  done: () => void
): [Record<string, Download>, (task: Task, id: string) => void] {
  const [downloads, setDownloads] = React.useState<Record<string, Download>>(
    {}
  );
  const finished = React.useRef(done);
  finished.current = done;
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
        finished.current();
      }
    }).catch(error => set({ error: String(error) }));
  };
  return [downloads, download];
}

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

  const [downloads, download] = useDownloads(api, refresh);

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
            <TaskLabel task={task} measured={chosen?.measured} />
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

/**
 * The line under a model's select while its file is not on this machine:
 * Download with its size and where it comes from, then the progress of the
 * download, or its error. Null for a model that needs no download. Nothing
 * downloads until the analyst presses Download.
 */
export function DownloadLine(props: {
  choice: IModelChoice;
  download: Download | undefined;
  onDownload: () => void;
  /** The class of the line: the settings editor's, or the AI models panel's. */
  className: string;
  /** Marks the button as the step at which the AI models panel opened. */
  step?: boolean;
}): JSX.Element | null {
  const { choice, download, className } = props;
  if (download !== undefined) {
    if (download !== null && typeof download === 'object') {
      return (
        <div className={`${className} jp-mod-error`}>{download.error}</div>
      );
    }
    return (
      <div className={className}>
        Downloading {choice.label.replace(', local', '')}{' '}
        <ProgressBar value={download} label="Download" />
      </div>
    );
  }
  const size = choice.download;
  if (choice.available || size === null) {
    return null;
  }
  return (
    <div className={className}>
      Not downloaded.{' '}
      <Button
        small
        className="jp-Epi-button jp-mod-styled jp-mod-accept"
        data-epi-step={props.step ? 'true' : undefined}
        onClick={props.onDownload}
      >
        Download
        {size === 0
          ? ''
          : size >= 1000
            ? ` ${(size / 1000).toFixed(1)} GB`
            : ` ${size} MB`}
      </Button>
      {choice.from
        ? ` from ${choice.from}`
        : choice.source
          ? ` from ${choice.source} on Hugging Face`
          : ''}
    </div>
  );
}

/** Whether a model's line is about its download: one that goes on or ended badly, or a file to download. */
export function showsDownload(
  choice: IModelChoice,
  download: Download | undefined
): boolean {
  return (
    download !== undefined || (!choice.available && choice.download !== null)
  );
}

function ChoiceNote(props: {
  choice: IModelChoice;
  download: Download | undefined;
  onDownload: () => void;
}): JSX.Element {
  const { choice } = props;
  if (showsDownload(choice, props.download)) {
    return <DownloadLine {...props} className="jp-Epi-modelsfield-note" />;
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
 * the task after a click. How the chosen model did when it was measured is
 * the last paragraph of the help.
 */
function TaskLabel(props: {
  task: (typeof TASKS)[number];
  measured?: string;
}): JSX.Element {
  const { task, measured } = props;
  const [help, setHelp] = React.useState(false);
  const paragraphs = measured ? [task.help, measured] : [task.help];
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
          text={paragraphs.join('\n\n')}
          open={help}
          onToggle={() => setHelp(!help)}
        />
      </span>
      {help && (
        <div className="jp-Epi-help-text jp-mod-field">
          {paragraphs.map(text => (
            <p key={text}>{text}</p>
          ))}
        </div>
      )}
    </>
  );
}
