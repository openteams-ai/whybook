import type { IEditorServices } from '@jupyterlab/codeeditor';
import { addIcon, Button, runIcon } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { EpiModel, IEpiCell } from '../model/epimodel';
import { askImage, imagePickOf } from '../model/imageask';
import { cellWrittenBy } from '../model/writtenby';
import { indexOf, outputKind, outputsOf } from '../model/notebook';
import type { IAttachment, IDecision } from '../tokens';
import {
  CellTitle,
  AITag,
  DecisionChips,
  GuessChip,
  PARALLEL_HELP,
  ProgressBar,
  anchorBelow,
  TypeBadge,
  useModel,
  useWidth
} from './common';
import {
  Attachment,
  CellEditor,
  GoneStrips,
  NoteCard,
  Outputs,
  ParallelStrip,
  PickZone,
  ResultStrip,
  useCellDrop
} from './bench';
import { LoadingCells } from './empty';
import { FullOutput, OutputBoundary } from './outputs';
import { TableQuestions } from './tablequestions';

/**
 * The Code view: the notebook's cells in their order, as the notebook shows
 * them, with the view's additions. A text cell is its rendered markdown,
 * with Edit and its questions on hover. A code cell has its title, the
 * decisions it makes, its code in an editor, and each output in full; a
 * plot answers a brush or a click with questions, as in the cell details.
 */
/** The type of a cell dragged by its prompt, to move it in the Code view. */
const CELL_MIME = 'application/x-whybook-cell';

function carriesCell(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(CELL_MIME);
}

/**
 * Move a cell by dragging its prompt, as in JupyterLab's notebook. A line
 * above or below the cell under the pointer shows where it goes. The drag
 * has a type of its own, so the drops that ask questions ignore it, and the
 * capture phase keeps it from the code editor.
 */
