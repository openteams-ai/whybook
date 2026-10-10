import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { IDocumentWidget } from '@jupyterlab/docregistry';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';
import * as React from 'react';

import { addCellItem, cellUnderMenu } from './cellmenu';
import { checkupIcon } from './icons';
import { checkupOf, existingCheckup } from './model/checkup';
import type { EpiModel } from './model/epimodel';
import type { ICellAlternative } from './model/libraries';
import {
  cellAlternatives,
  compareLabel,
  compareOption,
  compareWhy
} from './model/libraries';
import { CheckupSection } from './ui/checkup';
import { viewExtensions } from './ui/extensions';
import { EpiPanel, FACTORY } from './widgets';

const PLUGIN_ID = 'whybook:checkup';

namespace CommandIDs {
  export const compare = 'whybook:compare-library';
}

/** Where the tab's icon turns into the Check-up's: on no tab, on the tabs of Whybook views, or on every notebook's tab. */
type TabQuestion = 'off' | 'whybook' | 'notebooks';

/**
 * The key of `title.dataset` that marks a notebook's tab for the Check-up:
 * the tab bar writes it as `data-whybook-ask`, and style/checkup.css fades
 * the tab's icon into the icon of the Check-up while the pointer is on the
 * tab.
 */
const ASK_KEY = 'whybook-ask';

/**
 * The CSS variable that holds the icon of the Check-up as an image, which
 * style/checkup.css draws on a marked tab: the same icon as the head of the
 * Check-up, from one source.
 */
const ICON_VARIABLE = '--epi-checkup-icon';

/** The id of the right panel, where the Exploration panel is: see ./index.ts. */
const RIGHT_PANEL = 'epi-exploration';

/** The path of a document's widget, or null for another widget. */
function pathOf(widget: Widget): string | null {
  return 'context' in widget
    ? ((widget as IDocumentWidget).context?.path ?? null)
    : null;
}

/** The commands that save the notebook elsewhere: an event of 1.70. */
const EXPORTS = new Set(['docmanager:download', 'notebook:export-to-format']);

/**
 * The Check-up at the end of the Exploration panel, while "Questions about
 * the notebook" is on. It draws again when the setting changes: a view that
 * is open at that moment shows the Check-up, or stops showing it, with no
 * reload of the page (design iteration 1.83).
 */
function CheckupBlock(props: {
  model: EpiModel;
  enabled: () => boolean;
  switched: ISignal<object, void>;
}): JSX.Element | null {
  const { model, enabled, switched } = props;
  const [, redraw] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => {
    const draw = () => redraw();
    switched.connect(draw);
    return () => {
      switched.disconnect(draw);
    };
  }, [switched]);
  return enabled() ? React.createElement(CheckupSection, { model }) : null;
}

/**
 * Questions about the notebook itself, a prototype of design iterations
 * 1.67 to 1.70, as a plugin of its own: with the plugin gone, or its
 * setting "Questions about the notebook" off, the view is as it was.
 *
 * - A folded Check-up section at the end of the Exploration panel (1.68, D):
 *   the rules of "Does it run from the top?", "What makes it slow?", the
 *   review and the gaps, and "What would a reviewer ask?", one model call
 *   on request (./ui/checkup.tsx, ./model/checkup.ts).
 * - The run time of each cell that the view sees run, from the kernel's
 *   messages (./model/runtimes.ts).
 * - "Compare with statsmodels" in the menu of a cell that calls a known
 *   library (1.68, C2): a branch of the cell that a model writes.
 * - A trial behind its own setting, on the tabs of Whybook views by default
 *   (1.68, A3): while the pointer is on a notebook's tab, the tab's icon
 *   fades into the icon of the Check-up, and a click on it opens the
 *   Check-up, which comes into sight and is outlined for a moment.
 */
