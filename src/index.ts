import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ILayoutRestorer } from '@jupyterlab/application';
import {
  ICommandPalette,
  IMovableSectionRegistry,
  ISessionContextDialogs,
  WidgetTracker
} from '@jupyterlab/apputils';
import type { CodeEditor } from '@jupyterlab/codeeditor';
import { IEditorServices } from '@jupyterlab/codeeditor';
import type { IDocumentWidget } from '@jupyterlab/docregistry';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { PathExt } from '@jupyterlab/coreutils';
import { IMainMenu } from '@jupyterlab/mainmenu';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStatusBar } from '@jupyterlab/statusbar';
import { ITranslator } from '@jupyterlab/translation';
import type { IFormRenderer } from '@jupyterlab/ui-components';
import { IFormRendererRegistry } from '@jupyterlab/ui-components';
import type { JSONValue } from '@lumino/coreutils';
import type { Widget } from '@lumino/widgets';
import * as React from 'react';

import { agentRunsPlugin } from './agentruns';
import { checkupPlugin } from './checkup';
import { addContextMenus } from './contextmenu';
import { addKernelMenu } from './kernelmenu';
import { launcherPlugin } from './launcher';
import { closeReloadCopy } from './reload';
import { reproducePlugin } from './reproduce';
import { DatabasesPanel } from './databases';
import { EpiSidePanel } from './sidepanel';
import { Api } from './model/api';
import type { EpiModel } from './model/epimodel';
import { EpiSettings, SECTIONS } from './model/epimodel';
import type { AgentRuns } from './model/runs';
import { IAgentRuns } from './model/runs';
import { readSettings } from './model/settings';
import { modelsFieldRenderer } from './ui/modelsfield';
import {
  dataPolicyFieldRenderer,
  replacedFieldRenderer,
  retentionFieldRenderer
} from './ui/datapolicy';
import { findDefaultsFieldRenderer } from './ui/founddefaults';
import { addSettingCards } from './ui/settingcards';
import { RightPanel } from './ui/exploration';
import {
  ContentsSection,
  QuestionsSection,
  VariablesSection
} from './ui/variables';
import type { EpiPanel } from './widgets';
import {
  CurrentModel,
  EpiFactory,
  FACTORY,
  AIStatusWidget,
  FollowingWidget,
  StatusWidget,
  plotRendererFactory
} from './widgets';
import { epiIcon, explorationIcon, variablesIcon } from './icons';

namespace CommandIDs {
  export const openWhybook = 'whybook:open-epinotebook';
  export const openNotebook = 'whybook:open-notebook';
  export const toggleInteraction = 'whybook:toggle-interaction';
}

/** The description of a command that takes no arguments. */
const NO_ARGS = { args: { type: 'object', properties: {} } };

// JupyterLab keys the settings by the npm package's name and the schema file.
const PLUGIN_ID = 'whybook:plugin';
/** JupyterLab's notebook settings, which hold the cells' editor options. */
const NOTEBOOK_SETTINGS = '@jupyterlab/notebook-extension:tracker';

