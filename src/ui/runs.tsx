import { PathExt } from '@jupyterlab/coreutils';
import type { IRunningSessions } from '@jupyterlab/running';
import { GroupItem, TextItem } from '@jupyterlab/statusbar';
import {
  caretDownIcon,
  caretRightIcon,
  ReactWidget,
  stopIcon,
  UseSignal
} from '@jupyterlab/ui-components';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';
import * as React from 'react';

import { agentRunIcon, epiIcon } from '../icons';
import type { IAgentRun } from '../model/agent';
import { runStatus } from '../model/agent';
import type { EpiModel } from '../model/epimodel';
import type { AgentRuns, IHistoryRow, IRunEntry } from '../model/runs';
import { cellsSoFar, isGoing, pastRun, runTime, runWhen } from '../model/runs';
import { useModel } from './common';
import { Usd } from './cost';

/** "2 cells", or "no cell yet" for a run that has added none. */
function cellsText(count: number): string {
  if (count === 0) {
    return 'no cell yet';
  }
  return count === 1 ? '1 cell' : `${count} cells`;
}

/**
 * The item of one run: its notebook, the cells it added so far and the
 * time, with the question under it. A click on either opens the Whybook
 * view of the notebook on the run's strip, and the item's button stops the
 * run as the Stop of its strip does.
 */
export function runItem(
  entry: IRunEntry,
  runs: AgentRuns,
  now: number = Date.now()
): IRunningSessions.IRunningItem {
  const { run } = entry;
  const path = entry.context.path;
  const cells = cellsText(cellsSoFar(run));
  const open = () => void runs.open(run);
  return {
    className: 'jp-Epi-runitem',
    icon: () => epiIcon,
    // The panel folds an item with children on a click: the question stays.
    label: () => (
      <span
        className="jp-Epi-runitem-name"
        onClick={event => {
          event.stopPropagation();
          open();
        }}
      >
        {PathExt.basename(path)}
      </span>
    ),
    labelTitle: () =>
      `An agent answers "${run.question}" in ${path}: ${cells} so far. Click to open the run in Whybook.`,
    detail: () => `${cells} · ${runTime(run, now)}`,
    open,
    shutdown: () => entry.stop(),
    children: [
      {
        className: 'jp-Epi-runitem-question',
        icon: () => '',
        label: () => run.question,
        labelTitle: () => `${run.question} Click to open the run.`,
        open
      }
    ]
  };
}

/**
 * "Agent runs" in JupyterLab's Running panel (design iteration 1.56): an
 * item for each run that goes on, in every open notebook, with Stop. The
 * time of a run counts up while the panel shows it.
 */
export class RunsSection implements IRunningSessions.IManager {
  constructor(private _runs: AgentRuns) {
    _runs.changed.connect(this._onRuns, this);
  }

  readonly name = 'Agent runs';
  readonly supportsMultipleViews = false;
  readonly shutdownLabel = 'Stop the run; the cells it added stay';
  readonly shutdownAllLabel = 'Stop all';
  readonly shutdownAllConfirmationText =
    'Stop every agent run? The cells they added stay.';
  readonly shutdownItemIcon = stopIcon;

  get runningChanged(): ISignal<this, void> {
    return this._changed;
  }

  running(): IRunningSessions.IRunningItem[] {
    const now = Date.now();
    return this._runs.going().map(entry => runItem(entry, this._runs, now));
  }

  shutdownAll(): void {
    for (const entry of this._runs.going()) {
      entry.stop();
    }
  }

  refreshRunning(): void {
    this._changed.emit();
  }

  private _onRuns(): void {
    const going = this._runs.going().length > 0;
    if (going && !this._ticker) {
      // The panel draws its items only while it shows.
      this._ticker = window.setInterval(() => this._changed.emit(), 1000);
    } else if (!going && this._ticker) {
      window.clearInterval(this._ticker);
      this._ticker = 0;
    }
    this._changed.emit();
  }

  private _ticker = 0;
  private _changed = new Signal<this, void>(this);
}

/** What the status bar item says in its tooltip. */
export function runsTitle(runs: AgentRuns): string {
  const going = runs.going();
  const notebooks = [
    ...new Set(going.map(entry => PathExt.basename(entry.context.path)))
  ];
  const what =
    going.length === 1
      ? `An agent works in ${notebooks[0]}: ${cellsText(cellsSoFar(going[0].run))} so far.`
      : `${going.length} agents work in ${notebooks.join(', ')}.`;
  return `${what} Click to open the Running panel, which lists the runs with Stop.`;
}

function RunsCount(props: { runs: AgentRuns; open: () => void }): JSX.Element {
  const { runs, open } = props;
  const count = runs.going().length;
  return (
    <GroupItem
      spacing={4}
      className="jp-Epi-runstatus-count"
      title={runsTitle(runs)}
      role="button"
      tabIndex={0}
      aria-label={
        count === 1
          ? '1 agent run goes on. Open the Running panel'
          : `${count} agent runs go on. Open the Running panel`
      }
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <TextItem source={count} />
      <agentRunIcon.react tag="span" top="1px" stylesheet="statusBar" />
    </GroupItem>
  );
}

