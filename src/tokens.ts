/**
 * Types shared by the view, the kernel bridge and the server API.
 */

export type VariableKind =
  | 'numeric'
  | 'binary'
  | 'categorical'
  | 'datetime'
  | 'text'
  | 'id'
  | 'dataframe'
  | 'array'
  | 'constant'
  | 'model'
  | 'other';

export type ColumnTag =
  'num' | 'int' | 'cat' | 'ord' | 'bool' | 'date' | 'id' | 'text' | 'other';

/**
 * A column of a data frame. `name` evaluates to it in the kernel
 * (`df['age']`), `label` is what the user sees (`age`).
 */
export interface IColumn {
  name: string;
  label: string;
  parent: string;
  kind: VariableKind;
  tag: ColumnTag;
  dtype?: string;
  rows?: number;
  missing?: number;
  unique?: number;
  min?: number | string;
  max?: number | string;
  levels?: string[];
  /**
   * The library of its frame when the code written about it is not pandas
   * code: `polars`. The server writes the questions' code in it.
   */
  library?: string;
}

export interface ITerm {
  term: string;
  coef: number | null;
  lo?: number | null;
  hi?: number | null;
  p?: number | null;
}

/**
 * A variable in the kernel namespace.
 */
export interface IVariable {
  name: string;
  label: string;
  kind: VariableKind;
  type?: string;
  rows?: number;
  n_columns?: number;
  columns?: IColumn[];
  /** `total` counts the group's columns when the notebook keeps only some. */
  groups?: { label: string; columns: string[]; total?: number }[];
  grouped_by?: string;
  selection?: { of?: string; where?: string; from_cell?: string };
  value?: string;
  defined_in?: { file: string; line: number | null; module: string };
  model_class?: string | null;
  formula?: string;
  nobs?: number;
  converged?: boolean;
  terms?: ITerm[];
  shape?: number[];
  dtype?: string;
  /** The items of a sequence, or the characters of a secret. */
  length?: number;
  /**
   * A string that looks like a key, a token or a password: the kernel lists
   * its length and not its text, and the view shows it hidden.
   */
  secret?: boolean;
  tag?: ColumnTag;
  missing?: number;
  unique?: number;
  fingerprint?: string;
  unchanged?: boolean;
  error?: string;
  /** From the last run, as the notebook kept it: not in the kernel now. */
  stale?: boolean;
}

/**
 * A column as the notebook keeps it: prepareVariable gives it back its name,
 * its frame, the frame's rows and its library on reading.
 */
export type IStoredColumn = Omit<
  IColumn,
  'name' | 'parent' | 'rows' | 'library'
>;

/** A variable as the notebook keeps it, with the cell that defined it. */
export interface IStoredVariable extends Omit<IVariable, 'columns'> {
  cell?: string | null;
  columns?: IStoredColumn[];
}

export interface IKernelSnapshot {
  variables: IVariable[];
  packages: Record<string, string | null>;
  python: string;
  cwd?: string;
}

/**
 * Who chose a value of a cell. The kernel's analysis gives `defaulted`,
 * `library_default` and `literal`; the view tells a literal apart as the
 * analyst's (`you`), the AI's (`agent`) or, in code that a template wrote
 * with no model call, the template's (`template`): ./model/decisions.ts.
 */
export type Provenance =
  'defaulted' | 'library_default' | 'literal' | 'you' | 'agent' | 'template';

/**
 * One call that a decision covers, by the place where the cell names the
 * function: `line` counts from 1, and `col` counts UTF-8 bytes from the start
 * of the line, as Python's `ast` does. `target` is the frame that the call
 * joins or reads, in one word: `weather` for `.merge(weather, ...)`, `homes`
 * for `pd.read_csv("homes.csv")`.
 */
export interface IDecisionCall {
  line: number;
  col: number;
  target?: string | null;
}

