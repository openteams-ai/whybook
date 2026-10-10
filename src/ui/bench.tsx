import type { ICodeCellModel } from '@jupyterlab/cells';
import type { CodeEditor, IEditorServices } from '@jupyterlab/codeeditor';
import { PathExt } from '@jupyterlab/coreutils';
import type { IOutputModel } from '@jupyterlab/rendermime';
import {
  Button,
  caretDownIcon,
  caretRightIcon,
  codeIcon,
  ellipsesIcon,
  runIcon
} from '@jupyterlab/ui-components';
import * as React from 'react';

import type { IAgentRun } from '../model/agent';
import { cellType } from '../model/agent';
import type { EpiModel, IEpiCell, ISection, IStrip } from '../model/epimodel';
import { askImage, imagePickOf } from '../model/imageask';
import { cellWrittenBy } from '../model/writtenby';
import { codeMimeType } from '../model/languages';
import { noteBody, outputKind, outputsOf } from '../model/notebook';
import { pictureOf } from '../model/outputs';
import {
  SUMMARY_LINES,
  TEXT_LINES,
  convergedIn,
  outputText,
  retriedWarning
} from '../model/logs';
import type { IAttachment, IDecision } from '../tokens';
import { ITEM_MIME } from '../tokens';
import {
  AITag,
  CellLabel,
  CellTitle,
  CloseButton,
  DecisionChips,
  GUESS_HELP,
  GuessChip,
  GUESSED_TYPES,
  GUESSES,
  HelpButton,
  OwnQuestion,
  PARALLEL_HELP,
  ProgressBar,
  TypeBadge,
  aiOffReason,
  anchorBelow,
  anchorOf,
  carriesItem,
  dragItem,
  itemName,
  modifiersOf,
  stageText,
  useFileDrop,
  useModel,
  useSeconds,
  useWidth
} from './common';
import { AgentElsewhere, AgentPointer, AgentRunView } from './agent';
import { CapNote } from './cost';
import { EmptyStart, LoadingCells } from './empty';
import { Minimap } from './minimap';
import type { OutputLike } from './outputs';
import {
  FullOutput,
  Miniature,
  OutputBoundary,
  RenderedOutput,
  TextOutput
} from './outputs';
import { TableQuestions } from './tablequestions';
import { TableOutput } from './tables';
import { StripUndoAsk } from './undoask';

/** Outputs that draw a plot, which the level of detail sizes. */
const PLOT_KINDS = new Set(['plot', 'image', 'chart']);

export interface IBenchProps {
  model: EpiModel;
  editorServices: IEditorServices | null;
  openFile: (path: string, line: number | null) => void;
}

/** A card of the bench: it draws again when its cell or `revision` changes. */
interface ICardProps extends IBenchProps {
  cell: IEpiCell;
  /** The model's `revision` when the bench drew. */
  revision: number;
  nested?: boolean;
}

/**
 * Give the keyboard focus to the card that holds this element, when a
 * control of the card goes with the focus on it, as the × of a strip does.
 * Without a card, the view takes it.
 */
function focusCard(node: HTMLElement | null): void {
  const card = node?.parentElement?.closest<HTMLElement>(
    '[data-cell-id], .jp-Epi-bench, .jp-Epi-linear'
  );
  if (!card) {
    return;
  }
  if (!card.hasAttribute('tabindex')) {
    card.setAttribute('tabindex', '-1');
  }
  card.focus({ preventScroll: true });
}

/** Whether the keyboard focus is nowhere: its element went from the page. */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/**
 * The undo or redo that a key press asks for, with JupyterLab's keys: Ctrl
 * or Cmd with Z undoes, with Shift as well redoes, and Ctrl+Y redoes.
 */
function undoKey(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === 'z') {
    return event.shiftKey ? 'redo' : 'undo';
  }
  return key === 'y' && event.ctrlKey && !event.shiftKey ? 'redo' : null;
}

/**
 * The cell's source in a real editor, bound to the shared model, so edits
 * show in the classic notebook view too. Shift+Enter runs a code cell, and
 * ends the edit of a markdown cell, as Escape does. Ctrl+Z and Ctrl+Shift+Z
 * step through the cell's history.
 */
export function CellEditor(props: {
  model: EpiModel;
  cell: IEpiCell;
  editorServices: IEditorServices | null;
  /** A variable, column or table dragged onto the code: the card's drop. */
  onItemDrag: (event: DragEvent) => void;
  /** The end of an edit of a markdown cell. */
  onDone?: () => void;
  /** Put the cursor in the editor when it opens. */
  focus?: boolean;
}): JSX.Element {
  const host = React.useRef<HTMLDivElement>(null);
  const { cell, editorServices, model } = props;
  const onItemDrag = React.useRef(props.onItemDrag);
  onItemDrag.current = props.onItemDrag;
  const onDone = React.useRef(props.onDone);
  onDone.current = props.onDone;
  // The editor would insert the item's name, its plain-text form, where the
  // pointer is. An item from the view is a question about the cell instead,
  // so the drag is taken before the editor sees it.
  React.useEffect(() => {
    const node = host.current;
    if (!node) {
      return;
    }
    const take = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes(ITEM_MIME)) {
        event.preventDefault();
        event.stopPropagation();
        onItemDrag.current(event);
      }
    };
    for (const type of ['dragenter', 'dragover', 'drop']) {
      node.addEventListener(type, take as EventListener, true);
    }
    return () => {
      for (const type of ['dragenter', 'dragover', 'drop']) {
        node.removeEventListener(type, take as EventListener, true);
      }
    };
  }, [editorServices]);
  React.useEffect(() => {
    if (!host.current || !editorServices) {
      return;
    }
    const cellModel = cell.model as ICodeCellModel;
    const markdown = cell.type === 'markdown';
    if (!cellModel.mimeType || cellModel.mimeType === 'text/plain') {
      // The notebook's language picks the highlighting: SAS in a SAS notebook.
      cellModel.mimeType = markdown
        ? 'text/x-ipythongfm'
        : codeMimeType(model.notebook, editorServices.mimeTypeService);
    }
    // The notebook's options for its cells, line numbers included. A card is
    // narrow, so its lines wrap whatever the notebook does.
    const config = () => ({
      ...model.settings.cellEditors[markdown ? 'markdown' : 'code'],
      lineWrap: true
    });
    let editor: CodeEditor.IEditor | null = null;
    try {
      editor = editorServices.factoryService.newInlineEditor({
        host: host.current,
        model: cellModel,
        config: config()
      });
    } catch (error) {
      console.warn('Could not create the code editor', error);
    }
    const follow = () => editor?.setOptions(config());
    model.settings.changed.connect(follow);
    // A change of the code while this editor has the focus is the analyst's:
    // an answer, an agent or Undo in the view writes it without the focus.
    const typed = (_: unknown, change: { sourceChange?: unknown }) => {
      if (change.sourceChange && !markdown && editor?.hasFocus()) {
        model.cellEdited(cell.id);
      }
    };
    cellModel.sharedModel.changed.connect(typed);
    const onKey = (event: KeyboardEvent) => {
      // Undo and redo step through the cell's history, as in the notebook.
      // JupyterLab's Undo command reaches only a notebook panel, and without
      // these keys the browser's own undo changes the text as a new edit.
      const step = undoKey(event);
      if (step) {
        event.preventDefault();
        event.stopPropagation();
        if (step === 'undo') {
          editor?.undo();
        } else {
          editor?.redo();
        }
        return;
      }
      const done =
        (event.key === 'Enter' && event.shiftKey) || event.key === 'Escape';
      if (markdown && done) {
        event.preventDefault();
        event.stopPropagation();
        onDone.current?.();
      } else if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        void model.runCell(cell.id);
      }
    };
    host.current.addEventListener('keydown', onKey, true);
    if (props.focus) {
      editor?.focus();
    }
    const node = host.current;
    return () => {
      node.removeEventListener('keydown', onKey, true);
      model.settings.changed.disconnect(follow);
      cellModel.sharedModel.changed.disconnect(typed);
      editor?.dispose();
    };
  }, [cell.id, editorServices]);
  if (!editorServices) {
    return (
      <pre className="jp-Epi-code-fallback">
        {cell.model.sharedModel.getSource()}
      </pre>
    );
  }
  return <div className="jp-Epi-editor" ref={host} />;
}

