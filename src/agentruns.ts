import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IRunningSessionManagers } from '@jupyterlab/running';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStatusBar } from '@jupyterlab/statusbar';
import * as React from 'react';

import { addCellItem, cellUnderMenu } from './cellmenu';
import type { EpiModel } from './model/epimodel';
import { AgentRuns, IAgentRuns } from './model/runs';
import { viewExtensions } from './ui/extensions';
import { RunsHistory, RunsSection, RunsStatus } from './ui/runs';
import { EpiPanel } from './widgets';

const PLUGIN_ID = 'whybook:agent-runs';

/** The id of JupyterLab's Running panel, in the left side bar. */
const RUNNING_PANEL = 'jp-running-sessions';

/** The command of a cell's menu that shows the run that wrote the cell. */
const SHOW_RUN = 'whybook:show-agent-run';

/**
 * The agents' runs of every open notebook (design iteration 1.56). The
 * Whybook views of a notebook share its runs through the list, a section of
 * JupyterLab's Running panel lists the runs that go on, with Stop, and a
 * small status bar item counts them and opens the panel.
 *
 * Each notebook keeps its runs, behind the setting "History of agents'
 * runs", on by default (design iteration 1.73): "Agent runs" in the
 * Exploration panel lists them, and "Show the agent's run" in the menu of a
 * cell that a run wrote shows the run's strip.
 */
export const agentRunsPlugin: JupyterFrontEndPlugin<AgentRuns> = {
  id: PLUGIN_ID,
  description:
    "The agents' runs of every open notebook, in JupyterLab's Running panel, the status bar and each notebook's history of runs.",
  autoStart: true,
  provides: IAgentRuns,
  optional: [IRunningSessionManagers, IStatusBar, ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    managers: IRunningSessionManagers | null,
    statusBar: IStatusBar | null,
    settingRegistry: ISettingRegistry | null
  ): AgentRuns => {
    const runs = new AgentRuns();
    if (managers) {
      managers.add(new RunsSection(runs));
      // The item opens the Running panel: without it, the item has no use.
      statusBar?.registerStatusItem('whybook:agent-runs', {
        item: new RunsStatus(runs, () => app.shell.activateById(RUNNING_PANEL)),
        align: 'left',
        rank: 7,
        isActive: () => runs.going().length > 0,
        activeStateChanged: runs.changed
      });
    }

    // "Agent runs" in the Exploration panel, before the Check-up.
    const blocks = viewExtensions.exploration;
    const others = [...blocks].filter(([id]) => id !== PLUGIN_ID);
    blocks.clear();
    blocks.set(PLUGIN_ID, model =>
      runs.history ? React.createElement(RunsHistory, { model }) : null
    );
    for (const [id, render] of others) {
      blocks.set(id, render);
    }

    // "Show the agent's run" in the menu of a cell that a run wrote, after
    // "Show in the notebook" (src/contextmenu.ts).
    const hitRun = (): { model: EpiModel; id: string } | null => {
      if (!runs.history) {
        return null;
      }
      const node = cellUnderMenu(app);
      const cellId = node?.dataset.cellId;
      const panel = node
        ? Array.from(app.shell.widgets('main')).find(
            (widget): widget is EpiPanel =>
              widget instanceof EpiPanel && widget.node.contains(node)
          )
        : undefined;
      const model = panel?.content.model;
      const id = cellId && model ? model.runOf(cellId) : null;
      return model && id ? { model, id } : null;
    };
    app.commands.addCommand(SHOW_RUN, {
      label: "Show the agent's run",
      caption:
        "Show the strip of the agent's run that wrote this cell, with its steps and its answer",
      describedBy: { args: { type: 'object', properties: {} } },
      isVisible: () => !!hitRun(),
      execute: async () => {
        const hit = hitRun();
        if (hit) {
          await hit.model.openRun(hit.id);
        }
      }
    });
    addCellItem(app, { command: SHOW_RUN, rank: 0.085 });

    if (settingRegistry) {
      void settingRegistry
        .load(PLUGIN_ID)
        .then(settings => {
          const read = () => {
            runs.history =
              (settings.composite as { history?: unknown }).history !== false;
          };
          read();
          settings.changed.connect(read);
        })
        .catch(reason =>
          console.error(
            "Failed to load the settings of the agents' runs.",
            reason
          )
        );
    }
    return runs;
  }
};
