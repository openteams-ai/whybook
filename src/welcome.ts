import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import type { JSONValue } from '@lumino/coreutils';
import { PromiseDelegate } from '@lumino/coreutils';
import * as React from 'react';

import { Api } from './model/api';
import type { IServerStatus } from './model/api';
import type { EpiModel } from './model/epimodel';
import { modelGate } from './model/gate';
import type { IScreenSettings } from './model/ways';
import {
  nextStep,
  readScreenSettings,
  savedWaySettings,
  screenShows,
  waySettings
} from './model/ways';
import { openSettings } from './notebook7';
import { viewExtensions } from './ui/extensions';
import { EpiPanel, FACTORY } from './widgets';

const PLUGIN_ID = 'whybook:welcome';

/** The settings of the view, which a way sets: keepDataLocal and models. */
const VIEW_SETTINGS = 'whybook:plugin';

namespace CommandIDs {
  export const threeWays = 'whybook:three-ways';
}

/** The title of the screen and of its command, as ./ui/ways.tsx gives it. */
const TITLE = 'Three ways to use models';

/**
 * The screen "Three ways to use models", a first iteration in a plugin of
 * its own: with the plugin gone, Whybook does not ask, and the view is as
 * it was.
 *
 * - It shows by itself once for each user, when a notebook first opens in
 *   Whybook, or with the setting `when` at "call", before the first request
 *   that a model reads; never when the server decides the way for every
 *   user (c.Whybook.way_to_use_models, c.Whybook.keep_data_local), and
 *   never with `when` at "never", as on Binder (binder/overrides.json). The
 *   setting `shown` records the show, so it holds for every browser of the
 *   same server user.
 * - The command palette, and a link at the end of the AI models panel, open
 *   it at any time.
 * - While it is open, every request that a model reads waits (./model/gate.ts).
 * - A way's button sets "Keep data on this machine" and the model of each
 *   task (./model/ways.ts), then opens the AI models panel at the next step,
 *   such as the Download of a local model. "Decide later" closes it, and
 *   does not change a setting.
 */