export function Attachment(props: {
  attachment: IAttachment;
  openFile: (path: string, line: number | null) => void;
}): JSX.Element {
  const { attachment, openFile } = props;
  return (
    <div className="jp-Epi-attachment">
      <div className="jp-Epi-attachment-head">
        <span>
          attached · {attachment.file} § {attachment.symbol}()
        </span>
        <button
          className="jp-Epi-link"
          onClick={() =>
            openFile(
              attachment.file,
              attachment.highlight[0] ?? attachment.start
            )
          }
        >
          open in editor
        </button>
      </div>
      <pre className="jp-Epi-attachment-body">
        {attachment.lines.map(([number, text], index) => (
          <div
            key={index}
            className={
              number !== null && attachment.highlight.includes(number)
                ? 'jp-mod-highlight'
                : ''
            }
          >
            <span className="jp-Epi-lineno">{number ?? ''}</span>
            {text}
          </div>
        ))}
      </pre>
    </div>
  );
}

/**
 * Opens the cell's menu, the one a right-click opens, under the button:
 * moving, deleting and the rest, where the mouse and the keyboard find it.
 */
function CellMenuButton(): JSX.Element {
  return (
    <Button
      minimal
      small
      className="jp-Epi-button jp-Epi-cellmenu"
      title="More actions for this cell: move it, delete it and the rest"
      aria-label="More actions for this cell"
      aria-haspopup="menu"
      onClick={event => {
        const box = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: box.left,
            clientY: box.bottom,
            button: 2
          })
        );
      }}
    >
      <ellipsesIcon.react tag="span" elementPosition="center" />
    </Button>
  );
}

/**
 * One optional click for what the analyst expects, while the answer's cell
 * is written or run. It stays while the pointer or the keyboard focus is on
 * it, and the answer shows beside it all the same.
 */
function GuessPrompt(props: {
  model: EpiModel;
  strip: IStrip;
}): JSX.Element | null {
  const { model, strip } = props;
  const [engaged, setEngaged] = React.useState(false);
  const [help, setHelp] = React.useState(false);
  // The buttons go once a guess is chosen, with the focus on the one
  // pressed: the line that takes their place takes the focus.
  const chosen = React.useRef(false);
  const made = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (strip.guess && chosen.current) {
      chosen.current = false;
      if (focusLost()) {
        made.current?.focus();
      }
    }
  });
  const busy = strip.status === 'writing' || strip.status === 'running';
  const type = strip.question?.type;
  if (!model.settings.guessFirst || !type || !GUESSED_TYPES.includes(type)) {
    return null;
  }
  if (strip.guess) {
    return (
      <div className="jp-Epi-guess jp-mod-made" ref={made} tabIndex={-1}>
        You guessed first: <GuessChip guess={strip.guess} />
      </div>
    );
  }
  if (!busy && !engaged) {
    return null;
  }
  return (
    <div
      className="jp-Epi-guess"
      role="group"
      aria-label="What do you expect?"
      onMouseEnter={() => setEngaged(true)}
      onMouseLeave={() => setEngaged(false)}
      onFocus={() => setEngaged(true)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setEngaged(false);
        }
      }}
    >
      <span className="jp-Epi-guess-ask">What do you expect?</span>
      {GUESSES.map(guess => (
        <button
          key={guess.value}
          className="jp-Epi-guess-option"
          onClick={() => {
            chosen.current = true;
            model.setGuess(strip.cellId, guess.value);
          }}
        >
          {guess.label}
        </button>
      ))}
      <HelpButton
        label="a guess"
        ariaLabel="Why guess first"
        text={GUESS_HELP}
        open={help}
        onToggle={() => setHelp(!help)}
      />
      {help && <div className="jp-Epi-help-text">{GUESS_HELP}</div>}
    </div>
  );
}

/**
 * What a strip says about the notebook: what the answer does while it works,
 * and what it did once done, such as "Edited [5] in place". An answer that
 * failed before it changed the notebook says so; its error shows below.
 */
export function stripAction(model: EpiModel, strip: IStrip): string {
  const where = strip.placement;
  // A cell deleted while the model writes keeps its label in the strip.
  const target = where.cell
    ? (model.cell(where.cell)?.label ?? strip.gone?.label ?? '')
    : '';
  const made = strip.insertedId
    ? (model.cell(strip.insertedId)?.label ?? '')
    : '';
  const after = strip.replaced
    ? ` where ${strip.replaced} was`
    : target
      ? ` after ${target}`
      : ' at the end';
  if (strip.status === 'writing' || strip.status === 'running') {
    return where.kind === 'edit'
      ? `Editing ${target} in place`
      : where.kind === 'branch'
        ? `Branching ${target}`
        : `Adding a cell${after}`;
  }
  const changed =
    strip.insertedId !== null ||
    (where.kind === 'edit' && strip.before !== null);
  if (!changed) {
    return 'No change to the notebook';
  }
  const named = made && made !== '[ ]' ? made : '';
  return where.kind === 'edit'
    ? `Edited ${target} in place`
    : where.kind === 'branch'
      ? `Branched ${target}${named ? ` as ${named}` : ''}`
      : `Added ${named || 'a cell'}${after}`;
}