/**
 * The status bar item while an agent's run goes on, whatever the current
 * tab (design iteration 1.56): the number of runs and an icon, as JupyterLab
 * counts its kernels and terminals. A click opens the Running panel.
 */
export class RunsStatus extends ReactWidget {
  constructor(
    private _runs: AgentRuns,
    private _open: () => void
  ) {
    super();
    this.addClass('jp-Epi-runstatus');
    this.addClass('jp-mod-highlighted');
    this.node.addEventListener('click', this._open);
  }

  render(): JSX.Element {
    return (
      <UseSignal signal={this._runs.changed}>
        {() => <RunsCount runs={this._runs} open={this._open} />}
      </UseSignal>
    );
  }

  dispose(): void {
    this.node.removeEventListener('click', this._open);
    super.dispose();
  }
}

/** Whether the history of each view is open: folded at first. */
const historyOpen = new WeakMap<EpiModel, boolean>();

/** The most cell labels that a row of the history shows. */
const ROW_CELLS = 6;

/**
 * The history of the notebook's agents' runs, a block of the Exploration
 * panel (design iteration 1.73): one folded line with the number of runs,
 * which opens on a list, the newest first. A click on a run's question
 * shows its strip in the notebook, drawn again from the notebook's record
 * when it was closed, and a click on a cell's label shows the cell. The
 * block shows once the notebook has a run.
 */
export function RunsHistory(props: { model: EpiModel }): JSX.Element | null {
  const { model } = props;
  useModel(model);
  const [open, setOpen] = React.useState(() => historyOpen.get(model) ?? false);
  const rows = model.runHistory();
  if (!rows.length) {
    return null;
  }
  const Icon = open ? caretDownIcon : caretRightIcon;
  return (
    <div className="jp-Epi-block jp-Epi-runhistory">
      <button
        className="jp-Epi-block-head jp-Epi-runhistory-head"
        aria-expanded={open}
        onClick={() => {
          historyOpen.set(model, !open);
          setOpen(!open);
        }}
      >
        <span className="jp-Epi-runhistory-title">
          <Icon.react tag="span" className="jp-Epi-runhistory-caret" />
          <span>Agent runs</span>
        </span>
        <span className="jp-Epi-section-count">{rows.length}</span>
      </button>
      {open && (
        <ol className="jp-Epi-runhistory-list">
          {rows.map((row, index) => (
            <HistoryRow
              key={row.id ?? `live:${index}`}
              model={model}
              row={row}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * One run of the history: its question, which shows the run's strip, then
 * how it ended, its cells here, what it cost while the setting shows costs,
 * and when it ended, or where it was asked when that is another notebook.
 */
function HistoryRow(props: { model: EpiModel; row: IHistoryRow }): JSX.Element {
  const { model, row } = props;
  const run: IAgentRun | null =
    row.live ?? (row.id && row.record ? pastRun(row.id, row.record) : null);
  const going = !!row.live && isGoing(row.live);
  const askedIn =
    row.record?.asked_in && row.record.asked_in !== model.context.path
      ? row.record.asked_in
      : null;
  const cells = askedIn
    ? []
    : (run?.steps ?? [])
        .filter(step => !step.notebook)
        .flatMap(step => step.cells)
        .map(id => model.cell(id))
        .filter(
          (cell): cell is NonNullable<typeof cell> =>
            !!cell && cell.type === 'code'
        );
  const cost = row.record?.cost_usd;
  const open = () => {
    if (row.id) {
      void model.openRun(row.id);
    } else if (row.live) {
      model.showRun(row.live);
    }
  };
  return (
    <li
      className={`jp-Epi-runhistory-row jp-mod-${row.state}${row.live ? ' jp-mod-shown' : ''}`}
    >
      <button
        className="jp-Epi-runhistory-question"
        title={
          askedIn
            ? `Show the run in ${askedIn}, where it was asked`
            : row.live
              ? "Show the run's strip"
              : "Show the run's strip again, where it was"
        }
        onClick={open}
      >
        {row.question}
      </button>
      <span className="jp-Epi-runhistory-meta">
        <span className="jp-Epi-runhistory-status">
          {run ? runStatus(run) : row.state}
          {going && run ? ` · ${runTime(run)}` : ''}
        </span>
        {cells.slice(0, ROW_CELLS).map(cell => (
          <button
            key={cell.id}
            className="jp-Epi-label jp-Epi-runhistory-cell"
            title={`Show ${cell.label} ${cell.title}`}
            onClick={() => model.showCell(cell.id)}
          >
            {cell.label}
          </button>
        ))}
        {cells.length > ROW_CELLS && (
          <span className="jp-Epi-runhistory-more">
            +{cells.length - ROW_CELLS}
          </span>
        )}
        {model.settings.showCost && typeof cost === 'number' && (
          <span className="jp-Epi-runhistory-cost">
            <Usd value={cost} />
          </span>
        )}
        {!going && row.record && (
          <span className="jp-Epi-runhistory-when">
            {askedIn
              ? `asked in ${PathExt.basename(askedIn)}`
              : runWhen(row.record.at)}
          </span>
        )}
      </span>
    </li>
  );
}
