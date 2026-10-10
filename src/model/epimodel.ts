import type { ISessionContext } from '@jupyterlab/apputils';
import { Notification } from '@jupyterlab/apputils';
import type { ICellModel, ICodeCellModel } from '@jupyterlab/cells';
import { PathExt, URLExt } from '@jupyterlab/coreutils';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type * as nbformat from '@jupyterlab/nbformat';
import type { INotebookModel } from '@jupyterlab/notebook';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { Contents } from '@jupyterlab/services';
import { ContentsManager, ServerConnection } from '@jupyterlab/services';
import type { PartialJSONObject } from '@lumino/coreutils';
import { UUID } from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';
import { Debouncer } from '@lumino/polling';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

import type {
  AskedOutcome,
  Detail,
  Guess,
  IAnchor,
  IAgentRunRecord,
  IAskedQuestion,
  ICellAnalysis,
  ICostRecord,
  IColumn,
  IDecision,
  IDropResult,
  IEpiCellMeta,
  IEpiNotebookMeta,
  IErrorEvent,
  IItem,
  Interaction,
  IOption,
  IPlacement,
  IPlotAxis,
  IPlotPayload,
  IResultEvent,
  IVariable,
  IWrittenBy,
  MapDetail,
  Mode,
  QuestionType,
  StreamEvent,
  ViewKind
} from '../tokens';
import { QUESTION_TYPES } from '../tokens';
import type {
  IModelCall,
  IServerStatus,
  ISortedQuestion,
  JsonCheck
} from './api';
import { Api } from './api';
import type { ICustomLocalModel } from './custommodels';
import type { ExploredOrder } from './exploredorder';
import type { ModelChoices, Task } from './models';
import {
  aiReady,
  choiceOf,
  DEFAULT_MODELS,
  isRemote,
  modelAvailable,
  modelName,
  otherProviderReason,
  withDataPolicy
} from './models';
import { barFilter, barTest, barsText, identifier } from './bars';
import type {
  IDecisionValues,
  IModelValues,
  ModelQuestions
} from './rulesfirst';
import {
  asksModel,
  markModelValues,
  noModelNote,
  noTemplateFits,
  requestKey
} from './rulesfirst';
import type { IInferredLists, InferredKind } from './inferred';
import {
  contextOf,
  formulaOutcome,
  inferredLists,
  withModel,
  withPick
} from './inferred';
import type { INumbersInText, ISourceText } from './claims';
import { checkNumbers, htmlText } from './claims';
import type { IRunResult } from './jobs';
import { JobManager } from './jobs';
import { KernelBridge } from './kernel';
import type { Feature } from './languages';
import { languageOf, unsupported as unsupportedIn } from './languages';
import { outputText, rawText, stoppedBeforeConverging } from './logs';
import { guessPlace, keywordType, ownOption, wordPlace } from './own';
import { namesIn } from './names';
import type { INewCell, IPlacedCell } from './placement';
import { placeAfter } from './placement';
import { codeKey, editedByHand, viewCodeToKeep } from './handedit';
import type { IRunGroup } from './runnames';
import { runNames } from './runnames';
import type { IStoredVariable } from './restore';
import {
  analysisFor,
  keptWithout,
  listing,
  storedAnalysis,
  toStore
} from './restore';
import { CellTitles, importsTitle, titleNote } from './celltitles';
import { SignIns } from './connection';
import { FrameNotes } from './framenotes';
import type { ISignature } from './founddefaults';
import { FoundDefaults, foundDecisions, withFound } from './founddefaults';
import type {
  AgentView,
  IAgentEvent,
  IAgentOutput,
  IAgentRun,
  IAgentStep,
  IAgentToolEvent,
  IFrameFile,
  IRunNotebook
} from './agent';
import {
  agentFilePath,
  agentOutputs,
  answerHolders,
  cellByLabel,
  cellError,
  cellOutputText,
  FILE_CHARS,
  markedFile,
  runCap,
  stepType
} from './agent';
import type {
  IComparedCell,
  ICrossQuestion,
  IKernelChoice,
  IKernelSpecLike,
  IRawComparison
} from './crosskernel';
import {
  buildComparison,
  comparisonMarkdown,
  crossQuestions,
  framesFolder,
  introText,
  kernelChoices,
  kernelFacts,
  newNotebookPath,
  notebookTitle,
  promptKernels
} from './crosskernel';
import type { ICallCost, ICellPart, INotebookCost, Segment } from './cost';
import {
  ROUTE_KINDS,
  capReached,
  cellParts,
  cellRecord,
  cellWriter,
  leftUnder,
  raisedCap,
  recordTotal,
  seedRecord,
  withCall
} from './cost';
import { type IImageAsk, imageRequest } from './imageask';
import type { IOrdered, IQuestionOrder } from './questionorder';
import { needsAI, orderByScores } from './questionorder';
import { importsName } from './datalinks';
import type {
  GuardAnswer,
  GuardMode,
  IGuardColumn,
  IGuardMemory,
  IGuardEvent,
  IGuardFlag,
  IGuardHeld,
  IGuardSettings
} from './guard';
import { DEFAULT_GUARD, guardBody, guardColumn, heldWords } from './guard';
import {
  axisValueText,
  axisValues,
  boundCode,
  columnCode,
  rangeEnds,
  rangeText
} from './numbers';
import { PlotHooks } from './plothooks';
import { SpaceDetail } from './spacedetail';
import { pyComment, pyString } from './pycode';
import type { ICuts, IExtremes } from './leaveout';
import { cleanName, leaveOutCode } from './leaveout';
import { groupOf, rowsQuestions } from './regionrows';
import {
  IDLE_AFTER_MS,
  IN_USE_DELAY_MS,
  RefreshPolicy,
  SPINNER_DELAY_MS
} from './refresh';
import type { ITableAsk } from './tableask';
import { TableNotes } from './tablenotes';
import { writtenBy } from './writtenby';
import { countAsked } from './asked';
import {
  attributed,
  callsOf,
  chosenValue,
  decisionKey,
  withoutDrawing
} from './decisions';
import { agentFindings, notAsked } from './modelquestions';
import {
  cellMeta,
  cellsOf,
  deleteCell,
  editMeta,
  findCell,
  firstLine,
  indexOf,
  insertCodeCell,
  lineDiff,
  noteBody,
  notebookMeta,
  outputKind,
  outputsOf,
  setCellMeta,
  setNotebookMeta
} from './notebook';
import { labelRefs, relabel } from './labels';
import type { IHistoryRow } from './runs';
import { AgentRuns, historyOf, historyRows, keptCells, pastRun } from './runs';

export type Placement = 'sidebar' | 'document';

export type MapColumns = 'contents' | 'popover';

/** The widget ids of the sections of the side panel. */
export const SECTIONS = {
  variables: 'epi-variables-section',
  contents: 'epi-contents-section',
  questions: 'epi-questions-section'
};

/** The editor options of code and markdown cells, as the notebook sets them. */
export interface ICellEditors {
  code: Record<string, unknown>;
  markdown: Record<string, unknown>;
}

/**
 * Settings shared by every open notebook view.
 */
export class EpiSettings {
  interaction: Interaction = 'drag';
  variablesPlacement: Placement = 'sidebar';
  explorationPlacement: Placement = 'sidebar';
  capacity = 8;
  /** Where the columns of a data node clicked in the map show. */
  mapColumns: MapColumns = 'contents';
  /** The level of detail of outputs on the bench. */
  detail: Detail = 'full';
  /** How much of each cell's outputs the map shows. */
  mapDetail: MapDetail = 'minimal';
  /**
   * A trial: the width of the view sets the level of detail of the bench and
   * the Code view, and the zoom sets the map's (src/model/spacedetail.ts).
   */
  detailFollowsSpace = false;
  /**
   * The minimap in the bench's bottom right corner, which opens the map
   * view. Off, the bench keeps no column at its right for it.
   */
  minimap = false;
  /** Offer a guess of the result while a cell runs. */
  guessFirst = true;
  /** How many offered questions a request shows; 0 shows none. */
  offeredQuestions = 12;
  /**
   * When the strip of a finished answer closes, with its Undo: after the
   * analyst asks about or runs another cell, or only with its close button.
   */
  stripsClose: 'elsewhere' | 'manual' = 'elsewhere';
  /** The model of each task that asks one: 'off', 'remote' or a local model. */
  models: ModelChoices = { ...DEFAULT_MODELS };
  /** How a local model's answer is held to its JSON rules. */
  jsonCheck: JsonCheck = 'fast';
  /** Only models on this machine read outputs and variables, unless the server decides. */
  keepDataLocal = false;
  /**
   * Requests through OpenRouter go only to providers that keep no data,
   * unless the analyst turns it off; the server can pin it on.
   */
  zeroDataRetention = true;
  /** The local models that the settings add to the server's five: customLocalModels. */
  customLocalModels: ICustomLocalModel[] = [];
  /**
   * How a question that needs AI is answered: an agent adds and runs the
   * cells it needs, or the remote model writes one cell.
   */
  answers: 'agent' | 'cell' = 'agent';
  /** Where an agent's run shows, for review: its strip, a card, or the sidebar. */
  agentView: AgentView = 'strip';
  /**
   * The Cost sections of the Exploration panel and of Cell details, and the
   * notebook's cap on what its answers cost. Off, the view shows no cost
   * beyond what "Written by" says, and the cap holds nothing.
   */
  showCost = false;
  /**
   * When a drop or a click asks the model chosen for More questions for
   * questions, next to the templates' questions: always, only when no
   * template fits, or never (./rulesfirst.ts).
   */
  modelQuestions: ModelQuestions = 'always';
  /**
   * The kernel reads the signatures of the library functions that the cells
   * call, and the model chosen for More questions picks the defaults that
   * can change a result, for the cells' chips: on by default
   * (./founddefaults.ts).
   */
  findDefaults = true;
  /**
   * The order of the rows of Variables explored, in the Exploration panel:
   * the most used and the largest first, or by name (./exploredorder.ts).
   */
  exploredOrder: ExploredOrder = 'auto';
  /**
   * The review guard: its mode, which guards run, and the privacy policy
   * (./guard.ts). Its keys in schema/plugin.json are each a setting of its own.
   */
  guard: IGuardSettings = { ...DEFAULT_GUARD };
  /**
   * JupyterLab's editor options for notebook cells, from its notebook
   * settings: the view's editors follow them, line numbers included.
   */
  cellEditors: ICellEditors = {
    code: { lineNumbers: false },
    markdown: { lineNumbers: false }
  };

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /** Asks the plugin to open the Variables panel. */
  get reveal(): ISignal<this, void> {
    return this._reveal;
  }

  requestReveal(): void {
    this._reveal.emit();
  }

  /** Asks the plugin to open the right panel, where answers in the sidebar go. */
  get revealRight(): ISignal<this, void> {
    return this._revealRight;
  }

  requestRevealRight(): void {
    this._revealRight.emit();
  }

  /** Asks the plugin to open the file browser or the Databases panel. */
  get panel(): ISignal<this, 'files' | 'databases'> {
    return this._panel;
  }

  requestPanel(which: 'files' | 'databases'): void {
    this._panel.emit(which);
  }

  /**
   * The sections of the side panel that the user moved to another panel.
   * The view leaves them out when it shows the panels itself.
   */
  get moved(): ReadonlySet<string> {
    return this._moved;
  }

  setMoved(section: string, moved: boolean): void {
    if (moved) {
      this._moved.add(section);
    } else {
      this._moved.delete(section);
    }
    this._changed.emit();
  }

  /**
   * Change a setting from the UI. The plugin saves it in the settings registry.
   */
  set<
    K extends
      | 'interaction'
      | 'variablesPlacement'
      | 'explorationPlacement'
      | 'capacity'
      | 'mapColumns'
      | 'detail'
      | 'mapDetail'
      | 'detailFollowsSpace'
      | 'minimap'
      | 'guessFirst'
      | 'offeredQuestions'
      | 'stripsClose'
      | 'models'
      | 'keepDataLocal'
      | 'zeroDataRetention'
      | 'answers'
      | 'agentView'
      | 'showCost'
      | 'modelQuestions'
      | 'findDefaults'
      | 'exploredOrder'
  >(key: K, value: EpiSettings[K]): void {
    // As EpiSettings: the type of `this` is polymorphic, and takes no EpiSettings[K].
    (this as EpiSettings)[key] = value;
    this._changed.emit();
    this.save?.(key, value);
  }

  /**
   * Change the guard's settings from the UI: each field is saved under its
   * own key of schema/plugin.json.
   */
  setGuard(patch: Partial<IGuardSettings>): void {
    this.guard = { ...this.guard, ...patch };
    this._changed.emit();
    const keys: Record<keyof IGuardSettings, string> = {
      mode: 'reviewGuard',
      privacy: 'guardPrivacy',
      privacyModel: 'guardPrivacyModel',
      execution: 'guardExecution',
      executionModel: 'guardExecutionModel',
      remoteReview: 'guardRemoteReview',
      policy: 'privacyPolicy'
    };
    for (const [field, value] of Object.entries(patch)) {
      this.save?.(keys[field as keyof IGuardSettings], value);
    }
  }

  update(
    values: Partial<
      Pick<
        EpiSettings,
        | 'interaction'
        | 'variablesPlacement'
        | 'explorationPlacement'
        | 'capacity'
        | 'mapColumns'
        | 'detail'
        | 'mapDetail'
        | 'detailFollowsSpace'
        | 'minimap'
        | 'guessFirst'
        | 'offeredQuestions'
        | 'stripsClose'
        | 'models'
        | 'jsonCheck'
        | 'keepDataLocal'
        | 'zeroDataRetention'
        | 'customLocalModels'
        | 'answers'
        | 'agentView'
        | 'showCost'
        | 'modelQuestions'
        | 'findDefaults'
        | 'exploredOrder'
        | 'cellEditors'
        | 'guard'
      >
    >
  ): void {
    Object.assign(this, values);
    this._changed.emit();
  }

  save: ((key: string, value: unknown) => void) | null = null;

  private _changed = new Signal<this, void>(this);
  private _reveal = new Signal<this, void>(this);
  private _revealRight = new Signal<this, void>(this);
  private _panel = new Signal<this, 'files' | 'databases'>(this);
  private _moved = new Set<string>();
}

/** A data file near the notebook, offered by the empty view. */
export interface INearbyFile {
  path: string;
  name: string;
  /** A SQLite file: its tables are in the Databases panel. */
  database: boolean;
  size: number | null;
}

const DATA_FILE = /\.(csv|tsv|parquet|feather|arrow|xlsx|xls|json|jsonl)$/i;
const DATABASE_FILE = /\.(sqlite|sqlite3|db)$/i;

/**
 * How long the view waits, after Stop, for the server to end a run's stream
 * with what the run cost, before it closes the stream itself.
 */
const STOP_WAIT_MS = 5000;

/** Where the map shows: its offset in the view, in pixels, and its zoom. */
export interface IMapCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface IEpiCell {
  id: string;
  model: ICellModel;
  index: number;
  type: 'code' | 'markdown' | 'raw';
  label: string;
  count: number | null;
  /**
   * Whether the count is from an earlier run: the cell has one, and its code
   * has not run in the current kernel. The view greys such a label, as it
   * greys the variables of the last run.
   */
  lastRun: boolean;
  title: string;
  /**
   * Who wrote the title, when a model wrote it after the analyst edited the
   * code: null when the notebook does not record which model; undefined
   * when no model wrote it.
   */
  titleBy?: IWrittenBy | null;
  meta: IEpiCellMeta;
  analysis: ICellAnalysis | null;
  decisions: IDecision[];
  sectionId: string;
  branchOf: string | null;
  branches: string[];
  heading: { level: number; text: string } | null;
}

export interface ISection {
  id: string;
  title: string;
  number: number;
  cells: IEpiCell[];
}

/**
 * How far a model is with an answer: its stage, the time it started, and
 * the last line of its thinking.
 */
export interface IProgress {
  stage: string | null;
  elapsed: number | null;
  /** Date.now() when the wait started: the view counts the seconds itself. */
  started?: number;
  thinking?: string | null;
}

/** A deleted cell, as Undo puts it back. */
export interface IDeletedCell {
  index: number;
  /**
   * The ids of the cells before and after it: Undo puts it back next to
   * them, wherever other deletes and moves took them since.
   */
  before: string | null;
  after: string | null;
  cell: nbformat.ICell;
  label: string;
  title: string;
  /** The labels of the cells that use names the deleted cell defined. */
  users: string[];
}

export interface IStrip extends IProgress {
  cellId: string;
  /** The question the strip answers, and the analyst's guess of its result. */
  question?: IAskedQuestion;
  guess?: Guess | null;
  text: string;
  action: string;
  placement: IPlacement;
  /**
   * 'held': the answer needs a model, and did not start, since the
   * notebook's answers had reached its cap; `start` starts it.
   * 'waiting': the analyst deleted the cell that the answer is about while
   * the model wrote it. The answer waits in the strip where the cell was,
   * and nothing ran (`waiting`).
   */
  status: 'writing' | 'running' | 'done' | 'error' | 'held' | 'waiting';
  stage: string | null;
  elapsed: number | null;
  before: string | null;
  after: string | null;
  insertedId: string | null;
  error: string | null;
  showDiff: boolean;
  /**
   * For an edit in place: the metadata that Undo puts back, the marks and
   * notes of the answer the cell had before.
   */
  metaBefore?: Partial<IEpiCellMeta>;
  /**
   * What the analyst changed since the answer, while Undo asks before it
   * throws the changes away: the label of the cell that the answer added or
   * edited.
   */
  undoAsk?: string[] | null;
  /** An agent's run, when an agent answers the question. */
  agent?: IAgentRun;
  /** Starts an answer held at the notebook's cap. */
  start?: () => Promise<void>;
  /**
   * The cell that the question is about, as it was when the analyst deleted
   * it while the model wrote the answer: the strip shows where the cell
   * was, and "Restore and run" puts the cell back there.
   */
  gone?: IDeletedCell | null;
  /** The answer that came for a deleted cell, while it waits: nothing ran. */
  waiting?: IWaitingAnswer | null;
  /** The label of the deleted cell whose place the answer took alone. */
  replaced?: string | null;
  /**
   * For a run asked in another notebook that works in this one, the path of
   * that notebook: this notebook shows the run in a line of its own.
   */
  elsewhere?: string;
}

/** An answer that came for a cell that the analyst deleted meanwhile. */
export interface IWaitingAnswer {
  option: IOption;
  code: string;
  /** What the model wrote with the code: its mark, its notes and its cost. */
  meta: Partial<IEpiCellMeta>;
}

/** How a branch of a parallel exploration ended. */
export interface IParallelEnd {
  ok: boolean;
  error: string | null;
  /** The branch's label and title, for a branch whose cell is gone. */
  label: string;
  title: string;
}

export interface IAskBase {
  id: number;
  anchor: IAnchor | null;
  loading: boolean;
  error: string | null;
  /** Set when the kernel lacks the data the request needs. */
  missing?: IMissing | null;
  /** A model's order of the questions offered, after the rules' order. */
  order?: IQuestionOrder | null;
}

/**
 * The data a request needs and the kernel does not have: after a restart, or
 * before anything ran. The plan comes from reading the cells' source.
 */
export interface IMissing {
  names: string[];
  noKernel: boolean;
  /** True when no code cell has run in this kernel. */
  nothingRan: boolean;
  /**
   * A plot output made from the data, or the variable itself, kept from the
   * last run; or the inputs of the cell that the questions edit, branch or
   * follow, which `cell` names.
   */
  from: 'output' | 'variable' | 'cell';
  /** The label of the cell whose inputs the kernel lacks, for 'cell'. */
  cell?: string;
  /** The cells to run, in order, or null while the plan is being made. */
  plan: string[] | null;
  unresolved: string[];
  running: boolean;
  claude: { stage: string | null; reason: string | null } | null;
  /** Asks again once the cells have run. */
  resume: () => void;
}

export interface IDropAsk extends IAskBase {
  kind: 'drop';
  /** Show the questions in a popover in either way of asking. */
  popover?: boolean;
  /** Offer the frame's columns in the popover (a data node of the map). */
  columns?: boolean;
  source: IItem;
  target: { cellId?: string; item?: IItem };
  modifiers: { branch: boolean; parallel: boolean };
  result: IDropResult | null;
  checked: string[];
  claudeStage: string | null;
  /**
   * The questions that the model chosen for More questions writes for the
   * request in the background, next to the templates' (./rulesfirst.ts):
   * 'asking' while it writes them, 'done' when they joined the list, 'off'
   * when no template fits and no model answers, and 'failed' when it could
   * not, with `fromModelNote` saying why.
   */
  fromModel?: 'asking' | 'done' | 'off' | 'failed' | null;
  fromModelNote?: string | null;
  /** Whether no template fits the request: none of its questions runs. */
  noTemplate?: boolean;
}

export interface ICellsAsk extends IAskBase {
  kind: 'cells';
  cells: string[];
  options: IOption[];
}

export interface IRegionSummary {
  rows: number;
  total_rows: number;
  where: string;
  unit?: string;
  units?: number;
  groups: {
    name: string;
    rows: number;
    share: number;
    share_overall: number;
    mean?: number;
  }[];
  seen: string;
  error?: string;
}

export interface IRegionAsk extends IAskBase {
  kind: 'region';
  cellId: string;
  plot: IPlotPayload;
  /** A range of x; for bars, the first and the last bar picked. */
  x0: number;
  x1: number;
  /** For bars, the labels of the bars picked. */
  values: string[] | null;
  /** For a box on a chart of another library, the range of y it also covers. */
  y: [number, number] | null;
  summary: IRegionSummary | null;
  options: IOption[];
}

/**
 * Questions about the text of a markdown cell, or about words selected in
 * it: the numbers it states, and the outputs that show them.
 */
export interface INoteAsk extends IAskBase {
  kind: 'note';
  cellId: string;
  /** The words selected in the text, or null for all of it. */
  claim: string | null;
  numbers: INumbersInText;
  options: IOption[];
}

/**
 * What-if questions about one decision of a cell: the value a chip shows,
 * tried lower, higher or as the analyst types it, in a branch of the cell.
 */
export interface IDecisionAsk extends IAskBase {
  kind: 'decision';
  cellId: string;
  decision: IDecision;
  /**
   * The call the value goes into, as its index in the decision's calls, or
   * null for every call: a chip of two merges asks which merge to change.
   */
  where: number | null;
  /** Where the value comes from, such as "defaulted in prep.py:12". */
  note: string;
  options: IOption[];
  /** Why a typed value cannot be tried. */
  valueError: string | null;
  /** The value the analyst typed, while its branch is made. */
  typed?: string;
  /**
   * Where the values offered come from: the rules, which read the kind of
   * the constant, or a model when no rule knows it (./rulesfirst.ts).
   */
  values?: IDecisionValues;
}

export type Ask =
  | IDropAsk
  | ICellsAsk
  | IRegionAsk
  | INoteAsk
  | IDecisionAsk
  | ITableAsk
  | IImageAsk;

export interface IPreview extends IProgress {
  title: string;
  code: string | null;
  /** 'held' as for a strip: the notebook's cap stopped it before it started. */
  status: 'writing' | 'running' | 'done' | 'error' | 'held';
  outputs: nbformat.IOutput[];
  error: string | null;
  option: IOption;
  /** What the model wrote with the code: its mark, which a kept cell keeps. */
  meta?: Partial<IEpiCellMeta>;
  /** Starts an answer held at the notebook's cap. */
  start?: () => Promise<void>;
}

/**
 * What the object of a cell takes from the cell itself, kept until the cell
 * changes (EpiModel.cells).
 */
interface ICellReading {
  /** The model for titles when the title was chosen. */
  labels: string;
  source: string;
  meta: IEpiCellMeta;
  heading: IEpiCell['heading'];
  count: number | null;
  /** The analysis that the notebook kept for this code. */
  kept: ICellAnalysis | null;
  title: string;
  titleBy: IWrittenBy | null | undefined;
  /** Whether a text has words besides its heading. */
  note: boolean;
  /** The kernel's analysis, and whether the code ran, as `analysis` used them. */
  fresh: ICellAnalysis | null | undefined;
  ran: boolean;
  /**
   * The defaults that models found when `decisions` were made: the version
   * of the found defaults, or -1 with the setting off (./founddefaults.ts).
   */
  found: number;
  analysis: ICellAnalysis | null;
  /** The decisions of the analysis, with those that show only when a fit stopped before it converged. */
  made: IDecision[];
  /** Whether the cell's fit stopped before it converged, as `decisions` used it. */
  stalled: boolean;
  /** The decisions that the cell shows. */
  decisions: IDecision[];
  /** The object last made from this reading. */
  cell: IEpiCell | null;
}

/**
 * Whether a cell's new object shows what its last one shows, when both come
 * from the same reading: the fields that other cells and the kernel change.
 */
function sameCell(last: IEpiCell, next: IEpiCell): boolean {
  return (
    last.model === next.model &&
    last.index === next.index &&
    last.label === next.label &&
    last.lastRun === next.lastRun &&
    last.title === next.title &&
    last.analysis === next.analysis &&
    last.decisions === next.decisions &&
    last.sectionId === next.sectionId &&
    last.branchOf === next.branchOf &&
    last.branches.length === next.branches.length &&
    last.branches.every((id, index) => id === next.branches[index])
  );
}

let counter = 0;

/** The warnings shown as a notification, each once per page. */
const warned = new Set<string>();

/**
 * The state of one notebook in the question-driven view.
 *
 * The document view, the Variables and Exploration panels and the status
 * bar all read this model, so a selection in one shows in the others.
 */
export class EpiModel implements IDisposable {
  constructor(options: EpiModel.IOptions) {
    this.context = options.context;
    this.rendermime = options.rendermime;
    this.settings = options.settings;
    this._runs = options.runs;
    this._interaction = this.settings.interaction;
    this.spaceDetail = new SpaceDetail(this.settings, () => this._emit());
    this.api = new Api(options.serverSettings, {
      jsonCheck: () => this.settings.jsonCheck,
      onWarning: message => this._warnJsonCheck(message),
      keepDataLocal: () => this.keepDataLocal,
      zeroDataRetention: () => this.zeroDataRetention,
      customModels: () => this.settings.customLocalModels,
      // Every call of this view that reached a model: its cost is kept.
      onCall: call => this._onModelCall(call),
      // The review guard: its choices go with each request, and its questions open a dialog.
      guard: () => this._guardBody(),
      onGuard: event => this._askGuard(event),
      onGuardHeld: event => this._onGuardHeld(event)
    });
    this._guardDialog = options.askGuard ?? null;
    this._serverSettings = options.serverSettings;
    // A finished sign-in changes what the tasks can run.
    this.signIns = new SignIns(this.api, () => this.refreshStatus());
    this.bridge = new KernelBridge(this.context.sessionContext);
    this.plotHooks = new PlotHooks(this.bridge, this.context.sessionContext);
    this.jobs = new JobManager({
      sessionContext: this.context.sessionContext,
      rendermime: this.rendermime,
      capacity: this.settings.capacity,
      // The first figure a cell draws has the hooks' additions too.
      prepare: () => this.plotHooks.ready()
    });
    this.tableNotes = new TableNotes({
      api: this.api,
      notebook: () => this.notebook,
      enabled: () => this.aiReady('labels'),
      model: () => this.settings.models.labels,
      changed: () => this._emit()
    });
    this.frameNotes = new FrameNotes({
      api: this.api,
      notebook: () => this.notebook,
      enabled: () => this.aiReady('labels'),
      model: () => this.settings.models.labels,
      changed: () => this._emit()
    });
    this.cellTitles = new CellTitles({
      api: this.api,
      notebook: () => this.notebook,
      enabled: () => this.aiReady('labels'),
      model: () => this.settings.models.labels,
      shown: cellId => this.cell(cellId)?.title ?? '',
      changed: () => this._emit(),
      // Background titles wait while the analyst waits for an answer.
      busy: () =>
        !!this.ask?.loading ||
        this.agentRuns.some(
          run => run.state === 'starting' || run.state === 'working'
        ) ||
        [...this.strips.values()].some(strip => strip.status === 'writing')
    });
    this.foundDefaults = new FoundDefaults({
      api: this.api,
      enabled: () => this.settings.findDefaults,
      ready: () => this.aiReady('questions') && !this._capHolds('questions'),
      model: () => choiceOf(this.settings.models, 'questions'),
      changed: () => {
        // The cells make their chips again.
        this._version++;
        this._emit();
        // "Worth asking next" asks about the defaults that a model found as
        // soon as they come in. A call that starts or fails changes no
        // default.
        if (
          !this._isDisposed &&
          this.foundDefaults.version !== this._nextFound
        ) {
          this._nextFound = this.foundDefaults.version;
          void this._nextDebouncer.invoke();
        }
      }
    });
    this.bridge.signatures = this.settings.findDefaults;
    this.bridge.storedAnalysis = (cellId, source) => {
      const cell = findCell(this.notebook, cellId);
      return cell ? analysisFor(cellMeta(cell).analysis, source) : null;
    };
    this.bridge.changed.connect(this._onBridge, this);
    this.jobs.changed.connect(this._emit, this);
    this.settings.changed.connect(this._onSettings, this);
    this.context.sessionContext.statusChanged.connect(this._onStatus, this);
    // After the bridge's own handler, which tells whether it saw the start.
    this.context.sessionContext.kernelChanged.connect(this._onKernel, this);
    this.notebook.sharedModel.changed.connect(this._onNotebookChanged, this);
    this._watchCells();
    // The runs of this notebook that another view started: a view opened
    // again on the notebook shows the strip of a run that goes on.
    this.runs.changed.connect(this._onRuns, this);
    this._onRuns();
    void this.context.ready.then(() => {
      this.mode = notebookMeta(this.notebook).mode ?? 'wonder';
      // A notebook without sums of what calls cost starts from what it
      // holds now; cells that go before the first call do not lower it.
      this._costSeed = seedRecord(
        this.cells().map(cell => cell.meta),
        notebookMeta(this.notebook).agent_runs
      );
      this._onNotebookChanged();
      // A notebook saved by an older version may keep a secret's text.
      this._keep('variables');
      this.cellTitles.titleAll();
    });
    void this.context.sessionContext.ready.then(() => this._onKernel());
    this.refreshStatus();
  }

  /**
   * Whether the view shows: the widget sets it, from Lumino's visibility and
   * the browser tab's.
   */
  isVisible: () => boolean = () => true;

  /**
   * Whether the notebook is in use: its view shows, and the analyst used it
   * in the last `IDLE_AFTER_MS`. Refreshes that executions make due wait
   * longer and longer while it is not (./refresh.ts).
   */
  get inUse(): boolean {
    return this.isVisible() && Date.now() - this._usedAt < IDLE_AFTER_MS;
  }

  /**
   * The view was shown: the notebook is in use, and a refresh that waited
   * while it was not goes out now.
   */
  shown(): void {
    this._usedAt = Date.now();
    this._refreshPolicy.used();
  }

  /**
   * The analyst used the view or one of its panels: a key, a click, the
   * wheel or the pointer. After a pause, a refresh that waited goes out.
   */
  noteUse(): void {
    const idle = !this.inUse;
    this._usedAt = Date.now();
    if (idle && this.inUse) {
      this._refreshPolicy.used();
    }
  }

  /**
   * The pointer is on a list of questions, or left it. A model's order that
   * comes while the pointer is on the list waits until it leaves, so that a
   * question does not move under the pointer, and so do the places of the
   * questions that a model wrote in the background.
   */
  pointAtList(list: IOrdered, inside: boolean): void {
    if (inside) {
      this._pointed.add(list);
      return;
    }
    this._pointed.delete(list);
    const join = this._afterPointer?.get(list);
    this._afterPointer?.delete(list);
    join?.();
    list.order?.show?.();
  }

  /** Whether only local models read the data: the server's choice, or else the setting's. */
  get keepDataLocal(): boolean {
    return !!this.status?.keep_data_local || this.settings.keepDataLocal;
  }

  /**
   * The review guard's mode as it holds: the server's, when it fixes one
   * for every user (c.Whybook.review_guard), else the setting's.
   */
  get guardMode(): GuardMode {
    const fixed = this.status?.review_guard;
    return fixed === 'ask' || fixed === 'reject'
      ? fixed
      : this.settings.guard.mode;
  }

  /** Whether the server fixes the guard's mode, so that the setting cannot change it. */
  get guardFixed(): boolean {
    const fixed = this.status?.review_guard;
    return fixed === 'ask' || fixed === 'reject';
  }

  /** Whether the notebook's kernel runs in Whybook's sandbox (design iteration 1.46). */
  get sandboxed(): boolean {
    const name = this._kernelName();
    return !!this._kernelChoices().find(choice => choice.name === name)
      ?.sandboxed;
  }

  /** Whether the notebook says that its data is synthetic: the guard then lets identifiers and values go. */
  get guardSynthetic(): boolean {
    return notebookMeta(this.notebook).guard?.synthetic === true;
  }

  setGuardSynthetic(value: boolean): void {
    setNotebookMeta(this.notebook, {
      guard: { ...(notebookMeta(this.notebook).guard ?? {}), synthetic: value }
    });
    this._emit();
  }

  /**
   * What the server keeps of this view's session: the answers that the
   * analyst allowed, and what the guard held back. A change forgets an
   * answer, all of them, or allows what a held item flagged.
   */
  guardMemory(change?: {
    forget?: number | 'all';
    allow?: { guard: string; flags: IGuardFlag[]; note?: string };
  }): Promise<IGuardMemory> {
    return this.api.guardSession({ session: this.guardSession, ...change });
  }

  /** The guard's object of each request: what the view chose, and what the notebook tells of its data and its kernel. */
  private _guardBody(): Record<string, unknown> {
    const inferred = this.inferred();
    const unit = inferred.hand.unit ?? inferred.units[0]?.column ?? null;
    const columns: IGuardColumn[] = [];
    for (const variable of this.variables()) {
      for (const column of variable.columns ?? []) {
        columns.push(guardColumn(column));
      }
    }
    return guardBody(
      { ...this.settings.guard, mode: this.guardMode },
      {
        session: this.guardSession,
        sandboxed: this.sandboxed,
        folder:
          PathExt.dirname(this.context.path) || "the server's root folder",
        language: this.languageName() ?? 'Python',
        synthetic: this.guardSynthetic,
        unit,
        columns
      }
    );
  }