export const checkupPlugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    "Questions about the notebook itself: a Check-up section in the Exploration panel, a comparison with another library in a cell's menu, and the Check-up's icon on the notebook's tab.",
  autoStart: true,
  optional: [ISettingRegistry, INotebookTracker],
  activate: (
    app: JupyterFrontEnd,
    settingRegistry: ISettingRegistry | null,
    notebooks: INotebookTracker | null
  ): void => {
    // Off until the settings say otherwise: the Check-up is off by default.
    let enabled = false;
    let tabQuestion: TabQuestion = 'off';

    const whybookViews = (): EpiPanel[] =>
      Array.from(app.shell.widgets('main')).filter(
        (widget): widget is EpiPanel => widget instanceof EpiPanel
      );

    // The check-up of each view, which records the run times of its cells
    // from the moment the view opens.
    const attach = (panel: EpiPanel) => {
      if (!enabled || panel.isDisposed) {
        return;
      }
      const model = panel.content.model;
      if (!existingCheckup(model)) {
        checkupOf(model);
        // The check-up goes with its view: it stops listening to the kernel.
        panel.disposed.connect(() => existingCheckup(model)?.dispose());
      }
    };
    const detachAll = () => {
      for (const panel of whybookViews()) {
        existingCheckup(panel.content.model)?.dispose();
      }
    };

    // The Check-up of the Exploration panel draws again when the setting
    // turns it on or off, so that an open view needs no reload of the page.
    const switched = new Signal<object, void>({});
    viewExtensions.exploration.set(PLUGIN_ID, model =>
      React.createElement(CheckupBlock, {
        model,
        enabled: () => enabled,
        switched
      })
    );

    // The trial on a notebook's tab: its icon fades into the Check-up's.
    document.documentElement.style.setProperty(
      ICON_VARIABLE,
      `url("data:image/svg+xml,${encodeURIComponent(checkupIcon.svgstr)}")`
    );
    const marked = (widget: Widget): boolean =>
      tabQuestion !== 'off' &&
      enabled &&
      (widget instanceof EpiPanel ||
        (tabQuestion === 'notebooks' && !!notebooks?.has(widget)));
    const mark = (widget: Widget) => {
      const dataset = { ...widget.title.dataset };
      const on = marked(widget);
      if (on === ASK_KEY in dataset) {
        return;
      }
      if (on) {
        dataset[ASK_KEY] = 'true';
      } else {
        delete dataset[ASK_KEY];
      }
      widget.title.dataset = dataset;
    };
    const markAll = () => {
      for (const widget of app.shell.widgets('main')) {
        mark(widget);
      }
    };

    /** Open the Check-up of a notebook's Whybook view, from the view or from JupyterLab's notebook view. */
    const openCheckup = async (widget: Widget) => {
      let panel: EpiPanel | undefined =
        widget instanceof EpiPanel ? widget : undefined;
      if (!panel) {
        const path = pathOf(widget);
        if (!path) {
          return;
        }
        panel = (await app.commands.execute('docmanager:open', {
          path,
          factory: FACTORY
        })) as EpiPanel | undefined;
      }
      if (!panel) {
        return;
      }
      app.shell.activateById(panel.id);
      const model = panel.content.model;
      model.setRightTab('explore');
      checkupOf(model).open(true);
      if (model.settings.explorationPlacement === 'sidebar') {
        app.shell.activateById(RIGHT_PANEL);
      }
    };

    // A pointer down on the icon of a marked tab opens the Check-up, before
    // the tab bar selects the tab or starts to move it: the listener runs in
    // the capture phase, and the event goes no further.
    document.addEventListener(
      'pointerdown',
      event => {
        if (tabQuestion === 'off' || !enabled || event.button !== 0) {
          return;
        }
        const icon = (event.target as Element | null)?.closest?.(
          `.lm-TabBar-tab[data-${ASK_KEY}] .lm-TabBar-tabIcon`
        );
        const tab = icon?.closest('.lm-TabBar-tab') as HTMLElement | null;
        const id = tab?.dataset.id;
        const widget = id
          ? Array.from(app.shell.widgets('main')).find(item => item.id === id)
          : undefined;
        if (!widget) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void openCheckup(widget);
      },
      true
    );

    // "Compare with statsmodels" in the menu of a cell that calls a known
    // library, after "Ask about this cell" (src/contextmenu.ts).
    const hitCell = (): {
      model: EpiModel;
      cellId: string;
    } | null => {
      const node = cellUnderMenu(app);
      const cellId = node?.dataset.cellId;
      const panel = node
        ? whybookViews().find(view => view.node.contains(node))
        : undefined;
      return cellId && panel ? { model: panel.content.model, cellId } : null;
    };
    const entryOf = (
      index: number
    ): {
      model: EpiModel;
      cell: { id: string; label: string };
      entry: ICellAlternative;
    } | null => {
      const hit = enabled ? hitCell() : null;
      const cell = hit ? hit.model.cell(hit.cellId) : null;
      if (!hit || !cell || cell.type !== 'code') {
        return null;
      }
      const notebook = hit.model
        .codeCells()
        .map(item => item.model.sharedModel.getSource())
        .join('\n');
      const entry = cellAlternatives(
        cell.model.sharedModel.getSource(),
        notebook,
        hit.model.bridge.snapshot?.packages ?? null
      )[index];
      return entry ? { model: hit.model, cell, entry } : null;
    };
    const indexOf = (args: Record<string, unknown>): number =>
      typeof args.index === 'number' ? args.index : 0;
    app.commands.addCommand(CommandIDs.compare, {
      label: args => {
        const found = entryOf(indexOf(args));
        return found
          ? compareLabel(found.entry)
          : 'Compare with another library';
      },
      caption: args => {
        const found = entryOf(indexOf(args));
        if (!found) {
          return '';
        }
        const off = found.model.aiOff();
        const lacks = found.entry.missing
          ? ` This kernel has no ${found.entry.alternatives[0].module}.`
          : off
            ? ` Needs an AI model: ${off.reason}.`
            : ' Needs AI.';
        return `A model writes a branch of ${found.cell.label} with ${found.entry.other}. ${compareWhy(found.entry)}.${lacks}`;
      },
      isVisible: args => !!entryOf(indexOf(args)),
      isEnabled: args => {
        const found = entryOf(indexOf(args));
        return !!found && !found.entry.missing && !found.model.aiOff();
      },
      describedBy: {
        args: {
          type: 'object',
          properties: {
            index: {
              type: 'number',
              description:
                'Which other library of the cell: 0 for the first, 1 for the second'
            }
          }
        }
      },
      execute: args => {
        const found = entryOf(indexOf(args));
        if (found) {
          void found.model.apply(compareOption(found.entry, found.cell));
        }
      }
    });
    for (const index of [0, 1]) {
      addCellItem(app, {
        command: CommandIDs.compare,
        args: { index },
        rank: 0.035 + index / 1000
      });
    }

    // An export or a download of a notebook: the Check-up's note may say how
    // long it has been since the last one (1.70).
    app.commands.commandExecuted.connect((_, executed) => {
      if (!enabled || !EXPORTS.has(executed.id)) {
        return;
      }
      const current = app.shell.currentWidget;
      const path = current ? pathOf(current) : null;
      for (const panel of whybookViews()) {
        if (panel.context.path === path) {
          existingCheckup(panel.content.model)?.exported();
        }
      }
    });

    const apply = () => {
      if (enabled) {
        whybookViews().forEach(attach);
      } else {
        detachAll();
      }
      markAll();
    };
    void app.restored.then(() => {
      // The views that the layout restored, and those that open later.
      app.docRegistry
        .getWidgetFactory(FACTORY)
        ?.widgetCreated.connect((_, widget) => {
          attach(widget as EpiPanel);
          mark(widget);
        });
      notebooks?.widgetAdded.connect((_, panel) => mark(panel));
      apply();
    });

    if (settingRegistry) {
      void settingRegistry
        .load(PLUGIN_ID)
        .then(settings => {
          const read = () => {
            const composite = settings.composite as {
              enabled?: unknown;
              tabQuestion?: unknown;
            };
            enabled = composite.enabled === true;
            const tab = composite.tabQuestion;
            tabQuestion =
              tab === 'whybook' || tab === 'notebooks' ? tab : 'off';
            apply();
            switched.emit();
          };
          read();
          settings.changed.connect(read);
        })
        .catch(reason =>
          console.error('Failed to load the settings of the check-up.', reason)
        );
    }
  }
};
