import type { IEditorServices } from '@jupyterlab/codeeditor';
import { Button } from '@jupyterlab/ui-components';
import * as React from 'react';

import { countOpenAssumptions } from '../model/assumptions';
import { readsFile } from '../model/decisions';
import type { EpiModel } from '../model/epimodel';
import type { ExploredOrder } from '../model/exploredorder';
import { exploredOrder, orderExplored } from '../model/exploredorder';
import { extremesOf } from '../model/leaveout';
import { notebookMeta } from '../model/notebook';
import { needsAI, runnableFirst } from '../model/questionorder';
import type { QuestionType } from '../tokens';
import { QUESTION_TYPES } from '../tokens';
import {
  AIOffNote,
  CloseButton,
  LabelledText,
  OptionRows,
  OrderNote,
  OwnQuestion,
  ProgressBar,
  Relevance,
  TypeBadge,
  aiOffReason,
  pointerOn,
  stageText,
  useModel,
  useSeconds,
  useWidth
} from './common';
import { AgentRunView } from './agent';
import { CapNote, CostBlock } from './cost';
import { ExplorationCounts } from './counts';
import { CellDetails } from './details';
import { viewExtensions } from './extensions';
import { InferredChips } from './inferred';
import { LeaveOutRows } from './leaveout';
import { isMenuKey, openContextMenu } from './menukeys';
import { PlainOutputs } from './outputs';

export interface ICoverage {
  label: string;
  used: number;
  total: number;
  /** A column the analyst reached on their own, or only through offered questions. */
  squares: ('own' | 'offered' | null)[];
  note: string;
  /** The frame's name; null in the row of the derived variables. */
  name: string | null;
  /** How many code cells use the frame: those whose code reads its name. */
  cells: number;
  /** The frame's rows, when known, and all its columns. */
  shape: { rows: number | null; columns: number } | null;
  /** Rows times columns, which Largest compares. */
  size: number;
  /** A cell read the frame from a file: Auto lists it first. */
  loaded: boolean;
}

/**
 * How much of each source frame the analysis uses, and how many derived
 * variables later cells use, in the order of the setting `exploredOrder`
 * (../model/exploredorder.ts). The frames of an agent's run stay out
 * (../model/runnames.ts), except a table that the run read from a file: it
 * is data that the analysis starts from. In a notebook that a run made,
 * such as its notebook in R, every name is the run's.
 */
export function coverage(
  model: EpiModel,
  order: ExploredOrder = model.settings.exploredOrder
): ICoverage[] {
  const definitions = model.definitions();
  const sections = model.sections().sections;
  const first = sections[0]?.id;
  const used = model.used();
  const own = model.usedOwn();
  const cells = model.codeCells();
  // How many cells read each name.
  const readers = new Map<string, number>();
  for (const cell of cells) {
    for (const name of new Set(cell.analysis?.uses ?? [])) {
      readers.set(name, (readers.get(name) ?? 0) + 1);
    }
  }
  // The names that a cell which reads a file defines, such as nhefs of
  // `nhefs = pd.read_csv("nhefs.csv")`: the cell has the chip nhefs.csv.
  const loaded = new Set<string>();
  for (const cell of cells) {
    if (cell.decisions.some(readsFile)) {
      (cell.analysis?.defs ?? []).forEach(name => loaded.add(name));
    }
  }
  const ofRuns = new Set(model.runNames().flatMap(group => group.names));
  const frames = model
    .variables()
    .filter(
      v =>
        v.kind === 'dataframe' &&
        !v.selection &&
        v.columns &&
        (!ofRuns.has(v.name) || loaded.has(v.name))
    );
  const sources = frames.filter(frame => {
    const home = definitions.get(frame.name);
    return !home || home.sectionId === first;
  });
  const rows: ICoverage[] = [];
  for (const frame of sources) {
    const shape = {
      rows: frame.rows ?? null,
      columns: frame.n_columns ?? frame.columns?.length ?? 0
    };
    const keys = {
      name: frame.name,
      cells: readers.get(frame.name) ?? 0,
      shape,
      size: (shape.rows ?? 1) * shape.columns,
      loaded: loaded.has(frame.name)
    };
    const all = frame.columns ?? [];
    const columns = all.filter(column => column.tag !== 'id');
    const usedHere = used.get(frame.name) ?? new Set<string>();
    // A frame from the last run keeps only its first columns: the total is
    // the frame's, and the used ones are those the cells name.
    const total = Math.max(
      columns.length,
      (frame.n_columns ?? all.length) - (all.length - columns.length)
    );
    const count =
      total > columns.length
        ? usedHere.size
        : columns.filter(column => usedHere.has(column.label)).length;
    if (total <= 64) {
      rows.push({
        label: frame.name,
        used: count,
        total: columns.length,
        squares: columns.map(column =>
          own.get(frame.name)?.has(column.label)
            ? 'own'
            : usedHere.has(column.label)
              ? 'offered'
              : null
        ),
        note: 'One square per column',
        ...keys
      });
    } else {
      const per = Math.ceil(total / 16);
      const filled = count ? Math.max(1, Math.ceil(count / per)) : 0;
      rows.push({
        label: frame.groups
          ? `${frame.name} (${frame.groups.length} ${frame.grouped_by ?? 'group'}s)`
          : frame.name,
        used: count,
        total,
        squares: Array.from({ length: 16 }, (_, index) =>
          index < filled ? 'own' : null
        ),
        note: `One square ≈ ${per.toLocaleString()} columns, used ones first`,
        ...keys
      });
    }
  }
  const later = model
    .mainVariables()
    .filter(
      v =>
        (v.kind === 'dataframe' || v.kind === 'model') &&
        definitions.has(v.name) &&
        !sources.includes(v)
    );
  if (later.length) {
    const usedLater = later.map(variable => {
      const home = definitions.get(variable.name)!;
      return cells.some(
        cell =>
          cell.index > home.index && cell.analysis?.uses.includes(variable.name)
      );
    });
    rows.push({
      label: 'Derived',
      used: usedLater.filter(Boolean).length,
      total: later.length,
      squares: usedLater.map(on => (on ? 'own' : null)),
      note: 'Made in this notebook, and used by a later cell',
      name: null,
      cells: 0,
      shape: null,
      size: 0,
      loaded: false
    });
  }
  return orderExplored(rows, order);
}

