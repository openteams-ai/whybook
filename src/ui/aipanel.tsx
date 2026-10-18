import { HTMLSelect, caretDownIcon } from '@jupyterlab/ui-components';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

import type { IConnectionState } from '../model/api';
import { usesOpenRouter } from '../model/connection';
import type { EpiModel } from '../model/epimodel';
import type { ModelsPanelStep, Task } from '../model/models';
import {
  aiSummary,
  cannotRun,
  choicesFor,
  PICK_MODEL,
  shownChoice,
  TASKS,
  WAITING
} from '../model/models';
import { flash, HelpButton, useDismiss, useModel, viewOf } from './common';
import { ModelOptions } from './modeloptions';
import { ConnectionSection } from './connection';
import {
  DataPolicyToggle,
  dataPolicyFixed,
  RetentionToggle
} from './datapolicy';
import { viewExtensions } from './extensions';
import { GuardSection } from './guard';
import { DownloadLine, showsDownload, useDownloads } from './modelsfield';
import { TaskModelPicker } from './taskmodels';

/**
 * The AI button of the view's toolbar. Its panel connects the model that
 * writes cells and answers (connection.tsx), chooses the model of each task,
 * and links to all AI settings, in JupyterLab's settings editor. The status
 * bar item opens the same panel.
 */