export interface IDecision {
  name: string;
  value: string;
  provenance: Provenance;
  param?: string | null;
  function?: string | null;
  note?: string | null;
  source?: { file: string; line: number | null } | null;
  /**
   * The calls that leave this value, in the order of the code: two merges
   * that leave `how='inner'` make one decision with two calls. A decision
   * that an older version kept, or one of an assignment, lists none.
   */
  calls?: IDecisionCall[] | null;
  /**
   * The library that a default of the view's own list belongs to, and its
   * version, as the kernel read them: the popover says "default in pandas
   * 3.0.6". A decision that a model found has them in `found`. A decision
   * that an older version kept has neither.
   */
  library?: string | null;
  version?: string | null;
  /**
   * A library default that a model picked from the function's signature,
   * with "Find more defaults with AI" (src/model/founddefaults.ts): the
   * model, and the library and version whose signature it read. The note is
   * the model's reason. The notebook does not keep such a decision.
   */
  found?: {
    by: IWrittenBy | null;
    library: string;
    version: string | null;
  } | null;
}

export interface IAttachment {
  file: string;
  symbol: string;
  start: number;
  end: number;
  lines: [number | null, string][];
  highlight: number[];
}

export interface ICellAnalysis {
  defs: string[];
  uses: string[];
  formulas: string[];
  columns: Record<string, string[]>;
  decisions: IDecision[];
  attachments: IAttachment[];
  error?: string;
}

export type QuestionType =
  'association' | 'causal' | 'quality' | 'model' | 'descriptive';

export const QUESTION_TYPES: {
  id: QuestionType;
  label: string;
  short: string;
}[] = [
  { id: 'association', label: 'Association', short: 'association' },
  { id: 'causal', label: 'Causal', short: 'causal' },
  { id: 'quality', label: 'Data quality', short: 'quality' },
  { id: 'model', label: 'Model check', short: 'model' },
  { id: 'descriptive', label: 'Descriptive', short: 'descriptive' }
];

export type PlacementKind = 'edit' | 'new' | 'branch' | 'preview';

export interface IPlacement {
  kind: PlacementKind;
  /**
   * The cell that it is about. A new cell goes below it, and below the last
   * cell that ran (./model/placement.ts); in the placement of a strip, and in
   * a new cell's metadata, the cell that the new cell went after.
   */
  cell: string | null;
  /** Where the cell goes, as the lists show it: "new cell after [5]". */
  label: string;
  why?: string;
  confidence?: number | null;
}

/**
 * A question, or an option offered after a drop. `code` is the cell from
 * the offline templates; without it, answering needs Claude.
 */
/**
 * Which AI wrote or chose something: the choice in the settings and the
 * model that answered. Text from one model stays apart from another's after
 * the analyst switches models.
 */
export interface IWrittenBy {
  /**
   * The choice in the settings: 'remote', a local model's id such as
   * 'gemma-4-e2b', or 'jev'; 'script' for labels that a script wrote from the
   * table's numbers in place of a model, as the demos' generators do.
   */
  choice: string;
  /**
   * The model that answered, as the server names it: 'claude-opus-5-5',
   * 'Gemma 4 E2B'; for 'script', the script's path.
   */
  model: string | null;
  /** A local model's file: its repository and file name on Hugging Face. */
  file?: string | null;
  /** When, as an ISO date and time. */
  at: string;
}

export interface IOption {
  id: string;
  text: string;
  type: QuestionType;
  origin: string;
  /** The AI that proposed the question, for "More questions from AI". */
  by?: IWrittenBy;
  /** What a model reads the constant as, on a question that tries the model's values: the AI tag's tooltip says it. */
  kind?: string | null;
  template?: string | null;
  variables?: string[];
  probability: number | null;
  reasons: string[];
  effect?: string;
  placement: IPlacement | null;
  code?: string | null;
  /**
   * The outcome and the unit that the question takes from the notebook, by
   * column: the view shows where each came from (./model/inferred.ts).
   */
  uses?: { outcome?: string; unit?: string } | null;
}

export interface IDropResult {
  title: string;
  note: string | null;
  mode: 'auto' | 'branch' | 'parallel';
  options: IOption[];
  placements: IPlacement[];
  preselected: string[];
}

export interface IAskedQuestion {
  id: string;
  text: string;
  type: QuestionType;
  /** The AI that proposed the question, when an AI did. */
  by?: IWrittenBy;
  /** The AI that chose the type of a question the analyst typed. */
  type_by?: IWrittenBy;
  /**
   * The cells that the text names, by the label it names them with:
   * `{"[4]": cell id}`. The view shows each cell's current label in its place
   * (src/model/labels.ts).
   */
  refs?: Record<string, string>;
}