export function ResultStrip(props: {
  model: EpiModel;
  strip: IStrip;
}): JSX.Element {
  const { model, strip } = props;
  const busy = strip.status === 'writing' || strip.status === 'running';
  const seconds = useSeconds(strip.started, strip.status === 'writing');
  const root = React.useRef<HTMLDivElement>(null);
  const undo = React.useRef<HTMLButtonElement>(null);
  if (strip.status === 'held') {
    return <HeldStrip model={model} strip={strip} />;
  }
  if (strip.status === 'waiting') {
    return <WaitingStrip model={model} strip={strip} />;
  }
  if (strip.agent && strip.elsewhere) {
    // A run asked in another notebook that works in this one.
    return (
      <div className="jp-Epi-agentpointerwrap" data-strip-id={strip.cellId}>
        <AgentElsewhere
          model={model}
          run={strip.agent}
          askedIn={strip.elsewhere}
        />
      </div>
    );
  }
  if (strip.agent) {
    // An agent's run: in the strip, or a line that says where it shows. Only
    // the bench draws cards, so elsewhere a run for a card shows in its strip.
    const place = model.settings.agentView;
    // A run opened again from the history shows in its strip: the sidebar
    // shows the newest run (1.73).
    const inStrip =
      place === 'strip' ||
      (place === 'card' && model.view !== 'bench') ||
      (place === 'sidebar' && !!strip.agent.past);
    // The guess before the result asks while the agent works, as it does
    // while one cell is written.
    return inStrip ? (
      <div
        className="jp-Epi-strip jp-Epi-agentstrip"
        data-strip-id={strip.cellId}
      >
        <AgentRunView model={model} run={strip.agent} place="strip" />
        <GuessPrompt model={model} strip={strip} />
      </div>
    ) : (
      <div className="jp-Epi-agentpointerwrap" data-strip-id={strip.cellId}>
        <AgentPointer model={model} run={strip.agent} />
        <GuessPrompt model={model} strip={strip} />
      </div>
    );
  }
  const stage =
    strip.status === 'writing'
      ? stageText(
          strip.stage,
          seconds ?? (strip.elapsed ? Math.round(strip.elapsed) : null)
        )
      : strip.status === 'running'
        ? 'running'
        : strip.status === 'error'
          ? 'failed'
          : '';
  return (
    <div
      ref={root}
      className={`jp-Epi-strip${strip.status === 'error' ? ' jp-mod-error' : ''}`}
      data-strip-id={strip.cellId}
    >
      <div className="jp-Epi-strip-row">
        <ProgressBar value={busy ? null : 1} label={strip.text} />
        <span className="jp-Epi-strip-action">{stripAction(model, strip)}</span>
        <span className="jp-Epi-strip-text">{strip.text}</span>
        {stage && <span className="jp-Epi-strip-stage">{stage}</span>}
        {strip.status === 'writing' && (
          <Button
            small
            minimal
            className="jp-Epi-button"
            title="Stop the answer: nothing is added to the notebook"
            onClick={() => stopStrip(model, strip, root.current)}
          >
            Stop
          </Button>
        )}
        {!busy && (
          <Button
            minimal
            small
            className="jp-Epi-button"
            onClick={() => model.toggleDiff(strip.cellId)}
          >
            {strip.showDiff ? 'Hide code change' : 'Show code change'}
          </Button>
        )}
        {!busy && (
          <button
            ref={undo}
            className="jp-Epi-link"
            onClick={() => undoStrip(model, strip, root.current)}
          >
            Undo
          </button>
        )}
        {!busy && (
          <CloseButton
            label="Close this strip; the change stays"
            onClick={() => closeStrip(model, strip, root.current)}
          />
        )}
      </div>
      <StripUndoAsk model={model} strip={strip} back={undo} />
      {strip.status === 'writing' && strip.gone && (
        <div className="jp-Epi-strip-note">
          {goneName(strip, true)} was deleted. When the answer comes, it waits
          here, and nothing runs.
        </div>
      )}
      {strip.status === 'writing' && strip.thinking && (
        <div className="jp-Epi-thinking">{strip.thinking}</div>
      )}
      <GuessPrompt model={model} strip={strip} />
      {strip.error && <div className="jp-Epi-error">{strip.error}</div>}
      {strip.showDiff && (
        <pre className="jp-Epi-diff">
          {model.diff(strip).map((line, index) => (
            <div
              key={index}
              className={line.kind === '-' ? 'jp-mod-removed' : 'jp-mod-added'}
            >
              {line.kind} {line.text}
            </div>
          ))}
          {model.diff(strip).length === 0 && <div>(no change)</div>}
        </pre>
      )}
    </div>
  );
}

/**
 * An answer that needs a model and did not start: the notebook's answers
 * had reached its cap. Go on raises the cap by $1 and starts it.
 */
function HeldStrip(props: { model: EpiModel; strip: IStrip }): JSX.Element {
  const { model, strip } = props;
  const root = React.useRef<HTMLDivElement>(null);
  return (
    <div
      className="jp-Epi-strip jp-Epi-heldstrip"
      ref={root}
      data-strip-id={strip.cellId}
    >
      <div className="jp-Epi-strip-row">
        <span className="jp-Epi-strip-action">Not started</span>
        <span className="jp-Epi-strip-text">{strip.text}</span>
        <CloseButton
          label="Close; the answer does not start"
          onClick={() => closeStrip(model, strip, root.current)}
        />
      </div>
      <CapNote model={model} onGoOn={() => void model.goOn(strip.cellId)} />
    </div>
  );
}

/**
 * How a strip names the cell that the analyst deleted while the model wrote
 * its answer: "[5]", or "the cell" for one that never ran.
 */
function goneName(strip: IStrip, start = false): string {
  const label = strip.gone?.label ?? '';
  return label && label !== '[ ]' ? label : start ? 'The cell' : 'the cell';
}

/**
 * An answer that came for a cell that the analyst deleted while the model
 * wrote it (design iteration 1.55). It waits where the cell was, with its
 * code, and nothing ran. "Restore [5] and run" puts the cell back with the
 * answer, "Run it" puts the answer alone where the cell was, and the ×
 * drops the answer.
 */