/**
 * The question-driven Whybook view of notebooks, its side panels and
 * its status bar item.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'A question-driven view of notebooks.',
  autoStart: true,
  requires: [IRenderMimeRegistry],
  optional: [
    ILayoutRestorer,
    ICommandPalette,
    INotebookTracker,
    ISessionContextDialogs,
    ITranslator,
    ISettingRegistry,
    IEditorServices,
    IStatusBar,
    IDefaultFileBrowser,
    IFormRendererRegistry,
    IMovableSectionRegistry,
    IAgentRuns,
    IMainMenu
  ],
  activate: (
    app: JupyterFrontEnd,
    rendermime: IRenderMimeRegistry,
    restorer: ILayoutRestorer | null,
    palette: ICommandPalette | null,
    notebooks: INotebookTracker | null,
    sessionDialogs: ISessionContextDialogs | null,
    translator: ITranslator | null,
    settingRegistry: ISettingRegistry | null,
    editorServices: IEditorServices | null,
    statusBar: IStatusBar | null,
    fileBrowser: IDefaultFileBrowser | null,
    formRegistry: IFormRendererRegistry | null,
    movable: IMovableSectionRegistry | null,
    runs: AgentRuns | null,
    mainMenu: IMainMenu | null
  ) => {
    const settings = new EpiSettings();
    const current = new CurrentModel();
    rendermime.addFactory(plotRendererFactory, 40);

    const openFile = async (
      notebookPath: string,
      path: string,
      line: number | null
    ) => {
      const target = PathExt.join(PathExt.dirname(notebookPath), path);
      // The file editor, which docmanager:open gives for the Editor factory.
      const widget:
        IDocumentWidget<Widget & { editor?: CodeEditor.IEditor }> | undefined =
        await app.commands.execute('docmanager:open', {
          path: target,
          factory: 'Editor'
        });
      if (line && widget?.content?.editor) {
        await widget.context?.ready;
        const editor = widget.content.editor;
        editor.setCursorPosition({ line: line - 1, column: 0 });
        editor.revealPosition?.({ line: line - 1, column: 0 });
      }
    };

    const openSettings = () => {
      void app.commands.execute('settingeditor:open', { query: 'Whybook' });
    };

    const factory = new EpiFactory({
      name: FACTORY,
      label: 'Whybook',
      fileTypes: ['notebook'],
      modelName: 'notebook',
      preferKernel: true,
      canStartKernel: true,
      shutdownOnClose: false,
      rendermime,
      serverSettings: app.serviceManager.serverSettings,
      settings,
      editorServices,
      sessionDialogs: sessionDialogs ?? undefined,
      translator: translator ?? undefined,
      openFile: (notebook, path, line) => void openFile(notebook, path, line),
      openSettings,
      runs: runs ?? undefined
    });
    app.docRegistry.addWidgetFactory(factory);
    // The Running panel's item of an agent's run opens the Whybook view of
    // the run's notebook, or goes to the one open, on the run's strip.
    if (runs) {
      runs.opener = async entry => {
        const widget: EpiPanel | undefined = await app.commands.execute(
          'docmanager:open',
          { path: entry.context.path, factory: FACTORY }
        );
        widget?.content.model.showRun(entry.run);
      };
    }
    // The file browser's Open With menu shows the icon of the file type named
    // after the factory. This one matches no file: it only carries the icon.
    if (!app.docRegistry.getFileType(FACTORY)) {
      app.docRegistry.addFileType({
        name: FACTORY,
        displayName: 'Whybook',
        extensions: [],
        mimeTypes: [],
        icon: epiIcon,
        contentType: 'notebook',
        fileFormat: 'json'
      });
    }

    const tracker = new WidgetTracker<EpiPanel>({ namespace: 'whybook' });
    // JupyterLab's Kernel menu and Run menu act on the view in front.
    if (mainMenu) {
      addKernelMenu(app, tracker, mainMenu, sessionDialogs);
    }
    factory.widgetCreated.connect((_, widget) => {
      widget.context.pathChanged.connect(() => void tracker.save(widget));
      void tracker.add(widget);
      widget.disposed.connect(() => {
        if (current.model === widget.content.model) {
          current.model = tracker.currentWidget?.content.model ?? null;
        }
      });
    });
    tracker.currentChanged.connect(() => {
      current.model = tracker.currentWidget?.content.model ?? null;
    });
    if (restorer) {
      void restorer.restore(tracker, {
        command: 'docmanager:open',
        args: widget => ({ path: widget.context.path, factory: FACTORY }),
        name: widget => widget.context.path
      });
    }
    // A reload opened the notebook of the current view a second time, in
    // JupyterLab's notebook view, from the path that the page's URL keeps.
    closeReloadCopy(app, FACTORY, path =>
      tracker.find(widget => widget.context.path === path)
    );

    // The left panel: Variables, Contents of the selected variable, and Questions.
    const left = new EpiSidePanel({
      translator: translator ?? undefined,
      onMoved: (id, moved) => settings.setMoved(id, moved)
    });
    left.id = 'epi-variables';
    left.title.icon = variablesIcon;
    left.title.caption = 'Whybook: variables and questions';
    left.addClass('jp-Epi-sidepanel');
    const sections: [string, string, (model: EpiModel) => JSX.Element][] = [
      [
        SECTIONS.variables,
        'Variables',
        model => React.createElement(VariablesSection, { model })
      ],
      [
        SECTIONS.contents,
        'Contents',
        model => React.createElement(ContentsSection, { model })
      ],
      [
        SECTIONS.questions,
        'Questions',
        model => React.createElement(QuestionsSection, { model })
      ]
    ];
    for (const [id, label, render] of sections) {
      const section = new FollowingWidget(current, render);
      section.id = id;
      section.title.label = label;
      left.addSection(section);
    }
    // Contents needs the most room: a frame can have thousands of columns.
    left.accordionPanel.setRelativeSizes?.([0.3, 0.45, 0.25]);
    // Each section can move to another panel from the context menu of its header.
    movable?.registerSource(`${PLUGIN_ID}:variables`, 'Whybook', left);

    // Databases, under the file browser: where an analysis can start.
    const databases = new DatabasesPanel(
      app.serviceManager.serverSettings,
      () => current.model,
      update => {
        const handler = () => update();
        current.changed.connect(handler);
        return () => current.changed.disconnect(handler);
      }
    );
    app.shell.add(databases, 'left', { rank: 101 });
    restorer?.add(databases, databases.id);

    addContextMenus(app, () => current.model, settings);

    // The right panel: Exploration and Cell details.
    const right = new FollowingWidget(current, model =>
      React.createElement(RightPanel, { model, width: 270, editorServices })
    );
    right.id = 'epi-exploration';
    right.title.icon = explorationIcon;
    right.title.caption = 'Whybook: exploration and cell details';

    // A panel that comes back from the view opens, so the user sees where it went.
    const place = (reveal: boolean) => {
      if (settings.variablesPlacement === 'sidebar') {
        if (!left.isAttached) {
          app.shell.add(left, 'left', { rank: 150 });
          if (reveal) {
            app.shell.activateById(left.id);
          }
        }
      } else if (left.isAttached) {
        left.parent = null;
      }
      if (settings.explorationPlacement === 'sidebar') {
        if (!right.isAttached) {
          app.shell.add(right, 'right', { rank: 150 });
          if (reveal) {
            app.shell.activateById(right.id);
          }
        }
      } else if (right.isAttached) {
        right.parent = null;
      }
    };
    settings.changed.connect(() => place(true));
    // The empty view points at where an analysis starts from.
    settings.panel.connect((_, which) => {
      app.shell.activateById(
        which === 'files' ? (fileBrowser?.id ?? 'filebrowser') : databases.id
      );
    });
    // A data node clicked in the map shows its columns in Contents.
    settings.reveal.connect(() => {
      if (left.isAttached) {
        app.shell.activateById(left.id);
      }
    });
    // An answer in the sidebar goes to the right panel.
    settings.revealRight.connect(() => {
      if (right.isAttached) {
        app.shell.activateById(right.id);
      }
    });
    void app.restored.then(() => place(false));

    // Open the panels the first time a Whybook view opens.
    let revealed = false;
    factory.widgetCreated.connect((_, widget) => {
      if (revealed) {
        return;
      }
      revealed = true;
      void Promise.all([app.restored, widget.context.ready]).then(() => {
        // A notebook without code starts from a file or a table: the file
        // browser stays open, and Variables opens once there is code.
        const started = Array.from(widget.context.model.cells).some(
          cell =>
            cell.type === 'code' && cell.sharedModel.getSource().trim() !== ''
        );
        if (left.isAttached && started) {
          app.shell.activateById(left.id);
        }
        if (right.isAttached) {
          app.shell.activateById(right.id);
        }
      });
    });

    if (statusBar) {
      statusBar.registerStatusItem('whybook:status', {
        item: new StatusWidget(current, () => {
          current.model?.setRightTab('explore');
          if (right.isAttached) {
            app.shell.activateById(right.id);
          }
        }),
        align: 'left',
        rank: 5,
        isActive: () => current.model !== null
      });
      statusBar.registerStatusItem('whybook:models', {
        item: new AIStatusWidget(current, () => {
          // The panel of the view's toolbar; the settings editor without a view.
          if (current.model) {
            current.model.requestModelsPanel();
          } else {
            openSettings();
          }
        }),
        align: 'left',
        rank: 6,
        isActive: () => current.model !== null
      });
    }

    // The model of each task, in JupyterLab's settings editor, and the data
    // policy above it, with the server's lock.
    formRegistry?.addRenderer(`${PLUGIN_ID}.models`, {
      fieldRenderer: modelsFieldRenderer(
        new Api(app.serviceManager.serverSettings, {
          customModels: () => settings.customLocalModels,
          // The list of OpenRouter's models for a task follows this setting.
          zeroDataRetention: () => settings.zeroDataRetention
        })
      ) as unknown as IFormRenderer['fieldRenderer']
    });
    formRegistry?.addRenderer(`${PLUGIN_ID}.keepDataLocal`, {
      fieldRenderer: dataPolicyFieldRenderer(
        new Api(app.serviceManager.serverSettings, {
          customModels: () => settings.customLocalModels
        })
      ) as unknown as IFormRenderer['fieldRenderer']
    });
    // Zero data retention on OpenRouter, read only while the server pins it.
    formRegistry?.addRenderer(`${PLUGIN_ID}.zeroDataRetention`, {
      fieldRenderer: retentionFieldRenderer(
        new Api(app.serviceManager.serverSettings, {
          customModels: () => settings.customLocalModels
        })
      ) as unknown as IFormRenderer['fieldRenderer']
    });
    // "Find more defaults with AI", which says what it needs while no model
    // can pick the defaults.
    formRegistry?.addRenderer(`${PLUGIN_ID}.findDefaults`, {
      fieldRenderer: findDefaultsFieldRenderer(
        new Api(app.serviceManager.serverSettings, {
          customModels: () => settings.customLocalModels
        })
      ) as unknown as IFormRenderer['fieldRenderer']
    });
    // mapOutputs, which mapDetail replaced, and aiWhenNoTemplate, which
    // modelQuestions replaced: the view reads a saved value, and the form
    // leaves it out.
    for (const replaced of ['mapOutputs', 'aiWhenNoTemplate']) {
      formRegistry?.addRenderer(`${PLUGIN_ID}.${replaced}`, {
        fieldRenderer:
          replacedFieldRenderer as unknown as IFormRenderer['fieldRenderer']
      });
    }
    // The settings whose choices have pictures, as cards: in this plugin and
    // in the Check-up's.
    if (formRegistry) {
      addSettingCards(formRegistry);
    }

    if (settingRegistry) {
      void settingRegistry
        .load(PLUGIN_ID)
        .then(loaded => {
          // The replaced keys are read from what the analyst saved: JupyterLab
          // fills the defaults of their replacements into the composite.
          const apply = () =>
            settings.update(readSettings(loaded.composite, loaded.user));
          apply();
          loaded.changed.connect(apply);
          settings.save = (key, value) => {
            const name =
              key === 'capacity'
                ? 'subshellCapacity'
                : key === 'detail'
                  ? 'outputDetail'
                  : key === 'stripsClose'
                    ? 'resultStrips'
                    : key;
            // Each key that EpiSettings.set takes holds a JSON value.
            void loaded.set(name, value as JSONValue);
          };
        })
        .catch(reason =>
          console.error('Failed to load settings for the Whybook view.', reason)
        );
      // The view's editors follow the notebook's settings, such as line numbers.
      void settingRegistry
        .load(NOTEBOOK_SETTINGS)
        .then(loaded => {
          const apply = () => {
            const composite = loaded.composite as {
              codeCellConfig?: Record<string, unknown>;
              markdownCellConfig?: Record<string, unknown>;
            };
            settings.update({
              cellEditors: {
                code: { lineNumbers: false, ...composite.codeCellConfig },
                markdown: {
                  lineNumbers: false,
                  ...composite.markdownCellConfig
                }
              }
            });
          };
          apply();
          loaded.changed.connect(apply);
        })
        .catch(reason =>
          console.warn('Could not read the notebook settings.', reason)
        );
    }

    // The command that creates a notebook in the view, with its cards in the
    // launcher, File › New and the palette, is in ./launcher.ts.

    app.commands.addCommand(CommandIDs.openWhybook, {
      label: 'Open Notebook in Whybook View',
      icon: epiIcon,
      isEnabled: () => !!notebooks?.currentWidget,
      describedBy: NO_ARGS,
      execute: () => {
        const notebook = notebooks?.currentWidget;
        if (notebook) {
          return app.commands.execute('docmanager:open', {
            path: notebook.context.path,
            factory: FACTORY
          });
        }
      }
    });
    app.commands.addCommand(CommandIDs.openNotebook, {
      label: 'Open Whybook as Notebook',
      isEnabled: () => !!tracker.currentWidget,
      describedBy: NO_ARGS,
      execute: () => {
        const widget = tracker.currentWidget;
        if (widget) {
          return app.commands.execute('docmanager:open', {
            path: widget.context.path,
            factory: 'Notebook'
          });
        }
      }
    });
    app.commands.addCommand(CommandIDs.toggleInteraction, {
      label: () =>
        `Ask by ${settings.interaction === 'drag' ? 'clicking' : 'dragging'} (Whybook)`,
      describedBy: NO_ARGS,
      execute: () =>
        settings.set(
          'interaction',
          settings.interaction === 'drag' ? 'click' : 'drag'
        )
    });
    for (const command of [
      CommandIDs.openWhybook,
      CommandIDs.openNotebook,
      CommandIDs.toggleInteraction
    ]) {
      palette?.addItem({ command, category: 'Whybook' });
    }
  }
};

// The check-up of a notebook is a prototype in a plugin of its own, so that
// it can go without a trace (design iteration 1.70). So is the agent's work
// in another notebook, with the trial menu of the kernel (1.68, 1.69), and
// the launcher's section with a card for each kernel (1.72).
export default [
  plugin,
  agentRunsPlugin,
  checkupPlugin,
  reproducePlugin,
  launcherPlugin
];