/** A question of Worth asking next that the analyst set aside, with the cells it names. */
export interface IDismissedStep {
  text: string;
  refs?: Record<string, string>;
}

/** What the analyst expected before a result: one click, and optional. */
export type Guess = 'higher' | 'lower' | 'none' | 'unsure';

/**
 * A value that the analyst typed or picked for a decision of a cell, such as
 * 21 for MIN_DAYS: in the code that the view writes with it, the value is the
 * analyst's choice, not the AI's. `name` and `param` are the decision's, and
 * `value` is the value as Python code.
 *
 * A file that the analyst dropped or clicked is `file: true`, with `name` the
 * file's name and `value` its path from the notebook's folder: it is the path
 * that any reader call in the cell reads, whatever the reader names it.
 */
export interface IUserValue {
  name: string;
  param?: string | null;
  value: string;
  file?: boolean;
}

/**
 * How the answer to a question ended: its cell ran, or it failed, in the
 * writing or in the run. A question counts as asked once its cell ran.
 */
export type AskedOutcome = 'ran' | 'failed';

export interface IAssumption {
  text: string;
  kind: 'default' | 'modelling' | 'data';
}

export interface IFollowUp {
  text: string;
  type: QuestionType;
}

/**
 * What the view keeps in `cell.metadata.whybook`.
 */
export interface IEpiCellMeta {
  title?: string;
  /**
   * The titles that models wrote for the cell's code after the analyst
   * edited it, newest first: src/model/celltitles.ts.
   */
  title_note?: ITitleNotes;
  question?: IAskedQuestion;
  /** The analyst's guess before the result, for the question this cell answers. */
  guess?: { question: string; value: Guess; at: string };
  asked_by?: 'user' | 'agent';
  written_by?: 'user' | 'agent';
  /**
   * The view wrote the code from a template, with no model call: a drop's
   * question, a what-if value, a branch that needs no model. Older versions
   * did not write it, so a cell of the view without it may also be a model's
   * from before `generated_by` existed.
   */
  template?: boolean;
  branch?: { of: string; letter: string };
  decisions?: IDecision[];
  summary?: string;
  assumptions?: IAssumption[];
  follow_up?: IFollowUp[];
  placement?: IPlacement;
  generated_by?: {
    /**
     * The provider of the model that wrote it: 'openrouter', 'anthropic',
     * 'ollama', 'claude-code' and the others, or 'remote' when the view does
     * not know it. Notebooks written by older versions say 'claude'.
     */
    agent: string;
    model?: string | null;
    /**
     * What an answer of one cell cost, in US dollars; null when no price of
     * the model is known. A cell of an agent's run leaves it null: the run's
     * record holds the cost of the whole run.
     */
    cost_usd?: number | null;
    /**
     * How long the model took to write an answer of one cell, in seconds.
     * Older versions did not record it; a cell of an agent's run leaves it
     * out, and the run's record holds the time of the whole run.
     */
    seconds?: number | null;
    /** The choice in the settings, as in IWrittenBy. */
    choice?: string;
    /** When, as an ISO date and time. */
    at?: string;
  };
  selection?: { of: string; where: string };
  /** The values that the analyst typed or picked for decisions of the cell. */
  user_values?: IUserValue[];
  /** The agent's run that added the cell, and its step, from 1. */
  agent?: { run: string; step: number };
  /**
   * The key of the code that the view wrote in the cell, from a template, a
   * model or an agent's run; older versions did not write it
   * (src/model/handedit.ts).
   */
  view_code_key?: string;
  /** The code as the view wrote it, kept once the analyst changed it in the view. */
  view_code?: string;
  /** A model's labels for the cell's table outputs, by a hash of each output. */
  tables?: Record<string, ITableNotes>;
  /** The kernel's analysis of the cell, kept for a view without a kernel. */
  analysis?: ICellAnalysis & { source: string };
  /**
   * What models did for the cell and what it cost, as sums by kind: its
   * answers, its title, the labels of its tables, the summaries of the frames
   * it makes. A call for several cells gives each its share. Older versions
   * did not record it (src/model/cost.ts).
   */
  costs?: ICostRecord;
}