function WaitingStrip(props: { model: EpiModel; strip: IStrip }): JSX.Element {
  const { model, strip } = props;
  const root = React.useRef<HTMLDivElement>(null);
  const gone = !!strip.gone;
  const code = strip.waiting?.code ?? '';
  const run = (how: 'restore' | 'alone') => {
    // The strip changes into the strip of the answer that runs.
    if (root.current?.contains(document.activeElement)) {
      focusCard(root.current);
    }
    void model.runWaiting(strip.cellId, how);
  };
  return (
    <div
      ref={root}
      className="jp-Epi-strip jp-Epi-heldstrip jp-Epi-waitstrip"
      data-strip-id={strip.cellId}
    >
      <div className="jp-Epi-strip-row">
        <span className="jp-Epi-strip-action">Not added</span>
        <span className="jp-Epi-strip-text">{strip.text}</span>
        <CloseButton
          label="Close; the answer is dropped"
          onClick={() => closeStrip(model, strip, root.current)}
        />
      </div>
      <div className="jp-Epi-capnote">
        <span className="jp-Epi-capnote-text">
          {gone
            ? `${goneName(strip, true)} was deleted while the model wrote this answer, so the answer waits here: nothing was added to the notebook, and nothing ran.`
            : 'The answer waited while its cell was deleted, and nothing ran.'}
        </span>
        <button
          className="jp-Epi-link"
          aria-expanded={strip.showDiff}
          onClick={() => model.toggleDiff(strip.cellId)}
        >
          {strip.showDiff ? 'Hide code' : 'Show code'}
        </button>
        {gone && (
          <Button
            small
            className="jp-Epi-button jp-mod-styled"
            title={`Add the answer alone where ${goneName(strip)} was, and run it`}
            onClick={() => run('alone')}
          >
            Run it
          </Button>
        )}
        <Button
          small
          className="jp-Epi-button jp-mod-styled jp-mod-accept"
          title={
            gone
              ? `Put ${goneName(strip)} back where it was, then add the answer and run it`
              : 'Add the answer where it was meant to go, and run it'
          }
          onClick={() => run('restore')}
        >
          {gone ? `Restore ${goneName(strip)} and run` : 'Run it'}
        </Button>
      </div>
      {strip.showDiff && (
        <pre className="jp-Epi-diff">
          {code.split('\n').map((line, index) => (
            <div key={index} className="jp-mod-added">
              + {line}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/**
 * Stop an answer while the model writes it. The strip goes with the focus in
 * it, so the card that held the strip takes the focus first.
 */
function stopStrip(
  model: EpiModel,
  strip: IStrip,
  node: HTMLElement | null
): void {
  if (node?.contains(document.activeElement)) {
    focusCard(node);
  }
  model.stopAnswer(strip.cellId);
}

/**
 * Undo from a strip. An answer that nobody changed goes at once, and its
 * strip with it, Undo included: the card that held the strip takes the
 * focus, as after the ×. When the analyst changed the answer, the strip
 * stays and its question takes the focus.
 */
function undoStrip(
  model: EpiModel,
  strip: IStrip,
  node: HTMLElement | null
): void {
  const inside = node?.contains(document.activeElement) ?? false;
  model.undo(strip.cellId);
  if (inside && !model.strips.has(strip.cellId)) {
    focusCard(node);
  }
}

/**
 * Close a strip from its ×. The strip goes with the focus in it, so the
 * card that held the strip takes the focus first.
 */
function closeStrip(
  model: EpiModel,
  strip: IStrip,
  node: HTMLElement | null
): void {
  if (node?.contains(document.activeElement)) {
    focusCard(node);
  }
  model.dismissStrip(strip.cellId);
}

export function ParallelStrip(props: {
  model: EpiModel;
  cell: IEpiCell;
}): JSX.Element | null {
  const { model, cell } = props;
  const ids = model.parallel.get(cell.id) ?? [];
  // A branch the AI did not write has no cell, and shows by what it ended with.
  const branches = ids
    .map(id => ({
      id,
      cell: model.cell(id),
      job: model.jobs.jobFor(id),
      end: model.parallelEnded.get(id) ?? null
    }))
    .filter(branch => branch.cell || branch.end);
  if (!branches.length) {
    return null;
  }
  // The job says how a branch runs; once it goes, a minute after the run,
  // what the branch ended with stays.
  const state = (branch: (typeof branches)[number]) =>
    branch.job?.status === 'error' || branch.end?.ok === false
      ? 'failed'
      : branch.job?.status === 'done' || branch.end?.ok
        ? 'done'
        : branch.job
          ? 'running'
          : 'writing';
  const done = branches.filter(branch => state(branch) === 'done').length;
  const failed = branches.filter(branch => state(branch) === 'failed').length;
  return (
    <div className="jp-Epi-strip jp-Epi-parallel">
      <div className="jp-Epi-strip-row">
        <span className="jp-Epi-strip-action">
          Parallel exploration of {cell.label}
        </span>
        <span className="jp-Epi-strip-text">
          {done} of {branches.length} done
          {failed ? ` · ${failed} failed` : ''}
        </span>
      </div>
      {branches.map(branch => {
        const { job, end } = branch;
        const now = state(branch);
        const title = branch.cell?.title ?? end?.title ?? '';
        const value =
          now === 'done'
            ? 1
            : now === 'failed'
              ? 0
              : job?.status === 'queued'
                ? 0
                : (job?.progress ?? null);
        return (
          <React.Fragment key={branch.id}>
            <div
              className={`jp-Epi-parallel-row${now === 'failed' ? ' jp-mod-error' : ''}`}
            >
              <span className="jp-Epi-label">
                {branch.cell?.label ?? end?.label}
              </span>
              <span className="jp-Epi-strip-text">{title}</span>
              <span className="jp-Epi-subshell" title={PARALLEL_HELP}>
                {now === 'failed' || now === 'done' || now === 'writing'
                  ? now === 'writing'
                    ? 'AI writing'
                    : now
                  : job?.status === 'queued'
                    ? 'queued'
                    : job?.slot !== null && job?.slot !== undefined
                      ? `parallel run ${job.slot + 1}`
                      : 'main run'}
              </span>
              <ProgressBar value={value} label={title} />
              <span className="jp-Epi-percent">
                {now === 'failed' || job?.status === 'queued'
                  ? '—'
                  : value === null
                    ? '…'
                    : `${Math.round(100 * value)}%`}
              </span>
            </div>
            {now === 'failed' && (end?.error ?? job?.error) && (
              <div className="jp-Epi-error">
                {(end?.error ?? job?.error ?? '').split('\n')[0]}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/**
 * The key of each output: its kind and its place among the outputs of that
 * kind, as "table 2". A pin keeps the key, so that after another run it
 * stays on the same output, wherever that output is in the list.
 */
export function outputKeys(outputs: IOutputModel[]): string[] {
  const seen = new Map<string, number>();
  return outputs.map(output => {
    const kind = outputKind(output);
    const place = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, place);
    return `${kind} ${place}`;
  });
}

/**
 * Whether the fit of a cell converged, and which of its outputs are the
 * fit's summary: a printed summary says so, as statsmodels' `Converged:
 * Yes`, or a model that the cell makes says so in the kernel's listing.
 * Either one that says that the fit did not converge wins.
 */
export function fitOf(
  model: EpiModel,
  cell: IEpiCell,
  outputs: IOutputModel[]
): { converged: boolean; summaries: Set<number> } {
  const summaries = new Set<number>();
  let converged = false;
  for (let index = 0; index < outputs.length; index++) {
    const output = outputs[index];
    // A summary is printed, as statsmodels' print(fit.summary()) does.
    const kind = outputKind(output);
    if (kind !== 'log' && kind !== 'text') {
      continue;
    }
    const said = convergedIn(outputText(output.data)?.lines ?? []);
    if (said === false) {
      return { converged: false, summaries: new Set() };
    }
    if (said) {
      converged = true;
      summaries.add(index);
    }
  }
  for (const name of cell.analysis?.defs ?? []) {
    const variable = model.variable(name);
    if (variable?.kind === 'model' && typeof variable.converged === 'boolean') {
      if (!variable.converged) {
        return { converged: false, summaries: new Set() };
      }
      converged = true;
    }
  }
  return { converged, summaries };
}

/**
 * The outputs of a code cell at the level of detail in force: tables and
 * printed text as tiles or in full, plots and pictures as thumbnails.
 * An output that cannot be drawn says so in its place.
 */
export function Outputs(props: {
  model: EpiModel;
  cell: IEpiCell;
}): JSX.Element | null {
  const { model, cell } = props;
  // The slider's level, or the width's (src/model/spacedetail.ts).
  const detail = model.detail;
  const outputs = outputsOf(cell.model);
  const keys = outputKeys(outputs);
  const [pinned, setPinned] = React.useState<string | null>(null);
  const pinnedAt = pinned === null ? -1 : keys.indexOf(pinned);
  // The row stays in the page without outputs, so its width is known when
  // the first output comes.
  const row = React.useRef<HTMLDivElement>(null);
  const width = useWidth(row, 600);
  const region =
    model.ask?.kind === 'region' && model.ask.cellId === cell.id
      ? { x0: model.ask.x0, x1: model.ask.x1, y: model.ask.y }
      : null;
  const active =
    model.selectedOutput?.cellId === cell.id
      ? model.selectedOutput.index
      : null;
  const open = (index: number) => {
    model.showOutput(cell.id, index);
    if (outputKind(outputs[index]) !== 'plot') {
      setPinned(pinned === keys[index] ? null : keys[index]);
    }
  };
  // A fit that converged: the warnings of its earlier tries fold, and its
  // summary shows in full, but at Overview (design iteration 1.77).
  const fit = fitOf(model, cell, outputs);
  const textLimit = (index: number) =>
    fit.summaries.has(index) && detail !== 'overview'
      ? Math.max(SUMMARY_LINES, TEXT_LINES[detail])
      : TEXT_LINES[detail];
  return (
    <>
      <div className="jp-Epi-miniatures" ref={row}>
        {outputs.map((output, index) => {
          const kind = outputKind(output);
          const shown = active === index || pinnedAt === index;
          return (
            <OutputBoundary key={index} output={output}>
              {kind === 'table' ? (
                <TableOutput
                  model={model}
                  cellId={cell.id}
                  output={output}
                  available={width}
                  active={shown}
                  onOpen={() => open(index)}
                />
              ) : kind === 'log' || kind === 'text' ? (
                <TextOutput
                  output={output}
                  active={shown}
                  onOpen={() => open(index)}
                  limit={textLimit(index)}
                  fold={fit.converged ? retriedWarning : undefined}
                />
              ) : kind === 'widget' ? (
                // A widget is live, as in the notebook: a bar, a control, a figure.
                <div className="jp-Epi-widgetoutput">
                  <RenderedOutput
                    output={output}
                    rendermime={model.rendermime}
                  />
                </div>
              ) : PLOT_KINDS.has(kind) && detail !== 'overview' ? (
                // Full and Compact draw a plot at a readable size, and a Whybook
                // plot or a Plotly chart can be brushed where it is.
                <div className={`jp-Epi-plotout jp-mod-${detail}`}>
                  <FullOutput
                    output={
                      // A live figure cannot shrink: Compact shows its picture.
                      (detail === 'compact' && pictureOf(output)) || output
                    }
                    rendermime={model.rendermime}
                    width={Math.min(width, detail === 'full' ? 640 : 340)}
                    selection={region}
                    onSelect={(plot, x0, x1, anchor, y) =>
                      void model.askRegion(cell.id, plot, x0, x1, anchor, y)
                    }
                    pick={imagePickOf(model, cell.id)}
                    onAskImage={(pick, anchor) =>
                      askImage(model, cell.id, pick, anchor)
                    }
                  />
                </div>
              ) : (
                <Miniature
                  output={output}
                  active={shown}
                  onClick={() => open(index)}
                  rendermime={model.rendermime}
                />
              )}
            </OutputBoundary>
          );
        })}
      </div>
      {pinnedAt >= 0 && (
        <div className="jp-Epi-pinned">
          <OutputBoundary output={outputs[pinnedAt]}>
            {/* A table of a data frame asks from its headers and row labels. */}
            <TableQuestions
              model={model}
              cellId={cell.id}
              index={pinnedAt}
              output={outputs[pinnedAt]}
            >
              <RenderedOutput
                output={outputs[pinnedAt]}
                rendermime={model.rendermime}
              />
            </TableQuestions>
          </OutputBoundary>
        </div>
      )}
    </>
  );
}

/**
 * A code cell as a drop target: a variable, column or table dropped on it,
 * or on its code, or a file from the file browser, asks about the cell.
 */
export function useCellDrop(
  model: EpiModel,
  cell: IEpiCell
): {
  target: React.RefObject<HTMLDivElement>;
  over: boolean;
  /**
   * The name of a file from the file browser while it is over the cell, so
   * that the cell says where a drop goes (design iteration 1.77).
   */
  file: string | null;
  /**
   * The note that says where the drop goes: it follows the pointer over the
   * cell, so that it shows where the analyst looks (design iteration 1.83).
   */
  note: React.RefObject<HTMLDivElement>;
  handlers: {
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (event: React.DragEvent) => void;
  };
  /** For the editor, which takes a drag before CodeMirror sees it. */
  onItemDrag: (event: DragEvent) => void;
} {
  const [over, setOver] = React.useState(false);
  const [file, setFile] = React.useState<string | null>(null);
  const target = React.useRef<HTMLDivElement>(null);
  const note = React.useRef<HTMLDivElement>(null);
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  useFileDrop(
    target,
    (paths, anchor) => model.askFileDrop(paths, { cellId: cell.id }, anchor),
    (on, paths) => {
      setOver(on);
      setFile(on && paths?.length ? PathExt.basename(paths[0]) : null);
    },
    (x, y) => {
      pointer.current = { x, y };
      placeDropNote(target.current, note.current, x, y);
    }
  );
  // The note shows once the file is over the cell: at the pointer, at once.
  React.useLayoutEffect(() => {
    if (file && pointer.current) {
      const { x, y } = pointer.current;
      placeDropNote(target.current, note.current, x, y);
    }
  }, [file]);
  const dropItem = (event: {
    dataTransfer: DataTransfer | null;
    shiftKey: boolean;
    altKey: boolean;
    clientX: number;
    clientY: number;
  }): boolean => {
    setOver(false);
    const item = dragItem(event);
    if (!item) {
      return false;
    }
    model.arm(null);
    void model.askDrop(
      item,
      { cellId: cell.id },
      modifiersOf(event, model),
      anchorOf(event)
    );
    return true;
  };
  return {
    target,
    over,
    file,
    note,
    handlers: {
      onDragOver: event => {
        if (carriesItem(event)) {
          event.preventDefault();
          setOver(true);
        }
      },
      onDragLeave: () => setOver(false),
      onDrop: event => {
        if (dropItem(event)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
    },
    onItemDrag: event => {
      if (event.type === 'drop') {
        dropItem(event);
      } else {
        setOver(true);
      }
    }
  };
}

/**
 * Put the note of a file from the file browser next to the pointer, below
 * the name of the file that follows the pointer, and inside the card. In
 * the card's corner, the note of 1.77 was out of sight on a card taller than
 * the window, and far from where the analyst looks on any large card
 * (design iteration 1.83).
 */
export function placeDropNote(
  card: HTMLElement | null,
  note: HTMLElement | null,
  x: number,
  y: number
): void {
  if (!card || !note) {
    return;
  }
  const box = card.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(x - box.left + 16, box.width - note.offsetWidth - 8)
  );
  const top = Math.max(
    8,
    Math.min(y - box.top + 30, box.height - note.offsetHeight - 8)
  );
  note.style.left = `${Math.round(left)}px`;
  note.style.top = `${Math.round(top)}px`;
  note.style.right = 'auto';
  note.style.bottom = 'auto';
}

/**
 * The arrow keys between the targets of a pick, across the cells of the
 * view: down and right go to the next target, up and left to the one before,
 * Home and End to the first and the last. The target the focus is on is the
 * one Tab stop of them all (DocumentView).
 */
export function targetKeys(event: React.KeyboardEvent<HTMLElement>): void {
  const root = event.currentTarget.closest('.jp-Epi-main');
  if (!root) {
    return;
  }
  const zones = Array.from(
    root.querySelectorAll<HTMLElement>('.jp-Epi-dropzone')
  );
  const index = zones.indexOf(event.currentTarget);
  const next =
    event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? zones[Math.min(zones.length - 1, index + 1)]
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? zones[Math.max(0, index - 1)]
        : event.key === 'Home'
          ? zones[0]
          : event.key === 'End'
            ? zones[zones.length - 1]
            : null;
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

/** The target the focus is on: Tab comes back to it (DocumentView). */
function stopHere(event: React.FocusEvent<HTMLElement>): void {
  const root = event.currentTarget.closest('.jp-Epi-main');
  root?.querySelectorAll<HTMLElement>('.jp-Epi-dropzone').forEach(zone => {
    zone.dataset.stop = String(zone === event.currentTarget);
    zone.tabIndex = zone === event.currentTarget ? 0 : -1;
  });
}

/**
 * While an item is picked, a click on a card's head, its label or its
 * title, picks the card as the target, as the card's button does (design
 * iteration 1.77). The head's own buttons and links keep their clicks.
 */
export function pickByHead(
  model: EpiModel,
  cell: IEpiCell
): (event: React.MouseEvent<HTMLElement>) => void {
  return event => {
    const target = event.target as Element;
    if (!model.armed || target.closest('button, a, input, .jp-Epi-labelref')) {
      return;
    }
    model.pickCell(cell.id, modifiersOf(event, model), anchorOf(event));
  };
}

/**
 * In the click interaction, after a variable is picked: the button that
 * asks about it with this cell.
 */
export function PickZone(props: {
  model: EpiModel;
  cell: IEpiCell;
}): JSX.Element | null {
  const { model, cell } = props;
  const armed = model.armed;
  if (!armed) {
    return null;
  }
  return (
    <button
      className="jp-Epi-dropzone"
      onKeyDown={targetKeys}
      onFocus={stopHere}
      onClick={event => {
        model.pickCell(
          cell.id,
          modifiersOf(event, model),
          event.detail === 0 ? null : anchorOf(event)
        );
      }}
    >
      {model.interaction === 'click'
        ? `Ask about ${itemName(armed)} with ${cell.label}`
        : `Drop ${itemName(armed)} here`}
    </button>
  );
}

function CellCard(props: ICardProps): JSX.Element {
  const { model, cell, editorServices, openFile } = props;
  const drop = useCellDrop(model, cell);
  const codeOpen = model.codeOpen.has(cell.id);
  const job = model.jobs.jobFor(cell.id);
  const running = job?.status === 'running' || job?.status === 'queued';
  const strip = model.strips.get(cell.id);
  const armed = model.armed;
  const formula = cell.analysis?.formulas.find(
    f => f.includes('~') && !f.trim().startsWith('~')
  );
  const attachments = cell.analysis?.attachments ?? [];
  const off = aiOffReason(model);
  // A cell of an agent's run shows the type of its own step.
  const badge = cellType(cell.meta);
  const selectDecision = (decision: IDecision) => {
    if (model.variable(decision.name)) {
      model.select(decision.name);
    } else if (!codeOpen) {
      model.toggleCode(cell.id);
    }
  };
  return (
    <div
      ref={drop.target}
      className={`jp-Epi-cell${cell.branchOf ? ' jp-mod-branch' : ''}${armed ? ' jp-mod-target' : ''}${drop.over ? ' jp-mod-over' : ''}${drop.file ? ' jp-mod-filedrop' : ''}`}
      data-cell-id={cell.id}
      data-question-type={badge}
      onMouseDown={() => model.setCurrentCell(cell.id)}
      {...drop.handlers}
    >
      <div className="jp-Epi-cell-head" onClick={pickByHead(model, cell)}>
        <CellLabel cell={cell} />
        <CellTitle model={model} cell={cell} />
        {badge && (
          <TypeBadge type={badge} light={type => model.lightType(type)} />
        )}
        {cell.meta.guess && <GuessChip guess={cell.meta.guess.value} />}
        {cell.branchOf && (
          <span className="jp-Epi-subshell" title={PARALLEL_HELP}>
            {/* A job keeps its slot for the minute that it stays listed after it ends. */}
            {job?.status === 'running' && job.slot !== null
              ? `parallel run ${job.slot + 1}`
              : 'branch'}
          </span>
        )}
        <span className="jp-Epi-cell-actions">
          <Button
            minimal
            small
            className="jp-Epi-button"
            onClick={() => void model.runCell(cell.id)}
            disabled={running}
            title="Run this cell (Shift+Enter in the editor)"
          >
            <runIcon.react tag="span" elementPosition="center" />
            {running ? 'Running' : 'Run'}
          </Button>
          <Button
            minimal
            small
            className={`jp-Epi-button${codeOpen ? ' jp-mod-active' : ''}`}
            aria-pressed={codeOpen}
            onClick={() => model.toggleCode(cell.id)}
          >
            <codeIcon.react tag="span" elementPosition="center" />
            {codeOpen ? 'Hide code' : 'Show code'}
          </Button>
          <CellMenuButton />
        </span>
      </div>
      {(cell.decisions.length > 0 ||
        model.defaultsWaiting(cell).length > 0) && (
        <DecisionChips
          decisions={cell.decisions}
          waiting={model.defaultsWaiting(cell)}
          onClick={(decision, event) => {
            selectDecision(decision);
            void model.askDecision(
              cell.id,
              decision,
              anchorBelow(event.currentTarget)
            );
          }}
        />
      )}
      {formula && !codeOpen && <div className="jp-Epi-formula">{formula}</div>}
      {cell.meta.summary && (
        <div className="jp-Epi-summary">
          {cell.meta.written_by === 'agent' ? (
            <>
              <span className="jp-Epi-ai">{cell.meta.summary}</span>
              <AITag by={cellWrittenBy(cell.meta.generated_by)} />
              {/* The model wrote this about its code (design iteration 1.83). */}
              {model.editedByHand(cell.id) && (
                <span className="jp-Epi-edited-since">
                  {' '}
                  · you changed the code since
                </span>
              )}
            </>
          ) : (
            cell.meta.summary
          )}
        </div>
      )}
      {codeOpen && (
        <div className="jp-Epi-code">
          <CellEditor
            model={model}
            cell={cell}
            editorServices={editorServices}
            onItemDrag={drop.onItemDrag}
          />
          {attachments.map(attachment => (
            <Attachment
              key={attachment.file + attachment.symbol}
              attachment={attachment}
              openFile={openFile}
            />
          ))}
        </div>
      )}
      {job &&
        job.status !== 'done' &&
        job.status !== 'error' &&
        // A bar in the outputs, from tqdm or a widget, shows the progress itself.
        ((job.progress !== null && !job.outputBar) || cell.branchOf) && (
          <div className="jp-Epi-job">
            <ProgressBar
              value={job.status === 'queued' ? 0 : job.progress}
              label={cell.title}
              wide
            />
            <span>
              {job.status === 'queued' ? 'queued' : (job.stage ?? 'running')}
            </span>
            <span className="jp-Epi-percent">
              {job.progress !== null
                ? `${Math.round(job.progress * 100)}%`
                : ''}
            </span>
          </div>
        )}
      {job?.status === 'error' && (
        <div className="jp-Epi-error">{job.error?.split('\n')[0]}</div>
      )}
      <div className="jp-Epi-cell-foot">
        <Outputs model={model} cell={cell} />
        <PickZone model={model} cell={cell} />
      </div>
      {cell.meta.assumptions && cell.meta.assumptions.length > 0 && (
        <ul
          className={`jp-Epi-assumptions${cell.meta.written_by === 'agent' ? ' jp-Epi-ai' : ''}`}
        >
          {cell.meta.assumptions.map((assumption, index) => (
            <li key={index} className={`jp-mod-${assumption.kind}`}>
              {assumption.text}
            </li>
          ))}
        </ul>
      )}
      {cell.meta.follow_up && cell.meta.follow_up.length > 0 && (
        <div className="jp-Epi-followups">
          {cell.meta.follow_up.map((follow, index) => (
            <button
              key={index}
              className={`jp-Epi-followup${off ? ' jp-mod-disabled' : ''}`}
              // A follow-up needs AI: without a model it stays, greyed.
              aria-disabled={off ? 'true' : undefined}
              title={off ? `Needs an AI model: ${off}` : undefined}
              onClick={() => {
                if (off) {
                  return;
                }
                void model.apply({
                  id: `follow:${cell.id}:${index}`,
                  text: follow.text,
                  type: follow.type,
                  origin: 'claude',
                  probability: null,
                  reasons: [],
                  placement: {
                    kind: 'new',
                    cell: cell.id,
                    label: `new cell after ${cell.label}`
                  },
                  code: null
                });
              }}
            >
              <TypeBadge type={follow.type} />{' '}
              <span className="jp-Epi-ai">{follow.text}</span>
            </button>
          ))}
          <OwnQuestion
            model={model}
            onAsk={text => void model.askOwn(text, { cellId: cell.id })}
            placeholder="Your own follow-up question"
          />
        </div>
      )}
      {strip && <ResultStrip model={model} strip={strip} />}
      <ParallelStrip model={model} cell={cell} />
      {drop.file && (
        // Where a file from the file browser goes, while it is over the
        // card: onto this cell, wherever on the card it is dropped. The note
        // follows the pointer (placeDropNote).
        <div
          className="jp-Epi-filedrop-note"
          aria-hidden="true"
          ref={drop.note}
        >
          Drop {drop.file} on {cell.label}
        </div>
      )}
    </div>
  );
}

/**
 * A markdown cell: its text under the heading. The text can be questioned:
 * the button asks about all of it, and words selected in it ask about
 * those words alone.
 */
/**
 * The text of a markdown cell: rendered, with its questions. An Edit button,
 * shown on hover and to the keyboard, or a double-click on the text, opens
 * the source in an editor; Shift+Enter, Escape or Done renders it again.
 * On the bench it sits in a card; in the 1:1 view it reads as in a notebook.
 */
export function NoteCard(props: {
  model: EpiModel;
  cell: IEpiCell;
  editorServices: IEditorServices | null;
  variant?: 'bench' | 'linear';
  /** Open in the editor, with the cursor in it: a text just added. */
  editing?: boolean;
  /** The model's `revision` when the view drew: a card of a list sets it. */
  revision?: number;
}): JSX.Element {
  const { model, cell, editorServices } = props;
  const linear = props.variant === 'linear';
  const byAgent = cell.meta.written_by === 'agent';
  // The model knows whether the editor is open, so that the text keeps its
  // card while it has no words, and after the card is drawn again.
  const [editing, setOpen] = React.useState(
    () => !!props.editing || model.inEditor(cell.id)
  );
  const setEditing = (open: boolean) => {
    setOpen(open);
    model.editText(cell.id, open);
  };
  React.useEffect(() => {
    if (editing) {
      model.editText(cell.id, true);
    }
  }, []);
  // Escape or Shift+Enter closes the editor with the focus in it: the Edit
  // button, in the same place, takes the focus.
  const root = React.useRef<HTMLDivElement>(null);
  const refocus = React.useRef(false);
  React.useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      if (focusLost()) {
        root.current
          ?.querySelector<HTMLElement>('.jp-Epi-note-edit')
          ?.focus({ preventScroll: true });
      }
    }
  }, [editing]);
  const source = cell.model.sharedModel.getSource();
  const body = noteBody(source);
  // The bench shows a heading as its section; the notebook renders it.
  const shown = linear ? source.trim() : body;
  const output = React.useMemo(
    (): OutputLike => ({
      type: 'display_data',
      data: { 'text/markdown': shown },
      metadata: {},
      // Untrusted, as JupyterLab draws a markdown cell: its sanitizer
      // removes scripts and event handlers, whatever the notebook's trust.
      trusted: false
    }),
    [shown]
  );
  const text = React.useRef<HTMLDivElement>(null);
  const strip = model.strips.get(cell.id);
  const asked = model.ask?.kind === 'note' && model.ask.cellId === cell.id;
  const onMouseUp = (event: React.MouseEvent) => {
    if (event.detail > 1) {
      // The word a double-click selects: the double-click edits instead.
      return;
    }
    const selection = window.getSelection();
    const words = selection?.toString().trim() ?? '';
    if (
      words &&
      selection?.anchorNode &&
      text.current?.contains(selection.anchorNode)
    ) {
      void model.askNote(cell.id, anchorOf(event), words);
    }
  };
  const edit = editorServices ? (
    <Button
      minimal
      small
      className="jp-Epi-button jp-Epi-note-edit"
      title="Edit the text (or double-click it)"
      onClick={() => setEditing(!editing)}
    >
      {editing ? 'Done' : 'Edit'}
    </Button>
  ) : null;
  return (
    <div
      ref={root}
      className={`jp-Epi-note${asked ? ' jp-mod-asked' : ''}${linear ? ' jp-mod-linear' : ''}${editing ? ' jp-mod-editing' : ''}${byAgent ? ' jp-mod-ai' : ''}`}
      data-cell-id={cell.id}
      // A text is a cell too: Cell details follows it, as it follows code.
      onMouseDown={() => model.setCurrentCell(cell.id)}
    >
      <div className="jp-Epi-note-head">
        {byAgent && (
          // A text that an agent wrote, as the comparison of a run in
          // another notebook: marked as the summary of an agent's code is.
          <span className="jp-Epi-note-by">
            Written by the agent
            <AITag by={cellWrittenBy(cell.meta.generated_by)} />
          </span>
        )}
        <span className="jp-Epi-cell-actions">
          {edit}
          {body && (
            <Button
              minimal
              small
              className="jp-Epi-button"
              title="Questions about this text. Select words in it to ask about those alone."
              onClick={event => {
                // From the keyboard, the questions open beside the button.
                const box = event.currentTarget.getBoundingClientRect();
                void model.askNote(
                  cell.id,
                  event.detail === 0
                    ? { x: box.right, y: box.top }
                    : anchorOf(event)
                );
              }}
            >
              Question this text
            </Button>
          )}
          {!linear && <CellMenuButton />}
        </span>
      </div>
      {editing ? (
        <div className="jp-Epi-code">
          <CellEditor
            model={model}
            cell={cell}
            editorServices={editorServices}
            onItemDrag={() => undefined}
            onDone={() => {
              refocus.current = true;
              setEditing(false);
            }}
            focus
          />
        </div>
      ) : (
        <div
          className="jp-Epi-note-text"
          ref={text}
          onMouseUp={onMouseUp}
          onDoubleClick={() => editorServices && setEditing(true)}
        >
          <RenderedOutput output={output} rendermime={model.rendermime} />
        </div>
      )}
      {strip && <ResultStrip model={model} strip={strip} />}
    </div>
  );
}

/**
 * The cards of the bench and the Code view: each draws again only when its
 * cell's object or the model's `revision` changes, so that a key typed in
 * one cell draws one card.
 */
const Card = React.memo(CellCard);
const Note = React.memo(NoteCard);

function SectionBlock(
  props: IBenchProps & {
    section: ISection;
    revision: number;
    /** The strips of answers whose cell was deleted, by the cell before it. */
    gone: Map<string | null, IStrip[]>;
  }
): JSX.Element {
  const { model, section, editorServices, openFile, revision, gone } = props;
  // The section is not passed on: its object is new at each change.
  const card = { model, editorServices, openFile, revision };
  const collapsed = model.collapsed.has(section.id);
  const code = section.cells.filter(cell => cell.type === 'code');
  const top = section.cells.filter(cell => !cell.branchOf);
  // With runs shown as cards, the cells of each run go under its card.
  const items = groupByRun(model, top);
  // The strip of an answer whose cell was deleted, where the cell was: a
  // folded section shows its strips under its head.
  const headed = collapsed
    ? [section.id, ...top.map(cell => cell.id)].flatMap(
        id => gone.get(id) ?? []
      )
    : top.some(cell => cell.id === section.id)
      ? []
      : (gone.get(section.id) ?? []);
  return (
    <div className="jp-Epi-sectionblock">
      <button
        className="jp-Epi-sectionhead"
        onClick={() => model.toggleSection(section.id)}
        aria-expanded={!collapsed}
      >
        <span className="jp-Epi-label">§{section.number}</span>
        <span className="jp-Epi-sectiontitle">{section.title}</span>
        <span className="jp-Epi-sectioncount">
          {code.length === 0 && section.cells.length > 0
            ? 'text'
            : `${code.length} cell${code.length === 1 ? '' : 's'}`}
        </span>
        {collapsed ? (
          <caretRightIcon.react className="jp-Epi-chevron" tag="span" />
        ) : (
          <caretDownIcon.react className="jp-Epi-chevron" tag="span" />
        )}
      </button>
      <GoneStrips model={model} strips={headed} />
      {!collapsed &&
        items.map(item =>
          'run' in item ? (
            <div key={item.run.stripId} className="jp-Epi-agentgroup">
              <AgentRunView model={model} run={item.run} place="card" />
              {item.cells.map(cell => (
                <TopCell
                  key={cell.id}
                  {...card}
                  cell={cell}
                  gone={gone.get(cell.id)}
                />
              ))}
            </div>
          ) : (
            <TopCell
              key={item.cell.id}
              {...card}
              cell={item.cell}
              gone={gone.get(item.cell.id)}
            />
          )
        )}
    </div>
  );
}

/**
 * The strips of answers whose cell the analyst deleted while the model
 * wrote them, drawn where the cell was (design iteration 1.55).
 */
export function GoneStrips(props: {
  model: EpiModel;
  strips?: IStrip[];
}): JSX.Element | null {
  const { model, strips } = props;
  if (!strips?.length) {
    return null;
  }
  return (
    <>
      {strips.map(strip => (
        <div key={strip.cellId} className="jp-Epi-gonestrip">
          <ResultStrip model={model} strip={strip} />
        </div>
      ))}
    </>
  );
}

/**
 * A cell of a section with its branches, or a text, and the strips of
 * answers whose cell was deleted just after it.
 */
function TopCell(props: ICardProps & { gone?: IStrip[] }): JSX.Element {
  const { gone, ...card } = props;
  const { model, cell } = card;
  if (cell.type === 'code') {
    return (
      <>
        <Card {...card} />
        {cell.branches.map(id => {
          const branch = model.cell(id);
          return branch ? (
            <div key={id} className="jp-Epi-branchwrap">
              <Card {...card} cell={branch} nested />
            </div>
          ) : null;
        })}
        <GoneStrips model={model} strips={gone} />
      </>
    );
  }
  // A text shows while it has words, and while its editor is open.
  return (
    <>
      {(model.isNote(cell) || model.inEditor(cell.id)) && (
        <Note
          model={model}
          cell={cell}
          editorServices={card.editorServices}
          revision={card.revision}
        />
      )}
      <GoneStrips model={model} strips={gone} />
    </>
  );
}

/**
 * The cells of a section, with the cells of each agent's run together
 * under its card when runs show as cards.
 */
function groupByRun(
  model: EpiModel,
  cells: IEpiCell[]
): ({ cell: IEpiCell } | { run: IAgentRun; cells: IEpiCell[] })[] {
  const items: ({ cell: IEpiCell } | { run: IAgentRun; cells: IEpiCell[] })[] =
    [];
  const cards = model.settings.agentView === 'card';
  for (const cell of cells) {
    const id = cards ? cell.meta.agent?.run : undefined;
    const run = id ? model.agentRuns.find(item => item.id === id) : undefined;
    const last = items[items.length - 1];
    if (run && last && 'run' in last && last.run === run) {
      last.cells.push(cell);
    } else {
      items.push(run ? { run, cells: [cell] } : { cell });
    }
  }
  return items;
}

/**
 * The width of the bench, in pixels, from which the minimap has a column of
 * its own at the right of the cards, and covers no line of a card (design
 * iteration 1.77). On a narrower bench it floats over the cards, as the
 * column would take a tenth of the room or more.
 */
export const MINIMAP_GUTTER_FROM = 900;

/** Whether an element is at least `from` pixels wide, as it resizes. */
function useWide(ref: React.RefObject<HTMLElement>, from: number): boolean {
  const [wide, setWide] = React.useState(false);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return;
    }
    const measure = () => setWide(node.clientWidth >= from);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, from]);
  return wide;
}

export function Bench(props: IBenchProps): JSX.Element {
  const { model } = props;
  useModel(model);
  const { title, intro, sections } = model.sections();
  // Read after the cells, whose changes can count in it too.
  const revision = model.revision;
  const gone = model.goneStrips();
  const host = React.useRef<HTMLDivElement>(null);
  const [fileOver, setFileOver] = React.useState(false);
  useFileDrop(
    host,
    (paths, anchor) => model.askFileDrop(paths, {}, anchor),
    setFileOver
  );
  // A wide bench keeps a column at the right of the cards for the minimap.
  const minimap = model.settings.minimap && !model.isBlank();
  const wide = useWide(host, MINIMAP_GUTTER_FROM);
  const gutter = minimap && wide;
  const armed = model.armed;
  return (
    <div
      className={`jp-Epi-bench${fileOver ? ' jp-mod-filedrop' : ''}${gutter ? ' jp-mod-gutter' : ''}`}
      ref={host}
      // A table from the Databases panel dropped outside the cells starts
      // from it, as a file does.
      onDragOver={event => {
        if (carriesItem(event)) {
          event.preventDefault();
        }
      }}
      onDrop={event => {
        const item = dragItem(event);
        if (item?.kind === 'table') {
          event.preventDefault();
          model.arm(null);
          void model.askDrop(
            item,
            {},
            modifiersOf(event, model),
            anchorOf(event)
          );
        } else if (item?.kind === 'file' && item.path) {
          // A file offered by the empty view.
          event.preventDefault();
          model.askFileDrop([item.path], {}, anchorOf(event));
        }
      }}
    >
      {title && <h1 className="jp-Epi-nbtitle">{title}</h1>}
      {intro && (
        <NoteCard
          model={model}
          cell={intro}
          editorServices={props.editorServices}
        />
      )}
      {model.isLoading() && <LoadingCells />}
      <GoneStrips model={model} strips={gone.get(null)} />
      {model.isBlank() && <EmptyStart model={model} />}
      {!model.isBlank() &&
        sections.map(section => (
          <SectionBlock
            key={section.id}
            {...props}
            section={section}
            revision={revision}
            gone={gone}
          />
        ))}
      {[...model.strips.values()]
        .filter(strip => strip.cellId.startsWith('end:'))
        .map(strip => (
          <ResultStrip key={strip.cellId} model={model} strip={strip} />
        ))}
      {armed?.kind === 'table' && (
        <button
          className="jp-Epi-dropzone jp-mod-end"
          onKeyDown={targetKeys}
          onFocus={stopHere}
          onClick={event =>
            void model.askDrop(
              armed,
              {},
              modifiersOf(event, model),
              event.detail === 0 ? null : anchorOf(event)
            )
          }
        >
          Start from {armed.label} at the end
        </button>
      )}
      {minimap && <Minimap model={model} />}
    </div>
  );
}
