import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { ISessionContext } from '@jupyterlab/apputils';
import { ISessionContextDialogs } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type { IDocumentWidget } from '@jupyterlab/docregistry';
import type { NotebookPanel } from '@jupyterlab/notebook';
import { INotebookTracker } from '@jupyterlab/notebook';
import type { Contents } from '@jupyterlab/services';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { MenuSvg } from '@jupyterlab/ui-components';
import type { Widget } from '@lumino/widgets';

import { checkupQuestions } from './model/checkup';
import type { ICrossQuestion, IKernelSpecLike } from './model/crosskernel';
import {
  crossQuestions,
  kernelChoices,
  menuKernels,
  withRecent
} from './model/crosskernel';
import type { EpiModel } from './model/epimodel';
import type { AgentRuns, INotebookHost } from './model/runs';
import { IAgentRuns } from './model/runs';
import { EpiPanel, FACTORY } from './widgets';

const PLUGIN_ID = 'whybook:reproduce';

namespace CommandIDs {
  export const restart = 'whybook:kernel-menu-restart';
  export const change = 'whybook:kernel-menu-change';
  export const more = 'whybook:kernel-menu-more';
  export const reproduce = 'whybook:kernel-menu-reproduce';
}

/** Where the menu keeps the kernels used most recently, in this browser. */
const RECENT_KEY = 'whybook:recent-kernels';

function readRecent(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function writeRecent(names: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(names));
  } catch {
    // A private window keeps no list: the menu orders by language and name.
  }
}

/** The notebook of a panel of the main area: its path, its session and its Whybook model. */
interface ITarget {
  path: string;
  sessionContext: ISessionContext;
  /** The view model of the notebook's Whybook view, when one is open. */
  model: EpiModel | null;
}

/**
 * An agent that works in another notebook (design iterations 1.68 and 1.69),
 * as a plugin of its own:
 *
 * - the host of the notebooks that an agent's run makes: it makes one
 *   through JupyterLab's commands, opens it in the Whybook view beside the
 *   first with the kernel asked for, and removes it again (./model/runs.ts);
 * - "Would I get the same results in R?" in the Check-up section, once for
 *   each kernel that can answer it (./model/checkup.ts);
 * - the setting "Kernel menu", on by default (1.68, B1): a click on the
 *   kernel's name in a notebook's toolbar opens a menu with Restart kernel,
 *   the notebook's own kernel with a check mark, three other kernels,
 *   + More… for JupyterLab's own dialog, and Reproduce in another kernel.
 *   Off, JupyterLab's dialog opens as before, and the plugin does not touch
 *   the click. The menu does not depend on the Check-up's setting.
 */