/** What a model call is for, in the record of what calls cost. */
export type CostKind =
  | 'answers'
  | 'titles'
  | 'labels'
  | 'summaries'
  | 'order'
  | 'questions'
  | 'other';

/** What the calls of one kind cost, as sums: the metadata keeps no entry per call. */
export interface ICostSum {
  /** US dollars, over the calls with a known price. */
  usd: number;
  /** How many calls had a known price, $0 included. */
  n: number;
  /** How many calls had no known price: they are not in `usd`. */
  unpriced?: number;
  /** The calls' seconds on the server, where the server said. */
  seconds?: number;
}

/** The sums of each kind of call. */
export type ICostRecord = Partial<Record<CostKind, ICostSum>>;

/** A model's labels for a table that the bench shows as a tile. */
export interface ITableNote {
  /** What the table holds, in one to three words. */
  description: string;
  /** The result to see first, or an empty string when none stands out. */
  headline: string;
  /** The AI that wrote them; missing for labels that an older version kept. */
  by?: IWrittenBy;
}

/** The newest labels of a table, and one earlier set per other model. */
export interface ITableNotes extends ITableNote {
  earlier?: ITableNote[];
}

/**
 * An outcome or a unit of an analysis that the notebook keeps as inferred
 * (design iteration 1.64): what an AI model named, or what the analyst
 * picked from a chip. The rules' own are read from the code each time.
 */
export interface IInferredColumn {
  column: string;
  /** The frame that holds the column. */
  frame?: string | null;
  by: 'rules' | 'model' | 'analyst';
  /** The model that named it, for 'model'. */
  model?: IWrittenBy | null;
  /** Why the model named it, in its words. */
  why?: string | null;
}

export interface IInferredMeta {
  outcomes?: IInferredColumn[];
  units?: IInferredColumn[];
}

export interface IEpiNotebookMeta {
  /** The column that the analysis explains, set by hand, as the demos do. */
  outcome?: string;
  /** The column whose values name what the rows repeat over, set by hand. */
  unit?: string;
  /** The outcomes and units inferred, when the notebook sets none by hand. */
  inferred?: IInferredMeta;
  mode?: Mode;
  exploration?: {
    asked?: (IAskedQuestion & {
      at?: string;
      guess?: Guess;
      outcome?: AskedOutcome;
    })[];
    /** A text in a notebook of an older version, else the step with the cells it names. */
    dismissed?: (string | IDismissedStep)[];
  };
  /** The variables of the last run, for a view without a kernel. */
  variables?: IStoredVariable[];
  /** A model's summary of each data frame, by the frame's name. */
  frames?: Record<string, IFrameNotes>;
  /**
   * The modules that the agent wrote, by their path from the server's root:
   * which AI wrote each, when, and in which run.
   */
  files?: Record<
    string,
    { generated_by: NonNullable<IEpiCellMeta['generated_by']>; run?: string }
  >;
  /** The agent's runs, by their id, as each one ended. */
  agent_runs?: Record<string, IAgentRunRecord>;
  /**
   * The notebook's cap on what its AI answers cost, in US dollars, which the
   * analyst sets in the Cost section of the Exploration panel. No cap while
   * it is missing (src/model/cost.ts).
   */
  cost_cap_usd?: number;
  /**
   * What the review guard reads of the notebook: whether its data is
   * synthetic, so that identifiers and values may leave the machine
   * (src/model/guard.ts).
   */
  guard?: { synthetic?: boolean };
  /**
   * What every model call of the view cost, as sums by kind. Written at the
   * first call in a notebook without it, from what the notebook held before;
   * it never goes down when cells go (src/model/cost.ts).
   */
  costs?: ICostRecord;
}

/**
 * An agent's run as the notebook keeps it: who wrote its cells and modules,
 * and what the whole run cost, which no single cell holds.
 */
