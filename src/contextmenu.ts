import type { JupyterFrontEnd } from '@jupyterlab/application';
import { Clipboard, Notification } from '@jupyterlab/apputils';
import type { NotebookPanel } from '@jupyterlab/notebook';

import type { EpiModel, EpiSettings } from './model/epimodel';
import { EXPLORED_ORDERS, exploredOrder } from './model/exploredorder';
import type { IAnchor, IItem } from './tokens';

namespace CommandIDs {
  export const exploredOrder = 'whybook:explored-order';
  export const showVariable = 'whybook:show-variable';
  export const askVariable = 'whybook:ask-about-variable';
  export const copyName = 'whybook:copy-variable-name';
  export const showInNotebook = 'whybook:show-cell-in-notebook';
  export const runCell = 'whybook:run-cell';
  export const toggleCode = 'whybook:toggle-cell-code';
  export const askCell = 'whybook:ask-about-cell';
  export const loadTable = 'whybook:load-table';
  export const moveUp = 'whybook:move-cell-up';
  export const moveDown = 'whybook:move-cell-down';
  export const deleteCell = 'whybook:delete-cell';
  export const showOnBench = 'whybook:show-cell-on-bench';
  export const showOnMap = 'whybook:show-cell-on-map';
}

/** The description of a command that takes no arguments: these read the hit test. */
const NO_ARGS = { args: { type: 'object', properties: {} } };

/** How long the notice of a deleted cell, with its Undo, stays. */
const UNDO_MS = 12000;

/** The head of Variables explored, in the Exploration panel (./ui/exploration.tsx). */
const EXPLORED_HEAD = '.jp-Epi .jp-Epi-explored-head';

/**
 * Context menus for variables, cells and tables in the Whybook view and
 * its panels.
 */