  /** Ask the analyst what the guard flagged: one question at a time, in the order they came. */
  private _askGuard(
    event: IGuardEvent
  ): Promise<{ answer: GuardAnswer; note: string }> {
    const dialog = this._guardDialog;
    const next = this._guardQueue.then(() =>
      dialog ? dialog(event) : { answer: 'stop' as GuardAnswer, note: '' }
    );
    this._guardQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * What the guard held back: kept for the panel's list, and told in a
   * notice, unless nobody waited on the request, as for a table's labels.
   */
  private _onGuardHeld(event: IGuardHeld): void {
    this.guardHeld = [...this.guardHeld, { ...event, time: Date.now() }].slice(
      -100
    );
    if (!event.background) {
      Notification.warning(heldWords(event), { autoClose: 8000 });
    }
    this._emit();
  }

  /** Whether the server keeps the data on the machine, so that the setting is fixed. */
  get dataFixed(): boolean {
    return !!this.status?.keep_data_local;
  }

  /**
   * Whether requests through OpenRouter go only to providers that keep no
   * data: the server's lock (c.Whybook.openrouter_zdr), or else the setting's.
   */
  get zeroDataRetention(): boolean {
    return !!this.status?.openrouter_zdr || this.settings.zeroDataRetention;
  }

  /** Whether the server pins zero data retention, so that the setting is fixed. */
  get retentionFixed(): boolean {
    return !!this.status?.openrouter_zdr;
  }

  /** The status with the data policy in force, for the choices of models. */
  get policyStatus(): IServerStatus | null {
    return withDataPolicy(this.status, this.settings.keepDataLocal);
  }

  /** Whether a task will ask its model, with the settings and the server as they are. */
  aiReady(task: Task): boolean {
    return aiReady(this.policyStatus, this.settings.models, task);
  }

  /**
   * The library functions of a cell whose defaults a model reads now or
   * next, with "Find more defaults with AI": the cell's chips show a bar.
   */
  defaultsWaiting(cell: IEpiCell): string[] {
    if (!this.settings.findDefaults || cell.type !== 'code') {
      return [];
    }
    const signatures = this.bridge.signaturesOf(
      cell.id,
      cell.model.sharedModel.getSource()
    );
    return signatures ? this.foundDefaults.waiting(signatures) : [];
  }

  /**
   * Why a feature is off in the kernel's language, or null when it is on.
   * Before the kernel answers, the notebook's kernelspec names the language.
   */
  unsupported(feature: Feature): string | null {
    return unsupportedIn(feature, this.languageName());
  }

  /**
   * The kernel's `language_info.name`, or before the kernel answers the
   * language that the notebook's kernelspec names; null when neither does.
   */
  languageName(): string | null {
    const language: string | undefined =
      this.notebook.getMetadata('kernelspec')?.language;
    return this.bridge.languageName ?? language ?? null;
  }

  /** Why the kernel's language cannot answer a request, or null. */
  askUnsupported(ask: Ask): string | null {
    return (
      this.unsupported('questions') ??
      (ask.kind === 'region' ? this.unsupported('plots') : null)
    );
  }

  /**
   * Ask the model chosen for typed questions for the type of a question, and
   * with Jev its place, once per text. The keywords and first words decide
   * when they match, so a local model is asked only when the keywords give
   * no type; Jev also when the first words give no place.
   */
  async sortOwn(text: string, places: IPlacement[]): Promise<void> {
    const question = text.trim();
    const model = this.settings.models.typed;
    if (
      !question ||
      model === 'rules' ||
      this._sorted.has(question) ||
      !modelAvailable(this.policyStatus, model, 'typed')
    ) {
      return;
    }
    const placeLeft =
      model === 'jev' && places.length > 1 && !guessPlace(question);
    if (keywordType(question) && !placeLeft) {
      return;
    }
    this._sorted.set(question, null);
    const cellId = places.find(place => place.cell)?.cell ?? null;
    const cell = cellId ? this.cell(cellId) : null;
    try {
      const sorted = await this.api.sortQuestion({
        text: question,
        model,
        cell: cell ? cell.model.sharedModel.getSource() : null,
        places: places.map(place => place.kind)
      });
      this._sorted.set(question, sorted);
    } catch (error) {
      // The box keeps the keywords' type; the text is not asked again.
      console.warn('Could not sort the typed question', error);
    }
    // The texts of the last questions typed are enough.
    for (const old of Array.from(this._sorted.keys()).slice(0, -50)) {
      this._sorted.delete(old);
    }
    this._emit();
  }

  /** The type of a typed question: the keywords', else the model's, else descriptive, with the model that chose it. */
  ownType(text: string): {
    type: QuestionType;
    by: string | null;
    probability: number | null;
  } {
    const question = text.trim();
    const keyword = keywordType(question);
    if (keyword) {
      return { type: keyword, by: null, probability: null };
    }
    const sorted = this._sorted.get(question);
    const pick = sorted?.type;
    const known = QUESTION_TYPES.find(type => type.id === pick?.choice);
    if (sorted && pick && known) {
      return {
        type: known.id,
        by: sorted.model,
        probability: pick.probabilities[pick.choice] ?? null
      };
    }
    return { type: 'descriptive', by: null, probability: null };
  }

  /** The place of a typed question: its first words', else Jev's, else the request's default, with the model that chose it. */
  ownPlace(
    text: string,
    places: IPlacement[]
  ): { place: IPlacement | null; by: string | null } {
    const question = text.trim();
    const byWords = wordPlace(question, places);
    if (byWords) {
      return { place: byWords, by: null };
    }
    const sorted = this._sorted.get(question);
    const pick = sorted?.place?.choice;
    const byModel = pick ? places.find(place => place.kind === pick) : null;
    if (sorted && byModel) {
      return { place: byModel, by: sorted.model };
    }
    return { place: places[0] ?? null, by: null };
  }

  /** Asks the view's toolbar to open its panel of AI models. */
  get modelsPanelRequested(): ISignal<this, void> {
    return this._modelsPanelRequested;
  }

  requestModelsPanel(): void {
    this._modelsPanelRequested.emit();
  }

  /**
   * Why local models use the standard JSON check although the settings chose
   * the fast one, or null: from the last run of a local model, or from the
   * server's status.
   */
  get jsonCheckWarning(): string | null {
    if (this.settings.jsonCheck !== 'fast') {
      return null;
    }
    return this._jsonCheckWarning ?? this.status?.json_check_warning ?? null;
  }

  private _warnJsonCheck(message: string): void {
    if (!warned.has(message)) {
      warned.add(message);
      Notification.warning(message, { autoClose: 10000 });
    }
    if (message !== this._jsonCheckWarning) {
      this._jsonCheckWarning = message;
      this._emit();
    }
  }

  /** Ask the server again what it can run. */
  refreshStatus(): void {
    this.api
      .status()
      .then(status => {
        this.status = status;
        this._emit();
        // A model that can run now titles the cells that have none.
        if (this.context.isReady) {
          this.cellTitles.titleAll();
        }
        // And reads the signatures that no model has read.
        this._findDefaults();
      })
      .catch(() => {
        this.status = null;
        this._emit();
      });
  }

  readonly context: DocumentRegistry.IContext<INotebookModel>;
  readonly rendermime: IRenderMimeRegistry;
  readonly settings: EpiSettings;
  readonly api: Api;
  readonly bridge: KernelBridge;
  /** The kernel's hooks that add, to plots of other libraries, what questions need. */
  readonly plotHooks: PlotHooks;
  readonly jobs: JobManager;
  readonly tableNotes: TableNotes;
  readonly frameNotes: FrameNotes;
  readonly cellTitles: CellTitles;
  /**
   * The defaults that models picked from the signatures of the library
   * functions that the cells call: "Find more defaults with AI".
   */
  readonly foundDefaults: FoundDefaults;
  /**
   * The level of detail in force in this view: the slider's, or with the
   * setting "Level of detail follows the space", the width's and the zoom's.
   */
  readonly spaceDetail: SpaceDetail;
  /** Sign-ins to a provider of the connected model in progress: src/model/connection.ts. */
  readonly signIns: SignIns;
  /**
   * The review guard's session: the server keeps the analyst's answers under
   * it while this view is open, or until the server restarts.
   */
  readonly guardSession = `view-${UUID.uuid4()}`;
  /** What the guard held back in this session, the newest last. */
  guardHeld: IGuardHeld[] = [];
  /** The model of labels and captions when the settings last changed. */
  private _labelsModel = '';
  private _guardDialog: EpiModel.IOptions['askGuard'] | null = null;
  private _guardQueue: Promise<unknown> = Promise.resolve();

  status: IServerStatus | null = null;
  view: ViewKind = 'bench';
  mode: Mode = 'wonder';
  selected: string | null = null;
  armed: IItem | null = null;
  ask: Ask | null = null;
  /** The tab of the right panel: the exploration, or the details of the current cell. */
  rightTab: 'explore' | 'details' = 'explore';
  selectedOutput: { cellId: string; index: number } | null = null;
  preview: IPreview | null = null;
  strips = new Map<string, IStrip>();
  parallel = new Map<string, string[]>();
  /**
   * How each branch of a parallel exploration ended, by the id of its cell:
   * its job goes from the job manager a minute after it ends, and a branch
   * that the AI did not write has no cell and no job.
   */
  parallelEnded = new Map<string, IParallelEnd>();
  codeOpen = new Set<string>();
  collapsed = new Set<string>();
  touched = new Set<string>();
  mapSelection: string[] = [];
  /** Kept here so that the map shows the same place after a switch of view. */
  mapCamera: IMapCamera = { x: 0, y: 0, zoom: 1 };
  nextSteps: IOption[] = [];
  /** Whether the server has answered for the questions worth asking next, so that none means it found no gap. */
  nextFetched = false;
  /** The model's order of the questions worth asking next. */
  next: IOrdered = { order: null };
  /** The agents' runs of this view, the newest last. */
  agentRuns: IAgentRun[] = [];
  /**
   * A refresh reads the kernel: the Variables section marks its list busy
   * for screen readers, and draws nothing for it.
   */
  reading = false;
  /**
   * A refresh has read the kernel for longer than `SPINNER_DELAY_MS`: the
   * Variables section draws its progress circle.
   */
  refreshing = false;
  /** Click-mode stand-ins for Shift and Alt. */
  pickModifiers = { branch: false, parallel: false };

  get notebook(): INotebookModel {
    return this.context.model;
  }

  get sessionContext(): ISessionContext {
    return this.context.sessionContext;
  }

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * Counts the changes that any card can show: every change but a key
   * typed in a cell, which only that cell's card shows. A card draws again
   * when its cell's object or this count changes; `cells` counts the
   * changes of labels and titles that show on other cards.
   */
  get revision(): number {
    return this._revision;
  }

  /** Asks the current view to bring a cell into sight and flash it. */
  get cellShown(): ISignal<this, string> {
    return this._cellShown;
  }

  showCell(cellId: string): void {
    this.setCurrentCell(cellId);
    this._cellShown.emit(cellId);
  }

  /** The analyst typed in a cell's code, in one of the view's editors. */
  cellEdited(cellId: string): void {
    this.cellTitles.edited(cellId);
  }

  /**
   * Asks the view to put the keyboard focus on the first target of a pick,
   * the button of a cell that asks about the picked item with it: the way
   * from the Questions section to the cells, from the keyboard.
   */
  get targetsRequested(): ISignal<this, void> {
    return this._targetsRequested;
  }

  requestTargets(): void {
    this._targetsRequested.emit();
  }

  /**
   * Why the questions that need AI cannot be asked, and how to set a model
   * up, or null when a model answers them: the settings turn AI off for
   * cells, or the server has no model that can answer (its status gives the reason,
   * read without a call to the model).
   */
  aiOff(): { reason: string; setup: string | null } | null {
    if (this.aiReady('cells')) {
      return null;
    }
    if (this.settings.models.cells === 'off') {
      return {
        reason: 'AI is off for cells and answers in the settings',
        setup:
          'Choose the remote model for Cells and answers in the AI menu of the toolbar.'
      };
    }
    if (!this.status) {
      return { reason: 'the server did not answer', setup: null };
    }
    return {
      reason:
        this.status.claude?.reason ?? 'no AI model is set up on the server',
      setup: this.status.claude?.setup ?? null
    };
  }

  /** Asks the document to open a file, such as a module the agent wrote. */
  get fileOpenRequested(): ISignal<this, string> {
    return this._fileOpenRequested;
  }

  openFile(path: string): void {
    this._fileOpenRequested.emit(path);
  }

  /**
   * The type of question lit while the pointer rests on a badge of that type
   * on a cell, or on its bar in the Exploration panel: the view shows every
   * badge and every cell of that type. Null when no type is lit.
   */
  get litType(): QuestionType | null {
    return this._litType;
  }

  get litTypeChanged(): ISignal<this, QuestionType | null> {
    return this._litTypeChanged;
  }

  lightType(type: QuestionType | null): void {
    if (type !== this._litType) {
      this._litType = type;
      this._litTypeChanged.emit(type);
    }
  }

  /**
   * The cell the analyst worked on last: clicked, asked about, ran or
   * showed. The bench offers a way back to it once it scrolls out of view.
   */
  get currentCell(): string | null {
    return this._currentCell;
  }

  setCurrentCell(cellId: string | null): void {
    if (cellId !== this._currentCell) {
      this._currentCell = cellId;
      this._emit();
    }
  }

  /** Switch to the bench, or to the map, and bring a cell into sight there. */
  showIn(view: 'bench' | 'map', cellId: string): void {
    this._pendingShow = cellId;
    this.setCurrentCell(cellId);
    this.setView(view);
  }

  /** The cell to show once a view has drawn after `showIn`, taken once. */
  takePendingShow(): string | null {
    const cellId = this._pendingShow;
    this._pendingShow = null;
    return cellId;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  get interaction(): Interaction {
    return this.settings.interaction;
  }

  // Derived data.

  /**
   * The cells as the views show them. A cell keeps its object while what it
   * shows stays the same, so that a view draws again only the cells that
   * changed: a key typed in one cell makes one new object.
   */
  cells(): IEpiCell[] {
    // A run in the kernel changes which counts are from an earlier run.
    if (
      this._cells &&
      this._cellsVersion === this._version &&
      this._cellsRuns === this.bridge.runCount
    ) {
      return this._cells;
    }
    const labels = this.settings.models.labels;
    const readings: ICellReading[] = [];
    const drafts: IEpiCell[] = [];
    const byId = new Map<string, IEpiCell>();
    let sectionId = 'top';
    // The first level-one heading is the notebook's title. Every other
    // heading starts a section, whatever its level.
    let titled = false;
    for (const [index, model] of cellsOf(this.notebook).entries()) {
      const reading = this._reading(model, labels);
      const heading = reading.heading;
      if (heading && heading.level === 1 && !titled) {
        titled = true;
      } else if (heading) {
        sectionId = model.id;
      }
      this._analyse(model, reading);
      const cell: IEpiCell = {
        id: model.id,
        model,
        index,
        type: model.type as IEpiCell['type'],
        label: reading.count ? `[${reading.count}]` : '[ ]',
        count: reading.count,
        lastRun: !!reading.count && !reading.ran,
        title: reading.title,
        titleBy: reading.titleBy,
        meta: reading.meta,
        analysis: reading.analysis,
        decisions: reading.decisions,
        sectionId,
        branchOf: reading.meta.branch?.of ?? null,
        branches: [],
        heading
      };
      readings.push(reading);
      drafts.push(cell);
      byId.set(cell.id, cell);
    }
    for (const cell of drafts) {
      if (cell.branchOf) {
        const parent = byId.get(cell.branchOf);
        if (parent) {
          parent.branches.push(cell.id);
          const letter = cell.meta.branch?.letter ?? 'b';
          cell.label = parent.count
            ? `[${parent.count}${letter}]`
            : `[·${letter}]`;
        } else {
          // Its parent was deleted: it shows as a cell of its own, and joins
          // the parent again if Undo puts the parent back.
          cell.branchOf = null;
        }
      }
    }
    // A title written from a question names cells by the labels of its
    // moment: it shows their labels now.
    const labelOf = (id: string) => byId.get(id)?.label ?? null;
    for (const cell of drafts) {
      const question = cell.meta.question;
      if (question?.refs && cell.title === question.text) {
        cell.title = relabel(question.text, question.refs, labelOf);
      }
    }
    const cells = drafts.map((draft, index) => {
      const reading = readings[index];
      const cell =
        reading.cell && sameCell(reading.cell, draft) ? reading.cell : draft;
      reading.cell = cell;
      byId.set(cell.id, cell);
      if (cell.type === 'markdown') {
        this._notes?.set(cell, reading.note);
      }
      return cell;
    });
    if (this._shownElsewhere(cells)) {
      this._revision++;
    }
    const last = this._cells;
    this._cells =
      last &&
      last.length === cells.length &&
      cells.every((cell, index) => cell === last[index])
        ? last
        : cells;
    this._byId = byId;
    this._cellsVersion = this._version;
    this._cellsRuns = this.bridge.runCount;
    return this._cells;
  }

  /**
   * Whether a change of these cells shows on the cards of other cells. A
   * card names other cells by their labels, and shows the title of a branch
   * in its parent's strip, and the title of a cell whose label another cell
   * shows too in the mark of that label.
   */
  private _shownElsewhere(cells: IEpiCell[]): boolean {
    const last = this._byId;
    if (!last || last.size !== cells.length) {
      return true;
    }
    // Labels as sharedLabels counts them.
    const counts = new Map<string, number>();
    for (const cell of cells) {
      if (cell.type === 'code' && cell.label !== '[ ]') {
        counts.set(cell.label, (counts.get(cell.label) ?? 0) + 1);
      }
    }
    return cells.some(cell => {
      const before = last.get(cell.id);
      return (
        before !== cell &&
        (!before ||
          before.label !== cell.label ||
          (before.title !== cell.title &&
            (!!cell.branchOf || (counts.get(cell.label) ?? 0) > 1)))
      );
    });
  }

  /**
   * What the object of a cell takes from the cell itself. It is kept until
   * the cell changes (_onCellChanged) or the settings choose another model
   * for titles, so that a change reads the cell that changed alone again.
   */
  private _reading(model: ICellModel, labels: string): ICellReading {
    const kept = this._watching
      ? this._readings.get(model.sharedModel)
      : undefined;
    if (kept && kept.labels === labels) {
      return kept;
    }
    const code = model.type === 'code';
    const meta = cellMeta(model);
    const source = model.sharedModel.getSource();
    let heading: IEpiCell['heading'] = null;
    if (model.type === 'markdown') {
      const match = /^(#{1,6})\s+(.+)$/m.exec(
        source.split('\n').find(line => line.trim()) ?? ''
      );
      if (match) {
        heading = { level: match[1].length, text: match[2].trim() };
      }
    }
    // A model's title comes first: the analyst's cell had only its first
    // line. After an edit it stays until the title of the new code comes.
    // A cell that only imports names its modules, and no model titles it.
    const given = meta.title || meta.question?.text || '';
    const imports = code ? importsTitle(source) : null;
    const titled = code && !imports ? titleNote(meta, labels) : null;
    const reading: ICellReading = {
      labels,
      source,
      meta,
      heading,
      count: code ? (model as ICodeCellModel).executionCount : null,
      kept: code ? analysisFor(meta.analysis, source) : null,
      title:
        titled?.title ||
        given ||
        imports ||
        firstLine(
          source,
          code
            ? languageOf(
                this.bridge.languageName ??
                  this.notebook.getMetadata('kernelspec')?.language
              )
            : null
        ) ||
        (code ? 'Empty cell' : 'Note'),
      titleBy:
        titled && titled.title !== given ? (titled.by ?? null) : undefined,
      note: model.type === 'markdown' && noteBody(source) !== '',
      fresh: undefined,
      ran: false,
      found: -1,
      analysis: null,
      made: [],
      stalled: false,
      decisions: [],
      cell: null
    };
    if (this._watching) {
      this._readings.set(model.sharedModel, reading);
    }
    return reading;
  }

  /**
   * The analysis of a cell, the kernel's with the one the notebook kept for
   * its code, and the decisions it makes. They are made again only when the
   * kernel's analysis of the cell, or whether its code ran, changes. A
   * decision that shows only when the cell's fit stopped before it
   * converged, such as max_iter, goes in and out with what the outputs and
   * the kernel's listing say (design iteration 1.116).
   */
  private _analyse(model: ICellModel, reading: ICellReading): void {
    const code = model.type === 'code';
    const fresh = code
      ? this.bridge.freshAnalysis(model.id, reading.source)
      : null;
    const ran = this.bridge.hasRun(reading.source);
    const found =
      code && this.settings.findDefaults ? this.foundDefaults.version : -1;
    const made =
      reading.fresh !== fresh || reading.ran !== ran || reading.found !== found;
    if (made) {
      reading.fresh = fresh;
      reading.ran = ran;
      reading.found = found;
      reading.analysis = code
        ? this.bridge.analysis(model.id, reading.source, reading.kept)
        : null;
      reading.made = this._decisions(
        reading.meta,
        reading.analysis,
        reading.source
      );
      if (found >= 0) {
        // The defaults that a model picked from the signatures that the kernel read.
        reading.made = withFound(
          reading.made,
          foundDecisions(
            this.bridge.signaturesOf(model.id, reading.source) ?? [],
            signature => this.foundDefaults.answer(signature),
            reading.made
          )
        );
      }
    }
    // Only a cell with such a decision reads its outputs.
    const stalled =
      code &&
      reading.made.some(decision => decision.when === 'not_converged') &&
      this._stoppedBeforeConverging(model as ICodeCellModel, reading);
    if (made || reading.stalled !== stalled) {
      reading.stalled = stalled;
      reading.decisions = stalled
        ? reading.made
        : reading.made.filter(decision => decision.when !== 'not_converged');
    }
  }

  /**
   * Whether the fit of a code cell stopped before it converged, by its
   * outputs and by the models of the kernel's listing that it makes.
   */
  private _stoppedBeforeConverging(
    model: ICodeCellModel,
    reading: ICellReading
  ): boolean {
    const texts: string[] = [];
    for (let index = 0; index < model.outputs.length; index++) {
      texts.push(rawText(model.outputs.get(index).data));
    }
    const listed = (reading.analysis?.defs ?? []).map(name => {
      const variable = this.variable(name);
      return variable?.kind === 'model' &&
        typeof variable.converged === 'boolean'
        ? variable.converged
        : null;
    });
    return stoppedBeforeConverging(texts, listed);
  }

  /**
   * The labels that more than one cell shows now, such as the [2] of a cell
   * kept from the last run and the [2] of a cell of this run.
   */
  sharedLabels(): Set<string> {
    const cells = this.cells();
    if (this._sharedFor !== cells) {
      const seen = new Set<string>();
      this._shared = new Set();
      for (const cell of cells) {
        if (cell.label === '[ ]' || cell.type !== 'code') {
          continue;
        }
        if (seen.has(cell.label)) {
          this._shared.add(cell.label);
        }
        seen.add(cell.label);
      }
      this._sharedFor = cells;
    }
    return this._shared;
  }

  /** A question's text with the current labels of the cells it names. */
  questionText(question: {
    text: string;
    refs?: Record<string, string>;
  }): string {
    return relabel(
      question.text,
      question.refs,
      id => this.cell(id)?.label ?? null
    );
  }

  cell(cellId: string): IEpiCell | null {
    this.cells();
    return this._byId.get(cellId) ?? null;
  }

  codeCells(): IEpiCell[] {
    return this.cells().filter(cell => cell.type === 'code');
  }

  /**
   * The notebook title (the first level-one heading), the text under it,
   * and the sections. Every other heading starts a section, whatever its
   * level; the text under a heading is the first note of its section. A
   * text whose editor is open stays, with or without words.
   */
  sections(): {
    title: string | null;
    intro: IEpiCell | null;
    sections: ISection[];
  } {
    const cells = this.cells();
    if (this._sectionsOf?.cells === cells) {
      return this._sectionsOf.shown;
    }
    let title: string | null = null;
    let intro: IEpiCell | null = null;
    const sections: ISection[] = [];
    let current: ISection | null = null;
    for (const cell of cells) {
      const body =
        cell.type === 'markdown' &&
        (this.isNote(cell) || this.inEditor(cell.id));
      if (cell.heading && cell.heading.level === 1 && title === null) {
        title = cell.heading.text;
        intro = body ? cell : null;
        continue;
      }
      if (cell.heading) {
        current = {
          id: cell.id,
          title: cell.heading.text,
          // §0, the cells before the first heading, is not counted: §0, §1, §2.
          number: sections.filter(section => section.id !== 'top').length + 1,
          cells: body ? [cell] : []
        };
        sections.push(current);
        continue;
      }
      if (!current) {
        current = { id: 'top', title: 'Notebook', number: 0, cells: [] };
        sections.push(current);
      }
      current.cells.push(cell);
    }
    const shown = { title, intro, sections };
    this._sectionsOf = {
      cells,
      shown,
      byId: new Map(sections.map(section => [section.id, section]))
    };
    return shown;
  }

  /** The section of this id, as `sections` gives it. */
  private _section(sectionId: string): ISection | null {
    this.sections();
    return this._sectionsOf?.byId.get(sectionId) ?? null;
  }

  /** Whether a markdown cell has text besides its heading. */
  isNote(cell: IEpiCell): boolean {
    if (cell.type !== 'markdown') {
      return false;
    }
    // Known from the cell's part, while the cell is unchanged (cells).
    const known = this._notes?.get(cell);
    if (known !== undefined) {
      return known;
    }
    return noteBody(cell.model.sharedModel.getSource()) !== '';
  }

  /** Whether the editor of this text is open, on the bench or in the Code view. */
  inEditor(cellId: string): boolean {
    return !!this._editors?.has(cellId);
  }

  /**
   * The editor of a text opened or closed. A text keeps its card while its
   * editor is open, also when the analyst deletes all its words.
   */
  editText(cellId: string, open: boolean): void {
    if (open === this.inEditor(cellId)) {
      return;
    }
    if (open) {
      this._editors.add(cellId);
    } else {
      this._editors.delete(cellId);
    }
    this._sectionsOf = null;
    this._emit();
  }

  /** How questions and placements name a markdown cell: "§7 Summary". */
  noteLabel(cell: IEpiCell): string {
    const { intro } = this.sections();
    if (intro?.id === cell.id) {
      return 'the introduction';
    }
    const section = this._section(cell.sectionId);
    if (!section || section.number === 0) {
      return 'the note';
    }
    return section.id === cell.id
      ? `§${section.number} ${section.title}`
      : `the note in §${section.number} ${section.title}`;
  }

  /**
   * The kernel's variables, and those the notebook kept from the last run
   * that the kernel lacks, marked stale, until the cell that makes each runs.
   */
  variables(): IVariable[] {
    const key = `${this._version}:${this.bridge.runCount}`;
    if (this._variablesKey !== key) {
      this._variablesKey = key;
      this._variables = listing(
        this.sessionContext.session?.kernel
          ? (this.bridge.snapshot?.variables ?? null)
          : null,
        this._storedVariables(),
        cellId => this._ranHere(cellId),
        cellId => !!findCell(this.notebook, cellId)
      );
    }
    return this._variables;
  }

  /** How many of the variables shown are in the kernel now. */
  liveCount(): number {
    return this.variables().filter(variable => !variable.stale).length;
  }

  /**
   * The names that only an agent's run made, which no later cell outside
   * the run reads, by run, with the run's question (./runnames.ts): the
   * Variables panel lists them under their run, folded, and the map leaves
   * them out of its data (design iteration 1.83). A cell of a run that the
   * analyst edited by hand counts as the analyst's.
   */
  runNames(): IRunGroup[] {
    const cells = this.cells();
    const variables = this.variables();
    const kept = this._runNames;
    if (kept && kept.cells === cells && kept.variables === variables) {
      return kept.groups;
    }
    const records = notebookMeta(this.notebook).agent_runs ?? {};
    const groups = runNames(
      cells
        .filter(cell => cell.type === 'code')
        .map(cell => ({
          id: cell.id,
          run:
            cell.meta.agent?.run &&
            !editedByHand(cell.meta, cell.model.sharedModel.getSource())
              ? cell.meta.agent.run
              : null,
          defs: cell.analysis?.defs ?? [],
          uses: cell.analysis?.uses ?? []
        })),
      variables.map(variable => variable.name)
    ).map(group => ({
      ...group,
      question:
        this.agentRuns.find(run => run.id === group.run)?.question ??
        records[group.run]?.question ??
        ''
    }));
    this._runNames = { cells, variables, groups };
    return groups;
  }

  /**
   * The variables, less the names of agents' runs (`runNames`) and those
   * that only undone answers made (`undoneNames`): the main list of the
   * Variables panel, the frames that the map draws, and the Derived row of
   * Variables explored, whose source frames come from `variables()` with a
   * filter of their own (../ui/exploration.tsx).
   */
  mainVariables(): IVariable[] {
    const apart = new Set([
      ...this.runNames().flatMap(group => group.names),
      ...this.undoneNames().map(variable => variable.name)
    ]);
    if (!apart.size) {
      return this.variables();
    }
    return this.variables().filter(variable => !apart.has(variable.name));
  }

  /**
   * The variables that only the cells of undone answers made (design
   * iteration 1.119). Undo deletes the cell that an answer added and leaves
   * the kernel as it is, so the names that the cell made stay in the kernel,
   * and no cell makes them. Variables lists them apart, each with Remove,
   * and Variables explored leaves them out. A name that a cell of the
   * notebook makes is not one of them, then or later.
   */
  undoneNames(): IVariable[] {
    const undone = this._undone;
    if (!undone?.size) {
      return [];
    }
    const made = this._madeByCells();
    for (const name of [...undone.keys()]) {
      if (made.has(name)) {
        undone.delete(name);
      }
    }
    return this.variables().filter(
      variable => !variable.stale && undone.has(variable.name)
    );
  }

  /** The question of the undone answer that made this name. */
  undoneQuestion(name: string): string | null {
    return this._undone?.get(name) ?? null;
  }

  /** Whether Remove deletes this name from the kernel now. */
  isRemoving(name: string): boolean {
    return !!this._removing?.has(name);
  }

  /**
   * Delete these names of `undoneNames` from the kernel, with `del a, b` in
   * Python, and list the kernel's variables again. Only a click on Remove
   * calls it.
   */
  async removeUndone(names: string[]): Promise<void> {
    const listed = new Set(this.undoneNames().map(variable => variable.name));
    const removing = (this._removing ??= new Set());
    const gone = names.filter(name => listed.has(name) && !removing.has(name));
    const code = gone.length ? this.bridge.language?.remove?.(gone) : null;
    if (!code) {
      return;
    }
    gone.forEach(name => removing.add(name));
    this._emit();
    try {
      const { error } = await this.bridge.execute(code);
      if (error) {
        console.warn(`Could not remove ${gone.join(', ')}: ${error}`);
      }
      await this.refresh();
    } catch (error) {
      console.warn('Could not remove names from the kernel', error);
    } finally {
      for (const name of gone) {
        removing.delete(name);
        if (this._inKernel(name)) {
          continue;
        }
        this._undone?.delete(name);
        // Contents and a pick do not keep a name that is gone.
        if (this.selected === name) {
          this.selected = null;
        }
        const armed = this.armed;
        if (
          armed &&
          (armed.kind === 'variable' ? armed.name : armed.parent) === name
        ) {
          this.armed = null;
        }
      }
      this._emit();
    }
  }

  /**
   * Keep the names that the cell of an undone answer made, before Undo
   * deletes the cell: those of its analysis, and those that the notebook
   * kept with the cell at the last listing. A cell that the kernel has not
   * analysed yet, as when Undo comes right after the run, is analysed now.
   */
  private _keepUndone(cellId: string, question: string): void {
    const cell = this.cell(cellId);
    if (cell?.type !== 'code') {
      return;
    }
    const undone = (this._undone ??= new Map());
    const keep = (names: readonly string[]) =>
      names.forEach(name => undone.set(name, question));
    keep(cell.analysis?.defs ?? []);
    keep(
      this._storedVariables()
        .filter(variable => variable.cell === cellId)
        .map(variable => variable.name)
    );
    if (cell.analysis || !this.sessionContext.session?.kernel) {
      return;
    }
    const source = cell.model.sharedModel.getSource();
    void this.bridge
      .refreshAnalysis([{ id: cellId, source }])
      .then(() => {
        keep(this.bridge.freshAnalysis(cellId, source)?.defs ?? []);
        this._emit();
      })
      .catch(error => console.warn('Could not analyse the undone cell', error));
  }

  /**
   * The names that the code cells of the notebook make: by their analysis,
   * and by the analysis that each kept from its last run, which stands for
   * a cell changed since, until the kernel analyses it again.
   */
  private _madeByCells(): Set<string> {
    const names = new Set<string>();
    for (const cell of this.codeCells()) {
      for (const name of cell.analysis?.defs ?? []) {
        names.add(name);
      }
      for (const name of cell.meta.analysis?.defs ?? []) {
        names.add(name);
      }
    }
    return names;
  }

  /**
   * Whether the view wrote the code of this cell, from a template, a model
   * or an agent's run, and the analyst changed it since (./handedit.ts).
   */
  editedByHand(cellId: string): boolean {
    const cell = this.cell(cellId);
    return (
      !!cell && editedByHand(cell.meta, cell.model.sharedModel.getSource())
    );
  }

  /** Whether the notebook's file is still loading, so that its cells are not known yet. */
  isLoading(): boolean {
    return !this.context.isReady;
  }

  /**
   * Whether every cell is empty, as in a notebook just created. Never while
   * the file loads: a notebook with no cells yet is not known to be empty.
   */
  isBlank(): boolean {
    return (
      !this.isLoading() &&
      cellsOf(this.notebook).every(
        cell => cell.sharedModel.getSource().trim() === ''
      )
    );
  }

  /**
   * Data files in the notebook's folder and the folders just below it, for
   * the empty view to offer. Hidden folders are skipped.
   */
  async nearbyData(limit = 8): Promise<INearbyFile[]> {
    const list = async (path: string): Promise<Contents.IModel[]> => {
      const url =
        URLExt.join(
          this._serverSettings.baseUrl,
          'api/contents',
          URLExt.encodeParts(path)
        ) + '?content=1';
      const response = await ServerConnection.makeRequest(
        url,
        {},
        this._serverSettings
      );
      if (!response.ok) {
        return [];
      }
      return (await response.json()).content ?? [];
    };
    const folder = PathExt.dirname(this.context.path);
    const top = await list(folder);
    const below = await Promise.all(
      top
        .filter(item => item.type === 'directory' && !item.name.startsWith('.'))
        .slice(0, 12)
        .map(item => list(item.path))
    );
    const found: INearbyFile[] = [];
    for (const item of [...top, ...below.flat()]) {
      if (item.type !== 'file') {
        continue;
      }
      const database = DATABASE_FILE.test(item.name);
      if (database || DATA_FILE.test(item.name)) {
        found.push({
          path: item.path,
          name: item.name,
          database,
          size: item.size ?? null
        });
      }
    }
    return found.slice(0, limit);
  }

  variable(name: string): IVariable | null {
    return this.variables().find(variable => variable.name === name) ?? null;
  }

  column(frame: string, label: string): IColumn | null {
    return (
      this.variable(frame)?.columns?.find(column => column.label === label) ??
      null
    );
  }

  /**
   * Column labels used by code cells, per frame: a column counts once a cell
   * names it. A column dragged without a question that ran, and a frame that
   * a cell builds from its columns or shows whole, as with `.head()`, do not
   * count (whybook/server/kernel_code/analyze_cells.py).
   */
  used(): Map<string, Set<string>> {
    const used = new Map<string, Set<string>>();
    for (const cell of this.codeCells()) {
      for (const [frame, columns] of Object.entries(
        cell.analysis?.columns ?? {}
      )) {
        const set = used.get(frame) ?? new Set<string>();
        columns.forEach(column => set.add(column));
        used.set(frame, set);
      }
    }
    return used;
  }

  isUsed(item: IItem): boolean {
    if (item.kind === 'column' && item.parent) {
      return this.used().get(item.parent)?.has(item.label) ?? false;
    }
    return this.codeCells().some(cell =>
      cell.analysis?.uses.includes(item.name)
    );
  }

  /**
   * Questions answered or asked in this notebook.
   */
  asked(): IAskedQuestion[] {
    const asked = new Map<string, IAskedQuestion>();
    for (const cell of this.codeCells()) {
      if (cell.meta.question) {
        asked.set(cell.meta.question.id, cell.meta.question);
      }
    }
    for (const question of notebookMeta(this.notebook).exploration?.asked ??
      []) {
      asked.set(question.id, question);
    }
    return [...asked.values()];
  }

  /**
   * The type of the question asked last. The log keeps questions in the order
   * they were asked; without it, the last cell that answers one counts.
   */
  lastAskedType(): QuestionType | null {
    const log = notebookMeta(this.notebook).exploration?.asked ?? [];
    if (log.length) {
      return log[log.length - 1].type;
    }
    const answered = this.codeCells().filter(cell => cell.meta.question);
    return answered.length
      ? answered[answered.length - 1].meta.question!.type
      : null;
  }

  /**
   * Where each variable was defined: the cell and its section.
   */
  definitions(): Map<string, IEpiCell> {
    const definitions = new Map<string, IEpiCell>();
    for (const cell of this.codeCells()) {
      for (const name of cell.analysis?.defs ?? []) {
        definitions.set(name, cell);
      }
    }
    return definitions;
  }

  // What the server needs.

  itemJSON(item: IItem):
    | (Pick<IItem, 'kind' | 'name' | 'label' | 'path' | 'table'> & {
        kernel_path: string;
      })
    | IColumn
    | Omit<IVariable, 'columns' | 'groups' | 'terms'>
    | null {
    if ((item.kind === 'file' || item.kind === 'table') && item.path) {
      return {
        kind: item.kind,
        name: item.name,
        label: item.label,
        path: item.path,
        table: item.table,
        kernel_path: this._kernelPath(item.path)
      };
    }
    if (item.kind === 'column' && item.parent) {
      return this.column(item.parent, item.label);
    }
    const variable = this.variable(item.name);
    if (!variable) {
      return null;
    }
    const { columns, groups, terms, ...rest } = variable;
    return rest;
  }

  /** A file's path from the notebook's folder, where the kernel runs: the path its code reads. */
  private _kernelPath(path: string): string {
    return PathExt.relative(PathExt.dirname(this.context.path), path);
  }

  cellJSON(cell: IEpiCell): Record<string, unknown> {
    const kinds = new Set(
      outputsOf(cell.model).map(output => outputKind(output))
    );
    const note = cell.type === 'markdown';
    const source = cell.model.sharedModel.getSource();
    return {
      id: cell.id,
      type: cell.type,
      label: note ? this.noteLabel(cell) : cell.label,
      source: note ? noteBody(source) : source,
      section: this._section(cell.sectionId)?.title ?? null,
      title: cell.title,
      defs: cell.analysis?.defs ?? [],
      uses: cell.analysis?.uses ?? [],
      formulas: cell.analysis?.formulas ?? [],
      columns: cell.analysis?.columns ?? {},
      decisions: cell.decisions,
      outputs: [...kinds],
      branch_of: cell.branchOf
    };
  }

  serverContext(): Record<string, unknown> {
    // The outcome and the unit set by hand, or those inferred, with every
    // one that the view knows (./inferred.ts).
    const inferred = contextOf(this.inferred());
    const frames: Record<string, unknown> = {};
    for (const variable of this.variables()) {
      if (variable.kind === 'dataframe' && variable.columns) {
        frames[variable.name] = {
          rows: variable.rows,
          columns: Object.fromEntries(
            variable.columns.map(column => [column.label, column.tag])
          )
        };
      }
    }
    const used = new Set<string>();
    for (const [frame, columns] of this.used()) {
      used.add(frame);
      columns.forEach(column => used.add(column));
    }
    return {
      outcome: inferred.outcome,
      unit: inferred.unit,
      outcomes: inferred.outcomes,
      units: inferred.units,
      mode: this.mode,
      last_type: this.lastAskedType(),
      frames,
      used: [...used],
      // The server compares texts with those it writes now: each question
      // goes with the current labels of the cells it names.
      asked: this.asked().map(question => ({
        ...question,
        text: this.questionText(question)
      })),
      cells: this.codeCells().map(cell => `${cell.label} ${cell.title}`),
      // The templates' code is Python: in another language the server sends
      // their questions without code, and a model writes the cells.
      language: (this.languageName() ?? 'python').toLowerCase()
    };
  }

  // Refreshing from the kernel.

  /**
   * Read the kernel's variables and the analysis of the cells again, 300 ms
   * after the last call, whether the notebook is in use or not: for code
   * that needs them now, such as an agent's next step. Executions make
   * refreshes due by themselves, at the pace of use (./refresh.ts).
   */
  refresh(): Promise<void> {
    const pending = this._refresher.invoke();
    this._pendingRefresh = pending;
    void pending.finally(() => {
      if (this._pendingRefresh === pending) {
        this._pendingRefresh = null;
      }
    });
    return pending;
  }

  /**
   * Whether these names are in the kernel once a pending refresh of its
   * variables is done. A run lists its variables a moment after it ends, so
   * a question asked in that moment waits for the list, at most 10 s,
   * instead of calling the names missing. A refresh that is due goes out
   * now.
   */
  private async _listedAfterRefresh(names: string[]): Promise<boolean> {
    const pending =
      this._pendingRefresh ?? (this._refreshPolicy.due ? this.refresh() : null);
    if (!pending) {
      return false;
    }
    await Promise.race([
      pending,
      new Promise(resolve => window.setTimeout(resolve, 10000))
    ]);
    return names.every(name => this._inKernel(name));
  }

  // UI state.

  setPickModifier(key: 'branch' | 'parallel', value: boolean): void {
    this.pickModifiers = { ...this.pickModifiers, [key]: value };
    this._emit();
  }

  setView(view: ViewKind): void {
    this.view = view;
    if (view !== 'map') {
      this.mapSelection = [];
    }
    this._emit();
  }

  /** The level of detail in force on the bench and in the Code view. */
  get detail(): Detail {
    return this.spaceDetail.detail;
  }

  /** The level of detail in force on the map. */
  get mapDetail(): MapDetail {
    return this.spaceDetail.mapDetail;
  }

  /**
   * The analyst moved the slider of the bench or the Code view: the level is
   * saved, and while it follows the space, it holds until the width of the
   * view reaches another level.
   */
  pickDetail(level: Detail): void {
    this.spaceDetail.pick(level);
    this.settings.set('detail', level);
  }

  /** The analyst moved the slider of the map, which holds until the zoom reaches another level. */
  pickMapDetail(level: MapDetail): void {
    this.spaceDetail.pickMap(level);
    this.settings.set('mapDetail', level);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    setNotebookMeta(this.notebook, { mode });
    this._emit();
  }

  select(name: string | null): void {
    this.selected = name;
    this._emit();
  }

  arm(item: IItem | null): void {
    this.armed = item;
    this._emit();
  }

  toggleCode(cellId: string): void {
    if (!this.codeOpen.delete(cellId)) {
      this.codeOpen.add(cellId);
    }
    this._emit();
  }

  toggleSection(sectionId: string): void {
    if (!this.collapsed.delete(sectionId)) {
      this.collapsed.add(sectionId);
    }
    this._emit();
  }

  setRightTab(tab: 'explore' | 'details'): void {
    this.rightTab = tab;
    this._emit();
  }

  /** An output opened from its miniature: in full, in the cell's details. */
  showOutput(cellId: string, index: number): void {
    this.selectedOutput = { cellId, index };
    this._currentCell = cellId;
    this.rightTab = 'details';
    this._emit();
  }

  closeAsk(): void {
    this.ask = null;
    this._emit();
  }

  /**
   * Close the questions as Escape and their close button do: questions about
   * cells picked on the map, or about a text, also let go of the pick, so
   * that Enter on the cell opens its questions again.
   */
  dismissAsk(): void {
    if (this.ask?.kind === 'cells' || this.ask?.kind === 'note') {
      this.setMapSelection([], null);
    } else {
      this.closeAsk();
    }
  }

  // Moving and deleting cells.

  /** Whether a cell can move one place up (-1) or down (+1) in the notebook. */
  canMove(cellId: string, by: -1 | 1): boolean {
    return this._moveOf(cellId, by) !== null;
  }

  /**
   * Move a cell one place up or down in the notebook, past a text too. A
   * cell moves with the branches that follow it, past the next cell and its
   * branches, so that Run all runs a parent before its branches. A branch
   * moves among the branches of its parent.
   */
  moveCell(cellId: string, by: -1 | 1): void {
    const move = this._moveOf(cellId, by);
    if (move) {
      this.notebook.sharedModel.moveCells(move.from, move.to, move.count);
      this._emit();
    }
  }

  /**
   * The cells that Move up or Move down moves, as `moveCells` takes them,
   * or null when the cell cannot move that way.
   */
  private _moveOf(
    cellId: string,
    by: -1 | 1
  ): { from: number; to: number; count: number } | null {
    const cells = this.cells();
    const cell = cells.find(item => item.id === cellId);
    if (!cell) {
      return null;
    }
    const index = cell.index;
    if (cell.branchOf) {
      const other = cells[index + by];
      return other?.branchOf === cell.branchOf
        ? { from: index, to: index + by, count: 1 }
        : null;
    }
    // A cell and the branches of it that follow it move as one.
    const end = (start: number) => {
      let next = start + 1;
      while (next < cells.length && cells[next].branchOf === cells[start].id) {
        next++;
      }
      return next;
    };
    const last = end(index);
    const count = last - index;
    if (by > 0) {
      // After the next cell and its branches: `to` is its last cell.
      return last < cells.length
        ? { from: index, to: end(last) - 1, count }
        : null;
    }
    if (index === 0) {
      return null;
    }
    // Before the cell above, or before the parent of the branches above.
    let to = index - 1;
    const parent = cells[to].branchOf;
    if (parent) {
      let first = to;
      while (first > 0 && cells[first - 1].branchOf === parent) {
        first--;
      }
      if (first > 0 && cells[first - 1].id === parent) {
        to = first - 1;
      }
    }
    return { from: index, to, count };
  }

  /** Move a cell to a place in the notebook's order, as a drag does. */
  moveCellTo(cellId: string, to: number): void {
    const from = indexOf(this.notebook, cellId);
    const last = this.notebook.cells.length - 1;
    const target = Math.max(0, Math.min(last, to));
    if (from < 0 || from === target) {
      return;
    }
    this.notebook.sharedModel.moveCell(from, target);
    this._emit();
  }

  /**
   * Delete a cell. The result holds what Undo needs to put it back as it
   * was, with its id, outputs and metadata, and the cells that use names it
   * defines, which the notice of the delete names.
   */
  deleteCell(cellId: string): IDeletedCell | null {
    const saved = this._savedCell(cellId);
    if (!saved) {
      return null;
    }
    const strip = this.strips.get(cellId);
    if (strip?.status === 'writing' && !strip.agent) {
      // The model writes an answer about the cell: its strip stays where
      // the cell was, and the answer waits there when it comes.
      strip.gone = saved;
    } else {
      this.strips.delete(cellId);
    }
    if (this.selectedOutput?.cellId === cellId) {
      this.selectedOutput = null;
    }
    const ask = this.ask as { cellId?: string } | null;
    if (ask?.cellId === cellId) {
      this.ask = null;
    }
    this.notebook.sharedModel.deleteCell(saved.index);
    this._emit();
    return saved;
  }

  /**
   * What Undo needs to put a cell back as it is now: the cell with its id,
   * outputs and metadata, its place, and the labels of the cells that use
   * names it defines.
   */
  private _savedCell(cellId: string): IDeletedCell | null {
    const index = indexOf(this.notebook, cellId);
    if (index < 0) {
      return null;
    }
    const cell = this.cell(cellId);
    const defs = new Set(cell?.analysis?.defs ?? []);
    const users = defs.size
      ? this.codeCells()
          .filter(
            other =>
              other.id !== cellId &&
              (other.analysis?.uses ?? []).some(name => defs.has(name))
          )
          .map(other => other.label)
      : [];
    return {
      index,
      before: index > 0 ? this.notebook.cells.get(index - 1).id : null,
      after:
        index + 1 < this.notebook.cells.length
          ? this.notebook.cells.get(index + 1).id
          : null,
      cell: this.notebook.cells.get(index).toJSON(),
      label: cell?.label ?? '',
      title: cell?.title ?? '',
      users
    };
  }

  /**
   * Put a deleted cell back in its place, with its id, outputs and metadata:
   * after the cell it followed, else before the cell that followed it, else
   * at its old index. A cell that is back already, as after the Undo of the
   * notebook view on the same file, is not added again.
   */
  restoreCell(saved: IDeletedCell): void {
    const id = saved.cell.id;
    if (typeof id === 'string' && indexOf(this.notebook, id) >= 0) {
      return;
    }
    this.notebook.sharedModel.insertCell(this._placeOf(saved), saved.cell);
    // An answer that the model writes about the cell has its strip under
    // the cell again.
    const strip = typeof id === 'string' ? this.strips.get(id) : undefined;
    if (strip) {
      strip.gone = null;
    }
    this._emit();
  }

  /** The index where a deleted cell goes back: see restoreCell. */
  private _placeOf(saved: IDeletedCell): number {
    const before = saved.before ? indexOf(this.notebook, saved.before) : -1;
    const after = saved.after ? indexOf(this.notebook, saved.after) : -1;
    return before >= 0
      ? before + 1
      : after >= 0
        ? after
        : Math.min(saved.index, this.notebook.cells.length);
  }

  /**
   * The strips of answers whose cell the analyst deleted while the model
   * wrote them, by the cell that is now just before the deleted cell's
   * place: null for the start of the notebook. Unless `flat`, the key is
   * the cell whose card the bench draws the strip after: a branch's parent,
   * and null for the notebook's title.
   */
  goneStrips(flat = false): Map<string | null, IStrip[]> {
    const slots = new Map<string | null, IStrip[]>();
    for (const strip of this.strips.values()) {
      const gone = strip.gone;
      if (!gone || indexOf(this.notebook, strip.cellId) >= 0) {
        continue;
      }
      const index = this._placeOf(gone);
      let key = index > 0 ? this.notebook.cells.get(index - 1).id : null;
      const before = key && !flat ? this.cell(key) : null;
      if (before) {
        // The title shows above the sections, as the first heading of level 1.
        const title = this.cells().find(cell => cell.heading?.level === 1);
        key = before.id === title?.id ? null : (before.branchOf ?? before.id);
      }
      slots.set(key, [...(slots.get(key) ?? []), strip]);
    }
    return slots;
  }

  /**
   * Show a question request made in another module, such as the questions
   * about a table (./tableask.ts), and draw it again as it fills in.
   */
  showAsk(ask: Ask | null): void {
    this.ask = ask;
    this._emit();
  }

  /** Offer to run the cells that make what a request needs, then ask again. */
  needData(
    ask: Ask,
    names: string[],
    before: string | null,
    resume: () => void
  ): Promise<void> {
    return this._needs(ask, names, before, resume);
  }

  /**
   * Close the answer in the sidebar. An answer that the model still writes
   * stops, and its code does not run when it comes.
   */
  closePreview(): void {
    const preview = this.preview;
    if (preview) {
      this._stopWriting(preview);
    }
    this.preview = null;
    this._emit();
  }

  setMapSelection(ids: string[], anchor: IAnchor | null): void {
    this.mapSelection = ids;
    const only = ids.length === 1 ? this.cell(ids[0]) : null;
    if (only) {
      // The cell's details follow a cell picked on the map.
      this._currentCell = only.id;
    }
    if (only?.type === 'markdown') {
      void this.askNote(only.id, anchor);
    } else if (ids.length) {
      void this.askCells(ids, anchor);
    } else if (this.ask?.kind === 'cells' || this.ask?.kind === 'note') {
      this.ask = null;
    }
    this._emit();
  }

  /**
   * A click on a variable or a column.
   *
   * With nothing picked, a variable click selects it for Contents, and a
   * column click picks the column as the source. A variable click picks
   * nothing in either way of asking: an analyst who opens a frame to find
   * a column would pick the frame (design iteration 1.77), and Pick in
   * Contents picks a whole variable. With a source picked, the click picks
   * the target: another item, or the same item again for questions about
   * it alone.
   */
  pick(
    item: IItem,
    modifiers: { branch: boolean; parallel: boolean },
    anchor: IAnchor | null
  ): void {
    if (this.armed) {
      const source = this.armed;
      this.armed = null;
      void this.askDrop(source, { item }, modifiers, anchor);
      return;
    }
    if (item.kind === 'variable') {
      this.selected = item.name;
    } else {
      this.armed = item;
    }
    this._emit();
  }

  /**
   * Pick a cell as the target of the picked source.
   */
  pickCell(
    cellId: string,
    modifiers: { branch: boolean; parallel: boolean },
    anchor: IAnchor | null
  ): void {
    const source = this.armed;
    if (!source) {
      return;
    }
    this.armed = null;
    void this.askDrop(source, { cellId }, modifiers, anchor);
  }

  /**
   * Files dropped from the file browser: onto a cell, or onto the view to
   * start from them. One file at a time.
   */
  askFileDrop(
    paths: string[],
    target: { cellId?: string },
    anchor: IAnchor | null
  ): void {
    const path = paths[0];
    const item: IItem = {
      kind: 'file',
      name: path,
      label: PathExt.basename(path),
      path
    };
    this.arm(null);
    void this.askDrop(item, target, { branch: false, parallel: false }, anchor);
  }

  /**
   * Run every code cell in order; branches run in their subshells, together.
   * A cell that names something a running branch defines waits for that
   * branch: a question asked about a branch's rows is a cell after the
   * branch. The source decides, as the kernel's analysis lists only the
   * names the kernel has, and a fresh kernel has none.
   */
  async runAll(): Promise<void> {
    if (!this.sessionContext.session?.kernel) {
      await this.sessionContext.startKernel();
    }
    const running: { defs: string[] | null; done: Promise<void> }[] = [];
    const cells = this.codeCells();
    // The toolbar counts the cells of the run from its first: "1/5 cells".
    this.jobs.tally.plan(cells.length);
    for (const cell of cells) {
      const source = cell.model.sharedModel.getSource();
      const before = running.filter(
        branch =>
          branch.defs === null ||
          branch.defs.some(name => namesIn(source, name))
      );
      await Promise.all(before.map(branch => branch.done));
      // The cells of Run all are not the cell the analyst worked on last.
      if (cell.branchOf) {
        running.push({
          defs: cell.analysis ? cell.analysis.defs : null,
          // A failed branch does not stop the run; its cell shows the error.
          done: this.runCell(cell.id, { acted: false }).catch(() => undefined)
        });
      } else {
        await this.runCell(cell.id, { acted: false });
      }
    }
    await Promise.all(running.map(branch => branch.done));
  }

  /**
   * Ask about a data node of the map: the frame's own questions, with its
   * columns either in Contents or in the popover, as the setting says.
   */
  askData(name: string, anchor: IAnchor | null): void {
    this.selected = name;
    const columns = this.settings.mapColumns === 'popover';
    if (!columns) {
      this.settings.requestReveal();
    }
    const item: IItem = { kind: 'variable', name, label: name };
    if (!this._inKernel(name)) {
      const ask: IDropAsk = {
        kind: 'drop',
        id: ++counter,
        anchor,
        loading: true,
        error: null,
        source: item,
        target: { item },
        modifiers: { branch: false, parallel: false },
        result: null,
        checked: [],
        claudeStage: null,
        popover: true
      };
      this.ask = ask;
      this._emit();
      void this._needs(
        ask,
        [name],
        null,
        () => this.askData(name, anchor),
        'variable'
      );
      return;
    }
    void this.askDrop(
      item,
      { item },
      { branch: false, parallel: false },
      anchor,
      { popover: true, columns }
    );
  }

  /**
   * Run the cells the plan names, then ask again. Starts the kernel first
   * when there is none.
   */
  async runMissing(all: boolean): Promise<void> {
    const ask = this.ask;
    const missing = ask?.missing;
    if (!missing || !missing.plan || missing.running) {
      return;
    }
    missing.running = true;
    this._emit();
    try {
      if (!this.sessionContext.session?.kernel) {
        await this.sessionContext.startKernel();
      }
      if (all) {
        await this.runAll();
      } else {
        for (const cellId of missing.plan) {
          await this.runCell(cellId);
        }
      }
      await this.refresh();
    } catch (error) {
      ask.error = describeError(error);
      missing.running = false;
      this._emit();
      return;
    }
    if (this.ask === ask) {
      missing.resume();
    }
  }

  /**
   * Hand the names the source did not explain to Claude.
   */
  async askClaudeForMissing(): Promise<void> {
    const missing = this.ask?.missing;
    if (!missing || missing.claude) {
      return;
    }
    missing.claude = { stage: 'starting', reason: null };
    this._emit();
    try {
      await this.api.claudeDependencies(
        {
          cells: this.codeCells().map(cell => ({
            id: cell.id,
            label: cell.label,
            source: cell.model.sharedModel.getSource()
          })),
          names: missing.names,
          unresolved: missing.unresolved
        },
        event => {
          if (event.type === 'progress') {
            missing.claude = { stage: event.stage, reason: null };
          } else if (event.type === 'result') {
            const plan = event.plan as {
              cells: string[];
              reason: string;
            };
            missing.plan = [
              ...new Set([...(missing.plan ?? []), ...plan.cells])
            ];
            const order = this.codeCells().map(cell => cell.id);
            missing.plan.sort((a, b) => order.indexOf(a) - order.indexOf(b));
            missing.claude = { stage: null, reason: plan.reason };
          } else if (event.type === 'error') {
            missing.claude = { stage: null, reason: event.message };
          }
          this._emit();
        }
      );
    } catch (error) {
      missing.claude = { stage: null, reason: describeError(error) };
      this._emit();
    }
  }

  /**
   * The frame that has every column a plot shows: the one with as many rows
   * as the plot has marks first, as when the plot drew each row.
   */
  private _frameWith(plot: IPlotPayload): string | null {
    const { x, y, by, rows } = plot.source;
    const wanted = [x, y, by].filter((name): name is string => !!name);
    const frames = this.variables().filter(
      variable =>
        !variable.stale &&
        wanted.every(name =>
          variable.columns?.some(column => column.label === name)
        )
    );
    return (
      (frames.find(frame => frame.rows === rows) ?? frames[0])?.name ?? null
    );
  }

  /** Whether the kernel holds a variable of this name, as last listed. */
  private _inKernel(name: string): boolean {
    const variable = this.variable(name);
    return (
      !!this.sessionContext.session?.kernel && !!variable && !variable.stale
    );
  }

  /** The variable an item stands for, when the view shows it from the last run. */
  private _staleName(item: IItem): string | null {
    const name =
      item.kind === 'variable'
        ? item.name
        : item.kind === 'column'
          ? (item.parent ?? null)
          : null;
    return name && this.variable(name)?.stale ? name : null;
  }

  private _storedVariables(): IStoredVariable[] {
    return notebookMeta(this.notebook).variables ?? [];
  }

  /**
   * Whether the cell ran in the current kernel, from this view or another,
   * and its last run ended without an error: a cell that raised may not have
   * made what it defines.
   */
  private _ranHere(cellId: string): boolean {
    const cell = findCell(this.notebook, cellId);
    return !!cell && this.bridge.ranWithoutError(cell.sharedModel.getSource());
  }

  /**
   * Keep the variables and the analysis in the notebook, so that the view
   * opens as it was left, and survives a restart of the kernel.
   */
  private _keep(change: 'variables' | 'analysis'): void {
    if (change === 'variables') {
      const snapshot = this.bridge.snapshot;
      let next: IStoredVariable[] | null;
      if (!snapshot || snapshot.variables.length === 0) {
        // A fresh kernel lists nothing yet: the kept list stays, less the
        // text of a secret and the variables whose cell is gone, which a
        // notebook saved by an older version may hold.
        next = keptWithout(this._storedVariables(), cellId =>
          Boolean(findCell(this.notebook, cellId))
        );
      } else {
        const definitions = this.definitions();
        next = toStore(
          this.variables(),
          this._storedVariables(),
          name => definitions.get(name)?.id ?? null
        );
      }
      if (next) {
        setNotebookMeta(this.notebook, { variables: next });
      }
      return;
    }
    for (const cell of this.codeCells()) {
      const source = cell.model.sharedModel.getSource();
      const fresh = this.bridge.freshAnalysis(cell.id, source);
      // The kernel analyses a cell against the names it holds, so before the
      // cell runs, its analysis lacks the names it uses and its decisions:
      // the kept one stays, and opening a notebook does not change it.
      if (!fresh || !this.bridge.hasRun(source)) {
        continue;
      }
      const kept = storedAnalysis(fresh, source);
      if (JSON.stringify(kept) !== JSON.stringify(cell.meta.analysis)) {
        setCellMeta(cell.model, { analysis: kept });
      }
    }
  }

  /**
   * Mark the request as needing data, with a plan read from the source.
   */
  private async _needs(
    ask: Ask,
    names: string[],
    before: string | null,
    resume: () => void,
    from: IMissing['from'] = 'output'
  ): Promise<void> {
    if (this._stopUnsupported(ask)) {
      return;
    }
    if (await this._listedAfterRefresh(names)) {
      resume();
      return;
    }
    const noKernel = !this.sessionContext.session?.kernel;
    const available = noKernel
      ? []
      : (this.bridge.snapshot?.variables ?? []).map(v => v.name);
    ask.missing = {
      names,
      noKernel,
      nothingRan: available.length === 0,
      from,
      plan: null,
      unresolved: [],
      running: false,
      claude: null,
      resume
    };
    ask.loading = false;
    this._emit();
    try {
      const plan = await this.api.dependencies({
        cells: this.codeCells()
          .filter(cell => !cell.branchOf)
          .map(cell => ({
            id: cell.id,
            source: cell.model.sharedModel.getSource()
          })),
        names,
        available,
        before
      });
      ask.missing.plan = plan.cells;
      ask.missing.unresolved = plan.unresolved;
    } catch (error) {
      ask.error = describeError(error);
    }
    this._emit();
  }

  /**
   * Offer to run the cells that a cell needs, when the questions edit, branch
   * or follow that cell and the kernel lacks the names it uses: after a
   * restart, or before the cells above it ran. An edit in place ran its cell
   * without them and raised a NameError. A reading of the source finds the
   * cells that make the names (the `dependencies` route), as for a variable
   * from the last run. True when the request waits for these cells.
   */
  private async _cellNeeds(
    ask: Ask,
    cell: IEpiCell | null,
    resume: () => void
  ): Promise<boolean> {
    if (!cell || cell.type !== 'code' || this._ranHere(cell.id)) {
      return false;
    }
    const noKernel = !this.sessionContext.session?.kernel;
    const available = noKernel ? [] : [...this._kernelNames()];
    let plan: { cells: string[]; unresolved: string[]; inputs?: string[] };
    try {
      plan = await this.api.dependencies({
        cells: this.codeCells()
          .filter(other => !other.branchOf || other.id === cell.id)
          .map(other => ({
            id: other.id,
            source: other.model.sharedModel.getSource()
          })),
        names: [],
        available,
        before: cell.id
      });
    } catch (error) {
      // Without a reading of the source, the questions show as they did.
      console.warn('Could not read what the cell needs', error);
      return false;
    }
    const first = plan.cells.filter(id => id !== cell.id);
    if (!first.length || this.ask !== ask) {
      return false;
    }
    ask.missing = {
      names: plan.inputs ?? [],
      noKernel,
      nothingRan: (this.bridge.snapshot?.variables ?? []).length === 0,
      from: 'cell',
      cell: cell.label,
      plan: first,
      unresolved: [],
      running: false,
      claude: null,
      resume
    };
    ask.loading = false;
    this._emit();
    return true;
  }

  /**
   * The names in the kernel, as far as the view can tell: its variables, and
   * the modules and functions that cells use, which the kernel's analysis of
   * a cell lists only when they are in its namespace.
   */
  private _kernelNames(): Set<string> {
    const names = new Set(
      (this.bridge.snapshot?.variables ?? []).map(variable => variable.name)
    );
    for (const cell of this.codeCells()) {
      const fresh = this.bridge.freshAnalysis(
        cell.id,
        cell.model.sharedModel.getSource()
      );
      fresh?.uses.forEach(name => names.add(name));
    }
    return names;
  }

  touch(item: IItem): void {
    this.touched.add(
      item.kind === 'column' && item.parent
        ? `${item.parent}\u0000${item.label}`
        : item.name
    );
  }

  async askDrop(
    source: IItem,
    target: { cellId?: string; item?: IItem },
    modifiers: { branch: boolean; parallel: boolean },
    anchor: IAnchor | null,
    options: { popover?: boolean; columns?: boolean } = {}
  ): Promise<void> {
    const ask: IDropAsk = {
      kind: 'drop',
      id: ++counter,
      anchor,
      loading: true,
      error: null,
      source,
      target,
      modifiers,
      result: null,
      checked: [],
      claudeStage: null,
      ...options
    };
    this.ask = ask;
    this.touch(source);
    if (target.item) {
      this.touch(target.item);
    }
    this._emit();
    if (this._stopUnsupported(ask)) {
      return;
    }
    const cell = target.cellId ? this.cell(target.cellId) : null;
    // A variable from the last run is not in the kernel: its questions would
    // run code on nothing. Offer to run the cells that make it first.
    const stale = [source, target.item]
      .map(item => (item ? this._staleName(item) : null))
      .filter((name): name is string => name !== null);
    if (stale.length) {
      void this._needs(
        ask,
        [...new Set(stale)],
        null,
        () => this.askDrop(source, target, modifiers, anchor, options),
        'variable'
      );
      return;
    }
    // The questions edit the cell, branch it or follow it: the names it uses
    // come first.
    if (
      await this._cellNeeds(ask, cell, () =>
        this.askDrop(source, target, modifiers, anchor, options)
      )
    ) {
      return;
    }
    try {
      const result = await this.api.drop({
        source: this.itemJSON(source),
        target: cell
          ? { cell: this.cellJSON(cell) }
          : { item: target.item ? this.itemJSON(target.item) : null },
        modifiers,
        cells: this.codeCells().map(c => this.cellJSON(c)),
        context: this.serverContext()
      });
      ask.result = result;
      // Without a model, a question that needs AI stays in the checklist,
      // greyed and unchecked: it was checked, counted in "Start 3 branches",
      // and started as a branch that failed.
      const off = this.aiOff();
      ask.checked = result.preselected.filter(id => {
        const option = result.options.find(item => item.id === id);
        return !off || !option || !!option.code;
      });
      void this._orderByModel(
        ask,
        () => ask.result?.options ?? [],
        sorted => {
          if (ask.result) {
            ask.result.options = sorted;
          }
        },
        {
          source: this.itemJSON(source),
          target: target.item ? this.itemJSON(target.item) : null
        }
      );
      // The model writes questions in the background, next to the templates'.
      this._askModelToo(ask);
    } catch (error) {
      ask.error = describeError(error);
    }
    ask.loading = false;
    this._emit();
  }

  /** What-if branches for the value that a decision chip of a cell shows. */
  async askDecision(
    cellId: string,
    decision: IDecision,
    anchor: IAnchor | null
  ): Promise<void> {
    const cell = this.cell(cellId);
    if (!cell) {
      return;
    }
    const ask: IDecisionAsk = {
      kind: 'decision',
      id: ++counter,
      anchor,
      loading: true,
      error: null,
      cellId,
      decision,
      where: null,
      note: '',
      options: [],
      valueError: null
    };
    this.ask = ask;
    this._emit();
    if (this._stopUnsupported(ask)) {
      return;
    }
    // Each value runs in a branch of the cell, which needs what the cell uses.
    if (
      await this._cellNeeds(
        ask,
        cell,
        () => void this.askDecision(cellId, decision, anchor)
      )
    ) {
      return;
    }
    await this._decisionOptions(ask, cell);
  }

  /**
   * Which call of the decision asked about a what-if value goes into, by its
   * index in the decision's calls, or null for all of them; the values
   * offered say where.
   */
  async setDecisionWhere(where: number | null): Promise<void> {
    const ask = this.ask;
    const cell = ask?.kind === 'decision' ? this.cell(ask.cellId) : null;
    if (ask?.kind !== 'decision' || !cell || ask.where === where) {
      return;
    }
    ask.where = where;
    ask.loading = true;
    ask.error = null;
    ask.valueError = null;
    this._emit();
    await this._decisionOptions(ask, cell);
  }

  /** The calls that a what-if value of the decision asked about goes into, for the server. */
  private _decisionCalls(ask: IDecisionAsk): IDecision['calls'] | undefined {
    const call =
      ask.where === null ? undefined : callsOf(ask.decision)[ask.where];
    return call ? [call] : undefined;
  }

  /**
   * The questions of a chip: other values of its constant, by its kind. When
   * no rule knows the kind, the model chosen for More questions suggests
   * values, once per constant while the page is open; without a model, or
   * when the notebook's answers reached its cap, the values are half below
   * and above, and the questions say that a model would suggest others.
   */
  private async _decisionOptions(
    ask: IDecisionAsk,
    cell: IEpiCell
  ): Promise<void> {
    const where = ask.where;
    const key = this._valuesKey(ask);
    const found = this._modelValues?.get(key);
    try {
      const result = await this.api.decisionOptions({
        cell: this.cellJSON(cell),
        decision: ask.decision,
        context: this.serverContext(),
        calls: this._decisionCalls(ask),
        ...(found ? { suggested: found.values } : {})
      });
      // The analyst chose another call while this one was asked about.
      if (this.ask !== ask || ask.where !== where) {
        return;
      }
      ask.options = found
        ? markModelValues(result.options, found)
        : result.options;
      // The server names defaults, literals and the AI's values; a value the
      // analyst chose is theirs.
      ask.note =
        result.note ||
        (ask.decision.provenance === 'you' ? 'chosen by you' : '');
      if (found) {
        ask.values = {
          by: 'model',
          kind: found.kind || null,
          rule: null,
          why: null,
          model: found.by
        };
      } else if (result.ask_model) {
        const off = noModelNote(
          'values',
          this._taskOff('questions'),
          this._capHolds('questions')
        );
        ask.values = {
          by: off ? 'fallback' : 'asking',
          kind: null,
          rule: result.rule ?? null,
          why: off,
          stage: off ? null : 'starting'
        };
        if (!off) {
          void this._valuesFromModel(ask, cell, key);
        }
      } else {
        ask.values = {
          by: 'rules',
          kind: result.kind ?? null,
          rule: result.rule ?? null,
          why: null
        };
      }
    } catch (error) {
      if (this.ask !== ask || ask.where !== where) {
        return;
      }
      ask.error = describeError(error);
    }
    ask.loading = false;
    this._emit();
  }

  /** The constant asked about, by its cell and its decision: the model's values are the same for each call. */
  private _valuesKey(ask: IDecisionAsk): string {
    return `${ask.cellId}\u0000${decisionKey(ask.decision)}`;
  }

  /**
   * Ask the model chosen for More questions for values of a constant that no
   * rule knows, and show them in the questions of its chip. The values are
   * kept while the page is open: another click on the chip, or another
   * call, does not ask again. A request already on its way is not repeated.
   */
  private async _valuesFromModel(
    ask: IDecisionAsk,
    cell: IEpiCell,
    key: string
  ): Promise<void> {
    const asked = (this._valuesAsked ??= new Set());
    if (asked.has(key)) {
      return;
    }
    asked.add(key);
    const choice = choiceOf(this.settings.models, 'questions');
    // What the stream gave, filled by its events.
    const got: { found: IModelValues | null; failure: string | null } = {
      found: null,
      failure: null
    };
    try {
      await this.api.decisionValues(
        { cell: this.cellJSON(cell), decision: ask.decision, model: choice },
        event => {
          if (event.type === 'progress') {
            const current = this.ask;
            if (
              current?.kind === 'decision' &&
              this._valuesKey(current) === key &&
              current.values?.by === 'asking'
            ) {
              current.values = { ...current.values, stage: event.stage };
              this._emit();
            }
          } else if (event.type === 'result') {
            got.found = {
              kind: typeof event.kind === 'string' ? event.kind : '',
              values: Array.isArray(event.values)
                ? (event.values as IModelValues['values'])
                : [],
              by: writtenBy(choice, event.model, event.file),
              origin: isRemote(choice) ? 'claude' : 'local'
            };
          } else {
            got.failure = event.message;
          }
        }
      );
    } catch (error) {
      got.failure = describeError(error);
    }
    asked.delete(key);
    const found = got.found;
    if (found) {
      (this._modelValues ??= new Map()).set(key, found);
    }
    // The questions of the chip, if they are still open: the analyst may have
    // closed them, or chosen another call of the decision, meanwhile.
    const current = this.ask;
    const shown =
      current?.kind === 'decision' ? this.cell(current.cellId) : null;
    if (
      current?.kind !== 'decision' ||
      !shown ||
      this._valuesKey(current) !== key
    ) {
      return;
    }
    if (found) {
      await this._decisionOptions(current, shown);
      return;
    }
    current.values = {
      by: 'fallback',
      kind: null,
      rule: current.values?.rule ?? null,
      why: `The AI model could not suggest values: ${(got.failure ?? 'it gave no answer').replace(/\.$/, '')}.`
    };
    this._emit();
  }

  /**
   * Why the model of a task cannot run, as the questions say it, or null when
   * it can: the settings turn it off, or the server has no model that runs.
   */
  private _taskOff(task: Task): string | null {
    if (this.aiReady(task)) {
      return null;
    }
    const choice = choiceOf(this.settings.models, task);
    if (choice === 'off') {
      return 'AI is off for this task in the AI models panel';
    }
    if (isRemote(choice)) {
      return (
        otherProviderReason(this.status, choice) ??
        this.status?.claude?.reason ??
        (this.status
          ? 'no AI model is set up on the server'
          : 'the server did not answer')
      ).replace(/\.$/, '');
    }
    return (
      this.status?.local_models?.find(model => model.id === choice)?.reason ??
      `${modelName(this.status, choice)} cannot run`
    ).replace(/\.$/, '');
  }

  /**
   * Whether the notebook's cap holds a task's call: the setting shows the
   * cost, the task asks the connected model, whose price is known, and the
   * notebook's AI answers reached the cap. A local model costs nothing.
   */
  private _capHolds(task: Task): boolean {
    return (
      !!this.settings.showCost &&
      isRemote(choiceOf(this.settings.models, task)) &&
      this.status?.claude?.priced !== false &&
      capReached(this.cost().usd, this.costCap())
    );
  }

  /**
   * Why the model of a task cannot run, or null: for a part of the view that
   * asks a model itself, such as the check-up (./checkup.ts).
   */
  taskOff(task: Task): string | null {
    return this._taskOff(task);
  }

  /** Whether the notebook's cap holds a call of this task: for the same parts. */
  capHolds(task: Task): boolean {
    return this._capHolds(task);
  }

  /** Tries a value the analyst typed for the decision asked about, in a branch. */
  async tryDecisionValue(value: string): Promise<void> {
    const ask = this.ask;
    const cell = ask?.kind === 'decision' ? this.cell(ask.cellId) : null;
    if (ask?.kind !== 'decision' || !cell) {
      return;
    }
    ask.valueError = null;
    try {
      const result = await this.api.decisionOptions({
        cell: this.cellJSON(cell),
        decision: ask.decision,
        context: this.serverContext(),
        value,
        calls: this._decisionCalls(ask)
      });
      const option = result.options[0];
      if (!option) {
        ask.valueError = `${ask.decision.name} cannot be changed in the code of ${cell.label}`;
      } else {
        // The value is the analyst's, as typed: its chip will show it.
        ask.typed = value;
        await this.apply(option);
        return;
      }
    } catch (error) {
      ask.valueError = describeError(error);
    }
    this._emit();
  }

  async askCells(cellIds: string[], anchor: IAnchor | null): Promise<void> {
    const ask: ICellsAsk = {
      kind: 'cells',
      id: ++counter,
      anchor,
      loading: true,
      error: null,
      cells: cellIds,
      options: []
    };
    this.ask = ask;
    this._emit();
    if (this._stopUnsupported(ask)) {
      return;
    }
    // The questions of one cell edit, branch or follow it.
    const only = cellIds.length === 1 ? this.cell(cellIds[0]) : null;
    if (
      await this._cellNeeds(
        ask,
        only,
        () => void this.askCells(cellIds, anchor)
      )
    ) {
      return;
    }
    try {
      const cells = cellIds
        .map(id => this.cell(id))
        .filter(Boolean) as IEpiCell[];
      const result = await this.api.cellQuestions({
        cells: cells.map(c => this.cellJSON(c)),
        context: this.serverContext()
      });
      ask.options = [
        ...result.questions,
        ...(only ? this._yourValueQuestions(only) : [])
      ];
      void this._orderByModel(
        ask,
        () => ask.options,
        sorted => {
          ask.options = sorted;
        },
        null
      );
    } catch (error) {
      ask.error = describeError(error);
    }
    ask.loading = false;
    this._emit();
  }

  /**
   * Questions about the text of a markdown cell, or about the words
   * selected in it. The numbers the text states are checked against the
   * outputs at once, in the view; the questions come from the server.
   */
  async askNote(
    cellId: string,
    anchor: IAnchor | null,
    claim: string | null = null
  ): Promise<void> {
    const cell = this.cell(cellId);
    if (!cell || cell.type !== 'markdown') {
      return;
    }
    const text = claim ?? noteBody(cell.model.sharedModel.getSource());
    const ask: INoteAsk = {
      kind: 'note',
      id: ++counter,
      anchor,
      loading: true,
      error: null,
      cellId,
      claim,
      numbers: checkNumbers(text, this._sourceTexts()),
      options: []
    };
    this.ask = ask;
    this._emit();
    if (this._stopUnsupported(ask)) {
      return;
    }
    try {
      const result = await this.api.cellQuestions({
        cells: [{ ...this.cellJSON(cell), source: text, excerpt: !!claim }],
        context: this.serverContext()
      });
      ask.options = result.questions;
      void this._orderByModel(
        ask,
        () => ask.options,
        sorted => {
          ask.options = sorted;
        },
        null
      );
    } catch (error) {
      ask.error = describeError(error);
    }
    ask.loading = false;
    this._emit();
  }

  /** The outputs of the code cells as text, and their code, to find numbers in. */
  private _sourceTexts(): ISourceText[] {
    const texts: ISourceText[] = [];
    for (const cell of this.codeCells()) {
      texts.push({
        cellId: cell.id,
        output: -1,
        text: cell.model.sharedModel.getSource()
      });
      outputsOf(cell.model).forEach((output, index) => {
        const kind = outputKind(output);
        let text = '';
        if (kind === 'table') {
          text = htmlText(String(output.data['text/html'] ?? ''));
        } else if (kind === 'log' || kind === 'text') {
          text = outputText(output.data)?.lines.join('\n') ?? '';
        }
        if (text) {
          texts.push({ cellId: cell.id, output: index, text });
        }
      });
    }
    return texts;
  }

  async askRegion(
    cellId: string,
    plot: IPlotPayload,
    x0: number,
    x1: number,
    anchor: IAnchor | null,
    y: [number, number] | null = null
  ): Promise<void> {
    if (!plot.source.frame) {
      // A chart of another library names its columns, and not always its frame.
      const frame = this._frameWith(plot);
      plot = frame ? { ...plot, source: { ...plot.source, frame } } : plot;
    }
    const values =
      plot.kind === 'bars'
        ? (plot.bars ?? []).slice(x0, x1 + 1).map(bar => bar.x)
        : null;
    const ask: IRegionAsk = {
      kind: 'region',
      id: ++counter,
      anchor,
      loading: true,
      error: null,
      cellId,
      plot,
      x0,
      x1,
      values,
      y: plot.source.y ? y : null,
      summary: null,
      options: []
    };
    this.ask = ask;
    this._emit();
    if (this._stopUnsupported(ask)) {
      return;
    }
    const unit = notebookMeta(this.notebook).unit;
    const frame = plot.source.frame;
    const resume = () => void this.askRegion(cellId, plot, x0, x1, anchor, y);
    if (frame && !this._inKernel(frame)) {
      // The plot is from an earlier run: its rows are not in the kernel.
      await this._needs(ask, [frame], cellId, resume);
      return;
    }
    try {
      if (!frame) {
        const { x, y, by } = plot.source;
        const columns = [x, y, by].filter(name => !!name).join(', ');
        throw new Error(
          `No data frame in the kernel has the columns ${columns}`
        );
      }
      const summary = await this.bridge.run<
        IRegionSummary & { error?: string }
      >('region_summary', {
        frame: plot.source.frame,
        x: plot.source.x,
        x0,
        x1,
        values,
        y: plot.source.y,
        y0: ask.y?.[0],
        y1: ask.y?.[1],
        by: plot.source.by,
        unit
      });
      if (summary.error) {
        await this._needs(ask, [frame], cellId, resume);
        return;
      }
      ask.summary = summary;
      ask.options = values
        ? this._barOptions(ask, unit)
        : this._regionOptions(ask, unit);
      const cell = this.cell(cellId);
      if (cell) {
        const result = await this.api.cellQuestions({
          cells: [this.cellJSON(cell)],
          context: this.serverContext()
        });
        const sweeps = result.questions
          .filter(q => q.placement?.kind === 'branch' && q.code)
          .slice(0, 1);
        ask.options = [
          ...ask.options,
          ...sweeps.map(q => ({
            ...q,
            text: q.text.replace(
              /change what .* shows\?/,
              'change this picture?'
            )
          }))
        ];
      }
    } catch (error) {
      ask.error = describeError(error);
    }
    ask.loading = false;
    this._emit();
  }

  /** Ask the same drop again with "explore in parallel" turned on or off. */
  toggleParallel(): void {
    const ask = this.ask;
    if (ask?.kind !== 'drop') {
      return;
    }
    void this.askDrop(
      ask.source,
      ask.target,
      { ...ask.modifiers, parallel: !ask.modifiers.parallel },
      ask.anchor,
      { popover: ask.popover, columns: ask.columns }
    );
  }

  toggleChecked(optionId: string): void {
    if (this.ask?.kind !== 'drop') {
      return;
    }
    const checked = this.ask.checked;
    const index = checked.indexOf(optionId);
    if (index >= 0) {
      checked.splice(index, 1);
    } else {
      checked.push(optionId);
    }
    this._emit();
  }

  /**
   * The placement an option would use, labelled with where its new cell
   * goes now: below the cell the question is about, which the placement
   * names, and below the last cell that ran (./placement.ts). So a cached
   * question and a template show the same place.
   */
  placementFor(option: IOption): IPlacement | null {
    const placement = option.placement;
    if (placement?.kind !== 'new') {
      return placement;
    }
    const now = this._newPlacement(placement, option.code ?? null);
    return now === placement ? placement : { ...placement, label: now.label };
  }

  /** "More questions from AI": the model chosen for More questions writes questions about what was dropped. */
  async moreFromClaude(): Promise<void> {
    const ask = this.ask;
    if (
      ask?.kind !== 'drop' ||
      (!ask.target.item && !ask.target.cellId) ||
      !ask.result
    ) {
      return;
    }
    await this._moreQuestions(ask, null);
  }

  /**
   * A drop or a click asks the model chosen for More questions for
   * questions in the background, as "More questions from AI" does: the
   * templates' questions show at once, and the model's join them when they
   * come, in the view's order (`rankers.merged_order` on the server). The
   * setting "Questions from a model" asks always, only when no template
   * fits, or never.
   *
   * It asks once per request: the same request again shows the questions it
   * wrote, and one whose call failed waits for the button. Nothing runs by
   * itself. A file or a table that is not loaded yet is not asked about when
   * a template fits it: its templates load it, and the model would read its
   * name alone. Without a model, or at the notebook's cap, the list says
   * that a model would suggest questions where no template fits, and is as
   * it was elsewhere.
   */
  private _askModelToo(ask: IDropAsk): void {
    const result = ask.result;
    if (
      !result ||
      result.mode === 'parallel' ||
      this.settings.offeredQuestions <= 0
    ) {
      return;
    }
    const none = noTemplateFits(result.options);
    ask.noTemplate = none;
    if (
      !asksModel(this.settings.modelQuestions, result.options) ||
      (!none && (ask.source.kind === 'file' || ask.source.kind === 'table'))
    ) {
      return;
    }
    const key = this._requestKey(ask);
    const kept = this._fromModel?.get(key);
    if (kept) {
      // A question asked since goes, as the server leaves it out of a new
      // answer (./modelquestions.ts). The others go where the questions of
      // the request go now, not where they went when the model wrote them.
      const home = this._modelHome(ask);
      const added = notAsked(kept.added, this.asked()).map(question => ({
        ...question,
        placement: home
      }));
      result.options = inOrder([...result.options, ...added], kept.order);
      ask.fromModel = 'done';
      return;
    }
    if (this._modelAsked?.has(key)) {
      return;
    }
    const off = noModelNote(
      'questions',
      this._taskOff('questions'),
      this._capHolds('questions')
    );
    if (off) {
      if (none) {
        ask.fromModel = 'off';
        ask.fromModelNote = off;
      }
      return;
    }
    void this._moreQuestions(ask, key);
  }

  /**
   * The outcomes and the units of the analysis that the view knows, best
   * first: set by hand in the metadata, picked by the analyst, read from the
   * code by the rules, or named by a model (./inferred.ts).
   */
  inferred(): IInferredLists {
    return inferredLists(
      notebookMeta(this.notebook),
      this.codeCells().map(cell => ({
        id: cell.id,
        source: cell.model.sharedModel.getSource(),
        formulas: cell.analysis?.formulas ?? []
      })),
      this.variables()
    );
  }

  /**
   * The analyst picked an outcome or a unit from the chip of a question: it
   * goes first, as theirs, and the questions of the request are asked again.
   */
  pickInferred(
    kind: InferredKind,
    pick: { column: string; frame?: string | null }
  ): void {
    const meta = notebookMeta(this.notebook);
    setNotebookMeta(this.notebook, {
      inferred: withPick(meta.inferred, kind, pick)
    });
    void this._nextDebouncer.invoke();
    const ask = this.ask;
    if (ask?.kind === 'drop') {
      void this.askDrop(ask.source, ask.target, ask.modifiers, ask.anchor, {
        popover: ask.popover,
        columns: ask.columns
      });
    }
    this._emit();
  }

  /** The formulas of the cells, with the label of each cell, for the model that writes questions. */
  private _formulas(): { cell: string; formula: string }[] {
    return this.codeCells().flatMap(cell =>
      (cell.analysis?.formulas ?? [])
        .filter(formula => formulaOutcome(formula) !== null)
        .map(formula => ({ cell: cell.label, formula }))
    );
  }

  /**
   * Keep the outcomes and the units that a model named, as inferred: they
   * take the place of the model's earlier ones (./inferred.ts).
   */
  private _keepInferred(event: StreamEvent, by: IWrittenBy): void {
    if (event.type !== 'result') {
      return;
    }
    const named = {
      outcomes: (event.outcomes ?? []) as {
        column: string;
        frame: string;
        why: string;
      }[],
      units: (event.units ?? []) as {
        column: string;
        frame: string;
        why: string;
      }[]
    };
    if (!named.outcomes.length && !named.units.length) {
      return;
    }
    const meta = notebookMeta(this.notebook);
    setNotebookMeta(this.notebook, {
      inferred: withModel(meta.inferred, named, by)
    });
    // Worth asking next has questions about an outcome now.
    void this._nextDebouncer.invoke();
  }

  /** A request, for asking the model once: what was dropped or clicked, and onto what. */
  private _requestKey(ask: IDropAsk): string {
    const cell = ask.target.cellId ? this.cell(ask.target.cellId) : null;
    return requestKey(ask.source.name, {
      item: ask.target.item?.name,
      cell: cell
        ? { id: cell.id, source: cell.model.sharedModel.getSource() }
        : undefined
    });
  }

  /**
   * Where the model's questions of a request go: where the request's own
   * questions go, or after the cell it is about.
   */
  private _modelHome(ask: IDropAsk): IPlacement | null {
    const cell = ask.target.cellId ? this.cell(ask.target.cellId) : null;
    return (
      ask.result?.placements[0] ??
      (cell
        ? { kind: 'new', cell: cell.id, label: `new cell after ${cell.label}` }
        : null)
    );
  }

  /**
   * Questions from the model chosen for More questions: for the button, which
   * adds them after the questions of the request, or in the background with
   * `key`, whose questions take their place in the view's order, which the
   * server gives. The model reads the questions offered already, and adds
   * what they miss; the outcomes and the units that it names are kept as
   * inferred. A question about a drop onto a cell goes after the cell.
   */
  private async _moreQuestions(
    ask: IDropAsk,
    key: string | null
  ): Promise<void> {
    const cell = ask.target.cellId ? this.cell(ask.target.cellId) : null;
    ask.claudeStage = 'starting';
    if (key !== null) {
      ask.fromModel = 'asking';
      ask.fromModelNote = null;
      (this._modelAsked ??= new Set()).add(key);
    }
    this._emit();
    const choice = this.settings.models.questions;
    // What the stream gave, filled by its events.
    const got: {
      added: IOption[] | null;
      order: string[] | null;
      failure: string | null;
    } = { added: null, order: null, failure: null };
    try {
      await this.api.claudeQuestions(
        {
          selection: {
            source: this.itemJSON(ask.source),
            ...(ask.target.item
              ? { target: this.itemJSON(ask.target.item) }
              : {})
          },
          ...(cell
            ? {
                cell: {
                  id: cell.id,
                  label: cell.label,
                  source: cell.model.sharedModel.getSource()
                }
              }
            : {}),
          context: this.serverContext(),
          model: choice,
          offered: (ask.result?.options ?? []).map(option => ({
            id: option.id,
            text: option.text,
            type: option.type,
            origin: option.origin,
            probability: option.probability,
            runs: !needsAI(option),
            placement: option.placement ? { kind: option.placement.kind } : null
          })),
          formulas: this._formulas(),
          // What agents found, so that the model does not ask it again.
          found: agentFindings(notebookMeta(this.notebook).agent_runs),
          cells_above: this.codeCells().length
        },
        (event: StreamEvent) => {
          if (event.type === 'progress') {
            ask.claudeStage = event.stage;
          } else if (event.type === 'result' && ask.result) {
            const home = this._modelHome(ask);
            const by = writtenBy(choice, event.model, event.file);
            const added = (event.questions as IOption[]).map(q => ({
              ...q,
              placement: home,
              effect: 'AI writes the cell',
              by
            }));
            got.added = added;
            got.order = Array.isArray(event.order)
              ? (event.order as string[])
              : null;
            this._keepInferred(event, by);
            if (key === null) {
              ask.result.options = [...ask.result.options, ...added];
            } else {
              this._joinList(ask, added, got.order);
            }
          } else if (event.type === 'error') {
            got.failure = event.message;
          }
          this._emit();
        }
      );
    } catch (error) {
      got.failure = describeError(error);
    }
    ask.claudeStage = null;
    if (key === null) {
      // The button's request: an error takes the place of the questions, as before.
      if (got.failure) {
        ask.error = got.failure;
      }
    } else if (got.added) {
      (this._fromModel ??= new Map()).set(key, {
        added: got.added,
        order: got.order
      });
      ask.fromModel = 'done';
    } else {
      ask.fromModel = 'failed';
      ask.fromModelNote = `${(got.failure ?? 'it gave no answer').replace(/\.$/, '')}.`;
    }
    this._emit();
  }

  /**
   * The model's questions join the list of a request in the order that the
   * server gave. While the pointer is on the list, they wait at its end, and
   * the order shows once the pointer leaves, so that no question moves under
   * the pointer.
   */
  private _joinList(
    ask: IDropAsk,
    added: IOption[],
    order: string[] | null
  ): void {
    if (!ask.result) {
      return;
    }
    ask.result.options = [...ask.result.options, ...added];
    const show = () => {
      if (ask.result) {
        ask.result.options = inOrder(ask.result.options, order);
        this._emit();
      }
    };
    if (this._pointed.has(ask)) {
      (this._afterPointer ??= new WeakMap()).set(ask, show);
      return;
    }
    show();
  }

  // What the answers cost, and the notebook's cap.

  /** What the notebook's AI answers cost, each counted once (./cost.ts). */
  cost(): INotebookCost {
    return recordTotal(this.costRecord());
  }

  /**
   * What each kind of model call cost the notebook: the sums it keeps, or,
   * until its first call, those it started from.
   */
  costRecord(): ICostRecord {
    return notebookMeta(this.notebook).costs ?? this._startingCosts();
  }

  /** The sums that the notebook starts from: its answers, as it held them when it opened. */
  private _startingCosts(): ICostRecord {
    return (
      this._costSeed ??
      seedRecord(
        this.cells().map(cell => cell.meta),
        notebookMeta(this.notebook).agent_runs
      )
    );
  }

  /**
   * A call of this view that reached a model: its cost joins the notebook's
   * sums once, whatever becomes of its result, and the sums of the cells it
   * worked on with their share. A call for several cells, such as the titles
   * of eight cells, gives each cell an equal part of it. The answer of one
   * cell joins its cell's sums when it is written there (_answer).
   */
  private _onModelCall(call: IModelCall): void {
    const kind = ROUTE_KINDS[call.route] ?? 'other';
    const cost: ICallCost = { usd: call.usd, seconds: call.seconds };
    setNotebookMeta(this.notebook, {
      costs: withCall(this.costRecord(), kind, cost)
    });
    for (const [cellId, share] of this._callShares(call)) {
      const cell = findCell(this.notebook, cellId);
      if (cell) {
        setCellMeta(cell, {
          costs: withCall(cellRecord(cellMeta(cell)), kind, cost, share, false)
        });
      }
    }
    this._emit();
  }

  /** The cells a call worked on, each with its share of the call. */
  private _callShares(call: IModelCall): Map<string, number> {
    const body = (call.body ?? {}) as {
      cells?: { id?: unknown }[];
      tables?: { cell?: unknown }[];
      frames?: { name?: unknown }[];
    };
    const items: (string | null)[] =
      call.route === 'cells/title'
        ? (body.cells ?? []).map(item =>
            typeof item.id === 'string' ? item.id : null
          )
        : call.route === 'tables/describe'
          ? (body.tables ?? []).map(item =>
              typeof item.cell === 'string' ? item.cell : null
            )
          : call.route === 'frames/describe'
            ? (body.frames ?? []).map(item =>
                typeof item.name === 'string'
                  ? (this.definitions().get(item.name)?.id ?? null)
                  : null
              )
            : [];
    const shares = new Map<string, number>();
    for (const cellId of items) {
      if (cellId) {
        shares.set(cellId, (shares.get(cellId) ?? 0) + 1 / items.length);
      }
    }
    return shares;
  }

  /**
   * The sums of a cell with the answer that a model just wrote there. `before`
   * is the cell's metadata before the answer, so that a cell answered before
   * the view kept sums keeps its earlier answer once.
   */
  private _answerCosts(
    before: IEpiCellMeta,
    written: IEpiCellMeta['generated_by']
  ): ICostRecord | undefined {
    if (!written) {
      return undefined;
    }
    return withCall(cellRecord(before), 'answers', {
      usd: written.cost_usd ?? null,
      seconds: written.seconds ?? null
    });
  }

  /** The notebook's cap on what its answers cost, in US dollars; null for none. */
  costCap(): number | null {
    const cap = notebookMeta(this.notebook).cost_cap_usd;
    return typeof cap === 'number' && Number.isFinite(cap) && cap >= 0
      ? cap
      : null;
  }

  /** Set the notebook's cap, or remove it with null: the notebook keeps it. */
  setCostCap(usd: number | null): void {
    setNotebookMeta(this.notebook, { cost_cap_usd: usd ?? undefined });
    this._emit();
  }

  /**
   * What models did for a cell and what it cost: how its code came to be,
   * and its title, the labels of its tables and the summary of a frame it
   * makes, for Cell details.
   */
  costOf(cell: IEpiCell): { writer: Segment[]; parts: ICellPart[] } {
    const working = new Set(
      this.agentRuns
        .filter(run => run.state === 'starting' || run.state === 'working')
        .map(run => run.id ?? '')
    );
    const meta = notebookMeta(this.notebook);
    const definitions = this.definitions();
    const summarised = (cell.analysis?.defs ?? []).some(name => {
      const by = meta.frames?.[name]?.by;
      return (
        definitions.get(name)?.id === cell.id && !!by && by.choice !== 'script'
      );
    });
    return {
      writer: cellWriter(cell.meta, meta.agent_runs, cell.type, working),
      parts: cellParts(cell.meta, summarised)
    };
  }

  /**
   * Go on past the notebook's cap: raise the cap by $1 when the answers have
   * reached it (./cost.ts, raisedCap), and start the answer that waited in
   * this strip.
   */
  async goOn(key: string): Promise<void> {
    const strip = this.strips.get(key);
    if (strip?.status !== 'held' || !strip.start) {
      return;
    }
    this.strips.delete(key);
    this._raiseCap();
    await strip.start();
  }

  /** Go on past the notebook's cap with an answer for the sidebar. */
  async goOnPreview(): Promise<void> {
    const preview = this.preview;
    if (preview?.status !== 'held' || !preview.start) {
      return;
    }
    this.preview = null;
    this._raiseCap();
    await preview.start();
  }

  /**
   * Go on after a run stopped at the notebook's cap: raise the cap, and ask
   * the question again, from the start, since a run cannot go on from where
   * it stopped. The cells of the stopped run stay.
   */
  async goOnRun(run: IAgentRun): Promise<void> {
    const restart = run.restart;
    if (!restart || run.state !== 'stopped' || run.capped?.by !== 'notebook') {
      return;
    }
    run.restart = null;
    this.dismissAgent(run);
    this._raiseCap();
    await restart();
  }

  /**
   * Whether an answer that needs a model waits: the setting shows the cost,
   * a model answers, its price is known, and the notebook's answers have
   * reached its cap. An answer at no known price does not count against the
   * cap, and the cap does not hold it.
   */
  private _heldAtCap(): boolean {
    return (
      this.settings.showCost &&
      this.status?.claude?.priced !== false &&
      this.aiReady('cells') &&
      capReached(this.cost().usd, this.costCap())
    );
  }

  /** What is left under the notebook's cap for a run, or null when nothing caps it. */
  private _runBudget(): number | null {
    const cap = this.costCap();
    if (!this.settings.showCost || cap === null) {
      return null;
    }
    return leftUnder(this.cost().usd, cap);
  }

  private _raiseCap(): void {
    const cap = this.costCap();
    const total = this.cost().usd;
    if (cap !== null && capReached(total, cap)) {
      this.setCostCap(raisedCap(cap, total));
    }
  }

  /**
   * Say where the answer would show that it did not start at the notebook's
   * cap: in the strip of its cell, or in the sidebar for a preview. `start`
   * starts it, once the analyst goes on.
   */
  private _hold(
    where: IPlacement,
    what: { text: string; option?: IOption },
    start: () => Promise<void>
  ): string | null {
    if (where.kind === 'preview' && what.option) {
      this.preview = {
        title: what.text,
        code: null,
        status: 'held',
        stage: null,
        elapsed: null,
        thinking: null,
        outputs: [],
        error: null,
        option: what.option,
        start
      };
      this.settings.requestRevealRight();
      this._emit();
      return null;
    }
    const target = where.cell ? this.cell(where.cell) : null;
    const key = target?.id ?? `end:${++counter}`;
    this.strips.set(key, {
      cellId: key,
      text: what.text,
      action: 'Not started',
      placement: where,
      status: 'held',
      stage: null,
      elapsed: null,
      before: null,
      after: null,
      insertedId: null,
      error: null,
      showDiff: false,
      start
    });
    this._emit();
    return key;
  }

  // Answering.

  /**
   * Run an option at once: no confirmation and no diff step. The result
   * strip on the cell shows what was done, with the code change and Undo.
   * `previewMeta` is what a model wrote with the option's code, for a
   * preview kept as a cell: its mark, with the model and the cost.
   */
  async apply(
    option: IOption,
    placement: IPlacement | null = this.placementFor(option),
    previewMeta: Partial<IEpiCellMeta> | null = null
  ): Promise<void> {
    const ask = this.ask;
    this.ask = null;
    this.armed = null;
    this._actedOn(placement?.cell ?? null);
    await this._answer(option, placement, ask, previewMeta);
  }

  /**
   * Answer an option at its place, or at the end of the notebook as it is
   * now. An answer that needs a model waits while the notebook's answers
   * have reached its cap, with a way past the cap.
   */
  private async _answer(
    option: IOption,
    placement: IPlacement | null,
    ask: Ask | null,
    previewMeta: Partial<IEpiCellMeta> | null
  ): Promise<void> {
    const cells = this.codeCells();
    const where: IPlacement = placement ?? {
      kind: 'new',
      cell: cells[cells.length - 1]?.id ?? null,
      label: 'new cell at the end'
    };
    // The same question again, at the same place: the end is the end then.
    const again = () => this._answer(option, placement, ask, previewMeta);
    if (!option.code && this._heldAtCap()) {
      this._hold(where, { text: option.text, option }, again);
      return;
    }
    this._recordAsked(option);
    if (where.kind === 'preview') {
      await this._preview(option, ask);
      return;
    }
    const target = where.cell ? this.cell(where.cell) : null;
    const byAgent = !option.code && this._byAgent(where, ask);
    // A new cell goes below the cell the question is about, and below the
    // last cell that ran (./placement.ts); the code of an answer that a
    // model writes places it again once it comes. The strip shows right
    // above the cells that the answer adds, under the cell they go after,
    // or at the end while another strip holds that cell. An answer that a
    // model writes waits under the cell it is about while the model writes
    // (design iteration 1.55), and its strip moves once its cell goes in.
    const place =
      where.kind === 'new'
        ? this._newPlacement(where, option.code ?? null)
        : where;
    const apart =
      place.kind === 'new' &&
      (option.code || byAgent) &&
      place.cell !== (target?.id ?? null);
    const anchorId = !apart
      ? (target?.id ?? `end:${++counter}`)
      : place.cell && !this.strips.has(place.cell)
        ? place.cell
        : `end:${++counter}`;
    const question: IAskedQuestion = {
      id: option.id,
      text: option.text,
      type: option.type,
      ...this._provenance(option),
      refs: labelRefs(option.text, this.cells(), [target?.id, where.cell])
    };
    // A value that the analyst typed or picked for a decision is theirs in
    // the code that the view writes with it: its chip is plain, "Chosen by you".
    // So is a file that they dropped or clicked, in the code that reads it.
    const chosen =
      ask?.kind === 'decision'
        ? chosenValue(ask.decision, option, ask.typed ?? null)
        : ask?.kind === 'drop' && ask.source.kind === 'file' && ask.source.path
          ? {
              name: ask.source.label,
              value: this._kernelPath(ask.source.path),
              file: true
            }
          : null;
    const strip: IStrip = {
      cellId: anchorId,
      question,
      guess: null,
      text: option.text,
      action: capitalise(place.label || place.kind),
      placement: place,
      status: option.code ? 'running' : 'writing',
      stage: null,
      elapsed: null,
      started: Date.now(),
      thinking: null,
      before: null,
      after: null,
      insertedId: null,
      error: null,
      showDiff: false
    };
    this.strips.set(anchorId, strip);
    if (apart) {
      // Away from the cell the analyst asked about: it comes into sight.
      this._revealStrip(anchorId);
    }
    this._emit();
    let stop: AbortController | null = null;
    try {
      let code = option.code ?? null;
      let extra: Partial<IEpiCellMeta> = previewMeta ?? {};
      if (byAgent) {
        await this._agent(option, where, target, strip, ask, again);
        return;
      }
      if (!code) {
        // What "Restore and run" puts back, if the analyst deletes the cell
        // while the model writes; Stop on the strip ends the request.
        if (target) {
          this._watchTarget(target.id);
        }
        stop = new AbortController();
        this._writes.set(strip, stop);
        const written = await this._write(
          option,
          where,
          target,
          strip,
          ask,
          stop.signal
        );
        if (stop.signal.aborted) {
          return;
        }
        this._writes.delete(strip);
        code = written.code;
        extra = written.meta;
      }
      if (chosen) {
        extra = { ...extra, user_values: [chosen] };
      }
      // The analyst deleted the cell while the model wrote: the answer waits
      // where the cell was, and nothing runs.
      if (target && indexOf(this.notebook, target.id) < 0) {
        this._keepWaiting(strip, { option, code, meta: extra });
        return;
      }
      await this._place(
        option,
        place,
        target ? this.cell(target.id) : null,
        strip,
        code,
        extra
      );
    } catch (error) {
      if (stop?.signal.aborted) {
        // Stopped by the analyst: the strip went with its Stop.
        return;
      }
      strip.status = 'error';
      strip.error = describeError(error);
      this._recordOutcome(option.id, 'failed');
    }
    this._emit();
  }

  /**
   * Put the code of an answer in the notebook and run it: an edit replaces
   * the code of its cell, and a new cell or a branch goes after its cell,
   * or at `at`, the place of a deleted cell.
   */
  private async _place(
    option: IOption,
    where: IPlacement,
    target: IEpiCell | null,
    strip: IStrip,
    code: string,
    extra: Partial<IEpiCellMeta>,
    at: number | null = null
  ): Promise<void> {
    strip.status = 'running';
    this._emit();
    if (where.kind === 'edit' && target && target.type === 'code') {
      strip.before = target.model.sharedModel.getSource();
      strip.after = code;
      // Code that a model wrote keeps its mark, which model and when, and
      // what the model wrote about it, as a new cell does. Undo puts back
      // what the cell had, but not the cell's sums: the answer cost money.
      // The mark, with the key of the code, goes before the code, so that
      // the change of code is not taken for the analyst's (./handedit.ts).
      const before = cellMeta(target.model);
      const edit = editMeta(before, { ...extra, view_code_key: codeKey(code) });
      strip.metaBefore = edit.restore;
      setCellMeta(target.model, edit.patch);
      target.model.sharedModel.setSource(code);
      const costs = this._answerCosts(before, extra.generated_by);
      if (costs) {
        setCellMeta(target.model, { costs });
      }
      this._keepGuess(strip);
      const result = await this._run(
        target.model as ICodeCellModel,
        target.label,
        option.text,
        false
      );
      // The code changed, so Undo stays; the strip says that the run failed.
      if (!result.ok) {
        strip.status = 'error';
        strip.error = firstLine(result.error ?? 'The cell failed');
        this._recordOutcome(option.id, 'failed');
        return;
      }
    } else {
      const branchParent =
        where.kind === 'branch' && target
          ? target.branchOf
            ? this.cell(target.branchOf)
            : target
          : null;
      const letter = branchParent ? this._nextLetter(branchParent) : undefined;
      // A new cell goes where the rule puts it now that its code is known:
      // below the cell the question is about, and below the last cell that
      // ran (./placement.ts).
      const placed = where.kind === 'new' && at === null;
      let place = where;
      let after = branchParent ?? target;
      if (placed) {
        const id = this._newCellAfter(target?.id ?? where.cell, code);
        after = id ? this.cell(id) : null;
        place = id === where.cell ? where : this._placementAfter(where, id);
        strip.placement = place;
      }
      const index = at ?? this._insertIndex(after);
      const blank = this.isBlank() ? cellsOf(this.notebook) : [];
      const costs = this._answerCosts({}, extra.generated_by);
      const inserted = insertCodeCell(this.notebook, index, code, {
        title: option.text,
        question: strip.question,
        asked_by: 'user',
        written_by: 'agent',
        // No model wrote the code: a template's cell.
        ...(extra.generated_by ? {} : { template: true }),
        placement: place,
        ...(branchParent && letter
          ? { branch: { of: branchParent.id, letter } }
          : {}),
        ...extra,
        ...(costs ? { costs } : {})
      });
      // The first cell of a new notebook replaces its empty ones.
      for (const cell of blank) {
        deleteCell(this.notebook, cell.id);
      }
      strip.insertedId = inserted.id;
      strip.before = '';
      strip.after = code;
      this._keepGuess(strip);
      // The strip shows right above the new cell, under the cell it goes
      // after. While another strip holds that cell, or with no cell to show
      // it under, it goes with the new cell.
      if (placed ? strip.cellId !== after?.id : !target) {
        const key =
          placed && after && !this.strips.has(after.id)
            ? after.id
            : inserted.id;
        this.strips.delete(strip.cellId);
        strip.cellId = key;
        this.strips.set(key, strip);
      }
      // The strip and the new cell come into sight together, also when the
      // cell goes right after the cell asked about: its strip and the new
      // cell are at the bottom of that cell's card, which can be below the
      // fold, and a drop in the Whybook panel asks about a cell that the
      // analyst may not be looking at (design iteration 1.93).
      this._revealStrip(strip.cellId, inserted.id);
      this._emit();
      const label = this.cell(inserted.id)?.label ?? '[ ]';
      const result = await this._run(
        inserted,
        label,
        option.text,
        where.kind === 'branch'
      );
      // The run brought the cell's outputs, or its error: they come into
      // sight under the strip too, unless the analyst has moved the view
      // since, or another strip waits to come into sight.
      if (
        this.strips.get(strip.cellId) === strip &&
        (this._stripToShow === null || this._stripFollow)
      ) {
        this._revealStrip(strip.cellId, inserted.id, true);
      }
      if (!result.ok) {
        strip.status = 'error';
        strip.error = firstLine(result.error ?? 'The cell failed');
        this._recordOutcome(option.id, 'failed');
        return;
      }
    }
    strip.status = 'done';
    this._recordOutcome(option.id, 'ran');
  }

  /**
   * The analyst deleted the cell of an answer while the model wrote it
   * (design iteration 1.55). The answer waits in the strip where the cell
   * was, with its code, and nothing runs until the analyst puts it in the
   * notebook with the cell (`runWaiting`), or closes the strip.
   */
  private _keepWaiting(strip: IStrip, answer: IWaitingAnswer): void {
    strip.gone ??= this._targets.get(strip.cellId) ?? null;
    strip.status = 'waiting';
    strip.waiting = answer;
    strip.thinking = null;
    strip.before = '';
    strip.after = answer.code;
    strip.showDiff = true;
  }

  /**
   * Put an answer that waits in the notebook, and run it (design iteration
   * 1.55). 'restore' puts the deleted cell back where it was, then the
   * answer where it was meant to go: an edit edits the cell, and a new cell
   * or a branch goes after it. 'alone' puts the answer alone where the cell
   * was, as a new cell.
   */
  async runWaiting(key: string, how: 'restore' | 'alone'): Promise<void> {
    const strip = this.strips.get(key);
    const answer = strip?.waiting;
    if (!strip || strip.status !== 'waiting' || !answer) {
      return;
    }
    const gone = strip.gone ?? null;
    strip.waiting = null;
    strip.gone = null;
    strip.showDiff = false;
    this._targets.delete(key);
    try {
      if (how === 'alone' && gone) {
        const where: IPlacement = {
          kind: 'new',
          cell: null,
          label: `new cell where ${gone.label || 'the cell'} was`
        };
        strip.placement = where;
        strip.replaced = gone.label || 'the cell';
        await this._place(
          answer.option,
          where,
          null,
          strip,
          answer.code,
          answer.meta,
          this._placeOf(gone)
        );
      } else {
        if (gone) {
          this.restoreCell(gone);
        }
        await this._place(
          answer.option,
          strip.placement,
          this.cell(key),
          strip,
          answer.code,
          answer.meta
        );
      }
    } catch (error) {
      strip.status = 'error';
      strip.error = describeError(error);
      this._recordOutcome(answer.option.id, 'failed');
    }
    this._emit();
  }

  /**
   * Stop an answer while the model writes it (design iteration 1.55): the
   * request ends, nothing is added, and the strip goes.
   */
  stopAnswer(key: string): void {
    const strip = this.strips.get(key);
    if (!strip || strip.status !== 'writing' || strip.agent) {
      return;
    }
    this._stopWriting(strip);
    this.strips.delete(key);
    this._emit();
  }

  /** End the request of an answer that the model writes, for a strip or the sidebar. */
  private _stopWriting(holder: object): void {
    const stop = this._writes.get(holder);
    if (stop) {
      this._writes.delete(holder);
      stop.abort();
    }
  }

  /** The requests of the answers that the model writes, by their strip or preview. */
  private get _writes(): WeakMap<object, AbortController> {
    return (this._writesOf ??= new WeakMap());
  }

  /**
   * The cells that the model writes answers about, as each was at its last
   * change: what "Restore and run" puts back when the analyst deletes one in
   * another view, where this model does not see the cell go.
   */
  private get _targets(): Map<string, IDeletedCell> {
    return (this._targetsOf ??= new Map());
  }

  /** Keep what a cell is now, while the model writes an answer about it. */
  private _watchTarget(cellId: string): void {
    const saved = this._savedCell(cellId);
    if (saved) {
      this._targets.set(cellId, saved);
    }
  }

  /**
   * After a change of the notebook: a cell that an answer is written about
   * and that another view deleted leaves its strip where it was, and a cell
   * that came back, as after Undo in the notebook view, has its strip under
   * it again.
   */
  private _followTargets(): void {
    const targets = this._targetsOf;
    if (!targets?.size) {
      return;
    }
    for (const [cellId, saved] of targets) {
      const strip = this.strips.get(cellId);
      if (
        !strip ||
        strip.agent ||
        (strip.status !== 'writing' && strip.status !== 'waiting')
      ) {
        targets.delete(cellId);
      } else if (indexOf(this.notebook, cellId) >= 0) {
        strip.gone = null;
        this._watchTarget(cellId);
      } else {
        strip.gone ??= saved;
      }
    }
  }

  /**
   * A question the user typed in place of the ones offered. From a question
   * request, its cell goes where the request's questions go, and the AI
   * model is told what the request is about; from the follow-ups of a cell,
   * after that cell; from the notebook, at its end. With Alt+drop it joins
   * the checklist of branches. `how.type` is the type that a model's
   * follow-up showed, which the question keeps; else the words decide.
   */
  async askOwn(
    text: string,
    from: 'request' | 'notebook' | { cellId: string } = 'request',
    how: {
      place?: IPlacement | null;
      parallel?: boolean;
      type?: QuestionType;
    } = {}
  ): Promise<void> {
    const question = text.trim();
    if (!question) {
      return;
    }
    if (from !== 'request') {
      // Not about what an open request holds.
      this.ask = null;
    }
    let ask = this.ask;
    // Alt+Enter: the question joins a checklist of branches, as Alt+drop makes.
    if (
      how.parallel &&
      ask?.kind === 'drop' &&
      ask.result?.mode !== 'parallel'
    ) {
      await this.askDrop(
        ask.source,
        ask.target,
        { ...ask.modifiers, parallel: true },
        ask.anchor,
        { popover: ask.popover, columns: ask.columns }
      );
      ask = this.ask;
    }
    const placement: IPlacement | null =
      typeof from === 'object'
        ? {
            kind: 'new',
            cell: from.cellId,
            label: `new cell after ${this._labelOf(from.cellId)}`
          }
        : how.place !== undefined
          ? how.place
          : this.ownPlace(question, this.ownPlaces(ask)).place;
    const option = ownOption(
      question,
      placement,
      how.type ?? this.ownType(question).type
    );
    if (ask?.kind === 'drop' && ask.result?.mode === 'parallel') {
      if (!ask.result.options.some(known => known.id === option.id)) {
        ask.result.options = [...ask.result.options, option];
      }
      if (!ask.checked.includes(option.id)) {
        ask.checked = [...ask.checked, option.id];
      }
      this._emit();
      return;
    }
    await this.apply(option, placement);
  }

  /**
   * The places a typed question's cell can go in a request, the default first:
   * a new cell below the cell the request is about, an edit of it, a branch
   * of it, or a preview that the notebook does not keep. A new cell is
   * labelled with where it goes now (./placement.ts), and two new cells that
   * go to the same place show once.
   */
  ownPlaces(ask: Ask | null = this.ask): IPlacement[] {
    const seen = new Set<string | null>();
    const places: IPlacement[] = [];
    for (const place of this._ownPlaces(ask)) {
      if (place.kind !== 'new') {
        places.push(place);
        continue;
      }
      const now = this._newPlacement(place, null);
      if (!seen.has(now.cell)) {
        seen.add(now.cell);
        places.push(now === place ? place : { ...place, label: now.label });
      }
    }
    return places;
  }

  private _ownPlaces(ask: Ask | null): IPlacement[] {
    if (!ask) {
      return [];
    }
    const preview: IPlacement = {
      kind: 'preview',
      cell: null,
      label: 'a preview in the sidebar'
    };
    const around = (cellId: string): IPlacement[] => {
      const cell = this.cell(cellId);
      const after: IPlacement = {
        kind: 'new',
        cell: cellId,
        label: `new cell after ${this._labelOf(cellId)}`
      };
      if (!cell || cell.type !== 'code') {
        return [after, preview];
      }
      const parent = cell.branchOf ? (this.cell(cell.branchOf) ?? cell) : cell;
      return [
        after,
        { kind: 'edit', cell: cell.id, label: `edit ${cell.label} in place` },
        {
          kind: 'branch',
          cell: parent.id,
          label: `branch of ${parent.label} · runs in parallel`
        },
        preview
      ];
    };
    if (ask.kind === 'drop') {
      const placements = ask.result?.placements ?? [];
      if (placements.length) {
        return placements.some(place => place.kind === 'preview')
          ? placements
          : [...placements, preview];
      }
      if (!ask.target.cellId) {
        return [];
      }
      const places = around(ask.target.cellId);
      // Shift+drop branches every option, and the typed question too.
      const branch = places.find(place => place.kind === 'branch');
      return ask.modifiers.branch && branch
        ? [branch, ...places.filter(place => place !== branch)]
        : places;
    }
    if (ask.kind === 'cells') {
      const order = this.cells().map(cell => cell.id);
      const chosen = [...ask.cells].sort(
        (a, b) => order.indexOf(a) - order.indexOf(b)
      );
      const last = chosen[chosen.length - 1];
      if (!last) {
        return [];
      }
      return chosen.length === 1 ? around(last) : [around(last)[0], preview];
    }
    const [after] = around(ask.cellId);
    return [after, preview];
  }

  /** How placements name a cell: "[5]", or "§8 Summary" for a text. */
  private _labelOf(cellId: string): string {
    const cell = this.cell(cellId);
    if (!cell) {
      return 'the cell';
    }
    return cell.type === 'markdown' ? this.noteLabel(cell) : cell.label;
  }

  /**
   * Start several options at once, each as a branch in its own subshell.
   * When a branch needs a model and the notebook's answers have reached its
   * cap, none starts until the analyst goes on past the cap.
   */
  async startParallel(ask: Ask | null = this.ask): Promise<void> {
    if (ask?.kind !== 'drop' || !ask.result || !ask.target.cellId) {
      return;
    }
    const target = this.cell(ask.target.cellId);
    if (!target) {
      return;
    }
    const parent = target.branchOf
      ? (this.cell(target.branchOf) ?? target)
      : target;
    const options = ask.result.options.filter(option =>
      ask.checked.includes(option.id)
    );
    this.ask = null;
    if (options.some(option => !option.code) && this._heldAtCap()) {
      const count =
        options.length === 1 ? '1 branch' : `${options.length} branches`;
      this._hold(
        {
          kind: 'branch',
          cell: parent.id,
          label: `branch of ${parent.label} · runs in parallel`
        },
        { text: `Parallel exploration of ${parent.label}: ${count}` },
        () => this.startParallel(ask)
      );
      return;
    }
    const created: string[] = [];
    const runs: Promise<unknown>[] = [];
    for (const option of options) {
      this._recordAsked(option);
      const letter = this._nextLetter(parent);
      const index = this._insertIndex(parent);
      const placeholder =
        option.code ??
        `${pyComment(option.text)}\n# AI is writing this branch.`;
      const cell = insertCodeCell(this.notebook, index, placeholder, {
        title: option.text,
        question: {
          id: option.id,
          text: option.text,
          type: option.type,
          ...this._provenance(option)
        },
        asked_by: 'user',
        written_by: 'agent',
        ...(option.code ? { template: true } : {}),
        branch: { of: parent.id, letter },
        placement: {
          kind: 'branch',
          cell: parent.id,
          label: `branch of ${parent.label} · runs in parallel`
        }
      });
      created.push(cell.id);
      this._emit();
      const ended = (ok: boolean, error: string | null) => {
        this.parallelEnded.set(cell.id, {
          ok,
          error,
          label:
            this.cell(cell.id)?.label ??
            `${parent.label.replace(/\]$/, '')}${letter}]`,
          title: option.text
        });
        this._recordOutcome(option.id, ok ? 'ran' : 'failed');
        this._emit();
      };
      runs.push(
        (async () => {
          if (!option.code) {
            let written: { code: string; meta: Partial<IEpiCellMeta> };
            try {
              written = await this._write(
                option,
                { kind: 'branch', cell: parent.id, label: '' },
                parent,
                null,
                ask
              );
            } catch (error) {
              // The AI wrote nothing: the placeholder goes, as a cell that
              // fails to be written is not added, and the strip says why.
              ended(false, describeError(error));
              deleteCell(this.notebook, cell.id);
              return;
            }
            // The key of the code first: the view writes it (./handedit.ts).
            setCellMeta(cell, { view_code_key: codeKey(written.code) });
            cell.sharedModel.setSource(written.code);
            const costs = this._answerCosts(
              cellMeta(cell),
              written.meta.generated_by
            );
            setCellMeta(cell, { ...written.meta, ...(costs ? { costs } : {}) });
          }
          const label = this.cell(cell.id)?.label ?? '[ ]';
          const result = await this._run(cell, label, option.text, true);
          ended(result.ok, result.ok ? null : (result.error ?? null));
        })().catch(error => {
          console.warn('A parallel branch failed', error);
          ended(false, describeError(error));
        })
      );
    }
    this.parallel.set(parent.id, [
      ...(this.parallel.get(parent.id) ?? []),
      ...created
    ]);
    this._emit();
    await Promise.all(runs);
  }

  /**
   * Undo an answer: delete the cell it added, or put back the code of the
   * cell it edited. When the analyst changed that cell since, the strip asks
   * first, and Undo removes the changes only when `anyway`. The names that
   * the added cell made stay in the kernel: Variables lists them apart
   * (`undoneNames`).
   */
  undo(cellId: string, anyway = false): void {
    const strip = this.strips.get(cellId);
    if (!strip) {
      return;
    }
    if (!anyway) {
      const changed = this._changedSince(strip);
      if (changed.length) {
        strip.undoAsk = changed;
        this._emit();
        return;
      }
    }
    if (strip.insertedId) {
      this._keepUndone(strip.insertedId, strip.text);
      deleteCell(this.notebook, strip.insertedId);
    } else if (strip.placement.kind === 'edit' && strip.before !== null) {
      const cell = findCell(this.notebook, strip.cellId);
      // The marks and notes of the answer go with its code: code that the
      // analyst wrote is not left marked as a model's. They go first, with
      // the key of the code as it was, so that the change of code is not
      // taken for the analyst's (./handedit.ts).
      if (cell && strip.metaBefore) {
        setCellMeta(cell, strip.metaBefore);
      }
      cell?.sharedModel.setSource(strip.before);
      // Run it again, so the outputs and the kernel match the restored code.
      void this.runCell(strip.cellId);
    }
    this.strips.delete(cellId);
    this._emit();
  }

  /** Keep the answer and what the analyst changed since: the question of Undo closes. */
  dismissUndo(cellId: string): void {
    const strip = this.strips.get(cellId);
    if (strip?.undoAsk) {
      strip.undoAsk = null;
      this._emit();
    }
  }

  /**
   * The cell of an answer that holds other code than the answer wrote: the
   * cell it added, or the cell it edited, by its label.
   */
  private _changedSince(strip: IStrip): string[] {
    const id =
      strip.insertedId ??
      (strip.placement.kind === 'edit' && strip.before !== null
        ? strip.cellId
        : null);
    const cell = id ? findCell(this.notebook, id) : null;
    if (
      !cell ||
      strip.after === null ||
      cell.sharedModel.getSource() === strip.after
    ) {
      return [];
    }
    const label = this.cell(cell.id)?.label;
    return [
      label && label !== '[ ]'
        ? label
        : strip.insertedId
          ? 'the new cell'
          : 'the cell'
    ];
  }

  /**
   * How long, in milliseconds, a finished strip stays after the analyst
   * asks about or runs another cell, when the setting closes strips then.
   */
  stripLinger = 60000;

  /** Close the strip of a finished answer: the change stays, and its Undo goes. */
  dismissStrip(cellId: string): void {
    const strip = this.strips.get(cellId);
    if (strip && strip.status !== 'writing' && strip.status !== 'running') {
      this.strips.delete(cellId);
      this._emit();
    }
  }

  /**
   * The analyst acted on a cell, or on none: the finished strips of the
   * other cells close after a while, when the setting says so. A failed
   * strip stays until its close button.
   */
  private _actedOn(cellId: string | null): void {
    if (cellId) {
      this.setCurrentCell(cellId);
    }
    if (this.settings.stripsClose !== 'elsewhere') {
      return;
    }
    for (const [key, strip] of this.strips) {
      // An agent's run keeps its strip, with its answer, until its close button.
      if (
        key === cellId ||
        strip.status !== 'done' ||
        strip.agent ||
        this._closing.has(key)
      ) {
        continue;
      }
      const timer = window.setTimeout(() => {
        this._closing.delete(key);
        // A strip whose Undo asks a question stays until it is answered.
        if (this.strips.get(key) === strip && !strip.undoAsk) {
          this.strips.delete(key);
          this._emit();
        }
      }, this.stripLinger);
      this._closing.set(key, timer);
    }
  }

  toggleDiff(cellId: string): void {
    const strip = this.strips.get(cellId);
    if (strip) {
      strip.showDiff = !strip.showDiff;
      this._emit();
    }
  }

  diff(strip: IStrip): { kind: ' ' | '-' | '+'; text: string }[] {
    return lineDiff(strip.before ?? '', strip.after ?? '').filter(
      line => line.kind !== ' '
    );
  }

  async keepPreview(): Promise<void> {
    const preview = this.preview;
    if (!preview?.code) {
      return;
    }
    this.preview = null;
    // The kept cell keeps the mark of the model that wrote it, with its cost.
    await this.apply(
      { ...preview.option, code: preview.code },
      this._keptPlace(preview.option),
      preview.meta ?? null
    );
  }

  /**
   * Where a cell from a quick look goes: below the cell that makes what it
   * looks at, and below the last cell that ran (./placement.ts).
   */
  private _keptPlace(option: IOption): IPlacement {
    const definitions = this.definitions();
    const home = (option.variables ?? [])
      .map(name => definitions.get(name.split('[')[0]))
      .find(cell => cell && !cell.branchOf);
    const cells = this.codeCells();
    const after = home ?? cells[cells.length - 1];
    return {
      kind: 'new',
      cell: after?.id ?? null,
      label: home ? `new cell after ${home.label}` : 'new cell at the end'
    };
  }

  /**
   * "Leave out these rows" on the quick look of a number: a cell that makes
   * a clean frame without the rows at the ends that the analyst picked, in
   * the place of the kept quick look, and the clean frame in Contents
   * (./leaveout.ts, design iteration 1.85).
   */
  async leaveOutRows(extremes: IExtremes, cuts: ICuts): Promise<void> {
    const preview = this.preview;
    if (!preview || (cuts.low === null && cuts.high === null)) {
      return;
    }
    const taken = new Set([
      ...this.variables().map(variable => variable.name),
      ...this.definitions().keys()
    ]);
    const name = cleanName(extremes.frame, taken);
    const { text, code } = leaveOutCode(extremes, cuts, name);
    const option: IOption = {
      id: `leave-out:${extremes.frame}:${extremes.column}:${cuts.low}:${cuts.high}`,
      text,
      type: 'quality',
      origin: 'template',
      variables: preview.option.variables,
      probability: null,
      reasons: [],
      placement: null,
      code
    };
    this.preview = null;
    await this.apply(option, this._keptPlace(option));
    this.select(name);
  }

  keepSelection(ask: IRegionAsk): void {
    const plot = ask.plot;
    const frame = plot.source.frame;
    const x = plot.source.x;
    if (!frame) {
      return;
    }
    let name: string;
    let where: string;
    let mask: string;
    if (ask.values) {
      name = identifier(`sel_${x}_${ask.values.join('_')}`).slice(0, 40);
      where = barsText(x, ask.values);
      mask = barFilter(frame, x, ask.values, this._columnTag(frame, x));
    } else {
      // The name shows the bounds as the popover does; the mask keeps them
      // as brushed.
      const [x0, x1] = rangeEnds(ask.x0, ask.x1, plot.x, axisValues(plot, 'x'));
      const y = ask.y
        ? `_${plot.source.y}${rangeEnds(ask.y[0], ask.y[1], plot.y, axisValues(plot, 'y')).join('_')}`
        : '';
      name = `sel_${x}${x0}_${x1}${y}`.replace(/[^A-Za-z0-9_]/g, '_');
      where = regionWhere(ask);
      mask = regionMask(frame, ask);
    }
    const code = [
      // The bounds of a range of dates are pd.Timestamp(...).
      ...(mask.includes('pd.') ? ['import pandas as pd', ''] : []),
      `${name} = ${frame}[${mask}].copy()`,
      `${name}.attrs["whybook"] = {"selection": {"of": ${pyString(frame)}, "where": ${pyString(where)}}}`,
      `${name}.head()`
    ].join('\n');
    const plotCell = this.cell(ask.cellId);
    this.ask = null;
    void this.apply(
      {
        id: `keep:${name}`,
        text: `Keep ${where} of ${frame} as ${name}`,
        type: 'descriptive',
        origin: 'template',
        probability: null,
        reasons: [],
        placement: {
          kind: 'new',
          cell: ask.cellId,
          label: `new cell after ${plotCell?.label ?? ''}`
        },
        code
      },
      {
        kind: 'new',
        cell: ask.cellId,
        label: `new cell after ${plotCell?.label ?? ''}`
      }
    ).then(() => this.select(name));
  }

  dismissNext(text: string): void {
    const meta = notebookMeta(this.notebook);
    const exploration = meta.exploration ?? {};
    const step = this.nextSteps.find(item => item.text === text);
    const refs = labelRefs(text, this.cells(), [step?.placement?.cell]);
    setNotebookMeta(this.notebook, {
      exploration: {
        ...exploration,
        dismissed: [
          ...(exploration.dismissed ?? []),
          refs ? { text, refs } : text
        ]
      }
    });
    this.nextSteps = this.nextSteps.filter(step => step.text !== text);
    this._emit();
  }

  /**
   * Run a cell. It becomes the cell the analyst acted on, unless `acted` is
   * false, as for the cells of Run all.
   */
  async runCell(
    cellId: string,
    options: { acted?: boolean } = {}
  ): Promise<void> {
    const cell = this.cell(cellId);
    if (!cell || cell.type !== 'code') {
      return;
    }
    if (options.acted !== false) {
      this._actedOn(cellId);
    }
    this.cellTitles.flush(cellId);
    await this._run(
      cell.model as ICodeCellModel,
      cell.label,
      cell.title,
      cell.branchOf !== null
    );
  }

  /**
   * The view closed. An agent's run goes on while the notebook stays open in
   * another view, which shows the cells it adds: the model keeps following
   * the notebook and the kernel for the run's tool calls until the run ends.
   * Once the notebook closes too, no view can run a tool call, and the run
   * stops at once.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    for (const timer of this._closing.values()) {
      window.clearTimeout(timer);
    }
    this._refreshPolicy.dispose();
    this._nextDebouncer.dispose();
    this.tableNotes.dispose();
    this.cellTitles.dispose();
    this.signIns.dispose();
    if (!this._agentAborts.size) {
      this._release();
    } else if (this._notebookGone()) {
      this._stopRuns();
    } else {
      this.context.disposed.connect(this._stopRuns, this);
    }
  }

  /** Whether the notebook's document closed, in every view. */
  private _notebookGone(): boolean {
    return this.context.isDisposed || this.notebook.isDisposed;
  }

  /**
   * Stop an agent's run at once, and close its stream: no view can run its
   * tool calls, and the server stops waiting for the next one.
   */
  private _stopRun(run: IAgentRun): void {
    run.state = 'stopped';
    if (run.id) {
      void this.api.agentStop(run.id).catch(() => undefined);
    }
    this._agentAborts.get(run)?.abort();
  }

  /** Stop the runs that go on, and let go of what they used: the notebook closed. */
  private _stopRuns(): void {
    for (const run of this._agentAborts.keys()) {
      this._stopRun(run);
    }
    this._release();
  }

  /**
   * Let go of the kernel, the files and the signals of a closed view, once
   * no agent's run needs them.
   */
  private _release(): void {
    if (this._released) {
      return;
    }
    this._released = true;
    Signal.clearData(this);
    this._refresher.dispose();
    this.plotHooks.dispose();
    this.bridge.dispose();
    this.jobs.dispose();
    this._contentsManager?.dispose();
    // A run that this view started cannot be asked again from here: the
    // Go on of its strip is left to a view that is open.
    for (const entry of this.runs.all) {
      if (entry.owner === this) {
        entry.run.restart = null;
      }
    }
  }

  // Internals.

  /**
   * Stop a request that the kernel's language cannot answer, before it asks
   * the server: the request shows why instead of its questions.
   */
  private _stopUnsupported(ask: Ask): boolean {
    if (!this.askUnsupported(ask)) {
      return false;
    }
    ask.loading = false;
    this._emit();
    return true;
  }

  private _decisions(
    meta: IEpiCellMeta,
    analysis: ICellAnalysis | null,
    source: string
  ): IDecision[] {
    // Who chose each literal: the analyst in their own code, in code of the
    // view that they changed by hand, and for a value they typed or picked,
    // else the AI (./decisions.ts). The values that only shape a plot, such
    // as its size or its labels, show no chip (design iteration 1.83).
    return attributed(
      withoutDrawing(analysis?.decisions ?? meta.decisions ?? []),
      meta,
      source
    );
  }

  private async _run(
    cell: ICodeCellModel,
    label: string,
    text: string,
    subshell: boolean
  ) {
    // A new cell goes after the cells that ran in this kernel (./placement.ts).
    // While it waits and runs, the cell has no count, and until the next
    // listing of the kernel the bridge does not count its code as run.
    const runs = (this._viewRuns ??= new Map());
    runs.set(cell.id, null);
    let result: IRunResult;
    try {
      result = await this.jobs.run(cell, { label, text, subshell });
    } finally {
      if (cell.executionCount === null) {
        runs.delete(cell.id);
      } else {
        runs.set(cell.id, cell.executionCount);
      }
    }
    // Its decisions are saved with the cell once the analysis catches up.
    this._ran.add(cell.id);
    this._refreshPolicy.changed();
    return result;
  }

  /**
   * Keep the decisions of cells the view ran in their metadata, so the
   * view shows them again without a kernel.
   */
  private _saveDecisions(): void {
    for (const id of [...this._ran]) {
      const cell = this.cell(id);
      if (!cell) {
        this._ran.delete(id);
        continue;
      }
      if (!cell.analysis) {
        continue;
      }
      this._ran.delete(id);
      if (
        JSON.stringify(cell.analysis.decisions) !==
        JSON.stringify(cell.meta.decisions ?? [])
      ) {
        setCellMeta(cell.model, { decisions: cell.analysis.decisions });
      }
    }
  }

  /**
   * The frame and the pandas mask of the rows picked in a plot, which
   * Keep selection keeps: a range, or the bars picked. Null for a plot
   * without its frame, or of a polars frame, which a pandas mask cannot
   * select.
   */
  private _pickedRows(ask: IRegionAsk): { frame: string; mask: string } | null {
    const frame = ask.plot.source.frame;
    if (!frame || this.variable(frame)?.type?.startsWith('polars.')) {
      return null;
    }
    const x = ask.plot.source.x;
    const mask = ask.values
      ? barFilter(frame, x, ask.values, this._columnTag(frame, x))
      : regionMask(frame, ask);
    return { frame, mask };
  }

  /**
   * What the remote model reads to write a cell for an option: the question,
   * what it is about, the cell, the variables, the packages and the cells so
   * far. An agent's run reads the same.
   */
  private _solveBody(
    option: IOption,
    where: IPlacement,
    target: IEpiCell | null,
    ask: Ask | null
  ): Record<string, unknown> {
    const snapshot = this.bridge.snapshot;
    const selection =
      ask?.kind === 'drop'
        ? {
            source: this.itemJSON(ask.source),
            target: ask.target.item ? this.itemJSON(ask.target.item) : null
          }
        : null;
    // What the user pointed at, when the selection and the cell do not say.
    const about =
      ask?.kind === 'region'
        ? `the rows of ${ask.plot.source.frame ?? 'the plot'} where ${
            ask.values
              ? barsText(ask.plot.source.x, ask.values)
              : // The model reads the rows between the bounds as brushed.
                regionWhere(ask, true)
          }, picked in the plot "${ask.plot.title}"`
        : ask?.kind === 'cells' && ask.cells.length > 1
          ? `the cells ${ask.cells.map(id => this._labelOf(id)).join(' and ')} together`
          : ask?.kind === 'table' || ask?.kind === 'image'
            ? ask.about
            : null;
    const language = (this.languageName() ?? 'python').toLowerCase();
    return {
      question: { text: option.text, type: option.type },
      // The model writes the cell in the kernel's language.
      language,
      selection: selection?.source ? selection : null,
      about,
      // The rows picked in a plot, as the pandas mask of Keep selection:
      // a model answered about every row of the frame, where the question
      // was about 65 of them (design iteration 1.95).
      rows:
        ask?.kind === 'region' && language === 'python'
          ? this._pickedRows(ask)
          : undefined,
      // A point or an area of a picture: the AI reads the picture itself.
      image: ask?.kind === 'image' ? imageRequest(ask.pick) : undefined,
      placement: where.kind,
      // How the analyst works shapes the cell: the step alone, a figure
      // or table for a report, or the directions the answer opens.
      mode: this.mode,
      cell: target
        ? target.type === 'markdown'
          ? {
              label: this.noteLabel(target),
              kind: 'markdown',
              source:
                (ask?.kind === 'note' ? ask.claim : null) ??
                noteBody(target.model.sharedModel.getSource())
            }
          : {
              label: target.label,
              source: target.model.sharedModel.getSource()
            }
        : undefined,
      // The server sends the model 30 columns of a frame, and the size of
      // each group of columns: the rest would only lengthen the request.
      variables: (snapshot?.variables ?? []).map(variable => ({
        ...variable,
        columns: variable.columns?.slice(0, 30),
        groups: variable.groups?.map(group => ({
          label: group.label,
          columns: [],
          total: group.total ?? group.columns.length
        }))
      })),
      packages: snapshot?.packages ?? {},
      cells: this.codeCells().map(cell => `${cell.label} ${cell.title}`),
      // What the notebook defines and imports: the server adds the rest.
      defined: [
        ...new Set(this.codeCells().flatMap(cell => cell.analysis?.defs ?? []))
      ]
    };
  }

  private async _write(
    option: IOption,
    where: IPlacement,
    target: IEpiCell | null,
    progress: IProgress | null,
    ask: Ask | null,
    signal?: AbortSignal
  ): Promise<{ code: string; meta: Partial<IEpiCellMeta> }> {
    if (!this.aiReady('cells')) {
      throw new Error(
        `No AI model answered: ${this.aiOff()?.reason ?? 'none is set up on the server'}.`
      );
    }
    let written: { code: string; meta: Partial<IEpiCellMeta> } | null = null;
    let failure: string | null = null;
    await this._listed();
    await this.api.solve(
      this._solveBody(option, where, target, ask),
      event => {
        if (event.type === 'progress' && progress) {
          progress.stage = event.stage;
          progress.elapsed = event.elapsed;
          if (event.message) {
            progress.thinking = event.message;
          }
          this._emit();
        } else if (event.type === 'result') {
          const cell = event.cell as {
            code: string;
            summary: string;
            assumptions: IEpiCellMeta['assumptions'];
            follow_up: IEpiCellMeta['follow_up'];
          };
          written = {
            code: cell.code,
            meta: {
              summary: cell.summary,
              assumptions: cell.assumptions,
              follow_up: cell.follow_up,
              generated_by: this._writtenMark(event)
            }
          };
        } else if (event.type === 'error') {
          failure = event.message;
        }
      },
      signal
    );
    if (!written) {
      throw new Error(failure ?? 'The AI did not write the cell');
    }
    return written;
  }

  /**
   * Whether a question that needs AI goes to an agent: a new cell after the
   * question, as the setting chooses. An edit in place, a branch or a
   * preview that the analyst chose, and a question about a picture, get
   * one cell.
   */
  private _byAgent(where: IPlacement, ask: Ask | null): boolean {
    return (
      this.settings.answers === 'agent' &&
      where.kind === 'new' &&
      ask?.kind !== 'image'
    );
  }

  /**
   * The code cells around a variable: those that make it, those that bring
   * it in with an import, and those that use it, a decision chip included.
   */
  variableCells(name: string): {
    made: IEpiCell[];
    imported: IEpiCell[];
    used: IEpiCell[];
  } {
    const cells = this.codeCells();
    const importing = (cell: IEpiCell) =>
      importsName(cell.model.sharedModel.getSource(), name);
    const defining = cells.filter(cell => cell.analysis?.defs.includes(name));
    return {
      made: defining.filter(cell => !importing(cell)),
      imported: defining.filter(importing),
      used: cells.filter(
        cell =>
          !defining.includes(cell) &&
          (cell.analysis?.uses.includes(name) ||
            cell.decisions.some(decision => decision.name === name))
      )
    };
  }

  /**
   * Add an empty code or text cell at this place in the notebook, as the
   * Code view's buttons between cells do, and put the cursor in it.
   */
  insertCellAt(index: number, type: 'code' | 'markdown'): string {
    this.notebook.sharedModel.insertCell(index, {
      cell_type: type,
      source: '',
      metadata: {}
    });
    const id = this.notebook.cells.get(index).id;
    this._focusNext = id;
    this.setCurrentCell(id);
    this._emit();
    return id;
  }

  /** Whether this cell's editor should take the cursor when it opens. */
  focusRequested(cellId: string): boolean {
    return this._focusNext === cellId;
  }

  /** The editor of the cell took the cursor: the request is done. */
  focusTaken(cellId: string): void {
    if (this._focusNext === cellId) {
      this._focusNext = null;
    }
  }

  /** The run whose strip is under this cell, if any. */
  agentRunAt(cellId: string): IAgentRun | null {
    return this.agentRuns.find(run => run.stripId === cellId) ?? null;
  }

  /**
   * "Would I get the same results in R?", once for each kernel of the
   * server in another language, or in another version of the notebook's
   * language (design iteration 1.69). Each names the kernel that would
   * answer it. Nothing runs until the analyst asks.
   */
  kernelQuestions(): ICrossQuestion[] {
    return crossQuestions(this._kernelName(), this._kernelChoices());
  }

  /**
   * Ask a question of `kernelQuestions`: an agent makes a notebook with the
   * kernel beside this one, runs the analysis there, and writes the
   * comparison into this notebook. It is an agent's run whatever the setting
   * of answers, and it does not count with the questions about the data.
   */
  async askInKernel(question: ICrossQuestion): Promise<void> {
    const option: IOption = {
      id: question.id,
      text: question.text,
      type: 'model',
      origin: 'checkup',
      probability: null,
      reasons: [
        `An agent answers it in a notebook of its own, with ${question.kernel.displayName}`
      ],
      placement: null,
      code: null
    };
    const cells = this.codeCells();
    const where: IPlacement = {
      kind: 'new',
      cell: cells[cells.length - 1]?.id ?? null,
      label: 'new cell at the end'
    };
    const again = () => this.askInKernel(question);
    if (this._heldAtCap()) {
      // Asked from the kernel's menu, at the top of the view: the strip that
      // says why the run did not start comes into sight.
      const held = this._hold(where, { text: option.text, option }, again);
      if (held) {
        this._revealStrip(held);
      }
      return;
    }
    const anchorId = `end:${++counter}`;
    const strip: IStrip = {
      cellId: anchorId,
      question: { id: option.id, text: option.text, type: option.type },
      guess: null,
      text: option.text,
      action: 'In a notebook of its own',
      placement: where,
      status: 'writing',
      stage: null,
      elapsed: null,
      started: Date.now(),
      thinking: null,
      before: null,
      after: null,
      insertedId: null,
      error: null,
      showDiff: false
    };
    this.strips.set(anchorId, strip);
    (this._kernelAsked ??= new WeakMap()).set(strip, question.kernel);
    this._emit();
    try {
      await this._agent(option, where, null, strip, null, again);
    } catch (error) {
      strip.status = 'error';
      strip.error = describeError(error);
    }
    this._emit();
  }

  /** The name of the notebook's kernelspec: the running kernel's, else the one it saved. */
  private _kernelName(): string | null {
    const spec = this.notebook.getMetadata('kernelspec') as
      { name?: unknown } | undefined;
    return (
      this.sessionContext.session?.kernel?.name ??
      (typeof spec?.name === 'string' ? spec.name : null)
    );
  }

  /** The kernels of the server, as JupyterLab lists them. */
  private _kernelChoices(): IKernelChoice[] {
    const specs = this.sessionContext.specsManager?.specs?.kernelspecs as
      Record<string, IKernelSpecLike | undefined> | undefined;
    return kernelChoices(specs);
  }

  /**
   * The code cells of a notebook as a comparison reads them: each one's
   * label, code and the text of its outputs.
   */
  private _comparedCells(model: EpiModel): IComparedCell[] {
    return model.codeCells().map(cell => ({
      label: cell.label,
      code: cell.model.sharedModel.getSource(),
      outputs: cellOutputText(outputsOf(cell.model))
    }));
  }

  /**
   * What an agent's run reads besides the question: the server's kernels
   * and the files of the notebook's folder, which a run needs to make a
   * notebook, and for a question that compares kernels, this notebook's
   * cells with their code and outputs.
   */
  private async _agentContext(
    compare: IKernelChoice | null
  ): Promise<Record<string, unknown>> {
    // A view that cannot make notebooks gives the agent nothing to make
    // one with, and asks the server for no listing.
    if (!this.runs.host && !compare) {
      return {};
    }
    const current = this._kernelName();
    const choices = this._kernelChoices();
    const body: Record<string, unknown> = {
      kernels: promptKernels(choices, current)
    };
    try {
      const folder = await this._contents().get(
        PathExt.dirname(this.context.path),
        { content: true }
      );
      body.files = ((folder.content ?? []) as Contents.IModel[])
        .filter(item => !item.name.startsWith('.'))
        .slice(0, 60)
        .map(item => ({
          name: item.name,
          type: item.type,
          ...(typeof item.size === 'number' ? { size: item.size } : {})
        }));
    } catch {
      // The listing is a help to the agent: a run goes on without it.
    }
    if (compare) {
      const own = choices.find(choice => choice.name === current);
      body.compare = {
        kernel: compare.name,
        display_name: compare.displayName,
        language: compare.language
      };
      body.notebook = {
        name: PathExt.basename(this.context.path),
        kernel: own?.displayName ?? current ?? '',
        language: own?.language ?? this.bridge.languageName ?? '',
        // The outputs as the notebook saved them, errors included: a SAS
        // notebook's side of the comparison comes from them alone. The
        // server reads the first 40 cells.
        cells: this.codeCells()
          .slice(0, 40)
          .map(cell => ({
            label: cell.label,
            title: cell.title,
            code: cell.model.sharedModel.getSource(),
            outputs: [cellOutputText(outputsOf(cell.model))].filter(Boolean)
          }))
      };
    }
    return body;
  }

  /**
   * The agents' runs of every open notebook, which this view shares with
   * the other views of its notebook and with JupyterLab's Running panel
   * (./runs.ts).
   */
  get runs(): AgentRuns {
    return (this._runs ??= new AgentRuns());
  }

  /**
   * Bring the strip of an agent's run into sight: the Running panel opened
   * the view on the run, or the history of runs opened it again. The view
   * takes it once it has drawn the strip, scrolls to it and outlines it for
   * a moment.
   */
  showRun(run: IAgentRun): void {
    if (this.settings.agentView === 'sidebar') {
      this.settings.requestRevealRight();
    }
    this._stripToShow = run.stripId;
    this._stripIfHidden = false;
    this._stripCell = null;
    this._stripFollow = false;
    if (this.cell(run.stripId)) {
      this.setCurrentCell(run.stripId);
    }
    this._emit();
  }

  /**
   * The analyst started a run, or a question at the end waits at the cap:
   * the view scrolls to its strip and outlines it for a moment, when the
   * strip is out of sight (design iteration 1.73). The strip of a question
   * asked from the kernel's menu or the Check-up goes at the end of the
   * notebook, far from where the analyst was. `cell` is the cell that the
   * answer added, which comes into sight with the strip (1.93); `follow`
   * brings it into sight again once it ran, with its outputs.
   */
  private _revealStrip(
    key: string,
    cell: string | null = null,
    follow = false
  ): void {
    this._stripToShow = key;
    this._stripIfHidden = true;
    this._stripCell = cell;
    this._stripFollow = follow;
    this._emit();
  }

  /** The strip of a run to bring into sight, until the view has shown it. */
  get stripToShow(): string | null {
    return this._stripToShow;
  }

  /**
   * The cell that comes into sight with the strip to show, right under it:
   * the new cell of a template's answer, or of a model's one-cell answer
   * (design iteration 1.93). Null for the strip of an agent's run.
   */
  get stripCellToShow(): string | null {
    return this._stripToShow !== null ? this._stripCell : null;
  }

  /**
   * Whether the strip to show came into sight already with its cell, which
   * has run since: the view brings the cell's outputs into sight under it,
   * unless the analyst has moved the view in the meantime (1.93).
   */
  get stripFollows(): boolean {
    return this._stripToShow !== null && this._stripFollow;
  }

  /**
   * Whether the view leaves the strip to show where it is when it is in
   * sight already: a strip of a run that the analyst just started.
   */
  get stripIfHidden(): boolean {
    return this._stripToShow !== null && this._stripIfHidden;
  }

  /** The view showed the strip of `showRun`, or cannot show it. */
  stripShown(): void {
    this._stripToShow = null;
    this._stripIfHidden = false;
    this._stripCell = null;
    this._stripFollow = false;
  }

  /**
   * The notebook's agents' runs, the newest first, for the history of runs
   * in the Exploration panel (design iteration 1.73): those that go on, and
   * those that the notebook keeps.
   */
  runHistory(): IHistoryRow[] {
    return historyRows(notebookMeta(this.notebook).agent_runs, [
      ...this.agentRuns,
      ...this.runs
        .of(this.notebook)
        .map(entry => entry.run)
        .filter(run => !this.agentRuns.includes(run))
    ]);
  }

  /**
   * The id of the run that wrote this cell, while the notebook keeps the run
   * or its strip shows, else null.
   */
  runOf(cellId: string): string | null {
    const id = this.cell(cellId)?.meta.agent?.run;
    if (!id) {
      return null;
    }
    const kept = notebookMeta(this.notebook).agent_runs ?? {};
    return id in kept || this.agentRuns.some(run => run.id === id) ? id : null;
  }

  /**
   * Show the strip of a run of this notebook, and bring it into sight: the
   * strip that shows now, or the run as the notebook keeps it, drawn again
   * under the cell that the question was about, else under its first cell,
   * else at the end (design iteration 1.73). A run asked in another
   * notebook shows in that notebook's view.
   */
  async openRun(id: string): Promise<void> {
    const live =
      this.agentRuns.find(run => run.id === id) ??
      this.runs.of(this.notebook).find(entry => entry.run.id === id)?.run;
    if (live) {
      this.showRun(live);
      return;
    }
    const record = notebookMeta(this.notebook).agent_runs?.[id];
    if (!record) {
      return;
    }
    if (record.asked_in && record.asked_in !== this.context.path) {
      const host = this.runs.host;
      if (host) {
        await host.show(record.asked_in);
        await host.modelOf(record.asked_in)?.openRun(id);
      }
      return;
    }
    const run = pastRun(id, record);
    const here = run.steps
      .filter(step => !step.notebook)
      .flatMap(step => step.cells);
    // Where the strip showed: right above the run's cells, under the cell
    // that the run's first cell follows, which is the cell asked about when
    // no cell below it had run (./placement.ts); else with the first cell.
    const first = here.map(cellId => this.cell(cellId)).find(cell => !!cell);
    const before = first
      ? (first.branchOf ?? this._cellBefore(first.id))
      : null;
    run.stripId =
      (!first || !run.anchor || before === run.anchor
        ? [run.anchor, ...here]
        : [before, ...here, run.anchor]
      ).find(
        (cellId): cellId is string =>
          !!cellId && !!this.cell(cellId) && !this.strips.has(cellId)
      ) ?? `end:${++counter}`;
    const strip: IStrip = {
      cellId: run.stripId,
      question: {
        id: `${run.notebooks?.length ? 'crosskernel' : 'agent'}:${id}`,
        text: run.question,
        type: 'model'
      },
      guess: null,
      text: run.question,
      action: 'Agent',
      placement: { kind: 'new', cell: run.anchor, label: 'the run' },
      status: run.state === 'failed' ? 'error' : 'done',
      stage: null,
      elapsed: run.seconds ?? null,
      started: run.started,
      thinking: null,
      before: null,
      after: null,
      insertedId: null,
      error: run.error,
      showDiff: false,
      agent: run
    };
    this.strips.set(run.stripId, strip);
    this.agentRuns = [...this.agentRuns, run];
    // Every view of the notebook shows it, until its ×.
    this.runs.add({
      run,
      strip,
      context: this.context,
      stop: () => undefined,
      owner: this
    });
    this.showRun(run);
  }

  /**
   * The list of runs changed: a view of this notebook started a run, a run
   * went on, or its strip closed. This view shows each run of its notebook
   * with the strip of the view that started it, so that both draw the same.
   */
  private _onRuns(): void {
    if (this._isDisposed) {
      return;
    }
    const entries = this.runs.of(this.notebook);
    const listed = new Set(entries.map(entry => entry.run));
    for (const run of listed) {
      this._listedRuns.add(run);
    }
    // A run that left the list goes; a run that was never on it stays.
    this.agentRuns = [
      ...this.agentRuns.filter(
        run => !listed.has(run) && !this._listedRuns.has(run)
      ),
      ...listed
    ].sort((a, b) => a.started - b.started);
    for (const { run, strip, context } of entries) {
      if (context.model !== this.notebook) {
        // A run asked in another notebook that works in this one: a line
        // under the text that the run wrote first here.
        const key = run.notebooks?.find(
          notebook => notebook.path === this.context.path
        )?.intro;
        if (key && this.strips.get(key)?.agent !== run) {
          this.strips.set(key, {
            ...strip,
            cellId: key,
            placement: { kind: 'new', cell: key, label: 'the run' },
            elsewhere: context.path
          });
        }
        continue;
      }
      if (this.strips.get(run.stripId) === strip) {
        continue;
      }
      // The run's first cell took the strip of a question at the end.
      for (const [key, other] of this.strips) {
        if (other === strip) {
          this.strips.delete(key);
        }
      }
      this.strips.set(run.stripId, strip);
    }
    for (const [key, strip] of this.strips) {
      if (
        strip.agent &&
        this._listedRuns.has(strip.agent) &&
        !listed.has(strip.agent)
      ) {
        this.strips.delete(key);
      }
    }
    // Not _emit: the list would hear of its own change again.
    this._revision++;
    this._schedule();
  }

  /**
   * Answer a question with an agent: the remote model adds and runs the
   * cells it needs, and branches to compare choices, through tools that
   * the view runs as the server asks (whybook/server/agent.py). The strip
   * of the question shows the run; each cell is in the notebook as it runs.
   */
  private async _agent(
    option: IOption,
    where: IPlacement,
    target: IEpiCell | null,
    strip: IStrip,
    ask: Ask | null,
    restart: () => Promise<void>
  ): Promise<void> {
    if (!this.aiReady('cells')) {
      throw new Error(
        `No AI model answered: ${this.aiOff()?.reason ?? 'none is set up on the server'}.`
      );
    }
    const run: IAgentRun = {
      id: null,
      stripId: strip.cellId,
      question: option.text,
      anchor: target?.id ?? null,
      state: 'starting',
      steps: [],
      notes: [],
      thinking: null,
      answer: null,
      answerCells: [],
      followUp: [],
      by: null,
      costUsd: null,
      error: null,
      started: Date.now(),
      keepLocal: this.keepDataLocal,
      // Go on, past the notebook's cap: the question again, from the start.
      restart
    };
    // "Would I get the same results in R?" names the kernel that answers it.
    const compare = this._kernelAsked?.get(strip) ?? null;
    if (compare) {
      run.compare = {
        name: compare.name,
        displayName: compare.displayName,
        label: compare.label
      };
    }
    this.agentRuns = [...this.agentRuns, run];
    strip.agent = run;
    // The run belongs to the notebook: every view of it shows the strip,
    // and the Running panel lists the run. This view runs its tool calls,
    // in this notebook and in those that the run makes.
    this.runs.add({
      run,
      strip,
      context: this.context,
      stop: () => this.stopAgent(run),
      discard: anyway => this.discardAgent(run, anyway),
      owner: this
    });
    const abort = new AbortController();
    this._agentAborts.set(run, abort);
    // The analyst sees the run start, wherever its strip is: in the sidebar,
    // or at the end of the notebook for a question from the kernel's menu.
    if (this.settings.agentView === 'sidebar') {
      this.settings.requestRevealRight();
    }
    this._revealStrip(strip.cellId);
    // With a cap on the notebook, the server stops the run at what is left
    // under it, or at its own cap of a run, whichever is lower.
    const budget = this._runBudget();
    // The events are handled in order: a tool runs to its end before the next event.
    let chain = Promise.resolve();
    const question: IAskedQuestion = {
      id: option.id,
      text: option.text,
      type: option.type,
      ...this._provenance(option),
      refs: labelRefs(option.text, this.cells(), [target?.id, where.cell])
    };
    try {
      await this._listed();
      const context = await this._agentContext(compare);
      await this.api.agent(
        {
          ...this._solveBody(option, where, target, ask),
          ...context,
          ...(budget !== null ? { budget_usd: budget } : {})
        },
        event => {
          chain = chain.then(() =>
            this._agentEvent(run, strip, question, event as IAgentEvent)
          );
        },
        abort.signal
      );
      await chain;
    } catch (error) {
      await chain.catch(() => undefined);
      if (run.state !== 'stopped') {
        run.state = 'failed';
        run.error = abort.signal.aborted ? null : describeError(error);
      }
    }
    this._agentAborts.delete(run);
    if (this._isDisposed && !this._agentAborts.size) {
      // The view closed while the run went on: nothing needs the kernel now.
      this._release();
    }
    // The notebooks that the run made let go of it too.
    for (const notebook of run.notebooks ?? []) {
      this._runModels?.get(notebook.path)?._leaveRun(run);
    }
    if (this._notebookGone()) {
      return;
    }
    if (run.state === 'starting' || run.state === 'working') {
      run.state = run.error ? 'failed' : 'done';
    }
    strip.status = run.state === 'failed' ? 'error' : 'done';
    strip.error = run.error;
    // A run that answered, or that was stopped after a cell ran, counts.
    const cellsRan = run.steps.some(
      step => step.cells.length > 0 && step.state === 'done'
    );
    if (run.state === 'failed') {
      this._recordOutcome(option.id, 'failed');
    } else if (run.state === 'done' || cellsRan) {
      this._recordOutcome(option.id, 'ran');
    }
    this._emit();
    // The run ended: the other views of the notebook draw its end.
    this.runs.touch();
  }

  private async _agentEvent(
    run: IAgentRun,
    strip: IStrip,
    question: IAskedQuestion,
    event: IAgentEvent
  ): Promise<void> {
    if (this._notebookGone()) {
      // No view can run a tool call of the run, nor keep its end.
      if (run.state === 'starting' || run.state === 'working') {
        this._stopRun(run);
      }
      return;
    }
    // After Stop, only the run's end counts: the server says what it cost.
    if (
      (event as { type: string }).type === 'ping' ||
      (run.state === 'stopped' && event.type !== 'result')
    ) {
      return;
    }
    if (event.type === 'started') {
      run.id = event.run;
      run.keepLocal = event.keep_local;
      run.state = 'working';
    } else if (event.type === 'progress') {
      run.thinking = event.message ?? null;
      strip.stage = event.stage;
    } else if (event.type === 'text') {
      run.notes = [...run.notes, event.text];
    } else if (event.type === 'guard_held') {
      // What the review guard held back shows in the run's strip.
      run.held = [...(run.held ?? []), event];
      run.notes = [...run.notes, heldWords(event)];
    } else if (event.type === 'tool') {
      run.state = 'working';
      run.thinking = null;
      const result = await this._agentTool(run, strip, question, event);
      // Stop may have come while the tool ran.
      if ((run.state as IAgentRun['state']) !== 'stopped') {
        await this.api.agentResult({
          run: event.run,
          call: event.call,
          result
        });
      }
    } else if (event.type === 'result') {
      run.seconds = secondsOf(event, run);
      run.costUsd = typeof event.cost_usd === 'number' ? event.cost_usd : null;
      if (event.stopped) {
        run.state = 'stopped';
        run.capped = runCap(event.capped);
      } else {
        run.state = 'done';
        run.answer = typeof event.answer === 'string' ? event.answer : null;
        run.answerRefs = labelRefs(
          run.answer ?? '',
          this.cells(),
          run.steps.flatMap(step => step.cells)
        );
        run.answerCells = (event.cells as string[] | undefined) ?? [];
        // The cells that hold the answer show the question's type; the
        // run's other cells keep the type of their own step.
        this._answerType(run);
        run.followUp = (event.follow_up as string[] | undefined) ?? [];
        run.by = writtenBy(
          this.settings.models.cells,
          event.model,
          event.file ?? null
        );
        // A run that worked in a notebook it made brings back the
        // comparison, as a text cell of this notebook.
        if (run.notebooks?.length) {
          await this._keepComparison(
            run,
            event.comparison as IRawComparison | undefined
          );
        }
      }
      this._keepRun(run, event, event.stopped ? 'stopped' : 'done');
      run.thinking = null;
    } else if (event.type === 'error') {
      run.state = 'failed';
      run.error = event.message;
      run.seconds = secondsOf(event, run);
      run.costUsd = typeof event.cost_usd === 'number' ? event.cost_usd : null;
      this._keepRun(run, event, 'failed');
    }
    this._emit();
  }

  /** Run one tool of an agent's run in the notebook, and say what came out. */
  private async _agentTool(
    run: IAgentRun,
    strip: IStrip,
    question: IAskedQuestion,
    event: IAgentToolEvent
  ): Promise<Record<string, unknown>> {
    const input = event.input;
    if (event.name === 'new_notebook') {
      return this._agentNotebook(run, question, event);
    }
    if (event.name === 'share_frames') {
      return this._agentFrames(run, event);
    }
    // The notebook that the tool acts in: this one, or one that the run
    // made, whose view model adds and runs the cells in its kernel.
    const target = this._agentTarget(run, input.notebook);
    if ('error' in target) {
      return { status: 'error', error: target.error };
    }
    const model = target.model;
    const path = target.notebook?.path;
    const labelled = () => model.cells();
    // Both views draw a change: the strip here, the cells there.
    const changed = () => {
      this._emit();
      if (model !== this) {
        model._emit();
      }
    };
    // A fix of a cell of the run that failed, or its removal (1.103).
    if (
      event.name === 'remove_cell' ||
      (event.name === 'run_cell' && input.fix)
    ) {
      return model._agentFailed(run, event, path, changed);
    }
    if (event.name === 'run_cell') {
      // A cell that the agent removed after it failed is not its last cell.
      const lastAdded = run.steps
        .flatMap(step =>
          step.tool === 'run_cell' && step.notebook === path
            ? keptCells(step)
            : []
        )
        .pop();
      const code = String(input.code ?? '');
      const named = cellByLabel(labelled(), input.after as string | undefined);
      const last = lastAdded && model.cell(lastAdded) ? lastAdded : null;
      // The run's next cell follows its last cell, and its first cell goes
      // below the cell the question is about and the last cell that ran; a
      // cell that the agent names counts when it is lower (./placement.ts).
      const afterId = model._newCellAfter(
        model._lower(named, last ?? (path ? null : run.anchor)),
        code,
        { id: run.id, later: last !== null }
      );
      const after = afterId ? model.cell(afterId) : null;
      const step: IAgentStep = {
        call: event.call,
        tool: 'run_cell',
        title: String(input.title ?? 'A step'),
        why: String(input.why ?? ''),
        cells: [],
        ...(path ? { notebook: path } : {}),
        state: 'running',
        error: null
      };
      run.steps = [...run.steps, step];
      const inserted = model._agentCell(run, question, step, after, code);
      changed();
      const outcome = await model._agentRun(run, inserted, step.title, false);
      step.state = outcome.status === 'ok' ? 'done' : 'error';
      step.error = (outcome.error as string | undefined) ?? null;
      changed();
      return outcome;
    }
    if (event.name === 'explore') {
      const of = model.cell(
        cellByLabel(labelled(), input.of as string | undefined) ??
          (path ? null : run.anchor) ??
          ''
      );
      const parent = of?.branchOf ? model.cell(of.branchOf) : of;
      if (!parent || parent.type !== 'code') {
        return {
          status: 'error',
          error: `no code cell ${String(input.of ?? '')}`
        };
      }
      const branches =
        (input.branches as { title?: string; code?: string }[]) ?? [];
      const step: IAgentStep = {
        call: event.call,
        tool: 'explore',
        title: String(input.why ?? `Branches of ${parent.label}`),
        why: String(input.why ?? ''),
        cells: [],
        ...(path ? { notebook: path } : {}),
        state: 'running',
        error: null
      };
      run.steps = [...run.steps, step];
      const cells = branches.map(branch =>
        model._agentCell(
          run,
          question,
          step,
          parent,
          String(branch.code ?? ''),
          {
            title: String(branch.title ?? 'A branch'),
            branchOf: parent
          }
        )
      );
      changed();
      const outcomes = await Promise.all(
        cells.map((cell, index) =>
          model._agentRun(run, cell, String(branches[index].title ?? ''), true)
        )
      );
      const ok = outcomes.every(outcome => outcome.status === 'ok');
      step.state = ok ? 'done' : 'error';
      step.error = ok ? null : 'a branch failed';
      changed();
      return {
        status: ok ? 'ok' : 'error',
        of: parent.label,
        branches: outcomes
      };
    }
    if (event.name === 'write_file') {
      const before = run.steps.length;
      const result = await model._agentFile(run, event);
      // The step that wrote it, in the notebook it belongs to.
      const step = run.steps[before];
      if (step && path) {
        step.notebook = path;
      }
      changed();
      return result;
    }
    return { status: 'error', error: `the view has no tool ${event.name}` };
  }

  /**
   * The notebook that a tool acts in, by the name that the agent gives:
   * this one without a name, or a notebook that the run made.
   */
  private _agentTarget(
    run: IAgentRun,
    name: unknown
  ): { model: EpiModel; notebook: IRunNotebook | null } | { error: string } {
    const wanted = typeof name === 'string' ? name.trim() : '';
    if (
      !wanted ||
      wanted === this.context.path ||
      wanted === PathExt.basename(this.context.path)
    ) {
      return { model: this, notebook: null };
    }
    const notebook = (run.notebooks ?? []).find(
      item => item.path === wanted || PathExt.basename(item.path) === wanted
    );
    if (!notebook) {
      return {
        error: `no notebook ${wanted} in this run: make it with new_notebook`
      };
    }
    const model =
      this._runModels?.get(notebook.path) ??
      this.runs.host?.modelOf(notebook.path) ??
      null;
    if (!model || model.context.isDisposed) {
      return {
        error: `${PathExt.basename(notebook.path)} is closed: finish with what you have`
      };
    }
    return { model, notebook };
  }

  /**
   * Make a notebook for the run beside this one, with a kernel of the
   * server, through JupyterLab's commands, and open it next to this one.
   * The view writes its first cell, which says which question it answers,
   * and reads what its kernel has: its version, whether it reads parquet,
   * and its packages. At most one a run; the server counts them.
   */
  private async _agentNotebook(
    run: IAgentRun,
    question: IAskedQuestion,
    event: IAgentToolEvent
  ): Promise<Record<string, unknown>> {
    const input = event.input;
    const requested = String(input.name ?? '');
    const step: IAgentStep = {
      call: event.call,
      tool: 'new_notebook',
      title: `Making ${requested || 'a notebook'}`,
      why: String(input.why ?? ''),
      cells: [],
      state: 'running',
      error: null
    };
    run.steps = [...run.steps, step];
    this._emit();
    const refuse = (reason: string) => {
      step.state = 'error';
      step.error = reason;
      this._emit();
      return { status: 'refused', reason };
    };
    const host = this.runs.host;
    if (!host) {
      return refuse('this view cannot make notebooks');
    }
    const name = String(input.kernel ?? '');
    const kernel = this._kernelChoices().find(choice => choice.name === name);
    if (!kernel) {
      return refuse(`no kernel named ${name}: choose one of "kernels"`);
    }
    const where = newNotebookPath(this.context.path, requested);
    if ('error' in where) {
      return refuse(where.error);
    }
    try {
      await this._contents().get(where.path, { content: false });
      return refuse('a file of this name exists: choose another name');
    } catch {
      // No such file: the name is free.
    }
    let model: EpiModel;
    try {
      model = await host.create({
        path: where.path,
        kernel: kernel.name,
        beside: this.context.path
      });
    } catch (error) {
      return refuse(`the notebook could not be made: ${describeError(error)}`);
    }
    // The run works in the notebook until it ends: a view of it that closes
    // keeps what the run uses, and the run stops if the notebook closes.
    model._joinRun(run, this._agentAborts.get(run) ?? null);
    (this._runModels ??= new Map()).set(where.path, model);
    const title = notebookTitle({
      heading: this.sections().title ?? null,
      first: this.context.path,
      given: String(input.title ?? ''),
      requested,
      label: kernel.label
    });
    const intro = model._startAgentNotebook(
      introText({
        title,
        question: run.question,
        first: this.context.path,
        kernel
      }),
      run,
      question,
      kernel
    );
    const notebook: IRunNotebook = {
      path: where.path,
      kernel: kernel.name,
      displayName: kernel.displayName,
      label: kernel.label,
      sandboxed: kernel.sandboxed,
      intro
    };
    run.notebooks = [...(run.notebooks ?? []), notebook];
    step.notebook = where.path;
    this.runs.join(run, model.context);
    // What the kernel has: its version, parquet, and its packages.
    let facts = kernelFacts(null);
    try {
      facts = kernelFacts(await model.bridge.run('kernel_facts', {}));
    } catch {
      // A kernel without the program: the agent finds out by running cells.
    }
    notebook.version = facts.language;
    notebook.parquet = facts.parquet;
    void model.context.save().catch(() => undefined);
    // The step's link names the notebook.
    step.title = `A new notebook, with ${kernel.displayName}`;
    step.state = 'done';
    this._emit();
    model._emit();
    return {
      status: 'ok',
      notebook: PathExt.basename(where.path),
      kernel: kernel.displayName,
      language: kernel.label,
      version: facts.language,
      sandboxed: kernel.sandboxed,
      parquet: facts.parquet,
      packages: facts.packages
    };
  }

  /**
   * Write frames of this notebook's kernel to files that a notebook of the
   * run reads: a fixed program of the view runs in this kernel, as parquet
   * when the other kernel reads it, else as CSV, and this notebook gets no
   * cell. A kernel that cannot run the program, such as SAS without a
   * licence, writes nothing: the agent ports the reading of the data.
   */
  private async _agentFrames(
    run: IAgentRun,
    event: IAgentToolEvent
  ): Promise<Record<string, unknown>> {
    const input = event.input;
    const frames = (Array.isArray(input.frames) ? input.frames : [])
      .map(String)
      .slice(0, 10);
    const step: IAgentStep = {
      call: event.call,
      tool: 'share_frames',
      title: `Writing ${frames.join(', ') || 'frames'}`,
      why: String(input.why ?? ''),
      cells: [],
      state: 'running',
      error: null
    };
    run.steps = [...run.steps, step];
    this._emit();
    const refuse = (reason: string) => {
      step.state = 'error';
      step.error = reason;
      this._emit();
      return { status: 'refused', reason };
    };
    const target = this._agentTarget(run, input.notebook);
    if ('error' in target) {
      return refuse(target.error);
    }
    if (!target.notebook) {
      return refuse(
        'share_frames writes files for a notebook that new_notebook made: name that notebook'
      );
    }
    const language = this.bridge.language;
    if (!language?.snippets.write_frames) {
      const runs =
        language?.label ??
        this.bridge.languageName ??
        'no language the view knows';
      return refuse(
        `the kernel of ${PathExt.basename(this.context.path)} cannot write files: it runs ${runs}. Port the reading of the data from its code.`
      );
    }
    const folder = framesFolder(language.label);
    let written: {
      folder: string;
      files: {
        frame: string;
        path: string;
        format: string;
        rows: number;
        columns: { name: string; type: string }[];
        existed: boolean;
      }[];
      errors: { frame: string; error: string }[];
    };
    try {
      written = await this.bridge.run('write_frames', {
        frames,
        folder,
        format: target.notebook.parquet ? 'parquet' : 'csv'
      });
    } catch (error) {
      return refuse(`the frames could not be written: ${describeError(error)}`);
    }
    const files = written.files ?? [];
    const errors = written.errors ?? [];
    const dir = PathExt.dirname(this.context.path);
    run.frames = [
      ...(run.frames ?? []),
      ...files.map((file): IFrameFile => ({
        path: PathExt.join(dir, file.path),
        existed: !!file.existed
      }))
    ];
    step.title = files.length
      ? `Wrote ${files.map(file => file.frame).join(' and ')} to ${folder}/`
      : 'Wrote no frame';
    step.state = files.length ? 'done' : 'error';
    step.error = errors.length
      ? errors.map(item => `${item.frame}: ${item.error}`).join('; ')
      : null;
    this._emit();
    return {
      status: files.length ? 'ok' : 'error',
      folder,
      files: files.map(({ frame, path, format, rows, columns }) => ({
        frame,
        path,
        format,
        rows,
        columns
      })),
      ...(errors.length ? { errors } : {})
    };
  }

  /**
   * Take part in a run that another view runs: this notebook is one that
   * the run made. A view of it that closes keeps the kernel and the cells
   * for the run, and the run stops if the notebook closes in every view.
   */
  private _joinRun(run: IAgentRun, abort: AbortController | null): void {
    this._agentAborts.set(run, abort ?? new AbortController());
  }

  /** The run that this notebook took part in ended. */
  private _leaveRun(run: IAgentRun): void {
    this._agentAborts.delete(run);
    if (this._isDisposed && !this._agentAborts.size) {
      this._release();
    }
  }

  /**
   * The first cell of a notebook that an agent's run made, in place of the
   * empty cell of a new notebook: a text that says which question it
   * answers, marked as the agent's. The notebook keeps its kernel's name and
   * language, as JupyterLab's notebook view keeps them.
   */
  private _startAgentNotebook(
    text: string,
    run: IAgentRun,
    question: IAskedQuestion,
    kernel: IKernelChoice
  ): string {
    this.notebook.setMetadata('kernelspec', {
      name: kernel.name,
      display_name: kernel.displayName,
      language: kernel.language
    });
    const info = this.sessionContext.session?.kernel?.info;
    void info?.then(reply => {
      if (!this.notebook.isDisposed && reply.language_info) {
        this.notebook.setMetadata(
          'language_info',
          reply.language_info as unknown as PartialJSONObject
        );
      }
    });
    const shared = this.notebook.sharedModel;
    shared.transact(() => {
      shared.deleteCellRange(0, shared.cells.length);
      shared.insertCell(0, { cell_type: 'markdown', source: text });
    });
    const cell = this.notebook.cells.get(0);
    setCellMeta(cell, {
      question,
      asked_by: 'user',
      written_by: 'agent',
      agent: { run: run.id ?? '', step: run.steps.length },
      generated_by: this._writtenMark()
    });
    this._emit();
    return cell.id;
  }

  /**
   * The comparison of a run that worked in a notebook it made: the
   * estimates that the agent cites, checked against the outputs of both
   * notebooks, the defaults that differ between the two languages, and what
   * the other kernel lacks. It goes into this notebook as a text cell at the
   * end, marked as the agent's, and a question asked at the end has its
   * strip there.
   */
  private async _keepComparison(
    run: IAgentRun,
    raw: IRawComparison | undefined
  ): Promise<void> {
    const other = run.notebooks?.[0];
    if (!other || (!raw && !run.compare)) {
      return;
    }
    const model =
      this._runModels?.get(other.path) ??
      this.runs.host?.modelOf(other.path) ??
      null;
    const current = this._kernelName();
    const own = this._kernelChoices().find(choice => choice.name === current);
    const firstCells = this._comparedCells(this);
    const secondCells = model ? this._comparedCells(model) : [];
    const comparison = buildComparison({
      raw,
      first: {
        path: this.context.path,
        kernel: own?.displayName ?? current ?? '',
        language: own?.language ?? this.bridge.languageName ?? '',
        results: firstCells.some(cell => cell.outputs.trim() !== '')
      },
      second: {
        path: other.path,
        kernel: other.displayName,
        language: model?.bridge.languageName ?? other.label,
        results: secondCells.some(cell => cell.outputs.trim() !== '')
      },
      firstCells,
      secondCells
    });
    run.comparison = comparison;
    const ran = run.steps
      .filter(step => step.notebook === other.path)
      .reduce((sum, step) => sum + step.cells.length, 0);
    const text = comparisonMarkdown({
      question: run.question,
      comparison,
      answer: run.answer,
      ran
    });
    const index = this.notebook.cells.length;
    this.notebook.sharedModel.insertCell(index, {
      cell_type: 'markdown',
      source: text
    });
    const cell = this.notebook.cells.get(index);
    const step: IAgentStep = {
      call: 'compare',
      tool: 'compare',
      title: 'The comparison, in this notebook',
      why: '',
      cells: [cell.id],
      code: { [cell.id]: text },
      state: 'done',
      error: null
    };
    run.steps = [...run.steps, step];
    setCellMeta(cell, {
      question: {
        id: `${run.compare ? 'crosskernel' : 'agent'}:${run.id ?? ''}`,
        text: run.question,
        type: 'model'
      },
      asked_by: 'user',
      written_by: 'agent',
      agent: { run: run.id ?? '', step: run.steps.length },
      generated_by: this._writtenMark()
    });
    // The analyst's guess goes with the run's first cell here.
    const holder = this.strips.get(run.stripId);
    if (holder && !holder.insertedId) {
      holder.insertedId = cell.id;
      this._keepGuess(holder);
    }
    this._moveEndStrip(run, cell.id);
    this._emit();
  }

  /**
   * A question asked at the end of the notebook: its strip goes with the
   * run's first cell here, `cellId`. With `after`, the cell that the run's
   * first cell went after: the strip shows right above the run's cells,
   * under that cell, or with the first cell while another strip holds that
   * cell (./placement.ts), and comes into sight there.
   */
  private _moveEndStrip(
    run: IAgentRun,
    cellId: string,
    after?: string | null
  ): void {
    const key = run.stripId;
    const strip = this.strips.get(key);
    if (
      !strip ||
      (after === undefined
        ? run.anchor || !key.startsWith('end:')
        : key === after)
    ) {
      return;
    }
    const to = after && !this.strips.has(after) ? after : cellId;
    this.strips.delete(key);
    strip.cellId = to;
    run.stripId = to;
    this.strips.set(to, strip);
    if (after !== undefined && run.anchor) {
      this._revealStrip(to);
    }
  }

  /**
   * Write a module that the agent asks for, next to the notebook: a new
   * file, or one that the agent wrote before. Its first line marks it as
   * written by AI, and the notebook's metadata records it, as for a cell.
   */
  private async _agentFile(
    run: IAgentRun,
    event: IAgentToolEvent
  ): Promise<Record<string, unknown>> {
    const input = event.input;
    const requested = String(input.path ?? '');
    const step: IAgentStep = {
      call: event.call,
      tool: 'write_file',
      title: `Wrote ${requested || 'a file'}`,
      why: String(input.why ?? ''),
      cells: [],
      file: null,
      state: 'running',
      error: null
    };
    run.steps = [...run.steps, step];
    this._emit();
    const refuse = (reason: string) => {
      step.state = 'error';
      step.error = reason;
      this._emit();
      return { status: 'refused', path: requested, reason };
    };
    // A notebook that a run made in R takes an R module.
    const where = agentFilePath(
      this.context.path,
      requested,
      this.bridge.language?.label === 'R' ? 'R' : 'Python'
    );
    if ('error' in where) {
      return refuse(where.error);
    }
    const content = String(input.content ?? '');
    if (content.length > FILE_CHARS) {
      return refuse(`a file holds at most ${FILE_CHARS} characters`);
    }
    const files = notebookMeta(this.notebook).files ?? {};
    let previous: string | null;
    try {
      const existing = await this._contents().get(where.path, {
        content: true,
        type: 'file',
        format: 'text'
      });
      previous = String(existing.content ?? '');
    } catch {
      previous = null;
    }
    if (previous !== null && !files[where.path]) {
      return refuse(
        'a file of this name exists, and the agent did not write it: choose another name'
      );
    }
    const at = new Date().toISOString();
    const marked = markedFile(
      content,
      PathExt.basename(this.context.path),
      null,
      at
    );
    try {
      await this._contents().save(where.path, {
        type: 'file',
        format: 'text',
        content: marked
      });
    } catch (error) {
      return refuse(`the file could not be written: ${describeError(error)}`);
    }
    setNotebookMeta(this.notebook, {
      files: {
        ...files,
        [where.path]: {
          generated_by: { ...this._writtenMark(), at },
          ...(run.id ? { run: run.id } : {})
        }
      }
    });
    const lines = marked.replace(/\n$/, '').split('\n').length;
    step.file = {
      path: where.path,
      name: where.name,
      lines,
      content: marked,
      previous,
      previousRecord: files[where.path] ?? null
    };
    step.title = `Wrote ${where.name}`;
    step.state = 'done';
    this._emit();
    return { status: 'ok', path: where.name, lines };
  }

  /** The server's files, for the modules the agent writes. */
  private _contents(): ContentsManager {
    this._contentsManager ??= new ContentsManager({
      serverSettings: this._serverSettings
    });
    return this._contentsManager;
  }

  /** Add a cell of an agent's step after `after`, or as a branch of it. */
  private _agentCell(
    run: IAgentRun,
    question: IAskedQuestion,
    step: IAgentStep,
    after: IEpiCell | null,
    code: string,
    branch: { title: string; branchOf: IEpiCell } | null = null
  ): ICodeCellModel {
    const parent = branch?.branchOf ?? null;
    const letter = parent ? this._nextLetter(parent) : undefined;
    const index = this._insertIndex(parent ?? after);
    const blank = this.isBlank() ? cellsOf(this.notebook) : [];
    const title = branch?.title ?? step.title;
    const inserted = insertCodeCell(this.notebook, index, code, {
      title,
      question,
      // The cell's badge shows what its own step does; the cells that hold
      // the answer show the question's type once the run ends (_answerType).
      step_type: stepType(title, step.why, code),
      asked_by: 'user',
      written_by: 'agent',
      placement: parent
        ? {
            kind: 'branch',
            cell: parent.id,
            label: `branch of ${parent.label}`
          }
        : {
            kind: 'new',
            cell: after?.id ?? null,
            label: after
              ? `new cell after ${after.label}`
              : 'new cell at the end'
          },
      agent: { run: run.id ?? '', step: run.steps.indexOf(step) + 1 },
      generated_by: this._writtenMark(),
      ...(parent && letter ? { branch: { of: parent.id, letter } } : {})
    });
    for (const cell of blank) {
      deleteCell(this.notebook, cell.id);
    }
    step.cells = [...step.cells, inserted.id];
    step.code = { ...step.code, [inserted.id]: code };
    // The run's first cell holds the analyst's guess, as the one cell of an
    // answer does.
    const holder = this.strips.get(run.stripId);
    const first = !!holder && !holder.insertedId;
    if (holder && !holder.insertedId) {
      holder.insertedId = inserted.id;
      this._keepGuess(holder);
    }
    // A question at the end of the notebook, or about a cell that the first
    // cell does not follow: its strip goes with the first cell added.
    this._moveEndStrip(
      run,
      inserted.id,
      first ? ((parent ?? after)?.id ?? null) : undefined
    );
    return inserted;
  }

  /**
   * The cells that hold a run's answer, in this notebook or in a notebook
   * that the run made, lose the type of their own step: their badge shows
   * the question's type (./agent.ts, answerHolders).
   */
  private _answerType(run: IAgentRun): void {
    const models = new Map<string, EpiModel>([['', this]]);
    for (const notebook of run.notebooks ?? []) {
      const other =
        this._runModels?.get(notebook.path) ??
        this.runs.host?.modelOf(notebook.path) ??
        null;
      if (other && !other.context.isDisposed) {
        models.set(notebook.path, other);
      }
    }
    const holders = answerHolders(run, notebook => {
      const model = models.get(notebook);
      const ours = new Set(
        run.steps
          .filter(step => (step.notebook ?? '') === notebook)
          .flatMap(step => keptCells(step))
      );
      return model ? model.cells().filter(cell => ours.has(cell.id)) : [];
    });
    for (const { notebook, id } of holders) {
      const cell = findCell(models.get(notebook)!.notebook, id);
      if (cell && cellMeta(cell).step_type) {
        setCellMeta(cell, { step_type: undefined });
      }
    }
  }

  /**
   * Fix a cell of an agent's run that failed, in place, or remove it
   * (design iteration 1.103). run_cell with `fix` writes the agent's code
   * into that cell, which runs again where it is, with its title, and takes
   * a new label as it runs; remove_cell deletes it. The cell's step keeps
   * the cell's error, which its line in the run's card names. A cell that
   * is no longer a failed cell of the run here, since the analyst removed
   * it or ran it again, answers `failed: false`, and the server lets the
   * run end without it.
   */
  private async _agentFailed(
    run: IAgentRun,
    event: IAgentToolEvent,
    path: string | undefined,
    changed: () => void
  ): Promise<Record<string, unknown>> {
    const input = event.input;
    const removing = event.name === 'remove_cell';
    const asked = String((removing ? input.cell : input.fix) ?? '');
    const steps = run.steps.filter(
      step =>
        step.notebook === path &&
        (step.tool === 'run_cell' || step.tool === 'explore')
    );
    const ours = new Set(steps.flatMap(step => keptCells(step)));
    // "[14]", "14" or "R [2]": the label at the end.
    const wanted = /(\d+[a-z]?)\]?\s*$/.exec(asked)?.[1];
    const id = wanted
      ? cellByLabel(
          this.cells().filter(cell => ours.has(cell.id)),
          `[${wanted}]`
        )
      : null;
    const cell = id ? this.cell(id) : null;
    const step = cell
      ? steps.find(item => item.cells.includes(cell.id))
      : undefined;
    const error = cell ? cellError(outputsOf(cell.model)) : null;
    if (!cell || !step || !error) {
      const reason = `${asked} is no longer a cell of this run that failed: the analyst removed it, or ran it again`;
      return removing
        ? { status: 'ok', cell: asked, failed: false, reason }
        : { status: 'refused', failed: false, reason };
    }
    const label = cell.label;
    step.failures = {
      ...step.failures,
      [cell.id]: [...(step.failures?.[cell.id] ?? []), error]
    };
    if (removing) {
      step.removed = [...(step.removed ?? []), cell.id];
      if (run.stripId === cell.id) {
        this._moveRunStrip(run, cell.id);
      }
      this.deleteCell(cell.id);
      changed();
      return { status: 'ok', cell: label, removed: true };
    }
    const code = String(input.code ?? '');
    // The key of the agent's code goes first, so that the change is not
    // taken for the analyst's (./handedit.ts); Remove compares the cell
    // with the code of its step. The cell's type is read from the new code.
    setCellMeta(cell.model, {
      view_code_key: codeKey(code),
      view_code: undefined,
      step_type: stepType(
        cellMeta(cell.model).title ?? step.title,
        step.why,
        code
      )
    });
    cell.model.sharedModel.setSource(code);
    step.code = { ...step.code, [cell.id]: code };
    step.state = 'running';
    if (step.tool === 'run_cell') {
      step.error = null;
    }
    changed();
    const outcome = await this._agentRun(
      run,
      cell.model as ICodeCellModel,
      cell.title,
      !!cell.branchOf
    );
    if (step.tool === 'run_cell') {
      step.state = outcome.status === 'ok' ? 'done' : 'error';
      step.error = (outcome.error as string | undefined) ?? null;
    } else {
      // The branches of explore: done once none of them holds an error.
      const failing = keptCells(step).some(item => {
        const branch = this.cell(item);
        return !!branch && !!cellError(outputsOf(branch.model));
      });
      step.state = failing ? 'error' : 'done';
      step.error = failing ? 'a branch failed' : null;
    }
    changed();
    return { ...outcome, fixed: label };
  }

  /**
   * The run's strip leaves a cell that the agent removes: it goes to the
   * cell before, or after when another strip is there, as the strip of a
   * run shows right above its cells.
   */
  private _moveRunStrip(run: IAgentRun, from: string): void {
    const strip = this.strips.get(from);
    const index = indexOf(this.notebook, from);
    if (!strip || index < 0) {
      return;
    }
    const near = [index - 1, index + 1]
      .filter(at => at >= 0 && at < this.notebook.cells.length)
      .map(at => this.notebook.cells.get(at).id);
    const to = near.find(id => !this.strips.has(id));
    if (!to) {
      return;
    }
    this.strips.delete(from);
    strip.cellId = to;
    run.stripId = to;
    this.strips.set(to, strip);
  }

  /** Run a cell of an agent's step, and describe what came out for the agent. */
  private async _agentRun(
    run: IAgentRun,
    cell: ICodeCellModel,
    title: string,
    subshell: boolean
  ): Promise<Record<string, unknown>> {
    const before = new Set(
      (this.bridge.snapshot?.variables ?? []).map(variable => variable.name)
    );
    const label = this.cell(cell.id)?.label ?? '[ ]';
    const result = await this._run(cell, label, title, subshell);
    // The agent's next step reads what the cell made, whether the notebook
    // shows or not.
    await this.refresh().catch(() => undefined);
    const defines = (this.bridge.snapshot?.variables ?? [])
      .filter(variable => !before.has(variable.name))
      .map(variable => ({
        name: variable.name,
        kind: variable.kind,
        type: variable.type,
        rows: variable.rows,
        columns: variable.columns?.slice(0, 30).map(column => ({
          label: column.label,
          tag: column.tag
        }))
      }));
    const outputs = agentOutputs(outputsOf(cell));
    if (run.keepLocal) {
      await this._describeLocally(cell, outputs);
    }
    return {
      status: result.ok ? 'ok' : 'error',
      cell: this.cell(cell.id)?.label ?? label,
      title,
      ...(result.ok
        ? {}
        : { error: firstLine(result.error ?? 'The cell failed') }),
      outputs,
      defines
    };
  }

  /**
   * With the data on this machine, a local model describes each table the
   * agent's cell shows, and the agent reads the description instead.
   */
  private async _describeLocally(
    cell: ICodeCellModel,
    outputs: IAgentOutput[]
  ): Promise<void> {
    // The model chosen for labels, or else the first local model that can run.
    const local = this.status?.local_models ?? [];
    const chosen = this.settings.models.labels;
    const model = local.find(entry => entry.id === chosen)?.available
      ? chosen
      : local.find(entry => entry.available)?.id;
    const tables = outputs.filter(output => output.kind === 'table');
    if (!model || !tables.length) {
      return;
    }
    const code = cell.sharedModel.getSource();
    try {
      await this.api.describeTables(
        {
          model,
          tables: tables.map((table, index) => ({
            id: `agent-${index}`,
            cell: cell.id,
            code,
            text: table.text ?? '',
            rows: table.rows ?? null,
            columns: table.cols ?? null
          }))
        },
        event => {
          if (event.type !== 'result') {
            return;
          }
          for (const note of (event.tables ?? []) as {
            id: string;
            description?: string;
            headline?: string;
          }[]) {
            const table = tables[Number(note.id.replace('agent-', ''))];
            if (table) {
              table.description = note.description;
              table.headline = note.headline;
            }
          }
        }
      );
    } catch (error) {
      console.warn('A local model could not describe the tables', error);
    }
  }

  /** Stop an agent's run. The cells it added stay. */
  stopAgent(run: IAgentRun): void {
    if (run.state !== 'starting' && run.state !== 'working') {
      return;
    }
    const entry = this.runs.entry(run);
    if (entry && entry.owner !== this) {
      // Another view of the notebook started the run, and runs its tool
      // calls: that view stops it, also after it closed.
      entry.stop();
      return;
    }
    run.state = 'stopped';
    // The server ends the run's stream with what the run cost so far, which
    // the notebook keeps. A stream that does not end soon is closed here.
    const abort = this._agentAborts.get(run);
    if (run.id) {
      void this.api.agentStop(run.id).catch(() => abort?.abort());
      window.setTimeout(() => abort?.abort(), STOP_WAIT_MS);
    } else {
      abort?.abort();
    }
    // A cell of the run in the main shell stops too, in the notebook where
    // it runs; a branch in a subshell runs to its end, since an interrupt
    // reaches the main thread only. An R kernel is not interrupted: xeus-r
    // ends when the signal reaches it at its top level, and its cell runs
    // to its end instead.
    const running = run.steps.find(
      step => step.tool === 'run_cell' && step.state === 'running'
    );
    const model = !running
      ? null
      : running.notebook
        ? (this._runModels?.get(running.notebook) ?? null)
        : this;
    if (model && model.bridge.languageName?.toLowerCase() !== 'r') {
      void model.sessionContext.session?.kernel?.interrupt();
    }
    this._emit();
  }

  /** Close a run's strip, card or pane; the cells it added stay. */
  dismissAgent(run: IAgentRun): void {
    if (run.state === 'starting' || run.state === 'working') {
      return;
    }
    this.agentRuns = this.agentRuns.filter(item => item !== run);
    if (this.strips.get(run.stripId)?.agent === run) {
      this.strips.delete(run.stripId);
    }
    // The strip closes in every view of the notebook.
    this.runs.remove(run);
    this._emit();
  }

  /** The cells a run added, in the notebook's order. */
  agentCells(run: IAgentRun): IEpiCell[] {
    const ids = new Set(run.steps.flatMap(step => step.cells));
    return this.cells().filter(cell => ids.has(cell.id));
  }

  /**
   * The mark of code that the connected model wrote: the provider and the
   * model that the server named in its answer, else those of the connection,
   * and the cost and the time of an answer of one cell when they are known.
   */
  private _writtenMark(
    answer: {
      provider?: string | null;
      model?: string | null;
      cost_usd?: number | null;
      elapsed?: number | null;
    } = {}
  ): NonNullable<IEpiCellMeta['generated_by']> {
    const connected = this.status?.claude;
    return {
      agent: answer.provider ?? connected?.provider ?? 'remote',
      model: answer.model ?? connected?.model ?? null,
      cost_usd: answer.cost_usd ?? null,
      ...(typeof answer.elapsed === 'number'
        ? { seconds: answer.elapsed }
        : {}),
      choice: this.settings.models.cells,
      at: new Date().toISOString()
    };
  }

  /**
   * When a run ends, its cells and modules take the provider and the model
   * that the server named, and the notebook keeps the run with its cost and
   * its time. A run that failed is kept too once it added a cell or cost
   * money, so that its cost counts once, and its cells with it.
   */
  private _keepRun(
    run: IAgentRun,
    answer: IResultEvent | IErrorEvent,
    state: IAgentRunRecord['state']
  ): void {
    if (!run.id || run.discarded) {
      return;
    }
    // The cells of this notebook; those of a notebook that the run made go
    // into that notebook's record.
    const added = run.steps
      .filter(step => !step.notebook)
      .flatMap(step => step.cells);
    const anywhere = run.steps.flatMap(step => step.cells);
    if (state === 'failed' && !anywhere.length && !(run.costUsd ?? 0)) {
      return;
    }
    // A result names the provider and the model; an error names neither.
    const names = answer as { provider?: string | null; model?: string | null };
    const provider = names.provider ?? null;
    const model = names.model ?? null;
    const named = (
      mark: NonNullable<IEpiCellMeta['generated_by']>
    ): NonNullable<IEpiCellMeta['generated_by']> => ({
      ...mark,
      agent: provider ?? mark.agent,
      model: model ?? mark.model ?? null
    });
    let mark: NonNullable<IEpiCellMeta['generated_by']> | null = null;
    for (const id of added) {
      const cell = findCell(this.notebook, id);
      const written = cell ? cellMeta(cell).generated_by : undefined;
      if (cell && written) {
        mark = named(written);
        setCellMeta(cell, { generated_by: mark });
      }
    }
    const meta = notebookMeta(this.notebook);
    const files = { ...(meta.files ?? {}) };
    const paths = Object.keys(files).filter(path => files[path].run === run.id);
    for (const path of paths) {
      files[path] = {
        ...files[path],
        generated_by: named(files[path].generated_by)
      };
      mark = mark ?? files[path].generated_by;
    }
    const connected = this._writtenMark();
    const record: IAgentRunRecord = {
      question: run.question,
      provider: provider ?? mark?.agent ?? connected.agent,
      model: model ?? mark?.model ?? connected.model ?? null,
      cost_usd: run.costUsd,
      seconds: run.seconds ?? null,
      cells: added,
      files: paths,
      state,
      at: new Date().toISOString(),
      // What the run's strip shows, for the history of runs (1.73).
      ...(this.runs.history ? historyOf(run) : {})
    };
    setNotebookMeta(this.notebook, {
      files,
      agent_runs: { ...(meta.agent_runs ?? {}), [run.id]: record }
    });
    // A notebook that the run made keeps the run too, with the cells it
    // wrote there, so that each of them says who wrote it; it is saved with
    // its outputs.
    for (const notebook of run.notebooks ?? []) {
      const other =
        this._runModels?.get(notebook.path) ??
        this.runs.host?.modelOf(notebook.path) ??
        null;
      if (!other || other.context.isDisposed) {
        continue;
      }
      const ids = [
        ...(notebook.intro ? [notebook.intro] : []),
        ...run.steps
          .filter(step => step.notebook === notebook.path)
          .flatMap(step => step.cells)
      ];
      for (const id of ids) {
        const cell = findCell(other.notebook, id);
        const written = cell ? cellMeta(cell).generated_by : undefined;
        if (cell && written) {
          setCellMeta(cell, { generated_by: named(written) });
        }
      }
      setNotebookMeta(other.notebook, {
        agent_runs: {
          ...(notebookMeta(other.notebook).agent_runs ?? {}),
          [run.id]: {
            ...record,
            cells: ids,
            files: [],
            // Its history leads to the notebook where the strip shows.
            ...(this.runs.history ? { asked_in: this.context.path } : {})
          }
        }
      });
      void other.context.save().catch(() => undefined);
    }
  }

  /**
   * Delete the cells a run added, and the modules it wrote: a file it made
   * goes, and a file it changed gets its earlier content and record back.
   * The notice's Undo puts both back, as the analyst left them. When the
   * analyst changed a cell or a module of the run since, the run asks
   * first, and Remove deletes the changes only when `anyway`.
   */
  async discardAgent(run: IAgentRun, anyway = false): Promise<void> {
    const entry = this.runs.entry(run);
    if (entry && entry.owner !== this && entry.discard) {
      // The run was asked in another notebook: the view that runs it
      // removes what it added, in both notebooks.
      await entry.discard(anyway);
      return;
    }
    const written = run.steps
      .map(step => step.file)
      .filter((file): file is NonNullable<IAgentStep['file']> => !!file)
      .reverse();
    // What each module holds now: the notice's Undo writes it back.
    const left = await this._readFiles(written);
    // The notebooks that the run made, as they are now, and the frames it
    // wrote for them: the notice's Undo puts them back.
    const notebooks = await this._takeNotebooks(run);
    const frames = await this._takeFrames(run);
    if (run.discarded) {
      // Removed meanwhile, by a second press.
      return;
    }
    if (!anyway) {
      const changed = [
        ...this._changedCells(run),
        ...written
          .filter(file => {
            const now = left.get(file.path);
            return typeof now === 'string' && now !== file.content;
          })
          .map(file => file.name)
      ];
      if (changed.length) {
        run.removeAsk = changed;
        this._emit();
        return;
      }
    }
    run.removeAsk = null;
    run.discarded = true;
    this.stopAgent(run);
    const saved = this.agentCells(run)
      .reverse()
      .map(cell => this.deleteCell(cell.id))
      .filter((item): item is IDeletedCell => item !== null);
    const files = { ...(notebookMeta(this.notebook).files ?? {}) };
    const records = written.map(
      file =>
        [file.path, files[file.path]] as [string, IAgentFileRecord | undefined]
    );
    const runs = { ...(notebookMeta(this.notebook).agent_runs ?? {}) };
    const record = run.id ? runs[run.id] : undefined;
    if (run.id && record) {
      delete runs[run.id];
      setNotebookMeta(this.notebook, { agent_runs: runs });
    }
    void this._revertFiles(written, files, left);
    const removed = this._removeNotebooks(notebooks, frames);
    this.agentRuns = this.agentRuns.filter(item => item !== run);
    this.strips.delete(run.stripId);
    this.runs.remove(run);
    this._emit();
    const cells = saved.length === 1 ? 'cell' : `${saved.length} cells`;
    // "the cell and file", "the cell, pain.R.ipynb and 1 file", "the 2 files".
    const fileCount = written.length + frames.length;
    const before = [
      ...(saved.length ? [`the ${cells}`] : []),
      ...notebooks.map(item => PathExt.basename(item.path))
    ];
    const filesText =
      fileCount === 1
        ? notebooks.length
          ? '1 file'
          : 'file'
        : `${fileCount} files`;
    const parts = fileCount
      ? [...before, before.length ? filesText : `the ${filesText}`]
      : before;
    const what =
      parts.length > 1
        ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
        : (parts[0] ?? `the ${cells}`);
    const notice = Notification.emit(
      `Removed ${what} that the agent added for "${run.question}".`,
      'default',
      {
        autoClose: 10000,
        actions: [
          {
            label: 'Undo',
            callback: () => {
              for (const item of [...saved].reverse()) {
                this.restoreCell(item);
              }
              if (run.id && record) {
                setNotebookMeta(this.notebook, {
                  agent_runs: {
                    ...(notebookMeta(this.notebook).agent_runs ?? {}),
                    [run.id]: record
                  }
                });
              }
              void this._rewriteFiles([...written].reverse(), records, left);
              void removed.then(() =>
                this._restoreNotebooks(notebooks, frames)
              );
              Notification.dismiss(notice);
            }
          }
        ]
      }
    );
  }

  /**
   * The notebooks that a run made, as they are now: the content of an open
   * view's notebook, with what it has not saved, else the file's.
   */
  private async _takeNotebooks(
    run: IAgentRun
  ): Promise<{ path: string; content: PartialJSONObject | null }[]> {
    const taken: { path: string; content: PartialJSONObject | null }[] = [];
    for (const notebook of run.notebooks ?? []) {
      const model =
        this.runs.host?.modelOf(notebook.path) ??
        this._runModels?.get(notebook.path) ??
        null;
      let content: PartialJSONObject | null;
      if (model && !model.context.isDisposed) {
        content = model.notebook.toJSON() as unknown as PartialJSONObject;
      } else {
        try {
          const file = await this._contents().get(notebook.path, {
            content: true,
            type: 'notebook'
          });
          content = file.content as PartialJSONObject;
        } catch {
          content = null;
        }
      }
      taken.push({ path: notebook.path, content });
    }
    return taken;
  }

  /**
   * The files that a run's share_frames made, with their content: a file
   * that was there before the run stays, and is not in the list.
   */
  private async _takeFrames(
    run: IAgentRun
  ): Promise<{ path: string; content: string }[]> {
    const taken: { path: string; content: string }[] = [];
    const seen = new Set<string>();
    for (const file of run.frames ?? []) {
      if (file.existed || seen.has(file.path)) {
        continue;
      }
      seen.add(file.path);
      try {
        const model = await this._contents().get(file.path, {
          content: true,
          type: 'file',
          format: 'base64'
        });
        taken.push({ path: file.path, content: String(model.content ?? '') });
      } catch {
        // The file is gone already.
      }
    }
    return taken;
  }

  /**
   * Remove the notebooks that a run made, each with its views and its
   * kernel, and the files of its frames, then their folder when it is empty.
   */
  private async _removeNotebooks(
    notebooks: { path: string }[],
    frames: { path: string }[]
  ): Promise<void> {
    for (const notebook of notebooks) {
      this._runModels?.delete(notebook.path);
      try {
        await this.runs.host?.remove(notebook.path);
      } catch (error) {
        console.warn(`Could not remove ${notebook.path}`, error);
      }
    }
    const folders = new Set<string>();
    for (const frame of frames) {
      folders.add(PathExt.dirname(frame.path));
      try {
        await this._contents().delete(frame.path);
      } catch (error) {
        console.warn(`Could not remove ${frame.path}`, error);
      }
    }
    for (const folder of folders) {
      try {
        const listing = await this._contents().get(folder, { content: true });
        if (!((listing.content ?? []) as unknown[]).length) {
          await this._contents().delete(folder);
        }
      } catch {
        // The folder is gone, or holds other files: it stays.
      }
    }
  }

  /** Undo of a removal: the notebooks and the files of the frames come back, and each notebook opens again. */
  private async _restoreNotebooks(
    notebooks: { path: string; content: PartialJSONObject | null }[],
    frames: { path: string; content: string }[]
  ): Promise<void> {
    for (const frame of frames) {
      try {
        await this._contents().save(PathExt.dirname(frame.path), {
          type: 'directory'
        });
        await this._contents().save(frame.path, {
          type: 'file',
          format: 'base64',
          content: frame.content
        });
      } catch (error) {
        console.warn(`Could not put back ${frame.path}`, error);
      }
    }
    for (const notebook of notebooks) {
      if (!notebook.content) {
        continue;
      }
      try {
        await this._contents().save(notebook.path, {
          type: 'notebook',
          format: 'json',
          content: notebook.content
        });
        await this.runs.host?.show(notebook.path, null, false);
      } catch (error) {
        console.warn(`Could not put back ${notebook.path}`, error);
      }
    }
  }

  /** Keep a run's cells and modules, and what the analyst changed in them: Remove's question closes. */
  dismissRemove(run: IAgentRun): void {
    if (run.removeAsk) {
      run.removeAsk = null;
      this._emit();
    }
  }

  /** The cells of a run that hold other code than the agent wrote, by their labels. */
  private _changedCells(run: IAgentRun): string[] {
    const changed: string[] = [];
    for (const step of run.steps) {
      // A cell of a notebook that the run made is read in that notebook's view.
      const model = step.notebook
        ? (this.runs.host?.modelOf(step.notebook) ??
          this._runModels?.get(step.notebook) ??
          null)
        : this;
      if (!model || model.context.isDisposed) {
        continue;
      }
      const where = step.notebook
        ? ` in ${PathExt.basename(step.notebook)}`
        : '';
      for (const id of step.cells) {
        const cell = findCell(model.notebook, id);
        const code = step.code?.[id];
        if (
          cell &&
          code !== undefined &&
          cell.sharedModel.getSource() !== code
        ) {
          const label = model.cell(id)?.label;
          changed.push(
            label && label !== '[ ]'
              ? `${label}${where}`
              : `a cell it added${where}`
          );
        }
      }
    }
    return changed;
  }

  /** What each of these files holds now, or null for a file that is not there. */
  private async _readFiles(
    written: NonNullable<IAgentStep['file']>[]
  ): Promise<Map<string, string | null>> {
    const left = new Map<string, string | null>();
    for (const file of written) {
      try {
        const model = await this._contents().get(file.path, {
          content: true,
          type: 'file',
          format: 'text'
        });
        left.set(file.path, String(model.content ?? ''));
      } catch {
        left.set(file.path, null);
      }
    }
    return left;
  }

  /**
   * Delete the files a run made, and put back what a file it changed held,
   * with the record of the run that wrote that. A file that is not there, or
   * that could not be read, stays as it is: Undo could not give it back.
   */
  private async _revertFiles(
    written: NonNullable<IAgentStep['file']>[],
    files: Record<string, IAgentFileRecord>,
    left: Map<string, string | null>
  ): Promise<void> {
    for (const file of written) {
      if (typeof left.get(file.path) !== 'string') {
        continue;
      }
      try {
        if (file.previous === null) {
          await this._contents().delete(file.path);
          delete files[file.path];
        } else {
          await this._contents().save(file.path, {
            type: 'file',
            format: 'text',
            content: file.previous
          });
          if (file.previousRecord) {
            files[file.path] = file.previousRecord;
          }
        }
      } catch (error) {
        console.warn(`Could not remove ${file.path}`, error);
      }
    }
    setNotebookMeta(this.notebook, { files });
  }

  /**
   * Undo of a removal: write the files back as the removal found them, which
   * holds the analyst's changes, with their records.
   */
  private async _rewriteFiles(
    written: NonNullable<IAgentStep['file']>[],
    records: [string, IAgentFileRecord | undefined][],
    left: Map<string, string | null>
  ): Promise<void> {
    for (const file of written) {
      const content = left.get(file.path);
      if (typeof content !== 'string') {
        continue;
      }
      try {
        await this._contents().save(file.path, {
          type: 'file',
          format: 'text',
          content
        });
      } catch (error) {
        console.warn(`Could not write ${file.path} back`, error);
      }
    }
    const files = { ...(notebookMeta(this.notebook).files ?? {}) };
    for (const [path, record] of records) {
      if (record) {
        files[path] = record;
      }
    }
    setNotebookMeta(this.notebook, { files });
  }

  private async _preview(option: IOption, ask: Ask | null): Promise<void> {
    const preview: IPreview = {
      title: option.text,
      code: option.code ?? null,
      status: option.code ? 'running' : 'writing',
      stage: null,
      elapsed: null,
      started: Date.now(),
      thinking: null,
      outputs: [],
      error: null,
      option
    };
    // An answer that the model still writes for the sidebar gives way to
    // this one: its code does not run.
    if (this.preview) {
      this._stopWriting(this.preview);
    }
    this.preview = preview;
    // The answer shows in the right panel: open it if it is a closed sidebar.
    this.settings.requestRevealRight();
    this._emit();
    try {
      if (!preview.code) {
        const stop = new AbortController();
        this._writes.set(preview, stop);
        const written = await this._write(
          option,
          { kind: 'preview', cell: null, label: '' },
          null,
          preview,
          ask,
          stop.signal
        );
        this._writes.delete(preview);
        // The analyst closed the answer while the model wrote it: its code
        // does not run (design iteration 1.55).
        if (this.preview !== preview) {
          return;
        }
        preview.code = written.code;
        preview.meta = written.meta;
        preview.status = 'running';
        preview.started = Date.now();
        this._emit();
      }
      const execution = await this.bridge.execute(preview.code);
      preview.outputs = execution.outputs;
      preview.error = execution.error;
      preview.status = execution.error ? 'error' : 'done';
    } catch (error) {
      if (this.preview !== preview) {
        // Closed while the model wrote: its request ended.
        return;
      }
      preview.status = 'error';
      preview.error = describeError(error);
    }
    // The answer ran in the sidebar: the question counts, though no cell keeps it.
    this._recordOutcome(
      option.id,
      preview.status === 'done' ? 'ran' : 'failed'
    );
    this._emit();
  }

  /**
   * The analyst's guess of a result, made while its cell was written or run:
   * the question log and the cell that shows the result keep it.
   */
  setGuess(stripKey: string, value: Guess): void {
    const strip = this.strips.get(stripKey);
    if (!strip?.question) {
      return;
    }
    strip.guess = value;
    const meta = notebookMeta(this.notebook);
    const exploration = meta.exploration ?? {};
    setNotebookMeta(this.notebook, {
      exploration: {
        ...exploration,
        asked: (exploration.asked ?? []).map(asked =>
          asked.id === strip.question!.id ? { ...asked, guess: value } : asked
        )
      }
    });
    this._keepGuess(strip);
    this._emit();
  }

  /** How many questions the analyst guessed the result of. */
  guessCount(): number {
    return (notebookMeta(this.notebook).exploration?.asked ?? []).filter(
      asked => asked.guess
    ).length;
  }

  private _keepGuess(strip: IStrip): void {
    // The answer's cell: the one inserted, or the one edited. An edit does
    // not set insertedId, which Undo deletes.
    const answerId =
      strip.insertedId ??
      (strip.placement.kind === 'edit' && strip.before !== null
        ? strip.cellId
        : null);
    const cell = answerId ? this.cell(answerId) : null;
    if (cell && strip.guess && strip.question) {
      setCellMeta(cell.model, {
        guess: {
          question: strip.question.id,
          value: strip.guess,
          at: new Date().toISOString()
        }
      });
    }
  }

  /**
   * Of the columns that cells use, those the analyst reached on their own:
   * in cells they wrote, in cells that answer a question they typed, and the
   * columns they dragged. A dragged column counts once a cell names it.
   */
  usedOwn(): Map<string, Set<string>> {
    const used = this.used();
    const own = new Map<string, Set<string>>();
    const add = (frame: string, column: string) => {
      if (!used.get(frame)?.has(column)) {
        return;
      }
      const set = own.get(frame) ?? new Set<string>();
      set.add(column);
      own.set(frame, set);
    };
    for (const cell of this.codeCells()) {
      const id = cell.meta.question?.id;
      if (id && !id.startsWith('own:')) {
        continue;
      }
      for (const [frame, columns] of Object.entries(
        cell.analysis?.columns ?? {}
      )) {
        columns.forEach(column => add(frame, column));
      }
    }
    for (const key of this.touched) {
      const [frame, column] = key.split('\u0000');
      if (column) {
        add(frame, column);
      }
    }
    return own;
  }

  /**
   * The questions that count as asked in the Exploration panel, and those
   * that failed: a question counts once a cell that answers it ran (./asked.ts).
   */
  askedCounts(): { asked: IAskedQuestion[]; failed: IAskedQuestion[] } {
    const cells = this.codeCells()
      .filter(cell => cell.meta.question)
      .map(cell => {
        const outputs = outputsOf(cell.model);
        return {
          question: cell.meta.question!,
          ran: cell.count !== null || outputs.length > 0,
          failed: outputs.some(output => output.type === 'error')
        };
      });
    return countAsked(
      notebookMeta(this.notebook).exploration?.asked ?? [],
      cells
    );
  }

  /** Which AI proposed a question, or chose the type of a typed one. */
  private _provenance(option: IOption): Pick<IAskedQuestion, 'by' | 'type_by'> {
    if (option.by) {
      return { by: option.by };
    }
    if (option.origin === 'user') {
      const typed = this.ownType(option.text);
      if (typed.by) {
        return { type_by: writtenBy(this.settings.models.typed, typed.by) };
      }
    }
    return {};
  }

  /**
   * How the answer to a question ended, in the question log: it counts as
   * asked once its cell ran, and a failure stays out of the count.
   */
  private _recordOutcome(questionId: string, outcome: AskedOutcome): void {
    const meta = notebookMeta(this.notebook);
    const exploration = meta.exploration ?? {};
    const asked = exploration.asked ?? [];
    if (!asked.some(question => question.id === questionId)) {
      return;
    }
    setNotebookMeta(this.notebook, {
      exploration: {
        ...exploration,
        asked: asked.map(question =>
          question.id === questionId ? { ...question, outcome } : question
        )
      }
    });
  }

  private _recordAsked(option: IOption): void {
    const meta = notebookMeta(this.notebook);
    const exploration = meta.exploration ?? {};
    const asked = exploration.asked ?? [];
    if (asked.some(question => question.id === option.id)) {
      // Asked again: the new answer decides how it ended.
      setNotebookMeta(this.notebook, {
        exploration: {
          ...exploration,
          asked: asked.map(question => {
            if (question.id !== option.id) {
              return question;
            }
            const { outcome, ...rest } = question;
            return rest;
          })
        }
      });
      return;
    }
    setNotebookMeta(this.notebook, {
      exploration: {
        ...exploration,
        asked: [
          ...asked,
          {
            id: option.id,
            text: option.text,
            type: option.type,
            ...this._provenance(option),
            at: new Date().toISOString()
          }
        ]
      }
    });
  }

  /**
   * A question about each value that the analyst typed or picked in code the
   * view wrote, as the server asks about a value an AI chose ("The agent
   * chose it; nobody checked it"): the question says who chose it.
   */
  private _yourValueQuestions(cell: IEpiCell): IOption[] {
    if (cell.meta.written_by !== 'agent' || !cell.meta.user_values?.length) {
      return [];
    }
    return cell.decisions
      .filter(decision => decision.provenance === 'you')
      .map(decision => ({
        id: `you:${cell.id}:${decision.name}:${decision.value}`,
        text: `Is ${decision.name} = ${decision.value} the right choice in ${cell.label}?`,
        type: 'model' as const,
        origin: 'template',
        probability: 0.35,
        reasons: ['You chose it; no cell has checked it'],
        effect: 'You chose it; no cell has checked it',
        placement: {
          kind: 'new' as const,
          cell: cell.id,
          label: `new cell after ${cell.label}`
        },
        code: null
      }));
  }

  private _regionOptions(ask: IRegionAsk, unit: string | undefined): IOption[] {
    const plot = ask.plot;
    const frame = plot.source.frame;
    const by = plot.source.by;
    const x = plot.source.x;
    const options: IOption[] = [];
    const lower = ask.summary?.groups?.some(
      group => group.share < group.share_overall - 0.03
    );
    if (frame && by && unit) {
      const result = `logging_by_${by}`.replace(/[^A-Za-z0-9_]/g, '_');
      options.push({
        id: `region:dropout:${frame}:${ask.x0}:${ask.x1}:${ask.y ?? ''}`,
        text: lower
          ? 'Is the difference here driven by who stopped logging?'
          : `Who is still in the data here, by ${by}?`,
        type: 'quality',
        origin: 'template',
        probability: lower ? 0.8 : 0.6,
        reasons: lower
          ? ['a group has fewer rows here than overall']
          : ['compares the groups before and inside the window'],
        effect: `${unit} counts per ${by}, before and inside the window`,
        placement: {
          kind: 'new',
          cell: ask.cellId,
          label: `new cell after ${this.cell(ask.cellId)?.label ?? ''}`
        },
        code: [
          pyComment(
            `Who is still in ${frame} for ${x} ${rangeText(ask.x0, ask.x1, plot.x, axisValues(plot, 'x'))}, by ${by}?`
          ),
          'import pandas as pd',
          '',
          `_inside = ${frame}[${regionMask(frame, ask)}]`,
          `_before = ${frame}[${columnCode(frame, x, plot.x)} < ${boundCode(ask.x0, plot.x)}]`,
          `${result} = pd.DataFrame({`,
          `    ${pyString(`${unit}s before`)}: _before.groupby(${pyString(by)}, observed=True)[${pyString(unit)}].nunique(),`,
          `    ${pyString(`${unit}s inside`)}: _inside.groupby(${pyString(by)}, observed=True)[${pyString(unit)}].nunique(),`,
          '})',
          `${result}["still in"] = (${result}[${pyString(`${unit}s inside`)}] / ${result}[${pyString(`${unit}s before`)}]).round(3)`,
          'del _inside, _before',
          result
        ].join('\n')
      });
    }
    if (by) {
      options.push({
        id: `region:composition:${frame}:${ask.x0}:${ask.x1}:${ask.y ?? ''}`,
        text: `Does the share of each ${by} change in this window?`,
        type: 'quality',
        origin: 'template',
        probability: 0.5,
        reasons: ['a change in who is measured can look like an effect'],
        effect: 'AI writes the check',
        placement: {
          kind: 'new',
          cell: ask.cellId,
          label: `new cell after ${this.cell(ask.cellId)?.label ?? ''}`
        },
        code: null
      });
    }
    if (frame) {
      // Who the rows of the range are, and how the groups compare there,
      // one mean per unit when the frame has the unit (./regionrows.ts).
      const columns = this.variable(frame)?.columns ?? [];
      const known = unit ?? contextOf(this.inferred()).unit ?? null;
      const held =
        known && columns.some(column => column.label === known) ? known : null;
      options.push(
        ...rowsQuestions({
          frame,
          mask: regionMask(frame, ask),
          where: regionWhere(ask),
          y: plot.source.y,
          unit: held,
          group: groupOf(by, columns, [x, plot.source.y, held]),
          placement: {
            kind: 'new',
            cell: ask.cellId,
            label: `new cell after ${this.cell(ask.cellId)?.label ?? ''}`
          },
          key: `${ask.x0}:${ask.x1}:${ask.y ?? ''}`
        })
      );
    }
    return options;
  }

  /**
   * Questions about the bars picked in a bar plot: whether they differ from
   * the other bars by more than chance, and why.
   */
  private _barOptions(ask: IRegionAsk, unit: string | undefined): IOption[] {
    const plot = ask.plot;
    const frame = plot.source.frame;
    const x = plot.source.x;
    const y = plot.source.y;
    const values = ask.values ?? [];
    const bars = plot.bars ?? [];
    const picked = bars.filter(bar => values.includes(bar.x));
    const rest = bars.filter(bar => !values.includes(bar.x));
    if (!frame || !picked.length || !rest.length) {
      return [];
    }
    const cell = this.cell(ask.cellId);
    const placement: IPlacement = {
      kind: 'new',
      cell: ask.cellId,
      label: `new cell after ${cell?.label ?? ''}`
    };
    const name = barsText(x, values);
    const others =
      rest.length === 1 ? barsText(x, [rest[0].x]) : 'the other bars';
    const rows = (list: typeof bars) =>
      list.reduce((total, bar) => total + bar.n, 0);
    // A bar of means is the mean of the rows that have a y, so the mean of
    // several weighs each by those rows; a bar of counts is one count.
    const mean = (list: typeof bars) =>
      y
        ? list.reduce((total, bar) => total + bar.y * bar.n, 0) / rows(list)
        : list.reduce((total, bar) => total + bar.y, 0) / list.length;
    const columns = this.variable(frame)?.columns ?? [];
    const packages = this.bridge.snapshot?.packages;
    const options: IOption[] = [];
    if (
      y &&
      rows(picked) >= 2 &&
      rows(rest) >= 2 &&
      (!packages || 'scipy' in packages)
    ) {
      const perUnit = !!unit && columns.some(column => column.label === unit);
      const test = barTest({
        frame,
        x,
        y,
        values,
        tag: this._columnTag(frame, x),
        unit: perUnit ? unit! : null,
        picked: name,
        others
      });
      options.push({
        id: `region:bars:${frame}:${values.join('|')}:test`,
        text: test.text,
        type: 'association',
        origin: 'template',
        probability: 0.65,
        reasons: [
          perUnit
            ? `compares ${test.noun} means, as rows of one ${test.noun} are not independent`
            : 'compares the rows of the picked bars with the rest'
        ],
        effect: test.effect,
        placement,
        code: test.code
      });
    }
    options.push({
      id: `region:bars:${frame}:${values.join('|')}:why`,
      text: `Why ${values.length === 1 ? 'is' : 'are'} ${name} ${mean(picked) > mean(rest) ? 'higher' : 'lower'} than ${others}?`,
      type: 'causal',
      origin: 'template',
      probability: 0.5,
      reasons: ['a gap between bars can come from who is in each bar'],
      effect: 'AI writes the check',
      placement,
      code: null
    });
    return options;
  }

  /** The kernel's tag for a column of a frame: int, num, cat, bool, date... */
  private _columnTag(frame: string, column: string): string | null {
    return (
      this.variable(frame)?.columns?.find(entry => entry.label === column)
        ?.tag ?? null
    );
  }

  private _nextLetter(parent: IEpiCell): string {
    const used = new Set(
      this.cells()
        .filter(cell => cell.branchOf === parent.id)
        .map(cell => cell.meta.branch?.letter)
    );
    for (const letter of 'bcdefghijklmnopqrstuvwxyz') {
      if (!used.has(letter)) {
        return letter;
      }
    }
    return 'z';
  }

  /**
   * Where a new cell after `cell` goes: after the cell and its branches.
   */
  private _insertIndex(cell: IEpiCell | null): number {
    if (!cell) {
      return this.notebook.cells.length;
    }
    let index = indexOf(this.notebook, cell.id);
    const cells = this.cells();
    while (index + 1 < cells.length && cells[index + 1].branchOf === cell.id) {
      index++;
    }
    return index + 1;
  }

  /** The cells as the rule of placement reads them (./placement.ts). */
  private _placedCells(): IPlacedCell[] {
    const cells = this.cells();
    const views = this._viewRuns ?? new Map<string, number | null>();
    const runs = JSON.stringify([...views]);
    if (this._placed?.cells === cells && this._placed.runs === runs) {
      return this._placed.placed;
    }
    // A count of this kernel; or a run that the view started, which waits,
    // runs, or ended with the count that the cell shows.
    const ran = (cell: IEpiCell) =>
      cell.type === 'code' &&
      ((cell.count !== null && !cell.lastRun) ||
        (views.has(cell.id) &&
          (views.get(cell.id) === null || views.get(cell.id) === cell.count)));
    const placed = cells.map(cell => ({
      id: cell.id,
      branchOf: cell.branchOf,
      run: cell.meta.agent?.run || null,
      ran: ran(cell),
      defs: cell.analysis?.defs ?? []
    }));
    this._placed = { cells, runs, placed };
    return placed;
  }

  /**
   * The cell that a new cell goes after (./placement.ts): below `below`, the
   * cell the question is about, and below the last cell that ran; null for
   * the end of the notebook.
   */
  private _newCellAfter(
    below: string | null,
    code: string | null,
    run: INewCell['run'] = null
  ): string | null {
    return placeAfter(this._placedCells(), { below, code, run });
  }

  /**
   * Where the new cell of a placement goes now, as the strip of its answer
   * names it: the cell it goes after, with its label.
   */
  private _newPlacement(where: IPlacement, code: string | null): IPlacement {
    const after = this._newCellAfter(where.cell, code);
    return after === where.cell ? where : this._placementAfter(where, after);
  }

  /** A new cell's placement after this cell, or at the end for null. */
  private _placementAfter(where: IPlacement, after: string | null): IPlacement {
    return {
      ...where,
      cell: after,
      label: after
        ? `new cell after ${this._labelOf(after)}`
        : 'new cell at the end'
    };
  }

  /** The cell before this one, past the branches between them. */
  private _cellBefore(cellId: string): string | null {
    const top = this.cells().filter(cell => !cell.branchOf);
    const at = top.findIndex(cell => cell.id === cellId);
    return at > 0 ? top[at - 1].id : null;
  }

  /** Of two cells, the one lower in the notebook; a cell that is gone does not count. */
  private _lower(a: string | null, b: string | null): string | null {
    const at = (id: string | null) => (id ? indexOf(this.notebook, id) : -1);
    if (at(a) < 0) {
      return at(b) < 0 ? null : b;
    }
    return at(b) > at(a) ? b : a;
  }

  private _onBridge(
    sender: KernelBridge,
    change: 'variables' | 'analysis' | 'executed'
  ): void {
    if (change === 'executed') {
      this._refreshPolicy.changed();
      return;
    }
    this._version++;
    if (change === 'analysis') {
      this._saveDecisions();
      this._findDefaults();
    }
    this._keep(change);
    if (change === 'analysis') {
      // The first listing of a kernel comes before its first analysis of
      // the cells, and keeps each variable without the cell that makes it.
      // Without the cell, the first listing after a restart drops the
      // variable (./restore.ts, listing).
      this._keep('variables');
    }
    this._emit();
    if (!this._isDisposed) {
      void this._nextDebouncer.invoke();
    }
  }

  /**
   * With "Find more defaults with AI", the answers about the library
   * functions whose signatures the kernel read: those that the server kept,
   * then a model's (./founddefaults.ts).
   */
  private _findDefaults(): void {
    if (!this.settings.findDefaults || this._isDisposed) {
      return;
    }
    const signatures: ISignature[] = [];
    for (const cell of this.codeCells()) {
      const source = cell.model.sharedModel.getSource();
      signatures.push(...(this.bridge.signaturesOf(cell.id, source) ?? []));
    }
    this.foundDefaults.update(signatures);
  }

  private async _refreshNow(): Promise<void> {
    // One refresh at a time: one asked for while another reads the kernel
    // reads it again after that one.
    while (this._inFlight) {
      await this._inFlight;
    }
    // A closed view reads the kernel for an agent's run that goes on.
    if (
      !this.sessionContext.session?.kernel ||
      (this._isDisposed && !this._agentAborts.size)
    ) {
      return;
    }
    const reading = this._readKernel();
    this._inFlight = reading;
    try {
      await reading;
    } finally {
      this._inFlight = null;
    }
  }

  private async _readKernel(): Promise<void> {
    this._refreshPolicy.refreshing();
    // The circle shows only for a refresh that takes long: a short one
    // would flash it (SPINNER_DELAY_MS).
    const timer = window.setTimeout(() => {
      this.refreshing = true;
      this._emit();
    }, SPINNER_DELAY_MS);
    this.reading = true;
    this._emit();
    try {
      // The hooks keep IPython's callbacks out of these silent requests:
      // without them, a request that ends while a cell draws shows that
      // cell's figure in its own output, and the cell loses it.
      await this.plotHooks.ready();
      await this.bridge.refreshVariables();
      await this.bridge.refreshAnalysis(
        this.codeCells().map(cell => ({
          id: cell.id,
          source: cell.model.sharedModel.getSource()
        }))
      );
    } catch (error) {
      console.warn('Could not refresh from the kernel', error);
    } finally {
      window.clearTimeout(timer);
    }
    this.reading = false;
    this.refreshing = false;
    this._version++;
    this._emit();
  }

  /**
   * The kernel of the session is there, or another took its place. One that
   * the bridge saw start holds nothing yet, and is not read until something
   * runs in it; one that ran before the view connected is read once.
   */
  private _onKernel(): void {
    // What the view ran, and the names of undone answers, were in the
    // kernel before.
    this._viewRuns?.clear();
    this._undone?.clear();
    if (!this.sessionContext.session?.kernel || this.bridge.watchedStart) {
      this._refreshPolicy.cancel();
    } else {
      this._refreshPolicy.changed();
    }
  }

  /**
   * List the kernel before a request that sends its variables and packages
   * to a model, when the view has no listing of it: a kernel that nothing
   * ran in has its packages all the same.
   */
  private async _listed(): Promise<void> {
    if (this.sessionContext.session?.kernel && !this.bridge.snapshot) {
      await this.refresh().catch(() => undefined);
    }
  }

  private async _refreshNext(): Promise<void> {
    if (!this.bridge.snapshot || this.status === null) {
      return;
    }
    if (this.unsupported('questions')) {
      this.nextSteps = [];
      return;
    }
    const groups: Record<
      string,
      { label: string; total: number; used: number }[]
    > = {};
    const used = this.used();
    for (const variable of this.variables()) {
      if (variable.groups) {
        groups[variable.name] = variable.groups.map(group => ({
          label: group.label,
          total: group.columns.length,
          used: group.columns.filter(column =>
            used.get(variable.name)?.has(column)
          ).length
        }));
      }
    }
    try {
      const result = await this.api.next({
        cells: this.codeCells().map(cell => this.cellJSON(cell)),
        context: this.serverContext(),
        groups,
        // The server compares texts, so each goes with its cells' labels now.
        dismissed: (
          notebookMeta(this.notebook).exploration?.dismissed ?? []
        ).map(item =>
          typeof item === 'string' ? item : this.questionText(item)
        )
      });
      // The same questions keep the model's order: it is asked again only
      // for other questions, or when the settings choose another model.
      const asked = [
        choiceOf(this.settings.models, 'ranking'),
        ...result.questions.map(step => step.id)
      ].join(' ');
      const kept = asked === this._nextOrdered ? this.next.order : null;
      this.nextSteps = kept?.scores
        ? orderByScores(result.questions, kept.scores, kept.name)
        : result.questions;
      this.nextFetched = true;
      this._emit();
      if (asked !== this._nextOrdered) {
        this._nextOrdered = asked;
        void this._orderByModel(
          this.next,
          () => this.nextSteps,
          sorted => {
            this.nextSteps = sorted;
          },
          null
        );
      }
    } catch (error) {
      console.warn('Could not fetch next steps', error);
    }
  }

  /** The local models of the settings as the last status request sent them. */
  private _customModels = '[]';

  private _onSettings(): void {
    if (this._isDisposed) {
      return;
    }
    this.jobs.capacity = this.settings.capacity;
    this.spaceDetail.settingsChanged();
    // A pick belongs to the way of asking that made it: Drag does not show
    // Click's targets, and another way cancels the pick.
    if (this.settings.interaction !== this._interaction) {
      this._interaction = this.settings.interaction;
      this.armed = null;
    }
    // The server lists the local models of the settings as the status request sends them.
    const custom = JSON.stringify(this.settings.customLocalModels);
    if (custom !== this._customModels) {
      this._customModels = custom;
      this.refreshStatus();
    }
    // Another model for labels and captions writes its own titles.
    if (this.settings.models.labels !== this._labelsModel) {
      this._labelsModel = this.settings.models.labels;
      if (this.context.isReady) {
        this.cellTitles.titleAll();
      }
    }
    // Another model for the order of questions orders "Worth asking next" again.
    const choice = choiceOf(this.settings.models, 'ranking');
    if (this._nextOrdered && this._nextOrdered.split(' ')[0] !== choice) {
      void this._nextDebouncer.invoke();
    }
    // "Find more defaults with AI": turned on, the kernel reads the
    // signatures of every cell's functions again with their analysis.
    if (this.settings.findDefaults !== this.bridge.signatures) {
      this.bridge.signatures = this.settings.findDefaults;
      // The cells show the defaults that models found, or no longer.
      this._version++;
      if (this.settings.findDefaults) {
        void this.refresh();
      }
    }
    // Another model for More questions may answer where the last one failed.
    this._findDefaults();
    this._emit();
  }

  private _watchCells(): void {
    const connected = new Set<unknown>();
    const connect = () => {
      for (const cell of this.notebook.sharedModel.cells) {
        if (!connected.has(cell)) {
          cell.changed.connect(this._onCellChanged, this);
          connected.add(cell);
        }
      }
    };
    // Connected with this model, so that a closed view lets go of it.
    this.notebook.sharedModel.changed.connect(connect, this);
    connect();
    // Each change of a cell reaches _onCellChanged: what cells() read of a
    // cell can be kept until then.
    this._watching = true;
  }

  private _onCellChanged(
    sender: ICellModel['sharedModel'],
    change: object
  ): void {
    // The analyst's first change of code that the view wrote: the code as
    // the view wrote it is kept, so that the values of the analyst's own
    // code are theirs (./handedit.ts). The reading of the cell holds the
    // code before the change.
    const before = this._readings.get(sender)?.source;
    if (before !== undefined && 'sourceChange' in change) {
      const cell = findCell(this.notebook, sender.id);
      const kept = cell
        ? viewCodeToKeep(cellMeta(cell), before, sender.getSource())
        : null;
      if (cell && kept !== null) {
        // Not inside the change of the shared document that brought this.
        queueMicrotask(() => {
          if (!this._isDisposed && cellMeta(cell).view_code === undefined) {
            setCellMeta(cell, { view_code: kept });
          }
        });
      }
    }
    // The cell's object is made again from the cell (_reading).
    this._readings.delete(sender);
    this._version++;
    // A cell that the model writes an answer about: Restore puts it back as
    // the analyst left it.
    if (this._targetsOf?.has(sender.id)) {
      this._watchTarget(sender.id);
    }
    const keys = Object.keys(change);
    if (keys.length > 0 && keys.every(key => key === 'sourceChange')) {
      // A key typed: only this cell's card shows its code (`revision`).
      this._schedule();
    } else {
      this._emit();
    }
  }

  /**
   * A restarted kernel holds nothing: no refresh is due until a cell runs in
   * it. The plot hooks give it a status in JupyterLab when nothing else does
   * (./plothooks.ts).
   */
  private _onStatus(
    sender: ISessionContext,
    status: ISessionContext.KernelDisplayStatus
  ): void {
    if (
      status === 'restarting' ||
      status === 'autorestarting' ||
      status === 'dead'
    ) {
      this._refreshPolicy.cancel();
      this._viewRuns?.clear();
      this._undone?.clear();
    }
    this._emit();
  }

  private _onNotebookChanged(): void {
    this._version++;
    this._keepCostSeed();
    this._followTargets();
    this._emit();
  }

  /**
   * Until its first model call a notebook keeps no sums of what calls cost,
   * and its total is what it held when it opened. When a cell whose answer
   * cost money goes before that call, the notebook keeps those sums, so that
   * the total does not go down, now or when the notebook opens again.
   */
  private _keepCostSeed(): void {
    const seed = this._costSeed;
    if (!seed || notebookMeta(this.notebook).costs) {
      return;
    }
    const start = recordTotal(seed);
    const now = recordTotal(
      seedRecord(
        this.cells().map(cell => cell.meta),
        notebookMeta(this.notebook).agent_runs
      )
    );
    if (
      now.usd < start.usd - 1e-9 ||
      now.priced + now.unpriced < start.priced + start.unpriced
    ) {
      setNotebookMeta(this.notebook, { costs: seed });
    }
  }

  /**
   * The model chosen for "Question order", when it is not the rules: it
   * gives the probability that each offered question is worth asking next,
   * and the list takes the model's order when the answer comes, or when the
   * pointer leaves the list. The rules' order shows until then, and stays
   * when the model fails or the request is gone. The note above the list
   * says which order it is in.
   */
  private async _orderByModel(
    list: IOrdered,
    options: () => IOption[],
    apply: (sorted: IOption[]) => void,
    selection: unknown
  ): Promise<void> {
    const choice = choiceOf(this.settings.models, 'ranking');
    const offered = options();
    if (choice === 'rules' || offered.length < 2 || !this.aiReady('ranking')) {
      list.order = null;
      return;
    }
    // A local model by its own name: "Gemma 4 E2B", not "Gemma 4 E2B, local".
    const local = this.status?.local_models?.find(entry => entry.id === choice);
    const current: IQuestionOrder = {
      state: 'pending',
      name: local?.label ?? modelName(this.status, choice),
      by: null,
      message: null
    };
    list.order = current;
    this._emit();
    const scores: Record<string, number> = {};
    let by: IWrittenBy | null = null;
    let failure: string | null = null;
    try {
      await this.api.rankQuestions(
        {
          model: choice,
          questions: offered.map(option => ({
            id: option.id,
            text: option.text,
            type: option.type
          })),
          ...(selection ? { selection } : {}),
          context: this.serverContext()
        },
        event => {
          if (event.type === 'result') {
            Object.assign(scores, event.scores as Record<string, number>);
            by = writtenBy(choice, event.model, event.file);
          } else if (event.type === 'error') {
            failure = event.message;
          }
        }
      );
    } catch (error) {
      failure = describeError(error);
    }
    // A newer request, or the same list ordered again, took its place.
    if (list.order !== current) {
      return;
    }
    if (!by || !Object.keys(scores).length) {
      list.order = {
        ...current,
        state: 'failed',
        message: failure ?? 'the model gave no order'
      };
      this._emit();
      return;
    }
    const name = (by as IWrittenBy).model ?? current.name;
    const show = () => {
      if (list.order !== current) {
        return;
      }
      // The questions now, with any that came since the request.
      apply(orderByScores(options(), scores, name));
      list.order = { state: 'done', name, by, message: null, scores };
      this._emit();
    };
    if (this._pointed.has(list)) {
      current.state = 'held';
      current.name = name;
      current.by = by;
      current.show = show;
      this._emit();
      return;
    }
    show();
  }

  private _jsonCheckWarning: string | null = null;
  private _interaction: Interaction;
  private _targetsRequested = new Signal<this, void>(this);
  private _nextOrdered = '';
  private _agentAborts = new Map<IAgentRun, AbortController>();
  // A closed view let go of the kernel, the files and the signals.
  private _released = false;
  /** The sums of what calls cost that the notebook held when it opened: the start of its record. */
  private _costSeed: ICostRecord | null = null;
  private _focusNext: string | null = null;
  /** The lists of questions that the pointer is on. */
  private _pointed = new WeakSet<IOrdered>();
  private _currentCell: string | null = null;
  private _pendingShow: string | null = null;
  /** The list of runs; a model made without one keeps a list of its own. */
  private _runs: AgentRuns | undefined;
  private _writesOf: WeakMap<object, AbortController> | undefined;
  private _targetsOf: Map<string, IDeletedCell> | undefined;
  /** The runs that were on the list of runs: one that leaves it goes from this view. */
  private _listedRuns = new WeakSet<IAgentRun>();
  private _stripToShow: string | null = null;
  /** The strip to show stays where it is when it is in sight: see `stripIfHidden`. */
  private _stripIfHidden = false;
  /** The cell that comes into sight with the strip to show: see `stripCellToShow`. */
  private _stripCell: string | null = null;
  /** The strip to show came into sight already: see `stripFollows`. */
  private _stripFollow = false;
  /** The kernel that "Would I get the same results in R?" names, by its strip. Made when first used. */
  private _kernelAsked?: WeakMap<IStrip, IKernelChoice>;
  /** The view models of the notebooks that this view's runs made, by path. Made when first used. */
  private _runModels?: Map<string, EpiModel>;

  private _emit(): void {
    // Any card can show this change (`revision`).
    this._revision++;
    this._schedule();
    // The other views of the notebook draw the runs that this view runs.
    if (this._agentAborts.size) {
      this.runs.touch();
    }
  }

  /** Emit `changed` on the next frame, once for all the changes until then. */
  private _schedule(): void {
    if (this._isDisposed || this._frame) {
      return;
    }
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      if (!this._isDisposed) {
        this._changed.emit();
      }
    });
  }

  private _ran = new Set<string>();
  // The cells that the view ran in this kernel, with the count of the run,
  // or null while it waits and runs: a new cell goes after them
  // (./placement.ts). Then the cells as the rule of placement read them last.
  private _viewRuns?: Map<string, number | null>;
  private _placed?: {
    cells: IEpiCell[];
    runs: string;
    placed: IPlacedCell[];
  };
  private _serverSettings: ServerConnection.ISettings;
  private _variables: IVariable[] = [];
  private _variablesKey = '';
  private _runNames: {
    cells: IEpiCell[];
    variables: IVariable[];
    groups: IRunGroup[];
  } | null = null;
  // The names that the cells of undone answers made, with the question of
  // each answer (undoneNames), and those that Remove deletes now.
  private _undone?: Map<string, string>;
  private _removing?: Set<string>;
  private _version = 0;
  private _revision = 0;
  // A model's type and place for each text typed, null while it is asked.
  private _sorted = new Map<string, ISortedQuestion | null>();
  private _cells: IEpiCell[] | null = null;
  private _cellsVersion = -1;
  private _cellsRuns = -1;
  // What each cell's object takes from the cell, by its shared model, while
  // _watchCells sees each change of a cell (_reading).
  private _readings = new WeakMap<ICellModel['sharedModel'], ICellReading>();
  private _watching = false;
  private _byId = new Map<string, IEpiCell>();
  // Whether each text has words besides its heading, by its object.
  private _notes = new WeakMap<IEpiCell, boolean>();
  private _sectionsOf: {
    cells: IEpiCell[];
    shown: ReturnType<EpiModel['sections']>;
    byId: Map<string, ISection>;
  } | null = null;
  // The texts whose editor is open.
  private _editors = new Set<string>();
  private _shared = new Set<string>();
  private _sharedFor: IEpiCell[] | null = null;
  private _frame = 0;
  private _isDisposed = false;
  private _refresher = new Debouncer(() => this._refreshNow(), IN_USE_DELAY_MS);
  // The refresh of the kernel's variables on its way, if any.
  private _pendingRefresh: Promise<void> | null = null;
  // The refresh that reads the kernel now, if any.
  private _inFlight: Promise<void> | null = null;
  private _refreshPolicy = new RefreshPolicy({
    refresh: () => this.refresh(),
    inUse: () => this.inUse
  });
  // When the analyst last used the view, or it was shown.
  private _usedAt = Date.now();
  private _nextDebouncer = new Debouncer(() => this._refreshNext(), 1500);
  // The version of the found defaults that "Worth asking next" was asked for.
  private _nextFound = 0;
  private _changed = new Signal<this, void>(this);
  private _cellShown = new Signal<this, string>(this);
  private _litType: QuestionType | null = null;
  private _litTypeChanged = new Signal<this, QuestionType | null>(this);
  private _fileOpenRequested = new Signal<this, string>(this);
  private _contentsManager: ContentsManager | null = null;
  // The timers that close finished strips, by the strip's key.
  private _closing = new Map<string, number>();
  private _modelsPanelRequested = new Signal<this, void>(this);
  // The values that a model suggested for a constant that no rule knows, by
  // the constant and its cell, and the constants whose values a model
  // suggests now (./rulesfirst.ts). Made when first used.
  private _modelValues?: Map<string, IModelValues>;
  private _valuesAsked?: Set<string>;
  // The questions that a model wrote in the background for a request, with
  // the order of the request's list, by the request, and the requests that
  // it answers now.
  private _fromModel?: Map<
    string,
    { added: IOption[]; order: string[] | null }
  >;
  private _modelAsked?: Set<string>;
  /** The places of a model's questions, which wait while the pointer is on their list. */
  private _afterPointer?: WeakMap<IOrdered, () => void>;
}