function useReorder(model: EpiModel, cellId: string) {
  const [over, setOver] = React.useState<'before' | 'after' | null>(null);
  const side = (event: React.DragEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? 'before' : 'after';
  };
  return {
    className: over ? ` jp-mod-drop-${over}` : '',
    handle: {
      draggable: true,
      title: 'Drag to move this cell',
      onDragStart: (event: React.DragEvent<HTMLElement>) => {
        event.dataTransfer.setData(CELL_MIME, cellId);
        event.dataTransfer.effectAllowed = 'move';
        const cell = event.currentTarget.closest('.jp-Epi-linear-cell');
        if (cell) {
          event.dataTransfer.setDragImage(cell, 12, 12);
        }
      }
    },
    target: {
      onDragOverCapture: (event: React.DragEvent) => {
        if (!carriesCell(event)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const where = side(event);
        if (where !== over) {
          setOver(where);
        }
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setOver(null);
        }
      },
      onDropCapture: (event: React.DragEvent) => {
        if (!carriesCell(event)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const where = side(event);
        setOver(null);
        const dragged = event.dataTransfer.getData(CELL_MIME);
        const from = indexOf(model.notebook, dragged);
        const to = indexOf(model.notebook, cellId);
        if (from < 0 || to < 0 || dragged === cellId) {
          return;
        }
        // The index after the dragged cell leaves its place.
        let index = where === 'before' ? to : to + 1;
        if (from < index) {
          index -= 1;
        }
        model.moveCellTo(dragged, index);
      }
    }
  };
}

/**
 * The cells of the view: each draws again only when its cell's object or
 * the model's `revision` changes, so that a key typed in one cell draws one
 * cell.
 */
const CodeCell = React.memo(LinearCode);
const TextCell = React.memo(LinearText);
// A place between two cells draws again only when its place changes.
const Insert = React.memo(InsertBar);

export function LinearView(props: {
  model: EpiModel;
  editorServices: IEditorServices | null;
  /** Opens a module at a line, from the code of files under a cell. */
  openFile?: (path: string, line: number | null) => void;
}): JSX.Element {
  const { model, editorServices } = props;
  useModel(model);
  const host = React.useRef<HTMLDivElement>(null);
  const width = useWidth(host, 760);
  // While the file loads its cells are not known, and a cell added now
  // would go into the model that the file's content replaces.
  if (model.isLoading()) {
    return (
      <div className="jp-Epi-linear" ref={host}>
        <LoadingCells />
      </div>
    );
  }
  const cells = model.cells();
  // Read after the cells, whose changes can count in it too.
  const revision = model.revision;
  // The strips of answers whose cell was deleted, where the cell was.
  const gone = model.goneStrips(true);
  return (
    <div className="jp-Epi-linear" ref={host}>
      <GoneStrips model={model} strips={gone.get(null)} />
      {cells.map(cell => (
        <React.Fragment key={cell.id}>
          {/* Between two cells, but not between a cell and its branches. */}
          {cell.index > 0 && !cell.branchOf && (
            <Insert model={model} index={cell.index} />
          )}
          {cell.type === 'code' ? (
            <CodeCell
              model={model}
              cell={cell}
              editorServices={editorServices}
              width={Math.max(240, width - 110)}
              openFile={props.openFile}
              revision={revision}
            />
          ) : (
            <TextCell
              model={model}
              cell={cell}
              editorServices={editorServices}
              revision={revision}
            />
          )}
          <GoneStrips model={model} strips={gone.get(cell.id)} />
        </React.Fragment>
      ))}
      {/* A question asked at the end, as from the kernel's menu, until the
          run adds its first cell here: as on the bench (1.73). */}
      {[...model.strips.values()]
        .filter(strip => strip.cellId.startsWith('end:'))
        .map(strip => (
          <ResultStrip key={strip.cellId} model={model} strip={strip} />
        ))}
      <Insert model={model} index={cells.length} last />
    </div>
  );
}

/**
 * A place for a new cell, between two cells or after the last: on hover,
 * or with the keyboard focus, it offers a code cell or a text there.
 */
function InsertBar(props: {
  model: EpiModel;
  index: number;
  last?: boolean;
}): JSX.Element {
  const { model, index } = props;
  const where = props.last ? 'at the end' : 'here';
  return (
    <div className={`jp-Epi-insert${props.last ? ' jp-mod-last' : ''}`}>
      <button
        className="jp-Epi-insert-button"
        title={`Add a code cell ${where}`}
        onClick={event => {
          // The keys go to the new cell: a space must not press this again.
          event.currentTarget.blur();
          model.insertCellAt(index, 'code');
        }}
      >
        <addIcon.react tag="span" />
        Code
      </button>
      <button
        className="jp-Epi-insert-button"
        title={`Add a text cell ${where}`}
        onClick={event => {
          // The keys go to the new cell: a space must not press this again.
          event.currentTarget.blur();
          model.insertCellAt(index, 'markdown');
        }}
      >
        <addIcon.react tag="span" />
        Text
      </button>
    </div>
  );
}

/** A markdown or raw cell in the Code view, which moves by its empty prompt. */
function LinearText(props: {
  model: EpiModel;
  cell: IEpiCell;
  editorServices: IEditorServices | null;
  /** The model's `revision` when the view drew. */
  revision: number;
}): JSX.Element {
  const { model, cell, editorServices } = props;
  const reorder = useReorder(model, cell.id);
  // A text just added here opens in its editor, with the cursor in it.
  const editing = React.useRef(model.focusRequested(cell.id)).current;
  React.useEffect(() => {
    if (editing) {
      model.focusTaken(cell.id);
    }
  }, []);
  return (
    <div
      className={`jp-Epi-linear-cell jp-mod-${cell.type}${reorder.className}`}
      // A text just added is drawn at once, so that its editor takes the cursor.
      style={editing ? { contentVisibility: 'visible' } : undefined}
      {...reorder.target}
    >
      <div className="jp-Epi-linear-prompt" {...reorder.handle} />
      {cell.type === 'markdown' ? (
        <NoteCard
          model={model}
          cell={cell}
          editorServices={editorServices}
          variant="linear"
          editing={editing}
        />
      ) : (
        <pre className="jp-Epi-linear-raw">
          {cell.model.sharedModel.getSource()}
        </pre>
      )}
    </div>
  );
}

function LinearCode(props: {
  model: EpiModel;
  cell: IEpiCell;
  editorServices: IEditorServices | null;
  width: number;
  openFile?: (path: string, line: number | null) => void;
  /** The model's `revision` when the view drew. */
  revision: number;
}): JSX.Element {
  const { model, cell, editorServices, width } = props;
  // A cell just added here takes the cursor when its editor opens.
  const focus = React.useRef(model.focusRequested(cell.id)).current;
  React.useEffect(() => {
    if (focus) {
      model.focusTaken(cell.id);
    }
  }, []);
  const drop = useCellDrop(model, cell);
  const reorder = useReorder(model, cell.id);
  const job = model.jobs.jobFor(cell.id);
  const running = job?.status === 'running' || job?.status === 'queued';
  const strip = model.strips.get(cell.id);
  // A progress report shows as the bar under the code, not as an output.
  const outputs = outputsOf(cell.model)
    .map((output, index) => ({ output, index }))
    .filter(({ output }) => outputKind(output) !== 'progress');
  const region =
    model.ask?.kind === 'region' && model.ask.cellId === cell.id
      ? { x0: model.ask.x0, x1: model.ask.x1, y: model.ask.y }
      : null;
  const selectDecision = (decision: IDecision) => {
    if (model.variable(decision.name)) {
      model.select(decision.name);
    }
  };
  return (
    <div
      ref={drop.target}
      className={`jp-Epi-linear-cell jp-mod-code${cell.branchOf ? ' jp-mod-branch' : ''}${model.armed ? ' jp-mod-target' : ''}${drop.over ? ' jp-mod-over' : ''}${reorder.className}`}
      // A cell just added is drawn at once, so that its editor takes the cursor.
      style={focus ? { contentVisibility: 'visible' } : undefined}
      data-cell-id={cell.id}
      data-question-type={cell.meta.question?.type}
      onMouseDown={() => model.setCurrentCell(cell.id)}
      {...drop.handlers}
      {...reorder.target}
    >
      <div className="jp-Epi-linear-head">
        <CellTitle model={model} cell={cell} />
        {cell.meta.question && (
          <TypeBadge
            type={cell.meta.question.type}
            light={type => model.lightType(type)}
          />
        )}
        {cell.meta.guess && <GuessChip guess={cell.meta.guess.value} />}
        {cell.branchOf && (
          <span className="jp-Epi-subshell" title={PARALLEL_HELP}>
            branch of {model.cell(cell.branchOf)?.label ?? '?'}
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
      {/* The label is the prompt: the run's count, and a branch's letter. */}
      <div className="jp-Epi-linear-prompt" {...reorder.handle}>
        {cell.label}:
      </div>
      <div className="jp-Epi-code">
        <CellEditor
          model={model}
          cell={cell}
          editorServices={editorServices}
          onItemDrag={drop.onItemDrag}
          focus={focus}
        />
        <FilesFold
          attachments={cell.analysis?.attachments ?? []}
          openFile={props.openFile}
        />
      </div>
      {cell.meta.summary && (
        <div className="jp-Epi-summary">
          {cell.meta.written_by === 'agent' ? (
            <>
              <span className="jp-Epi-ai">{cell.meta.summary}</span>
              <AITag by={cellWrittenBy(cell.meta.generated_by)} />
            </>
          ) : (
            cell.meta.summary
          )}
        </div>
      )}
      {job &&
        job.status !== 'done' &&
        job.status !== 'error' &&
        !job.outputBar && (
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
      {outputs.length > 0 &&
        (model.detail === 'full' ? (
          <div className="jp-Epi-linear-outputs">
            {outputs.map(({ output, index }) => {
              const full = (
                <FullOutput
                  output={output}
                  rendermime={model.rendermime}
                  width={Math.min(width, 720)}
                  selection={region}
                  onSelect={(plot, x0, x1, anchor, y) =>
                    void model.askRegion(cell.id, plot, x0, x1, anchor, y)
                  }
                  pick={imagePickOf(model, cell.id)}
                  onAskImage={(pick, anchor) =>
                    askImage(model, cell.id, pick, anchor)
                  }
                />
              );
              // A table of a data frame asks from its headers and row labels.
              return (
                <OutputBoundary key={index} output={output}>
                  {outputKind(output) === 'table' ? (
                    <TableQuestions
                      model={model}
                      cellId={cell.id}
                      index={index}
                      output={output}
                    >
                      {full}
                    </TableQuestions>
                  ) : (
                    full
                  )}
                </OutputBoundary>
              );
            })}
          </div>
        ) : (
          // Below full, the outputs are those of the bench: tiles and thumbnails.
          <div className="jp-Epi-linear-outputs jp-mod-detail">
            <Outputs model={model} cell={cell} />
          </div>
        ))}
      <PickZone model={model} cell={cell} />
      {strip && <ResultStrip model={model} strip={strip} />}
      <ParallelStrip model={model} cell={cell} />
    </div>
  );
}

/**
 * The code of files that a cell depends on, folded under its editor in the
 * Code view and read only: the lines of each module function it calls, with
 * the ones that use a decision, such as MIN_DAYS in prep.py, marked. The
 * bench shows the same lines under "Show code".
 */
function FilesFold(props: {
  attachments: IAttachment[];
  openFile?: (path: string, line: number | null) => void;
}): JSX.Element | null {
  const { attachments } = props;
  const [open, setOpen] = React.useState(false);
  if (!attachments.length) {
    return null;
  }
  const files = [...new Set(attachments.map(attachment => attachment.file))];
  const lines = attachments.reduce(
    (total, attachment) =>
      total + attachment.lines.filter(([number]) => number !== null).length,
    0
  );
  return (
    <div className={`jp-Epi-filesfold${open ? ' jp-mod-open' : ''}`}>
      <button
        className="jp-Epi-filesfold-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="jp-Epi-filesfold-caret" aria-hidden="true" />
        Code from {files.join(', ')}:{' '}
        {attachments.map(attachment => `${attachment.symbol}()`).join(', ')},{' '}
        {lines} {lines === 1 ? 'line' : 'lines'}, read only
      </button>
      {open &&
        attachments.map(attachment => (
          <Attachment
            key={attachment.file + attachment.symbol}
            attachment={attachment}
            openFile={props.openFile ?? (() => undefined)}
          />
        ))}
    </div>
  );
}