export const reproducePlugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Reproduce the analysis with another kernel, in a notebook of its own, from the Check-up or from the menu of the kernel.',
  autoStart: true,
  optional: [
    IAgentRuns,
    ISettingRegistry,
    INotebookTracker,
    ISessionContextDialogs
  ],
  activate: (
    app: JupyterFrontEnd,
    runs: AgentRuns | null,
    settingRegistry: ISettingRegistry | null,
    notebooks: INotebookTracker | null,
    sessionDialogs: ISessionContextDialogs | null
  ): void => {
    const whybookViews = (): EpiPanel[] =>
      Array.from(app.shell.widgets('main')).filter(
        (widget): widget is EpiPanel => widget instanceof EpiPanel
      );
    const viewOf = (path: string): EpiPanel | null =>
      whybookViews().find(
        panel => panel.context.path === path && !panel.isDisposed
      ) ?? null;

    const host: INotebookHost = {
      async create({ path, kernel, beside }) {
        const created = (await app.commands.execute('docmanager:new-untitled', {
          path: PathExt.dirname(path),
          type: 'notebook'
        })) as Contents.IModel;
        await app.serviceManager.contents.rename(created.path, path);
        // JupyterLab's tracker of views takes a view that opens while no
        // view has the focus as its current one, as when the question was
        // asked from the Check-up: the side panels would then show the new
        // notebook. The first notebook's view, the current tab, takes the
        // focus first.
        const first = viewOf(beside);
        if (first && app.shell.currentWidget === first) {
          app.shell.activateById(first.id);
        }
        const panel = (await app.commands.execute('docmanager:open', {
          path,
          factory: FACTORY,
          kernel: { name: kernel },
          // A tab after the first notebook's, which keeps the focus.
          options: {
            mode: 'tab-after',
            ref: viewOf(beside)?.id,
            activate: false
          }
        })) as EpiPanel | undefined;
        if (!panel) {
          throw new Error(`JupyterLab did not open ${path}`);
        }
        await panel.context.ready;
        await panel.context.sessionContext.ready;
        const connection = panel.context.sessionContext.session?.kernel;
        if (!connection) {
          throw new Error(`the kernel ${kernel} did not start`);
        }
        // The info reply comes once the kernel runs.
        await connection.info;
        return panel.content.model;
      },
      async show(path, cellId = null, activate = true) {
        const panel = (await app.commands.execute('docmanager:open', {
          path,
          factory: FACTORY,
          ...(activate
            ? {}
            : { options: { mode: 'tab-after', activate: false } })
        })) as EpiPanel | undefined;
        if (panel && cellId) {
          await panel.context.ready;
          panel.content.model.showCell(cellId);
        }
      },
      modelOf(path) {
        return viewOf(path)?.content.model ?? null;
      },
      async remove(path) {
        // Every view of the notebook, the Whybook view and JupyterLab's, closes
        // without asking to save: the notebook goes.
        for (const widget of Array.from(app.shell.widgets('main'))) {
          const context = (widget as Widget & Partial<IDocumentWidget>).context;
          if (context?.path === path) {
            context.model.dirty = false;
            widget.dispose();
          }
        }
        await app.serviceManager.sessions.stopIfNeeded(path);
        await app.serviceManager.contents.delete(path);
      }
    };
    if (runs) {
      runs.host = host;
    }

    const specs = () =>
      app.serviceManager.kernelspecs.specs?.kernelspecs as
        Record<string, IKernelSpecLike | undefined> | undefined;

    // "Would I get the same results in R?" in the Check-up's group
    // Reproduce: one row for each kernel that can answer it, which shows in
    // the notebooks that the kernel's question is offered for.
    const addQuestions = () => {
      for (const id of [...checkupQuestions.keys()]) {
        if (id === 'other-language' || id.startsWith('reproduce:')) {
          checkupQuestions.delete(id);
        }
      }
      const question = (model: EpiModel, name: string) =>
        model.kernelQuestions().find(item => item.kernel.name === name) ?? null;
      for (const choice of kernelChoices(specs())) {
        const id = `reproduce:${choice.name}`;
        checkupQuestions.set(id, {
          id,
          group: 'reproduce',
          text: model => question(model, choice.name)?.text ?? '',
          how: `An agent reruns the analysis in a new notebook with ${choice.displayName}, and compares the estimates`,
          cost: 'needs AI · an agent',
          needsAI: true,
          ask: model => {
            const found = question(model, choice.name);
            if (found) {
              void model.askInKernel(found);
            }
          }
        });
      }
    };
    void app.serviceManager.kernelspecs.ready.then(addQuestions);
    app.serviceManager.kernelspecs.specsChanged.connect(addQuestions);

    // The kernels used most recently in this browser, for the menu's order.
    const noteKernel = (sessionContext: ISessionContext) => {
      const name = sessionContext.session?.kernel?.name;
      if (name) {
        writeRecent(withRecent(readRecent(), name));
      }
    };
    const watch = (sessionContext: ISessionContext) => {
      sessionContext.kernelChanged.connect(() => noteKernel(sessionContext));
    };
    notebooks?.widgetAdded.connect((_, panel) => watch(panel.sessionContext));
    app.docRegistry
      .getWidgetFactory(FACTORY)
      ?.widgetCreated.connect((_, widget) =>
        watch((widget as EpiPanel).context.sessionContext)
      );

    // The menu of the kernel's name (1.68, B1). JupyterLab's MenuSvg draws
    // the check mark of the notebook's own kernel; Lumino's Menu draws none.
    let menuOn = false;
    let target: ITarget | null = null;
    const menu = new MenuSvg({ commands: app.commands });
    menu.addClass('jp-Epi-kernelmenu');
    menu.id = 'jp-Epi-kernelmenu';

    const targetOf = (node: Element): ITarget | null => {
      const widget = Array.from(app.shell.widgets('main')).find(item =>
        item.node.contains(node)
      );
      if (widget instanceof EpiPanel) {
        return {
          path: widget.context.path,
          sessionContext: widget.context.sessionContext,
          model: widget.content.model
        };
      }
      if (widget && notebooks?.has(widget)) {
        const panel = widget as NotebookPanel;
        return {
          path: panel.context.path,
          sessionContext: panel.sessionContext,
          model: viewOf(panel.context.path)?.content.model ?? null
        };
      }
      return null;
    };

    const questionsOf = (goal: ITarget): ICrossQuestion[] =>
      crossQuestions(
        goal.sessionContext.session?.kernel?.name ?? null,
        kernelChoices(specs())
      );

    app.commands.addCommand(CommandIDs.restart, {
      label: 'Restart kernel',
      describedBy: { args: { type: 'object', properties: {} } },
      isEnabled: () => !!target?.sessionContext.session?.kernel,
      execute: async () => {
        const context = target?.sessionContext;
        if (!context) {
          return;
        }
        if (sessionDialogs) {
          await sessionDialogs.restart(context);
        } else {
          await context.restartKernel();
        }
      }
    });
    app.commands.addCommand(CommandIDs.change, {
      label: args =>
        kernelChoices(specs()).find(choice => choice.name === args.name)
          ?.displayName ?? String(args.name ?? 'Another kernel'),
      caption: args =>
        args.name === target?.sessionContext.session?.kernel?.name
          ? "This notebook's kernel"
          : `Change this notebook's kernel to ${String(args.name ?? '')}: its cells then run there`,
      // The notebook's own kernel, first in the menu, shows a check mark.
      isToggled: args =>
        args.name === target?.sessionContext.session?.kernel?.name,
      describedBy: {
        args: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The name of the kernelspec to change to'
            }
          }
        }
      },
      execute: async args => {
        const context = target?.sessionContext;
        const name = String(args.name ?? '');
        if (context && name && name !== context.session?.kernel?.name) {
          await context.changeKernel({ name });
        }
      }
    });
    app.commands.addCommand(CommandIDs.more, {
      label: '+ More…',
      caption:
        "JupyterLab's dialog, with every kernel and every running session",
      describedBy: { args: { type: 'object', properties: {} } },
      execute: async () => {
        const context = target?.sessionContext;
        if (context && sessionDialogs) {
          await sessionDialogs.selectKernel(context);
        }
      }
    });
    app.commands.addCommand(CommandIDs.reproduce, {
      label: args => {
        const found = target
          ? questionsOf(target).find(item => item.kernel.name === args.kernel)
          : null;
        return found
          ? `Reproduce in ${found.kernel.displayName}`
          : 'Reproduce in another kernel';
      },
      caption: args => {
        const found = target
          ? questionsOf(target).find(item => item.kernel.name === args.kernel)
          : null;
        const off = target?.model?.aiOff();
        return `${found?.text ?? ''} An agent reruns the analysis in a new notebook beside this one, with ${found?.kernel.displayName ?? 'the kernel'}, and compares the estimates. It installs nothing. ${off ? `Needs an AI model: ${off.reason}.` : 'Needs AI.'}`.trim();
      },
      isEnabled: () => !target?.model?.aiOff(),
      describedBy: {
        args: {
          type: 'object',
          properties: {
            kernel: {
              type: 'string',
              description:
                'The name of the kernelspec that reproduces the analysis'
            }
          }
        }
      },
      execute: async args => {
        const goal = target;
        const found = goal
          ? questionsOf(goal).find(item => item.kernel.name === args.kernel)
          : null;
        if (!goal || !found) {
          return;
        }
        // In JupyterLab's notebook view, the question opens the notebook's
        // Whybook view, which runs the agent and shows its strip.
        let model = goal.model;
        if (!model) {
          const panel = (await app.commands.execute('docmanager:open', {
            path: goal.path,
            factory: FACTORY
          })) as EpiPanel | undefined;
          await panel?.context.ready;
          model = panel?.content.model ?? null;
        }
        if (model) {
          await model.askInKernel(found);
        }
      }
    });

    const openMenu = (node: Element, keyboard: boolean) => {
      const goal = targetOf(node);
      if (!goal) {
        return false;
      }
      target = goal;
      menu.clearItems();
      menu.addItem({ command: CommandIDs.restart });
      const current = goal.sessionContext.session?.kernel?.name ?? null;
      for (const choice of menuKernels(
        current,
        kernelChoices(specs()),
        readRecent()
      )) {
        menu.addItem({
          command: CommandIDs.change,
          args: { name: choice.name }
        });
      }
      menu.addItem({ command: CommandIDs.more });
      const questions = questionsOf(goal);
      if (questions.length) {
        menu.addItem({ type: 'separator' });
        for (const question of questions) {
          menu.addItem({
            command: CommandIDs.reproduce,
            args: { kernel: question.kernel.name }
          });
        }
      }
      const box = node.getBoundingClientRect();
      menu.open(box.left, box.bottom);
      if (keyboard) {
        menu.activeIndex = 0;
      }
      return true;
    };

    const kernelButton = (event: Event): Element | null =>
      menuOn
        ? ((event.target as Element | null)?.closest?.('.jp-KernelName') ??
          null)
        : null;
    // The click on the kernel's name, from the pointer or the keyboard, goes
    // to the menu instead of JupyterLab's dialog: the listeners run in the
    // capture phase, and the event goes no further. Enter and Space make the
    // browser click the button, so their own handler is kept from the dialog.
    document.addEventListener(
      'click',
      event => {
        const button = kernelButton(event);
        if (button && openMenu(button, event.detail === 0)) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true
    );
    document.addEventListener(
      'keydown',
      event => {
        const button = kernelButton(event);
        if (
          button &&
          (event.key === 'Enter' || event.key === ' ') &&
          targetOf(button)
        ) {
          event.stopPropagation();
        }
      },
      true
    );

    if (settingRegistry) {
      void settingRegistry
        .load(PLUGIN_ID)
        .then(settings => {
          const read = () => {
            menuOn =
              (settings.composite as { kernelMenu?: unknown }).kernelMenu ===
              true;
          };
          read();
          settings.changed.connect(read);
        })
        .catch(reason =>
          console.error(
            'Failed to load the settings of the kernel menu.',
            reason
          )
        );
    }
  }
};
