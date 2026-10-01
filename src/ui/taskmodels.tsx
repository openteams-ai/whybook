import { Button, HTMLSelect } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { Api, IProviderModel } from '../model/api';
import {
  filterExample,
  filterModels,
  messageOf,
  providerOf,
  SELECT_MODELS
} from '../model/connection';
import type { Task } from '../model/models';
import { remoteModelChoice } from '../model/models';

/** The calls of the API that the list of a provider's models makes. */
export type TaskModelsApi = Pick<Api, 'connection' | 'connectionModels'>;

/**
 * The models that the connected provider lists, for one task, under the
 * task's select in the AI models panel and in the settings editor (design
 * iteration 1.81). The analyst picks one, and the task's choice names it
 * with its provider, 'remote:openrouter:z-ai/glm-5.3-flash': the provider's
 * key answers it, and its price counts. A long list takes a filter, as the
 * list of models of the connected model does.
 */
export function TaskModelPicker(props: {
  api: TaskModelsApi;
  task: { id: Task; label: string };
  onPick: (choice: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { api, task } = props;
  const [provider, setProvider] = React.useState<{
    id: string;
    label: string;
  } | null>(null);
  const [models, setModels] = React.useState<IProviderModel[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [typed, setTyped] = React.useState('');
  const [chosen, setChosen] = React.useState('');
  React.useEffect(() => {
    let live = true;
    const list = async () => {
      // The provider and the URL of the connected model, then its list.
      const state = await api.connection();
      const id = state.connection.provider;
      if (!live) {
        return;
      }
      setProvider({ id, label: providerOf(state, id)?.label ?? id });
      const listed = await api.connectionModels(id, state.connection.base_url);
      if (live) {
        setModels(listed.models);
      }
    };
    list().catch(reason => {
      if (live) {
        setError(messageOf(reason));
        setModels([]);
      }
    });
    return () => {
      live = false;
    };
  }, [api]);
  const label = provider?.label ?? 'the connected provider';
  const many = (models?.length ?? 0) > SELECT_MODELS;
  const offered = many ? filterModels(models ?? [], typed) : (models ?? []);
  return (
    <div
      className="jp-Epi-modelpicker jp-Epi-taskpicker"
      data-task={task.id}
      aria-label={`Models for ${task.label}`}
    >
      <div className="jp-Epi-connection-group">
        Models of {label} for {task.label}
      </div>
      {models === null && (
        <div className="jp-Epi-connection-note" role="status">
          Asking {label} for its models…
        </div>
      )}
      {error && (
        <div className="jp-Epi-aipanel-note jp-mod-warning" role="alert">
          {error}
        </div>
      )}
      {models !== null && models.length > 0 && !many && (
        <HTMLSelect
          aria-label={`Model of ${label} for ${task.label}`}
          value={chosen}
          onChange={event => setChosen(event.currentTarget.value)}
        >
          <option value="">Choose a model</option>
          {models.map(entry => (
            <option key={entry.id} value={entry.id}>
              {entry.note ? `${entry.label} (${entry.note})` : entry.label}
            </option>
          ))}
        </HTMLSelect>
      )}
      {models !== null && many && (
        <>
          <input
            className="jp-mod-styled"
            aria-label={`Model of ${label} for ${task.label}`}
            placeholder={`Filter ${models.length} models, such as ${filterExample(provider?.id ?? '')}`}
            value={typed}
            onChange={event => {
              setTyped(event.currentTarget.value);
              setChosen('');
            }}
          />
          {typed && (
            <ul
              className="jp-Epi-modellist"
              role="listbox"
              aria-label="Matching models"
            >
              {offered.map(entry => (
                <li key={entry.id}>
                  <button
                    role="option"
                    aria-selected={chosen === entry.id}
                    className={chosen === entry.id ? 'jp-mod-selected' : ''}
                    onClick={() => setChosen(entry.id)}
                  >
                    <span>{entry.label}</span>
                    {entry.note && <small>{entry.note}</small>}
                  </button>
                </li>
              ))}
              {offered.length === 0 && (
                <li className="jp-Epi-connection-note">No model matches.</li>
              )}
            </ul>
          )}
        </>
      )}
      <div className="jp-Epi-keyform-buttons">
        <Button
          small
          className={chosen ? 'jp-mod-styled jp-mod-accept' : undefined}
          disabled={!chosen || !provider}
          onClick={() =>
            provider && props.onPick(remoteModelChoice(provider.id, chosen))
          }
        >
          Use for {task.label}
        </Button>
        <Button small minimal onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
