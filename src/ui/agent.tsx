import { PathExt } from '@jupyterlab/coreutils';
import { Button } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { IAgentRun } from '../model/agent';
import { runStatus } from '../model/agent';
import type { EpiModel } from '../model/epimodel';
import { splitLabels } from '../model/labels';
import { runWhen } from '../model/runs';
import type { QuestionType } from '../tokens';
import { QUESTION_TYPES } from '../tokens';
import {
  AITag,
  CloseButton,
  ProgressBar,
  TypeBadge,
  useSeconds
} from './common';
import { CapNote, Usd } from './cost';
import { UndoAsk } from './undoask';

const LOCAL_NOTE =
  'The data stayed on this machine: the agent read what local models wrote about each output, not its values.';

/**
 * An agent's run: the question, a line per step with the cells it added,
 * the agent's words while it works, and the answer it ends with. The same
 * run shows in the strip under the question, in a card on the bench, or
 * in the right sidebar, as the setting "Where an agent's run shows" says.
 */
export function AgentRunView(props: {
  model: EpiModel;
  run: IAgentRun;
  place: 'strip' | 'card' | 'sidebar';
}): JSX.Element {
  const { model, run, place } = props;
  const busy = run.state === 'starting' || run.state === 'working';
  const seconds = useSeconds(run.started, busy);
  const remove = React.useRef<HTMLButtonElement>(null);
  const last = run.thinking ?? run.notes[run.notes.length - 1] ?? null;
  // The notebook where the question was asked; a run can work in a
  // notebook that it made too (design iteration 1.69).
  const home = model.runs.entry(run)?.context.path ?? model.context.path;
  const made = run.notebooks ?? [];
  const hasFiles =
    run.steps.some(step => step.file) ||
    made.length > 0 ||
    !!run.frames?.length;
  return (
    <div
      className={`jp-Epi-agentrun jp-mod-${place} jp-mod-${run.state}`}
      role="group"
      aria-label={`Agent: ${run.question}`}
    >
      <div className="jp-Epi-agentrun-head">
        <ProgressBar value={busy ? null : 1} label={run.question} />
        <span className="jp-Epi-agentrun-kind">Agent</span>
        <span className="jp-Epi-agentrun-question">{run.question}</span>
        <span className="jp-Epi-agentrun-status">
          {runStatus(run)}
          {busy && seconds !== null ? ` · ${seconds} s` : ''}
          {/* A run from the history says when it ended (1.73). */}
          {run.past ? ` · ${runWhen(run.past.at)}` : ''}
        </span>
        {run.keepLocal && (
          <span className="jp-Epi-agentrun-local" title={LOCAL_NOTE}>
            data stays here
          </span>
        )}
        {busy ? (
          <Button
            small
            minimal
            className="jp-Epi-button"
            onClick={() => model.stopAgent(run)}
          >
            Stop
          </Button>
        ) : (
          <>
            {made.map(notebook => (
              <button
                key={notebook.path}
                className="jp-Epi-link"
                title={`Open ${notebook.path}, which the agent made, with ${notebook.displayName}`}
                onClick={() => void model.runs.host?.show(notebook.path)}
              >
                Open {PathExt.basename(notebook.path)}
              </button>
            ))}
            {run.steps.length > 0 && !run.past && (
              <button
                ref={remove}
                className="jp-Epi-link"
                title={
                  made.length
                    ? `Remove the cells that the agent added, and ${made.map(notebook => PathExt.basename(notebook.path)).join(', ')} with the files it wrote. Undo puts them back.`
                    : undefined
                }
                onClick={() => void model.discardAgent(run)}
              >
                {hasFiles ? 'Remove its cells and files' : 'Remove its cells'}
              </button>
            )}
            <CloseButton
              label="Close; the cells stay"
              onClick={() => model.dismissAgent(run)}
            />
          </>
        )}
      </div>
      {run.removeAsk && (
        <UndoAsk
          changed={run.removeAsk}
          verb="Remove"
          back={remove}
          cell={run.anchor}
          onConfirm={() => void model.discardAgent(run, true)}
          onKeep={() => model.dismissRemove(run)}
        />
      )}
      {run.steps.length > 0 && (
        <ol className="jp-Epi-agentrun-steps">
          {run.steps.map(step => (
            <li key={step.call} className={`jp-mod-${step.state}`}>
              <span
                className="jp-Epi-agentrun-mark"
                aria-label={step.state}
                title={step.state}
              />
              <span className="jp-Epi-agentrun-cells">
                {step.tool === 'new_notebook' && step.notebook && (
                  <button
                    className="jp-Epi-label jp-Epi-agentrun-cell jp-Epi-agentrun-file"
                    title={`Open ${step.notebook}`}
                    onClick={() => void model.runs.host?.show(step.notebook!)}
                  >
                    {PathExt.basename(step.notebook)}
                  </button>
                )}
                {step.cells.map(id => (
                  <CellLink
                    key={id}
                    model={model}
                    cellId={id}
                    notebook={step.notebook ?? home}
                    run={run}
                  />
                ))}
                {step.file && (
                  <button
                    className="jp-Epi-label jp-Epi-agentrun-cell jp-Epi-agentrun-file"
                    title={`Open ${step.file.name}: ${step.file.lines} lines, written by AI`}
                    onClick={() => model.openFile(step.file!.path)}
                  >
                    {step.file.name}
                  </button>
                )}
              </span>
              <span className="jp-Epi-agentrun-title">
                {step.tool === 'explore'
                  ? `Side exploration: ${step.title}`
                  : step.tool === 'write_file' && step.file
                    ? `A module of ${step.file.lines} lines`
                    : step.title}
              </span>
              {step.why && step.tool !== 'explore' && (
                <span className="jp-Epi-agentrun-why">{step.why}</span>
              )}
              {step.error && (
                <span className="jp-Epi-agentrun-error">{step.error}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {busy && last && <div className="jp-Epi-thinking">{last}</div>}
      {run.answer && (
        <div className="jp-Epi-agentrun-answer">
          <LinkedText model={model} run={run} text={run.answer} />
          <AITag by={run.by} verb="Answered" />
        </div>
      )}
      {run.answer && !busy && <EditedSince model={model} run={run} />}
      {run.followUp.length > 0 && !busy && (
        <div className="jp-Epi-agentrun-followups">
          {run.followUp.map(item => {
            const { type, text } = followUp(item);
            return (
              <button
                key={item}
                className="jp-Epi-agentrun-followup"
                title="Ask this, as a typed question"
                onClick={() => void model.askOwn(text, 'notebook')}
              >
                <TypeBadge type={type} />
                <span>{text}</span>
              </button>
            );
          })}
        </div>
      )}
      {run.error && <div className="jp-Epi-error">{run.error}</div>}
      {run.state === 'stopped' && <RunCapNote model={model} run={run} />}
      {run.past && !run.past.full && (
        <div className="jp-Epi-caption jp-Epi-agentrun-kept">
          The notebook kept the cells of this run, not its steps or its answer:
          it ran before Whybook kept them.
        </div>
      )}
    </div>
  );
}

/**
 * Why a run stopped at a cost cap. At the notebook's cap, Go on raises the
 * cap and asks the question again, since a run cannot go on from where it
 * stopped. The server's cap of a run has no way past it in the view.
 */
function RunCapNote(props: {
  model: EpiModel;
  run: IAgentRun;
}): JSX.Element | null {
  const { model, run } = props;
  if (run.capped?.by === 'notebook' && run.restart) {
    return (
      <CapNote model={model} stopped onGoOn={() => void model.goOnRun(run)} />
    );
  }
  if (run.capped?.by === 'server') {
    return (
      <div className="jp-Epi-capnote">
        <span className="jp-Epi-capnote-text">
          The run reached the server's cost cap of a run,{' '}
          <Usd value={run.capped.usd} /> (c.Whybook.agent_budget_usd).
        </span>
      </div>
    );
  }
  return null;
}

/**
 * The cells of a run that the analyst changed by hand since the run, under
 * its answer: what the answer says of them may no longer hold (design
 * iteration 1.83, ../model/handedit.ts).
 */
function EditedSince(props: {
  model: EpiModel;
  run: IAgentRun;
}): JSX.Element | null {
  const { model, run } = props;
  const edited = run.steps
    .filter(step => !step.notebook)
    .flatMap(step => step.cells)
    .filter(id => model.editedByHand(id))
    .map(id => model.cell(id)?.label ?? '[ ]');
  if (!edited.length) {
    return null;
  }
  const labels =
    edited.length === 1
      ? edited[0]
      : `${edited.slice(0, -1).join(', ')} and ${edited[edited.length - 1]}`;
  return (
    <div className="jp-Epi-caption jp-Epi-agentrun-edited" role="note">
      You changed the code of {labels} since this answer: what it says of{' '}
      {edited.length === 1 ? 'that cell' : 'those cells'} may no longer hold.
    </div>
  );
}

/** One line in the question's strip, when the run shows in a card or in the sidebar. */
export function AgentPointer(props: {
  model: EpiModel;
  run: IAgentRun;
}): JSX.Element {
  const { model, run } = props;
  const busy = run.state === 'starting' || run.state === 'working';
  return (
    <div className="jp-Epi-strip jp-Epi-agentpointer">
      <div className="jp-Epi-strip-row">
        <ProgressBar value={busy ? null : 1} label={run.question} />
        <span className="jp-Epi-strip-action">Agent</span>
        <span className="jp-Epi-strip-text">{run.question}</span>
        <span className="jp-Epi-strip-stage">
          {runStatus(run)} ·{' '}
          {model.settings.agentView === 'sidebar'
            ? 'in the sidebar'
            : 'in the card below'}
        </span>
        {busy && (
          <Button
            small
            minimal
            className="jp-Epi-button"
            onClick={() => model.stopAgent(run)}
          >
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

function CellLink(props: {
  model: EpiModel;
  cellId: string;
  /** The path of the cell's notebook, when it may be another than the view's. */
  notebook?: string;
  run?: IAgentRun;
}): JSX.Element | null {
  const { model, notebook } = props;
  if (notebook && notebook !== model.context.path) {
    return (
      <ElsewhereLink
        model={model}
        cellId={props.cellId}
        notebook={notebook}
        run={props.run}
      />
    );
  }
  const cell = props.model.cell(props.cellId);
  if (!cell) {
    return <span className="jp-Epi-label jp-mod-gone">removed</span>;
  }
  if (cell.type === 'markdown') {
    // A text, such as the comparison of a run in another notebook: its
    // section, §4, else "text".
    const note = model.noteLabel(cell);
    return (
      <button
        className="jp-Epi-label jp-Epi-agentrun-cell"
        title={`Show ${note} in the view`}
        onClick={() => model.showCell(cell.id)}
      >
        {/^§\d+/.exec(note)?.[0] ?? 'text'}
      </button>
    );
  }
  // A label that more than one cell shows carries a mark, and its tooltip
  // names the cell.
  const shared = props.model.sharedLabels().has(cell.label);
  return (
    <button
      className="jp-Epi-label jp-Epi-agentrun-cell"
      title={
        shared
          ? `${cell.label}: ${cell.title}`
          : `Show ${cell.label} in the view`
      }
      onClick={() => props.model.showCell(cell.id)}
    >
      {cell.label}
      {shared && <span className="jp-Epi-labelref-mark" aria-hidden="true" />}
    </button>
  );
}

/**
 * A cell of another notebook of the run: the language or the name of its
 * notebook, then its label there, "R [2]". A click opens that notebook's
 * view on the cell.
 */
function ElsewhereLink(props: {
  model: EpiModel;
  cellId: string;
  notebook: string;
  run?: IAgentRun;
}): JSX.Element {
  const { model, cellId, notebook, run } = props;
  const other = model.runs.host?.modelOf(notebook) ?? null;
  const cell = other && !other.isDisposed ? other.cell(cellId) : null;
  const language = run?.notebooks?.find(item => item.path === notebook)?.label;
  const prefix = language ?? PathExt.basename(notebook, '.ipynb');
  const label = cell && cell.label !== '[ ]' ? cell.label : '[ ]';
  return (
    <button
      className="jp-Epi-label jp-Epi-agentrun-cell jp-mod-elsewhere"
      title={`Show ${cell?.title ? `${label} ${cell.title}` : 'the cell'} in ${notebook}`}
      onClick={() => void model.runs.host?.show(notebook, cellId)}
    >
      {prefix} {label}
    </button>
  );
}

/**
 * A run asked in another notebook that works in this one: one line under
 * the text that the run wrote first here, with the question, what the run
 * did so far, and Stop while it works. The run's strip, its answer and its
 * Remove are in the notebook where it was asked.
 */
export function AgentElsewhere(props: {
  model: EpiModel;
  run: IAgentRun;
  /** The path of the notebook where the question was asked. */
  askedIn: string;
}): JSX.Element {
  const { model, run, askedIn } = props;
  const busy = run.state === 'starting' || run.state === 'working';
  // The cells of this notebook, as this notebook's view counts them.
  const here = run.steps
    .filter(step => step.notebook === model.context.path)
    .reduce((sum, step) => sum + step.cells.length, 0);
  const state =
    run.state === 'starting'
      ? 'Starting'
      : run.state === 'working'
        ? 'Working'
        : run.state === 'done'
          ? 'Answered'
          : run.state === 'stopped'
            ? 'Stopped'
            : 'Failed';
  return (
    <div className="jp-Epi-strip jp-Epi-agentpointer jp-Epi-agentelsewhere">
      <div className="jp-Epi-strip-row">
        <ProgressBar value={busy ? null : 1} label={run.question} />
        <span className="jp-Epi-strip-action">Agent</span>
        <span className="jp-Epi-strip-text">{run.question}</span>
        <span className="jp-Epi-strip-stage">
          {state} · {here === 1 ? '1 cell' : `${here} cells`} here · asked in{' '}
          {PathExt.basename(askedIn)}
        </span>
        <button
          className="jp-Epi-link"
          title={`Open ${askedIn}, where the run shows its steps and its answer`}
          onClick={() => void model.runs.host?.show(askedIn)}
        >
          {busy ? 'Show the run' : 'Show the answer'}
        </button>
        {busy && (
          <Button
            small
            minimal
            className="jp-Epi-button"
            onClick={() => model.stopAgent(run)}
          >
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

/** The answer, with each cell label in it, such as [7], a link to that cell. */
function LinkedText(props: {
  model: EpiModel;
  run: IAgentRun;
  text: string;
}): JSX.Element {
  const { model, run, text } = props;
  const parts = splitLabels(text);
  const cells = model.cells();
  // A label after the language of a notebook that the run made, "R [2]",
  // names a cell of that notebook.
  const elsewhere = (index: number) => {
    const before = parts[index - 1] ?? '';
    const notebook = (run.notebooks ?? []).find(item =>
      before.endsWith(`${item.label} `)
    );
    const other = notebook ? model.runs.host?.modelOf(notebook.path) : null;
    const cell = other?.cells().find(item => item.label === parts[index]);
    return notebook && cell ? { notebook, cell } : null;
  };
  return (
    <span className="jp-Epi-agentrun-text">
      {parts.map((part, index) => {
        const there = index % 2 === 1 ? elsewhere(index) : null;
        if (there) {
          return (
            <ElsewhereLink
              key={index}
              model={model}
              cellId={there.cell.id}
              notebook={there.notebook.path}
              run={run}
            />
          );
        }
        // The language before a label of another notebook goes into its link.
        const next = index % 2 === 0 ? elsewhere(index + 1) : null;
        const shown = next
          ? part.slice(0, -`${next.notebook.label} `.length)
          : part;
        // The cell that the answer named, by its id, whatever its label is
        // now; a label the answer did not record goes to the cell that has it.
        const named = run.answerRefs?.[part];
        const cell =
          index % 2 === 1
            ? named
              ? cells.find(item => item.id === named)
              : cells.find(item => item.label === part)
            : undefined;
        return cell ? (
          <CellLink key={index} model={model} cellId={cell.id} />
        ) : (
          <React.Fragment key={index}>{shown}</React.Fragment>
        );
      })}
    </span>
  );
}

/** "association: Does sleep relate to pain?" as its type and its question. */
function followUp(item: string): { type: QuestionType; text: string } {
  const [head, ...rest] = item.split(':');
  const type = QUESTION_TYPES.find(
    known => known.id === head.trim().toLowerCase()
  )?.id;
  return type && rest.length
    ? { type, text: rest.join(':').trim() }
    : { type: 'descriptive', text: item.trim() };
}