/** The notebook's record of a module that the agent wrote. */
type IAgentFileRecord = NonNullable<IEpiNotebookMeta['files']>[string];

/**
 * The questions of a list in the order of these ids. A question whose id
 * the order lacks keeps its place among the others, after them.
 */
export function inOrder(options: IOption[], order: string[] | null): IOption[] {
  if (!order) {
    return options;
  }
  const place = new Map(order.map((id, index) => [id, index]));
  return options
    .map((option, index) => ({ option, index }))
    .sort(
      (a, b) =>
        (place.get(a.option.id) ?? order.length + a.index) -
        (place.get(b.option.id) ?? order.length + b.index)
    )
    .map(({ option }) => option);
}

export namespace EpiModel {
  export interface IOptions {
    context: DocumentRegistry.IContext<INotebookModel>;
    rendermime: IRenderMimeRegistry;
    serverSettings: ServerConnection.ISettings;
    settings: EpiSettings;
    /**
     * The agents' runs of every open notebook, which the views of a notebook
     * share (./runs.ts). A model without it keeps its runs to itself.
     */
    runs?: AgentRuns;
    /**
     * The dialog that asks the analyst about what the review guard flagged
     * (src/ui/guard.tsx). Without it, every question is answered "stop".
     */
    askGuard?: (
      event: IGuardEvent
    ) => Promise<{ answer: GuardAnswer; note: string }>;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How long a run took, in seconds: the server's count, else the view's clock. */
function secondsOf(event: { elapsed?: unknown }, run: IAgentRun): number {
  return typeof event.elapsed === 'number'
    ? event.elapsed
    : Math.round((Date.now() - run.started) / 100) / 10;
}

/**
 * A bound of a region at full precision, for a model, which reads the rows
 * it is told: a number as it reads back, and a date to its millisecond.
 */
function preciseBound(
  value: number,
  axis: IPlotAxis | null | undefined
): string {
  return axis?.type === 'date' ? axisValueText(value, axis) : String(value);
}

/**
 * The range of a region as a condition: `5 <= week <= 9 and 2 <= pain <= 8`.
 * The bounds are rounded for reading, dates to the unit of the plot's dates
 * (rangeEnds), unless `precise`.
 */
export function regionWhere(ask: IRegionAsk, precise = false): string {
  const { x, y } = ask.plot.source;
  const ends = (
    low: number,
    high: number,
    axis: IPlotAxis | null | undefined,
    which: 'x' | 'y'
  ): [string, string] =>
    precise
      ? [preciseBound(low, axis), preciseBound(high, axis)]
      : rangeEnds(low, high, axis, axisValues(ask.plot, which));
  const [x0, x1] = ends(ask.x0, ask.x1, ask.plot.x, 'x');
  const range = `${x0} <= ${x} <= ${x1}`;
  if (!ask.y) {
    return range;
  }
  const [y0, y1] = ends(ask.y[0], ask.y[1], ask.plot.y, 'y');
  return `${range} and ${y0} <= ${y} <= ${y1}`;
}

/**
 * The pandas mask of a region's rows in `frame`, with the bounds as brushed:
 * region_summary.py counted the rows between them.
 */
function regionMask(frame: string, ask: IRegionAsk): string {
  const { x, y } = ask.plot.source;
  // A date axis compares with pd.Timestamp(...) bounds (src/model/numbers.ts).
  const { x: xAxis, y: yAxis } = ask.plot;
  const range = `${columnCode(frame, x, xAxis)}.between(${boundCode(ask.x0, xAxis)}, ${boundCode(ask.x1, xAxis)})`;
  return ask.y && y
    ? `${range} & ${columnCode(frame, y, yAxis)}.between(${ask.y.map(bound => boundCode(bound, yAxis)).join(', ')})`
    : range;
}

export function typeLabel(type: QuestionType): string {
  return (
    {
      association: 'Association',
      causal: 'Causal',
      quality: 'Data quality',
      model: 'Model check',
      descriptive: 'Descriptive'
    } as Record<QuestionType, string>
  )[type];
}