export interface IAgentRunRecord {
  question: string;
  /** The provider and the model that the server named at the end, else those of the connection. */
  provider: string | null;
  model: string | null;
  /**
   * In USD for the whole run; null when no price of the model is known, or
   * when the server could not tell what a stopped run cost.
   */
  cost_usd: number | null;
  /** How long the whole run took, in seconds; older versions did not record it. */
  seconds?: number | null;
  cells: string[];
  files: string[];
  /** 'failed' is recorded for a run that added cells or cost money; older versions did not record it. */
  state: 'done' | 'stopped' | 'failed';
  /** When the run ended, as an ISO date and time. */
  at: string;
  /*
   * What the run's strip shows, so that the history of runs draws it again
   * (design iteration 1.73, src/model/runs.ts). A record without `steps` is
   * from an older version, or from a view whose setting "History of agents'
   * runs" was off.
   */
  /** When the run started, as an ISO date and time. */
  started?: string;
  /** The cell that the question was about, or null for a question about the notebook. */
  anchor?: string | null;
  /** The choice of the settings whose model answered: 'remote', or a local model's id. */
  choice?: string;
  steps?: IAgentStepRecord[];
  /** The answer, cut to 2,000 characters, and the cells it names by their labels then. */
  answer?: string | null;
  answer_refs?: Record<string, string>;
  /** The follow-up questions, "type: question", at most five. */
  follow_up?: string[];
  /** The notebooks that the run made beside this one. */
  notebooks?: {
    path: string;
    kernel: string;
    display_name: string;
    label: string;
  }[];
  /**
   * In the record of a notebook that the run made: the notebook where the
   * question was asked, which shows the run's strip.
   */
  asked_in?: string;
  /** Whether the data stayed on this machine for the run. */
  keep_local?: boolean;
  /** The cost cap that stopped the run. */
  capped?: { by: 'notebook' | 'server'; usd: number } | null;
  /** Why the run failed, cut to 500 characters. */
  error?: string | null;
}

/** A step of an agent's run as the notebook keeps it: its tool, its words and its cells. */
export interface IAgentStepRecord {
  /** run_cell, explore, write_file, new_notebook, share_frames or compare. */
  tool: string;
  title: string;
  why?: string;
  /** The cells that the step added, by their ids. */
  cells: string[];
  /** The notebook of the cells, from the server's root, when it is not this one. */
  notebook?: string;
  /** The module that the step wrote: its path from the server's root, its name and its lines. */
  file?: { path: string; name: string; lines: number };
  state: 'done' | 'error';
  error?: string | null;
  /**
   * The first line of each error of the step's cells before their last run,
   * by the cell's id: the agent fixed the cell in place, or removed it
   * (design iteration 1.103).
   */
  failures?: Record<string, string[]>;
  /** The cells that the agent removed after they failed. */
  removed?: string[];
}

/** A model's summary of a data frame, with the key of the columns it read. */
export interface IFrameNote {
  summary: string;
  key: string;
  /** The AI that wrote it; missing for summaries that an older version kept. */
  by?: IWrittenBy;
}

/** A model's title for a cell's code. */
export interface ITitleNote {
  title: string;
  /** The fingerprint of the code the title is for. */
  key: string;
  by?: IWrittenBy;
}

/** The newest title of a cell, and one earlier title per other model. */
export interface ITitleNotes extends ITitleNote {
  earlier?: ITitleNote[];
}

/** The newest summary of a frame, and one earlier summary per other model. */
export interface IFrameNotes extends IFrameNote {
  earlier?: IFrameNote[];
}

export type Mode = 'do' | 'report' | 'wonder';

export type ViewKind = 'bench' | 'map' | 'linear';

export type Interaction = 'drag' | 'click';

/**
 * Something that can be dragged or picked: a variable or a column.
 */
export interface IItem {
  kind: 'variable' | 'column' | 'file' | 'table';
  name: string;
  label: string;
  parent?: string;
  /** For a file, or a table's database: the path in the server's contents. */
  path?: string;
  /** For a table: its name in the database. */
  table?: string;
}

/**
 * Where a popover opens: next to a pointer position. With `side: 'left'` it
 * opens to the left of x, so it does not cover what lies to the right.
 */
export interface IAnchor {
  x: number;
  y: number;
  side?: 'left' | 'right';
  /** Opens above y, so it does not cover what lies below, such as code. */
  above?: boolean;
  /** Without room above, it opens beside this span of x, such as a cell. */
  beside?: { left: number; right: number };
  /** The bottom of the element above which it opens, for a popover that opens below it instead. */
  bottom?: number;
  /**
   * Opens under the element whose bottom is `bottom`, left-aligned with `x`,
   * and stays on that side while it grows: the popover of a chip (design
   * iteration 1.86). `y` is the top of the element, for the side above where
   * the room below is the smaller.
   */
  below?: boolean;
}