/** Up to this many rows, Variables explored shows them all; past it, they scroll. */
export const EXPLORED_SHOWN = 5;

/** What the row of a frame counts, for the tooltip of its name. */
function keysText(row: ICoverage): string | undefined {
  if (!row.shape) {
    return undefined;
  }
  const users =
    row.cells === 0
      ? 'No cell uses it.'
      : `Used by ${row.cells} cell${row.cells === 1 ? '' : 's'}.`;
  const { rows, columns } = row.shape;
  const size =
    rows === null
      ? `${columns.toLocaleString()} columns.`
      : `${rows.toLocaleString()} rows × ${columns.toLocaleString()} columns.`;
  return `${users} ${size}`;
}

/**
 * The block "Variables explored": a row for each frame that the analysis
 * starts from, and one for the variables it derives, in the order of a
 * setting. A right click on the head, or the Menu key or Shift+F10 on it,
 * opens the menu of orders (../contextmenu.ts). Past a few rows the list
 * scrolls, and the head stays in sight with its count (design iteration
 * 1.82).
 */
export function ExploredBlock(props: {
  model: EpiModel;
  rows: ICoverage[];
  /** What the block says while it has no rows. */
  empty: string;
}): JSX.Element {
  const { model, rows } = props;
  const order = exploredOrder(model.settings.exploredOrder);
  const scrolls = rows.length > EXPLORED_SHOWN;
  // Another order shows its first rows.
  const list = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (list.current) {
      list.current.scrollTop = 0;
    }
  }, [order.id]);
  const caption =
    order.caption.charAt(0).toLowerCase() + order.caption.slice(1);
  return (
    <div className="jp-Epi-block jp-Epi-explored">
      <div
        className="jp-Epi-block-head jp-Epi-explored-head"
        tabIndex={0}
        title={`Order: ${order.title}, ${caption}. Right-click to change it, or press Shift+F10.`}
        onKeyDown={event => {
          if (isMenuKey(event)) {
            event.preventDefault();
            event.stopPropagation();
            openContextMenu(event.currentTarget);
          }
        }}
      >
        <span>Variables explored</span>
        {rows.length > 0 && (
          <span className="jp-Epi-section-count">{rows.length}</span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="jp-Epi-caption">{props.empty}</div>
      ) : (
        <div
          ref={list}
          className={`jp-Epi-explored-list${scrolls ? ' jp-mod-scroll' : ''}`}
          role="list"
          aria-label={`Variables explored. Order: ${order.title}`}
          // A list that scrolls takes the focus, for the keys that scroll it.
          tabIndex={scrolls ? 0 : undefined}
        >
          {rows.map(row => (
            <div
              key={row.name ?? ':derived'}
              className="jp-Epi-coverage"
              role="listitem"
            >
              <div className="jp-Epi-coverage-head">
                <span title={keysText(row)}>{row.label}</span>
                <span className="jp-Epi-mono">
                  {row.used.toLocaleString()} / {row.total.toLocaleString()}
                </span>
              </div>
              <div className="jp-Epi-squares">
                {row.squares.map((state, index) => (
                  <span
                    key={index}
                    className={
                      state === 'own'
                        ? 'jp-mod-used'
                        : state === 'offered'
                          ? 'jp-mod-used jp-mod-offered'
                          : ''
                    }
                    title={
                      state === 'offered'
                        ? 'Reached only through offered questions'
                        : undefined
                    }
                  />
                ))}
              </div>
              <div className="jp-Epi-caption">{row.note}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The open assumptions of the notebook (../model/assumptions.ts): the values
 * that its cells leave to the defaults of the analyst's or an agent's code,
 * and the library defaults of a read whose frame looks wrong. The count
 * leaves out the other library defaults, whose chips show them.
 */
export function openAssumptions(model: EpiModel): number {
  return countOpenAssumptions(model.codeCells(), model.variables());
}

/** Whether the view knows an outcome of the analysis: set by hand, or inferred (../model/inferred.ts). */
function outcomeKnown(model: EpiModel): boolean {
  const lists = model.inferred();
  return !!lists.hand.outcome || lists.outcomes.length > 0;
}

export function ExplorationPanel(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  // A question counts once its cell ran; a failed one stays out.
  const { asked, failed } = model.askedCounts();
  const off = aiOffReason(model);
  const counts = Object.fromEntries(
    QUESTION_TYPES.map(type => [type.id, 0])
  ) as Record<QuestionType, number>;
  // Questions the analyst typed, apart from those they picked.
  const typed = { ...counts };
  for (const question of asked) {
    if (question.type in counts) {
      counts[question.type]++;
      if (question.id.startsWith('own:')) {
        typed[question.type]++;
      }
    }
  }
  const max = Math.max(1, ...Object.values(counts));
  const causalShare = asked.length ? counts.causal / asked.length : 0;
  // The line on causal questions waits for the first one: a notebook made
  // to check one estimate, or to describe the data, asks none.
  const spread =
    asked.length === 0
      ? 'No questions yet.'
      : counts.causal === 0
        ? null
        : causalShare < 0.15
          ? 'Few causal questions so far: the effect estimate rests on untested paths.'
          : 'Good spread across question types.';
  const meta = notebookMeta(model.notebook);
  const branches = model.codeCells().filter(cell => cell.branchOf).length;
  // A kernel of another language: no columns read, and no questions offered.
  const noAnalysis = model.unsupported('analysis');
  const noQuestions = model.unsupported('questions');
  const rows = noAnalysis ? [] : coverage(model);
  // While no AI model answers, the suggestions that run come first.
  const steps = runnableFirst(model.nextSteps, !!model.aiOff()).slice(0, 3);
  return (
    <div className="jp-Epi-exploration">
      <div className="jp-Epi-block">
        <div className="jp-Epi-block-head">
          <span>Questions asked</span>
          <span className="jp-Epi-big">{asked.length}</span>
        </div>
        {QUESTION_TYPES.map(type => (
          <div
            key={type.id}
            className="jp-Epi-typebar"
            onMouseEnter={() => model.lightType(type.id)}
            onMouseLeave={() => model.lightType(null)}
          >
            <span className="jp-Epi-typebar-label">
              <TypeBadge type={type.id} />
            </span>
            <span className="jp-Epi-typebar-track">
              <span
                className={`jp-mod-${type.id}`}
                style={{
                  width: `${Math.round((100 * typed[type.id]) / max)}%`
                }}
              />
              <span
                className={`jp-mod-${type.id} jp-mod-picked`}
                style={{
                  width: `${Math.round((100 * (counts[type.id] - typed[type.id])) / max)}%`
                }}
              />
            </span>
            <span
              className="jp-Epi-typebar-count"
              title={`${typed[type.id]} typed, ${counts[type.id] - typed[type.id]} picked`}
            >
              {counts[type.id]}
            </span>
          </div>
        ))}
        {asked.some(question => question.id.startsWith('own:')) && (
          <div className="jp-Epi-caption jp-Epi-shades">
            Darker: questions you typed. Lighter: questions you picked.
          </div>
        )}
        {spread && <div className="jp-Epi-caption">{spread}</div>}
        {failed.length > 0 && (
          <div
            className="jp-Epi-caption jp-Epi-failedcount"
            title={failed
              .map(question => model.questionText(question))
              .join('\n')}
          >
            Not counted: {failed.length} question
            {failed.length === 1 ? ' that' : 's that'} failed.
          </div>
        )}
      </div>
      <ExploredBlock
        model={model}
        rows={rows}
        empty={
          noAnalysis ??
          'Run the notebook to see which columns the analysis uses.'
        }
      />
      <ExplorationCounts
        branches={branches}
        assumptions={openAssumptions(model)}
        guesses={model.settings.guessFirst ? model.guessCount() : null}
      />
      {model.settings.showCost && <CostBlock model={model} />}
      <div className="jp-Epi-block" {...pointerOn(model, model.next)}>
        <div className="jp-Epi-block-head">
          <span>Worth asking next</span>
          <span className="jp-Epi-section-count">suggested</span>
        </div>
        {noQuestions ? (
          <div className="jp-Epi-caption jp-Epi-unsupported">{noQuestions}</div>
        ) : (
          <>
            <AIOffNote model={model} />
            <OwnQuestion
              model={model}
              onAsk={text => void model.askOwn(text, 'notebook')}
            />
          </>
        )}
        {!noQuestions && steps.length > 0 && <OrderNote list={model.next} />}
        {!noQuestions && steps.length === 0 && (
          <div className="jp-Epi-caption">
            {model.nextFetched && model.liveCount() > 0
              ? // The kernel has data: the server found no gap to ask about.
                outcomeKnown(model)
                ? // The words that design iteration 1.59 proposes for these cases.
                  meta.exploration?.dismissed?.length
                  ? 'No suggestions left: the others were put off with Not now.'
                  : 'Every column is in the analysis, and no cell leaves a choice open.'
                : 'No suggestions yet: no cell leaves a choice open, and Whybook does not know which column this analysis explains.'
              : 'Suggestions appear once the kernel has data.'}
          </div>
        )}
        {!noQuestions && <InferredChips model={model} options={steps} />}
        <OptionRows model={model} options={steps}>
          {step => {
            // A question without code needs AI: marked as in the popover, and
            // greyed without a model.
            const needs = needsAI(step);
            return (
              <div className="jp-Epi-next">
                <div className="jp-Epi-next-text">
                  <LabelledText model={model} text={step.text} />
                </div>
                <div className="jp-Epi-next-meta">
                  <TypeBadge type={step.type} />
                  <Relevance value={step.probability} reasons={step.reasons} />
                </div>
                <div className="jp-Epi-next-foot">
                  <span className="jp-Epi-next-why">
                    {step.reasons[0]}
                    {needs && <span className="jp-Epi-needs"> · needs AI</span>}
                  </span>
                  <Button
                    small
                    className="jp-Epi-button jp-mod-styled jp-mod-accept"
                    disabled={needs && !!off}
                    title={
                      needs && off ? `Needs an AI model: ${off}` : undefined
                    }
                    onClick={() => void model.apply(step)}
                  >
                    Ask
                  </Button>
                  <button
                    className="jp-Epi-link"
                    onClick={() => model.dismissNext(step.text)}
                  >
                    Not now
                  </button>
                </div>
              </div>
            );
          }}
        </OptionRows>
      </div>
      {[...viewExtensions.exploration].map(([id, render]) => (
        <React.Fragment key={id}>{render(model)}</React.Fragment>
      ))}
    </div>
  );
}

export function RightPanel(props: {
  model: EpiModel;
  width: number;
  /** For the code in Cell details, in an editor that cannot change it. */
  editorServices?: IEditorServices | null;
}): JSX.Element {
  const { model, width } = props;
  useModel(model);
  // An answer in the sidebar, as a quick look, opens under the tabs, where
  // it is seen, at the height of its content (design iteration 1.77). The
  // newest agent's run, when runs show in the sidebar, takes the lower half.
  const answer = model.preview;
  const run =
    model.settings.agentView === 'sidebar'
      ? (model.agentRuns[model.agentRuns.length - 1] ?? null)
      : null;
  return (
    <div className={`jp-Epi-right${!answer && run ? ' jp-mod-split' : ''}`}>
      <div className="jp-Epi-right-main">
        <RightTabs
          model={model}
          width={width}
          editorServices={props.editorServices ?? null}
          preview={
            answer ? (
              <div className="jp-Epi-right-preview">
                <PreviewPane model={model} width={width} />
              </div>
            ) : null
          }
        />
      </div>
      {!answer && run && (
        <div className="jp-Epi-right-answer">
          <AgentRunView model={model} run={run} place="sidebar" />
        </div>
      )}
    </div>
  );
}

function RightTabs(props: {
  model: EpiModel;
  width: number;
  editorServices: IEditorServices | null;
  /** An answer in the sidebar, under the tabs and above what they show. */
  preview: JSX.Element | null;
}): JSX.Element {
  const { model, width } = props;
  return (
    <>
      <div className="jp-Epi-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={model.rightTab === 'explore'}
          className={model.rightTab === 'explore' ? 'jp-mod-active' : ''}
          onClick={() => model.setRightTab('explore')}
        >
          Exploration
        </button>
        <button
          role="tab"
          aria-selected={model.rightTab === 'details'}
          className={model.rightTab === 'details' ? 'jp-mod-active' : ''}
          onClick={() => model.setRightTab('details')}
        >
          Cell details
        </button>
      </div>
      {props.preview}
      {model.rightTab === 'explore' ? (
        <ExplorationPanel model={model} />
      ) : (
        <CellDetails
          model={model}
          width={width}
          editorServices={props.editorServices}
        />
      )}
    </>
  );
}

/**
 * The answer to a question asked for the sidebar: what the model is doing
 * while it writes the code, then the output, which the notebook keeps only
 * if the analyst asks.
 */
function PreviewPane(props: {
  model: EpiModel;
  width: number;
}): JSX.Element | null {
  const { model, width } = props;
  const preview = model.preview;
  const busy = preview?.status === 'writing' || preview?.status === 'running';
  const seconds = useSeconds(preview?.started, busy);
  // The room the preview has, measured: the panel's width less the paddings
  // and the borders, so that a plot fits with no horizontal scroll bar
  // (design iteration 1.77).
  const box = React.useRef<HTMLDivElement>(null);
  const room = useWidth(box, Math.max(160, width - 40));
  // A new preview comes into sight, under the tabs.
  const started = preview?.started;
  React.useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'nearest' });
  }, [started]);
  if (!preview) {
    return null;
  }
  // The values at the ends of a number's quick look, which the analyst can leave out.
  const extremes =
    preview.status === 'done' ? extremesOf(preview.outputs) : null;
  return (
    <div className="jp-Epi-preview" ref={box}>
      <div className="jp-Epi-preview-head">
        <span className="jp-Epi-preview-title">{preview.title}</span>
        <CloseButton
          label="Close the answer"
          onClick={() => model.closePreview()}
        />
      </div>
      {busy && (
        <div className="jp-Epi-preview-status" aria-live="polite">
          <ProgressBar
            value={null}
            label={
              preview.status === 'writing'
                ? 'AI is writing the code of the answer'
                : 'Running the code of the answer'
            }
            wide
          />
          <span className="jp-Epi-preview-stage">
            {preview.status === 'writing'
              ? stageText(preview.stage, seconds)
              : `Running the code${seconds !== null ? ` · ${seconds} s` : ''}`}
          </span>
          {preview.status === 'writing' && preview.thinking && (
            <span className="jp-Epi-thinking">{preview.thinking}</span>
          )}
        </div>
      )}
      {preview.status === 'held' && (
        <CapNote model={model} onGoOn={() => void model.goOnPreview()} />
      )}
      {preview.error && <div className="jp-Epi-error">{preview.error}</div>}
      <PlainOutputs
        outputs={preview.outputs}
        rendermime={model.rendermime}
        width={room}
      />
      {preview.status === 'done' && (
        <div className="jp-Epi-preview-actions">
          <span>Nothing is written to the notebook unless you keep it.</span>
          <Button
            small
            className="jp-Epi-button jp-mod-styled jp-mod-accept"
            onClick={() => void model.keepPreview()}
          >
            Keep as a cell
          </Button>
          {extremes && <LeaveOutRows model={model} extremes={extremes} />}
        </div>
      )}
    </div>
  );
}