export const welcomePlugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'The screen "Three ways to use models": where models run, and what leaves this machine, asked once.',
  autoStart: true,
  optional: [ISettingRegistry, ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null
  ): void => {
    // Nothing shows by itself until the settings say so.
    let screen: IScreenSettings = { when: 'never', shown: true };
    let own: ISettingRegistry.ISettings | null = null;
    let view: ISettingRegistry.ISettings | null = null;
    // One screen at a time, and the first notebook asks once a session. The
    // screen in progress resolves to whether it showed.
    let showing: Promise<boolean> | null = null;
    let asked = false;

    const views = (): EpiPanel[] =>
      Array.from(app.shell.widgets('main')).filter(
        (widget): widget is EpiPanel => widget instanceof EpiPanel
      );
    /** The Whybook view in front, else another one that is open. */
    const inFront = (): EpiModel | null => {
      const current = app.shell.currentWidget;
      const panel = current instanceof EpiPanel ? current : views()[0];
      return panel?.content.model ?? null;
    };

    /** What the server can run; null when it does not answer. */
    const statusOf = async (
      model: EpiModel | null
    ): Promise<IServerStatus | null> => {
      try {
        return await (
          model?.api ?? new Api(app.serviceManager.serverSettings)
        ).status();
      } catch {
        return null;
      }
    };

    /**
     * Show the screen, by itself at `moment`, or because the analyst asked
     * for it with `moment` null. A way pressed sets its settings, and the AI
     * models panel of `model`'s view opens at its next step.
     */
    const show = (
      model: EpiModel | null,
      moment: 'notebook' | 'call' | null
    ): Promise<void> => {
      if (showing) {
        // The analyst's own request waits for a check in progress, such as
        // the one when a notebook opens, and shows the screen if the check
        // did not.
        return showing.then(shown =>
          moment === null && !shown ? show(model, null) : undefined
        );
      }
      const shown = new PromiseDelegate<boolean>();
      showing = shown.promise;
      // Every request that a model reads waits until Whybook knows whether
      // the screen shows, and then until it closes.
      const closed = new PromiseDelegate<void>();
      void modelGate.hold(closed.promise);
      const run = async (): Promise<boolean> => {
        const status = await statusOf(model);
        if (moment !== null) {
          if (!screenShows(moment, screen, status)) {
            return false;
          }
          // Once for each user, also when the page reloads before an answer.
          screen = { ...screen, shown: true };
          modelGate.disarm();
          await own?.set('shown', true);
        }
        // The settings as they are: the view's, else the registry's.
        const current = model
          ? {
              keepDataLocal: model.settings.keepDataLocal,
              models: model.settings.models
            }
          : view
            ? savedWaySettings(view.composite, view.user)
            : null;
        if (!current) {
          return false;
        }
        const { showThreeWays } = await import('./ui/ways');
        const way = await showThreeWays({
          status,
          keepDataLocal: current.keepDataLocal,
          models: current.models
        });
        if (way === null) {
          return true;
        }
        const next = waySettings(way, status, current.models);
        const target = model ?? inFront();
        if (target) {
          // The view's settings change at once, before the requests that
          // waited go, and are saved in the settings registry.
          target.settings.set('keepDataLocal', next.keepDataLocal);
          target.settings.set('models', next.models);
        } else {
          await view?.set('keepDataLocal', next.keepDataLocal);
          await view?.set(
            'models',
            next.models as unknown as Record<string, JSONValue>
          );
        }
        const step = nextStep(way, status, next.models);
        if (target) {
          target.requestModelsPanel(step);
        } else {
          openSettings(app.commands, app.serviceManager.serverSettings.baseUrl);
        }
        return true;
      };
      void run()
        .catch(reason => {
          console.error(
            'The screen "Three ways to use models" failed.',
            reason
          );
          return false;
        })
        .then(result => {
          closed.resolve();
          showing = null;
          shown.resolve(result);
        });
      return shown.promise.then(() => undefined);
    };

    // With `when` at "call", the first request that a model reads shows the
    // screen, and waits for it.
    const arm = () => {
      if (screen.when === 'call' && !screen.shown) {
        modelGate.arm(model => show(model, 'call'));
      } else {
        modelGate.disarm();
      }
    };

    // With `when` at "notebook", the first notebook that opens in Whybook.
    const opened = async (panel: EpiPanel) => {
      if (asked || screen.shown || screen.when !== 'notebook') {
        return;
      }
      asked = true;
      await panel.context.ready;
      if (panel.isDisposed) {
        asked = false;
        return;
      }
      await show(panel.content.model, 'notebook');
    };

    const loaded = settingRegistry
      ? Promise.all([
          settingRegistry.load(PLUGIN_ID),
          settingRegistry.load(VIEW_SETTINGS)
        ])
          .then(([settings, viewSettings]) => {
            own = settings;
            view = viewSettings;
            const read = () => {
              screen = readScreenSettings(settings.composite);
              // Cleared in the settings editor: the next notebook asks again.
              if (!screen.shown) {
                asked = false;
              }
              arm();
            };
            read();
            settings.changed.connect(read);
          })
          .catch(reason =>
            console.error(
              'Failed to load the settings of "Three ways to use models".',
              reason
            )
          )
      : Promise.resolve();

    void Promise.all([app.restored, loaded]).then(() => {
      app.docRegistry
        .getWidgetFactory(FACTORY)
        ?.widgetCreated.connect((_, widget) => void opened(widget as EpiPanel));
      // A view that the layout restored counts as a notebook that opened.
      const restored = views()[0];
      if (restored) {
        void opened(restored);
      }
    });

    app.commands.addCommand(CommandIDs.threeWays, {
      label: TITLE,
      caption:
        'Choose where models run, and what leaves this machine: frontier models for everything, data that stays on this machine, or all local.',
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => show(inFront(), null)
    });
    palette?.addItem({ command: CommandIDs.threeWays, category: 'Whybook' });

    // A link at the end of the AI models panel opens the screen again.
    viewExtensions.modelsPanel.set(PLUGIN_ID, (model, close) =>
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'jp-Epi-link',
          onClick: () => {
            close();
            void show(model, null);
          }
        },
        TITLE
      )
    );
  }
};