export interface IProgressEvent {
  type: 'progress';
  stage: 'starting' | 'thinking' | 'writing' | 'retrying';
  elapsed: number;
  /** The last line of the model's thinking, when it shows its thinking. */
  message?: string;
}

export interface IErrorEvent {
  type: 'error';
  message: string;
  elapsed?: number;
  /** What the call cost before it failed, when it reached a model whose price is known. */
  cost_usd?: number | null;
}

export interface IResultEvent {
  type: 'result';
  elapsed: number;
  /** The model that answered, as the server names it: 'claude-opus-5-5', 'Gemma 4 E2B'. */
  model?: string | null;
  /** A local model's file, as its repository and file name. */
  file?: string | null;
  cost_usd?: number | null;
  [key: string]: unknown;
}

export type StreamEvent = IProgressEvent | IErrorEvent | IResultEvent;

/** The key of the view's metadata in a notebook and in its cells. */
export const METADATA_KEY = 'whybook';

export const RESULT_MIME = 'application/vnd.whybook.result+json';
export const PLOT_MIME = 'application/vnd.whybook.plot+json';
export const PROGRESS_MIME = 'application/vnd.whybook.progress+json';

/** The payload of a plot of the view's helpers, in an output's data. */
export function plotPayload(
  data: Record<string, unknown>
): IPlotPayload | null {
  return (data[PLOT_MIME] as IPlotPayload) ?? null;
}

export const ITEM_MIME = 'application/x-whybook-item';

/**
 * An axis of a Whybook plot: the column it shows. A date axis holds each date
 * as the milliseconds since 1970 of its time on the frame's clock.
 */
export interface IPlotAxis {
  field: string;
  label: string;
  /** "date" for dates; numbers otherwise. */
  type?: 'number' | 'date';
  /** The time zone of the frame's dates, such as "Europe/Warsaw". */
  tz?: string | null;
  /** Whether the frame holds the dates as Python objects, which pandas compares once parsed. */
  objects?: boolean;
}

/**
 * The payload of a Whybook plot, as the whybook Python helpers display it.
 */
export interface IPlotPayload {
  version: number;
  kind: 'ribbon' | 'scatter' | 'hist' | 'bars';
  title: string;
  x: IPlotAxis;
  y: IPlotAxis | null;
  source: {
    frame: string | null;
    x: string;
    y: string | null;
    by: string | null;
    rows: number;
  };
  select: 'x' | 'xy';
  series?: {
    name: string;
    points: { x: number; y: number; lo: number; hi: number; n: number }[];
  }[];
  points?: { x: number; y: number; g: string | null; i: number }[];
  /**
   * The groups of a scatter's points, in the order of a ribbon's lines, which
   * gives each its colour. A payload of an older version has none: the
   * groups then take the order in which they first appear.
   */
  groups?: string[];
  bins?: { x0: number; x1: number; n: number }[];
  /**
   * A bar of a mean has the 95% interval of the mean, `lo` to `hi`
   * (design iteration 1.85); a bar of a count has none.
   */
  bars?: { x: string; y: number; n: number; lo?: number; hi?: number }[];
  /**
   * The unit that each bar's `n` counts, "patient", when the bars average
   * one mean per unit (`whybook.bars(..., unit=...)`); rows without it.
   */
  unit?: string;
  /**
   * A thin line for each unit of a ribbon, such as each patient over the
   * weeks, under the mean and its band: up to 40 units, picked at random
   * (`whybook.ribbon(..., units=...)`, design iteration 1.75).
   */
  lines?: { name: string; points: { x: number; y: number }[] }[];
  /** The column that names the units of `lines`, how many are drawn and how many there are. */
  lines_of?: { field: string; shown: number; total: number };
  /** The largest move of a jittered point on each axis of a scatter. */
  jitter?: { x?: number; y?: number };
}

/** How much of each output the bench shows, from the least to the most. */
export type Detail = 'overview' | 'compact' | 'full';

/**
 * The level of detail of the outputs on the map: none, one line of small
 * tiles per cell, or the tiles of the bench's Overview.
 */
export type MapDetail = 'none' | 'minimal' | 'overview';