export function addContextMenus(
  app: JupyterFrontEnd,
  model: () => EpiModel | null,
  settings: EpiSettings
): void {
  const { commands, contextMenu } = app;
  const hit = (attribute: string) =>
    app.contextMenuHitTest(node => node.dataset[attribute] !== undefined);
  const anchorOf = (node: HTMLElement | undefined): IAnchor | null => {
    if (!node) {
      return null;
    }
    const rect = node.getBoundingClientRect();
    return { x: rect.right, y: rect.top };
  };

  commands.addCommand(CommandIDs.showVariable, {
    label: 'Show in Variables',
    describedBy: NO_ARGS,
    execute: () => {
      const name = hit('variable')?.dataset.variable;
      const current = model();
      if (name && current) {
        current.select(name);
        settings.requestReveal();
      }
    }
  });
  commands.addCommand(CommandIDs.askVariable, {
    label: 'Ask about it',
    describedBy: NO_ARGS,
    execute: () => {
      const node = hit('variable');
      const name = node?.dataset.variable;
      if (name) {
        model()?.askData(name, anchorOf(node));
      }
    }
  });
  commands.addCommand(CommandIDs.copyName, {
    label: 'Copy name',
    describedBy: NO_ARGS,
    execute: () => {
      const name = hit('variable')?.dataset.variable;
      if (name) {
        Clipboard.copyToSystem(name);
      }
    }
  });

  commands.addCommand(CommandIDs.showInNotebook, {
    label: 'Show in the notebook',
    caption: 'Open the classic notebook view at this cell',
    describedBy: NO_ARGS,
    execute: async () => {
      const cellId = hit('cellId')?.dataset.cellId;
      const current = model();
      if (!cellId || !current) {
        return;
      }
      const panel = (await commands.execute('docmanager:open', {
        path: current.context.path,
        factory: 'Notebook'
      })) as NotebookPanel | undefined;
      if (!panel?.content) {
        return;
      }
      await panel.context.ready;
      const index = panel.content.widgets.findIndex(
        cell => cell.model.id === cellId
      );
      if (index >= 0) {
        panel.content.activeCellIndex = index;
        await panel.content.scrollToItem(index);
      }
    }
  });
  // Between the views: from the map to the bench, and back.
  for (const [id, view, label] of [
    [CommandIDs.showOnBench, 'bench', 'Show on the bench'],
    [CommandIDs.showOnMap, 'map', 'Show on the map']
  ] as const) {
    commands.addCommand(id, {
      label,
      isVisible: () => {
        const current = model();
        return !!current && current.view !== view;
      },
      describedBy: NO_ARGS,
      execute: () => {
        const cellId = hit('cellId')?.dataset.cellId;
        const current = model();
        if (cellId && current?.cell(cellId)) {
          current.showIn(view, cellId);
        }
      }
    });
  }
  commands.addCommand(CommandIDs.runCell, {
    label: 'Run',
    describedBy: NO_ARGS,
    execute: () => {
      const cellId = hit('cellId')?.dataset.cellId;
      if (cellId) {
        void model()?.runCell(cellId);
      }
    }
  });
  commands.addCommand(CommandIDs.toggleCode, {
    label: () => 'Show or hide the code',
    describedBy: NO_ARGS,
    execute: () => {
      const cellId = hit('cellId')?.dataset.cellId;
      const current = model();
      if (cellId && current) {
        current.setView('bench');
        current.toggleCode(cellId);
      }
    }
  });
  commands.addCommand(CommandIDs.askCell, {
    label: 'Ask about this cell',
    describedBy: NO_ARGS,
    execute: () => {
      const node = hit('cellId');
      const cellId = node?.dataset.cellId;
      if (cellId) {
        void model()?.askCells([cellId], anchorOf(node));
      }
    }
  });

  const cellOf = () => hit('cellId')?.dataset.cellId ?? null;
  commands.addCommand(CommandIDs.moveUp, {
    label: 'Move up',
    isEnabled: () => {
      const cellId = cellOf();
      return !!cellId && !!model()?.canMove(cellId, -1);
    },
    describedBy: NO_ARGS,
    execute: () => {
      const cellId = cellOf();
      if (cellId) {
        model()?.moveCell(cellId, -1);
      }
    }
  });
  commands.addCommand(CommandIDs.moveDown, {
    label: 'Move down',
    isEnabled: () => {
      const cellId = cellOf();
      return !!cellId && !!model()?.canMove(cellId, 1);
    },
    describedBy: NO_ARGS,
    execute: () => {
      const cellId = cellOf();
      if (cellId) {
        model()?.moveCell(cellId, 1);
      }
    }
  });
  commands.addCommand(CommandIDs.deleteCell, {
    label: 'Delete cell',
    describedBy: NO_ARGS,
    execute: () => {
      const current = model();
      const cellId = cellOf();
      const saved = current && cellId ? current.deleteCell(cellId) : null;
      if (!current || !saved) {
        return;
      }
      // The kernel keeps what the cell defined; later cells may still use it.
      const users = saved.users.length
        ? ` ${saved.users.join(', ')} ${saved.users.length === 1 ? 'uses' : 'use'} names it defined.`
        : '';
      const name = [saved.label, saved.title].filter(Boolean).join(' ');
      const notice = Notification.emit(
        `Deleted ${name || 'the cell'}.${users}`,
        'default',
        {
          autoClose: UNDO_MS,
          actions: [
            {
              label: 'Undo',
              callback: () => {
                current.restoreCell(saved);
                Notification.dismiss(notice);
              }
            }
          ]
        }
      );
    }
  });

  commands.addCommand(CommandIDs.loadTable, {
    label: 'Ask about this table',
    describedBy: NO_ARGS,
    execute: () => {
      const node = hit('table');
      const current = model();
      const path = node?.dataset.database;
      const table = node?.dataset.table;
      if (!current || !path || !table) {
        return;
      }
      const item: IItem = {
        kind: 'table',
        name: `${path}::${table}`,
        label: table,
        path,
        table
      };
      void current.askDrop(
        item,
        {},
        { branch: false, parallel: false },
        anchorOf(node),
        { popover: true }
      );
    }
  });

  // The order of Variables explored, from the menu of its head (design
  // iteration 1.82). The order is a setting: it holds for every notebook.
  commands.addCommand(CommandIDs.exploredOrder, {
    label: args => exploredOrder(args.order).title,
    caption: args => exploredOrder(args.order).caption,
    isToggled: args => settings.exploredOrder === exploredOrder(args.order).id,
    describedBy: {
      args: {
        type: 'object',
        properties: {
          order: {
            type: 'string',
            enum: EXPLORED_ORDERS.map(order => order.id)
          }
        }
      }
    },
    execute: args => settings.set('exploredOrder', exploredOrder(args.order).id)
  });

  const items: [string, string][] = [
    [CommandIDs.askVariable, '.jp-Epi [data-variable]'],
    [CommandIDs.showVariable, '.jp-Epi [data-variable]'],
    [CommandIDs.copyName, '.jp-Epi [data-variable]'],
    [CommandIDs.askCell, '.jp-Epi [data-cell-id]'],
    [CommandIDs.runCell, '.jp-Epi [data-cell-id]'],
    [CommandIDs.toggleCode, '.jp-Epi [data-cell-id]'],
    [CommandIDs.showOnBench, '.jp-Epi [data-cell-id]'],
    [CommandIDs.showOnMap, '.jp-Epi [data-cell-id]'],
    [CommandIDs.showInNotebook, '.jp-Epi [data-cell-id]'],
    ['separator', '.jp-Epi [data-cell-id]'],
    [CommandIDs.moveUp, '.jp-Epi [data-cell-id]'],
    [CommandIDs.moveDown, '.jp-Epi [data-cell-id]'],
    [CommandIDs.deleteCell, '.jp-Epi [data-cell-id]'],
    ['separator', '.jp-Epi [data-cell-id]'],
    [CommandIDs.loadTable, '.jp-Epi [data-table]']
  ];
  items.forEach(([command, selector], rank) =>
    contextMenu.addItem(
      command === 'separator'
        ? { type: 'separator', selector, rank: rank / 100 }
        : { command, selector, rank: rank / 100 }
    )
  );
  EXPLORED_ORDERS.forEach((order, rank) =>
    contextMenu.addItem({
      command: CommandIDs.exploredOrder,
      args: { order: order.id },
      selector: EXPLORED_HEAD,
      rank: rank / 100
    })
  );
}
