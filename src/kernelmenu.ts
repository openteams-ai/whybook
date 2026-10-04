/**
 * JupyterLab's Kernel menu, and the kernel items of its Run menu, for the
 * Whybook view (design iteration 1.77). The view registers as a kernel user,
 * as JupyterLab's notebook does, so that Interrupt, Restart, Restart and
 * Clear, Restart and Run All, Change Kernel, Shut Down and Reconnect act on
 * the kernel of the Whybook view in front. Without it these items were
 * greyed out whenever a Whybook view was in front.
 */
import type { JupyterFrontEnd } from '@jupyterlab/application';
import type {
  ISessionContextDialogs,
  WidgetTracker
} from '@jupyterlab/apputils';
import { SemanticCommand } from '@jupyterlab/apputils';
import type { ICodeCellModel } from '@jupyterlab/cells';
import type { IMainMenu } from '@jupyterlab/mainmenu';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { Widget } from '@lumino/widgets';

import type { EpiPanel } from './widgets';

/** The commands that the menus run for a Whybook view. */
export namespace KernelMenuIDs {
  export const interrupt = 'whybook:interrupt-kernel';
  export const restart = 'whybook:restart-kernel';
  export const clearOutputs = 'whybook:clear-all-outputs';
  export const change = 'whybook:change-kernel';
  export const shutdown = 'whybook:shutdown-kernel';
  export const reconnect = 'whybook:reconnect-to-kernel';
  export const runAll = 'whybook:run-all-cells';
}

/** The description of a command that takes no arguments of its own. */
const NO_ARGS = { args: { type: 'object', properties: {} } };

/**
 * Add the commands, and register them with the Kernel menu and the Run
 * menu of `mainMenu` for the views that `tracker` holds.
 */
export function addKernelMenu(
  app: JupyterFrontEnd,
  tracker: WidgetTracker<EpiPanel>,
  mainMenu: IMainMenu,
  sessionDialogs: ISessionContextDialogs | null
): void {
  const { commands, shell } = app;
  // The view that the menu names, or else the current one.
  const viewOf = (args: ReadonlyPartialJSONObject): EpiPanel | null => {
    const id = args[SemanticCommand.WIDGET];
    const named =
      typeof id === 'string' ? tracker.find(view => view.id === id) : null;
    return named ?? tracker.currentWidget;
  };
  const isEnabled = () =>
    tracker.currentWidget !== null &&
    tracker.currentWidget === shell.currentWidget;

  commands.addCommand(KernelMenuIDs.interrupt, {
    label: 'Interrupt Kernel',
    caption: 'Interrupt the kernel of this notebook',
    describedBy: NO_ARGS,
    isEnabled,
    execute: async args => {
      await viewOf(args)?.context.sessionContext.session?.kernel?.interrupt();
    }
  });
  // True when the kernel restarted: Restart and Run All runs the cells then.
  commands.addCommand(KernelMenuIDs.restart, {
    label: 'Restart Kernel…',
    caption: 'Restart the kernel of this notebook',
    describedBy: NO_ARGS,
    isEnabled,
    execute: async args => {
      const context = viewOf(args)?.context.sessionContext;
      if (!context) {
        return false;
      }
      if (sessionDialogs) {
        return sessionDialogs.restart(context);
      }
      await context.restartKernel();
      return true;
    }
  });
  commands.addCommand(KernelMenuIDs.clearOutputs, {
    label: 'Clear Outputs of All Cells',
    caption: 'Clear the outputs and the counts of every code cell',
    describedBy: NO_ARGS,
    isEnabled,
    execute: args => {
      const notebook = viewOf(args)?.context.model;
      if (!notebook) {
        return;
      }
      for (const cell of notebook.cells) {
        if (cell.type === 'code') {
          (cell as ICodeCellModel).clearExecution();
        }
      }
    }
  });
  commands.addCommand(KernelMenuIDs.change, {
    label: 'Change Kernel…',
    caption: 'Change the kernel of this notebook',
    describedBy: NO_ARGS,
    isEnabled,
    execute: async args => {
      const context = viewOf(args)?.context.sessionContext;
      if (context && sessionDialogs) {
        await sessionDialogs.selectKernel(context);
      }
    }
  });
  commands.addCommand(KernelMenuIDs.shutdown, {
    label: 'Shut Down Kernel',
    caption: 'Shut down the kernel of this notebook',
    describedBy: NO_ARGS,
    isEnabled,
    execute: async args => {
      await viewOf(args)?.context.sessionContext.shutdown();
    }
  });
  commands.addCommand(KernelMenuIDs.reconnect, {
    label: 'Reconnect to Kernel',
    describedBy: NO_ARGS,
    isEnabled,
    execute: async args => {
      await viewOf(args)?.context.sessionContext.session?.kernel?.reconnect();
    }
  });
  commands.addCommand(KernelMenuIDs.runAll, {
    label: 'Run All Cells',
    caption: 'Run every cell of this notebook in order',
    describedBy: NO_ARGS,
    isEnabled,
    execute: async args => {
      await viewOf(args)?.content.model.runAll();
    }
  });

  const ours = (widget: Widget) => tracker.has(widget);
  const users = mainMenu.kernelMenu.kernelUsers;
  users.interruptKernel.add({ id: KernelMenuIDs.interrupt, isEnabled: ours });
  users.restartKernel.add({ id: KernelMenuIDs.restart, isEnabled: ours });
  users.clearWidget.add({ id: KernelMenuIDs.clearOutputs, isEnabled: ours });
  users.changeKernel.add({ id: KernelMenuIDs.change, isEnabled: ours });
  users.shutdownKernel.add({ id: KernelMenuIDs.shutdown, isEnabled: ours });
  users.reconnectToKernel.add({
    id: KernelMenuIDs.reconnect,
    isEnabled: ours
  });
  const runners = mainMenu.runMenu.codeRunners;
  runners.restart.add({ id: KernelMenuIDs.restart, isEnabled: ours });
  runners.runAll.add({ id: KernelMenuIDs.runAll, isEnabled: ours });
}