export function AIButton(props: {
  model: EpiModel;
  openSettings: () => void;
}): JSX.Element {
  const { model, openSettings } = props;
  useModel(model);
  const button = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const [where, setWhere] = React.useState<{
    right: number;
    top: number;
  } | null>(null);
  // The element that had the focus when the panel opened, such as the link
  // of a note, takes it back on Escape: the AI button, after its own click.
  const opener = React.useRef<HTMLElement | null>(null);
  // The step at which the panel opened, such as the Download of a model that
  // the screen "Three ways to use models" chose: null for the panel's top.
  const [step, setStep] = React.useState<ModelsPanelStep | null>(null);
  const open = React.useCallback(
    (_sender: unknown = null, at: ModelsPanelStep | null = null) => {
      // A model downloaded since the view opened shows up.
      model.refreshStatus();
      const active = document.activeElement;
      opener.current =
        active instanceof HTMLElement &&
        active !== document.body &&
        !panel.current?.contains(active)
          ? active
          : null;
      setStep(at);
      setWhere(placeOf(button.current, viewOf(model)));
    },
    [model]
  );
  const close = React.useCallback(() => {
    setWhere(null);
    setStep(null);
  }, []);
  React.useEffect(() => {
    model.modelsPanelRequested.connect(open);
    return () => {
      model.modelsPanelRequested.disconnect(open);
    };
  }, [model, open]);
  // A dialog that the panel opens, such as the privacy policy's, counts as inside.
  useDismiss(panel, close, {
    anchor: button,
    keep: '.jp-Dialog'
  });
  // The panel is a dialog: it takes the focus when it opens, so that the
  // keyboard reaches its choices. With the focus left on the button, Tab
  // went past the panel, which closed as the focus left it. At a step, the
  // control of the step takes it, and its row is outlined for a moment.
  const opened = where !== null;
  React.useEffect(() => {
    if (!opened) {
      return;
    }
    // After the click that opened it: the toolbar activates the document,
    // which takes the focus, when the click leaves the focus outside it.
    const frame = window.requestAnimationFrame(() => {
      const target = step
        ? panel.current?.querySelector<HTMLElement>('[data-epi-step]')
        : null;
      if (target) {
        target.focus();
        target.scrollIntoView?.({ block: 'nearest' });
        flash(target.closest('.jp-Epi-aipanel-note') ?? target);
      } else {
        panel.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [opened, step]);
  React.useEffect(() => {
    if (!where) {
      return;
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const inside = panel.current?.contains(document.activeElement);
        close();
        if (inside) {
          const back = opener.current?.isConnected
            ? opener.current
            : button.current;
          back?.focus();
        }
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
    };
  }, [where]);
  const { settings } = model;
  // The choices as the data policy leaves them: no remote model reads a table.
  const status = model.policyStatus;
  // The connection as the panel's section last read it.
  const [connection, setConnection] = React.useState<IConnectionState | null>(
    null
  );
  // The task whose select opened the list of the provider's models.
  const [picking, setPicking] = React.useState<Task | null>(null);
  // A local model's file goes on downloading while the panel is closed.
  const [downloads, download] = useDownloads(model.api, () =>
    model.refreshStatus()
  );
  return (
    <>
      <button
        ref={button}
        className="jp-Epi-aibutton"
        aria-haspopup="dialog"
        aria-expanded={where !== null}
        title={`${aiSummary(status, settings.models)}. Choose the model of each task.`}
        onClick={() => (where ? close() : open())}
      >
        <span>AI</span>
        <caretDownIcon.react tag="span" className="jp-Epi-aibutton-caret" />
      </button>
      {where &&
        ReactDOM.createPortal(
          <div
            ref={panel}
            className="jp-Epi-aipanel"
            role="dialog"
            aria-label="AI models"
            tabIndex={-1}
            style={{
              right: where.right,
              top: where.top,
              // The panel scrolls when the connection's choices make it taller than the window.
              maxHeight: `calc(100vh - ${where.top + 8}px)`
            }}
          >
            <div className="jp-Epi-aipanel-title">AI models</div>
            <ConnectionSection
              model={model}
              onState={setConnection}
              openList={step?.kind === 'connect' ? step : null}
            />
            {model.jsonCheckWarning && (
              <div className="jp-Epi-aipanel-note jp-mod-warning">
                {model.jsonCheckWarning}
              </div>
            )}
            <div className="jp-Epi-policies">
              <DataPolicyToggle
                id="jp-Epi-quick-keepDataLocal"
                checked={settings.keepDataLocal}
                fixed={model.dataFixed}
                fixedNote={dataPolicyFixed(model.status)}
                onChange={value => settings.set('keepDataLocal', value)}
              />
              {/* Only with an OpenRouter connection, whose requests it filters. */}
              {usesOpenRouter(model.status, connection) && (
                <RetentionToggle
                  id="jp-Epi-quick-zeroDataRetention"
                  checked={settings.zeroDataRetention}
                  fixed={model.retentionFixed}
                  onChange={value => settings.set('zeroDataRetention', value)}
                />
              )}
            </div>
            <GuardSection model={model} />
            {TASKS.map(task => {
              const saved = settings.models[task.id];
              const choices = choicesFor(status, task.id, saved);
              // A tier that the provider has no model of shows as the connected model.
              const value = saved && shownChoice(status, saved);
              const chosen = choices.find(choice => choice.id === value);
              const choose = (next: string) =>
                settings.set('models', { ...settings.models, [task.id]: next });
              return (
                <TaskRow key={task.id} task={task}>
                  <HTMLSelect
                    id={`jp-Epi-quick-${task.id}`}
                    value={value}
                    onChange={event => {
                      const next = event.currentTarget.value;
                      // The provider's list opens; the choice stays until a model is picked.
                      if (next === PICK_MODEL) {
                        setPicking(task.id);
                      } else {
                        choose(next);
                      }
                    }}
                  >
                    <ModelOptions choices={choices} value={value} />
                  </HTMLSelect>
                  {picking === task.id && (
                    <TaskModelPicker
                      api={model.api}
                      task={task}
                      onPick={next => {
                        choose(next);
                        setPicking(null);
                      }}
                      onCancel={() => setPicking(null)}
                    />
                  )}
                  {chosen &&
                    chosen.id !== 'off' &&
                    // A local model's file downloads here; a speech
                    // engine's, in the settings editor.
                    (task.id !== 'speech' &&
                    showsDownload(chosen, downloads[chosen.id]) ? (
                      <DownloadLine
                        choice={chosen}
                        download={downloads[chosen.id]}
                        onDownload={() => download(task.id, chosen.id)}
                        className="jp-Epi-aipanel-note jp-mod-download"
                        step={
                          step?.kind === 'download' && step.task === task.id
                        }
                      />
                    ) : (
                      !chosen.available &&
                      (chosen.waiting ? (
                        <div className="jp-Epi-aipanel-note jp-mod-waiting">
                          {WAITING}
                        </div>
                      ) : (
                        <div className="jp-Epi-aipanel-note">
                          {chosen.download !== null
                            ? 'Not downloaded: see all AI settings'
                            : cannotRun(chosen)}
                        </div>
                      ))
                    ))}
                </TaskRow>
              );
            })}
            <div className="jp-Epi-aipanel-links">
              <button
                className="jp-Epi-link"
                onClick={() => {
                  close();
                  openSettings();
                }}
              >
                All AI settings
              </button>
              {/* Links that a plugin of its own adds, such as the screen "Three ways to use models". */}
              {Array.from(viewExtensions.modelsPanel, ([id, link]) => (
                <React.Fragment key={id}>{link(model, close)}</React.Fragment>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

/**
 * Where the panel opens: under the AI button, with their right edges in
 * line. The toolbar's "⋯" menu holds the items that the toolbar has no room
 * for, and while it is closed the button in it has no box: the panel then
 * opens under the toolbar, at the right edge of the notebook, where "⋯" is.
 * With the notebook out of sight too, it opens at the top right of the window.
 */
function placeOf(
  button: HTMLElement | null,
  view: HTMLElement | null
): { right: number; top: number } {
  const under = boxOf(button);
  if (under) {
    return { right: window.innerWidth - under.right, top: under.bottom + 2 };
  }
  const area = boxOf(view);
  if (area) {
    return { right: window.innerWidth - area.right, top: area.top + 2 };
  }
  return { right: 8, top: 8 };
}

/** The box of an element on the page, or null when it shows nowhere. */
function boxOf(element: HTMLElement | null): DOMRect | null {
  const box = element?.getBoundingClientRect();
  return box && (box.width > 0 || box.height > 0) ? box : null;
}

/**
 * One task of the panel: its name with a help icon, its choice, and the
 * help under them once the icon is pressed.
 */
function TaskRow(props: {
  task: (typeof TASKS)[number];
  children: React.ReactNode;
}): JSX.Element {
  const { task } = props;
  const [help, setHelp] = React.useState(false);
  return (
    <div className="jp-Epi-aipanel-row">
      <span className="jp-Epi-tasklabel">
        <label htmlFor={`jp-Epi-quick-${task.id}`}>{task.label}</label>
        <HelpButton
          label={task.label}
          text={task.help}
          open={help}
          onToggle={() => setHelp(!help)}
        />
      </span>
      {props.children}
      {help && <div className="jp-Epi-help-text">{task.help}</div>}
    </div>
  );
}
