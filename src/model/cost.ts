import type {
  CostKind,
  IAgentRunRecord,
  ICostRecord,
  ICostSum,
  IEpiCellMeta,
  IWrittenBy
} from '../tokens';

/**
 * What the model calls of a notebook cost. Every call that the view makes
 * adds its cost to sums by kind: the notebook's in `whybook.costs`, and each
 * cell's that the call worked on in the cell's `whybook.costs`, with its
 * share of a call for several cells. The sums never go down: a cell that
 * goes takes its own sums with it, and the notebook's stay. A notebook
 * without sums starts from what it held before: the cost of each answer of
 * one cell in its cell's `generated_by`, and of each run in
 * `whybook.agent_runs`. The notebook's cap is `whybook.cost_cap_usd`.
 */

/** How much "Go on, for up to $1 more" raises the notebook's cap, in US dollars. */
export const GO_ON_USD = 1;

/** Sums of prices differ from the cap in the ninth decimal: 0.1 + 0.2. */
const EPSILON = 1e-9;

/** The kinds of call, in the order the Cost sections list them. */
export const COST_KINDS: CostKind[] = [
  'answers',
  'titles',
  'labels',
  'summaries',
  'order',
  'questions',
  'other'
];

/** The kind of each route of the server that calls a model. */
export const ROUTE_KINDS: Record<string, CostKind> = {
  solve: 'answers',
  agent: 'answers',
  'cells/title': 'titles',
  'tables/describe': 'labels',
  'frames/describe': 'summaries',
  'questions/rank': 'order',
  'questions/claude': 'questions',
  // Other values of a constant that no rule knows, from the model of More questions.
  'decision/values': 'questions',
  // The library defaults that can change a result, from the same model ("Find more defaults with AI").
  'defaults/ask': 'questions',
  // What a reviewer would ask, from the same model: the check-up's question.
  'questions/review': 'questions',
  'questions/sort': 'other',
  'dependencies/claude': 'other'
};

/** The words of each kind in the Exploration panel. */
export const KIND_LABELS: Record<CostKind, string> = {
  answers: 'Answers',
  titles: 'Titles',
  labels: 'Table labels',
  summaries: 'Frame summaries',
  order: 'Question order',
  questions: 'More questions',
  other: 'Other'
};

/** The words of each kind in Cell details, for one cell. */
export const CELL_KIND_LABELS: Record<CostKind, string> = {
  answers: 'Answers',
  titles: 'Its title',
  labels: 'The labels of its tables',
  summaries: 'The summary of a frame it makes',
  order: 'Question order',
  questions: 'More questions',
  other: 'Other'
};

export interface INotebookCost {
  /** What the calls with a known price cost, in US dollars. */
  usd: number;
  /** How many calls have a known price. */
  priced: number;
  /**
   * How many calls have no known price: a model whose price nobody knows,
   * such as one of Hugging Face or of a model server of the analyst's, or an
   * answer whose cost the notebook does not record. They are not in `usd`.
   */
  unpriced: number;
}

/** One model call, as the record takes it. */
export interface ICallCost {
  /** US dollars; null when no price of the model is known. */
  usd: number | null;
  /** The call's seconds on the server, when it said. */
  seconds?: number | null;
}

function known(cost: number | null | undefined): cost is number {
  return typeof cost === 'number' && Number.isFinite(cost);
}

/** Dollars to the hundredth of a millionth, and seconds to the tenth. */
function round(value: number, scale: number): number {
  return Math.round(value * scale) / scale;
}

/**
 * The record with one more call of this kind: its share of the cost, and of
 * the time when `seconds` is kept. A call counts once in the notebook's sums,
 * with share 1; a call for several cells gives each cell a share.
 */
export function withCall(
  record: ICostRecord | undefined,
  kind: CostKind,
  call: ICallCost,
  share = 1,
  seconds = true
): ICostRecord {
  const before: ICostSum = record?.[kind] ?? { usd: 0, n: 0 };
  const priced = known(call.usd);
  const next: ICostSum = {
    usd: priced ? round(before.usd + call.usd! * share, 1e8) : before.usd,
    n: before.n + (priced ? 1 : 0)
  };
  const unpriced = (before.unpriced ?? 0) + (priced ? 0 : 1);
  if (unpriced) {
    next.unpriced = unpriced;
  }
  const time =
    (before.seconds ?? 0) +
    (seconds && known(call.seconds) ? call.seconds * share : 0);
  if (time) {
    next.seconds = round(time, 10);
  }
  return { ...record, [kind]: next };
}

/** The sums of a record over its kinds. */
export function recordTotal(record: ICostRecord | undefined): INotebookCost {
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const sum of Object.values(record ?? {})) {
    if (!sum) {
      continue;
    }
    usd += sum.usd;
    priced += sum.n;
    unpriced += sum.unpriced ?? 0;
  }
  return { usd: round(usd, 1e8), priced, unpriced };
}

/**
 * What the answers of a notebook cost, each counted once, from the marks
 * that it held before the view kept sums: the answers of one cell in their
 * cells' `generated_by`, and the runs in `whybook.agent_runs`. The cells of a
 * run hold no cost of their own. The cells of a run that the notebook has no
 * record of, such as a run that failed at once or ran before notebooks
 * kept records of runs, count once as a run without a known price.
 */
export function notebookCost(
  cells: IEpiCellMeta[],
  runs: Record<string, IAgentRunRecord> | undefined
): INotebookCost & { seconds: number } {
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  let seconds = 0;
  const count = (cost: number | null | undefined, time?: number | null) => {
    if (known(cost)) {
      usd += cost;
      priced++;
    } else {
      unpriced++;
    }
    seconds += known(time) ? time : 0;
  };
  const recorded = runs ?? {};
  for (const run of Object.values(recorded)) {
    count(run.cost_usd, run.seconds);
  }
  const unrecorded = new Set<string>();
  for (const meta of cells) {
    const written = meta.generated_by;
    if (!written) {
      continue;
    }
    if (meta.agent) {
      if (!(meta.agent.run in recorded)) {
        unrecorded.add(meta.agent.run);
      }
      continue;
    }
    count(written.cost_usd, written.seconds);
  }
  unpriced += unrecorded.size;
  return { usd: round(usd, 1e8), priced, unpriced, seconds };
}

/** The sums that a notebook written before the view kept them starts from: its answers. */
export function seedRecord(
  cells: IEpiCellMeta[],
  runs: Record<string, IAgentRunRecord> | undefined
): ICostRecord {
  const found = notebookCost(cells, runs);
  if (!found.priced && !found.unpriced) {
    return {};
  }
  return {
    answers: {
      usd: found.usd,
      n: found.priced,
      ...(found.unpriced ? { unpriced: found.unpriced } : {}),
      ...(found.seconds ? { seconds: round(found.seconds, 10) } : {})
    }
  };
}

/**
 * The sums of a cell written before the view kept them: the answer of one
 * cell that its mark holds. A cell of an agent's run has none: its run's
 * record holds the cost.
 */
export function cellSeed(meta: IEpiCellMeta): ICostRecord {
  const written = meta.generated_by;
  if (!written || meta.agent) {
    return {};
  }
  return withCall({}, 'answers', {
    usd: written.cost_usd ?? null,
    seconds: written.seconds ?? null
  });
}

/** The sums of a cell: those it keeps, or those it starts from. */
export function cellRecord(meta: IEpiCellMeta): ICostRecord {
  return meta.costs ?? cellSeed(meta);
}

/** Whether the calls with a known price cost as much as the cap, or more. */
export function capReached(
  total: number,
  cap: number | null | undefined
): boolean {
  return known(cap) && total >= cap - EPSILON;
}

/** What is left under the cap for a run, in US dollars: the server stops the run there. */
export function leftUnder(total: number, cap: number): number {
  return Math.max(0, Math.round((cap - total) * 1e6) / 1e6);
}

/**
 * The cap after "Go on, for up to $1 more": $1 above the cap, or $1 above
 * the total when the total has passed that, so that the answer has room.
 */
export function raisedCap(cap: number, total: number): number {
  const raised = Math.round((cap + GO_ON_USD) * 100) / 100;
  return raised > total + EPSILON
    ? raised
    : Math.ceil((total + GO_ON_USD) * 100) / 100;
}

/**
 * A cap that the analyst typed: US dollars, with or without "$". An empty
 * field is no cap; a value is kept to the cent.
 */
export function parseCap(
  text: string
): { ok: true; value: number | null } | { ok: false } {
  if (!text.trim()) {
    return { ok: true, value: null };
  }
  const cleaned = text.trim().replace(/^\$\s*/, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) {
    return { ok: false };
  }
  return { ok: true, value: Math.round(Number(cleaned) * 100) / 100 };
}

/** The zeros after the last digit that counts, keeping two decimals. */
function trimZeros(text: string): string {
  return text.replace(/(\.\d\d\d*?)0+$/, '$1');
}

/**
 * US dollars as the view shows them: cents from 10 cents up, "$0.42",
 * "$2.00", and two significant digits below, "$0.016", "$0.00041".
 */
export function formatUsd(value: number): string {
  if (value === 0) {
    return '$0.00';
  }
  if (value >= 0.1) {
    return `$${value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }
  const decimals = Math.min(10, Math.max(2, 1 - Math.floor(Math.log10(value))));
  return `$${trimZeros(value.toFixed(decimals))}`;
}

/**
 * The exact amount, for the tooltip of every amount the view shows:
 * "$0.000412, 0.041 cents". Amounts of a dollar or more have no cents.
 */
export function exactUsd(value: number): string {
  const dollars = `$${trimZeros(value.toFixed(8))}`;
  if (value === 0 || value >= 1) {
    return dollars;
  }
  const cents = value * 100;
  const text = String(
    Number(cents >= 1 ? cents.toFixed(2) : cents.toPrecision(2))
  );
  return `${dollars}, ${text} ${text === '1' ? 'cent' : 'cents'}`;
}

/** Seconds as the view shows them: "8 s", "1 min 12 s". */
export function formatSeconds(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  if (whole < 60) {
    return `${whole} s`;
  }
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** A piece of text in the Cost sections: words, or an amount with its exact value on hover. */
export type Segment = string | { usd: number };

/** The calls of a sum in words: "1 call", "3 calls". */
export function callsText(sum: ICostSum): string {
  const calls = sum.n + (sum.unpriced ?? 0);
  return calls === 1 ? '1 call' : `${calls} calls`;
}

/** How many calls of a sum had no known price, for the tooltip of its count; null for none. */
export function unpricedOf(sum: ICostSum): string | null {
  return sum.unpriced
    ? `${sum.unpriced} of them without a known price, not in the amount`
    : null;
}

/**
 * How the code of a cell came to be, for the Cost section of Cell details:
 * from a template with no model call, by the analyst, by an answer of one
 * cell with its cost and time, or by an agent's run with the run's cost and
 * time, which cover all its cells. `working` holds the ids of the runs that
 * go on in this view.
 */
export function cellWriter(
  meta: IEpiCellMeta,
  runs: Record<string, IAgentRunRecord> | undefined,
  kind: 'code' | 'markdown' | 'raw',
  working: ReadonlySet<string> = new Set()
): Segment[] {
  const written = meta.generated_by;
  if (!written) {
    if (meta.written_by === 'agent') {
      return meta.template
        ? ['Written from a template, with no model call.']
        : [
            'Whybook wrote this code, from a template or with a model; the notebook does not record which.'
          ];
    }
    return [
      kind === 'markdown' ? 'You wrote this text.' : 'You wrote this code.'
    ];
  }
  const time = (seconds: number | null | undefined) =>
    known(seconds) ? formatSeconds(seconds) : null;
  if (meta.agent) {
    const record = runs?.[meta.agent.run];
    if (!record) {
      return working.has(meta.agent.run)
        ? [
            "Written in an agent's run that is still working: its cost shows when it ends."
          ]
        : [
            "Written in an agent's run whose cost the notebook does not record."
          ];
    }
    const cells =
      record.cells.length === 1
        ? 'its one cell'
        : `its ${record.cells.length} cells`;
    const took = time(record.seconds);
    if (known(record.cost_usd)) {
      return took
        ? [
            "Written in an agent's run, which cost ",
            { usd: record.cost_usd },
            ` in ${took} for ${cells}.`
          ]
        : [
            "Written in an agent's run, which cost ",
            { usd: record.cost_usd },
            ` for ${cells}.`
          ];
    }
    return took
      ? [
          `Written in an agent's run, which took ${took} for ${cells}, at no known price.`
        ]
      : [
          `Written in an agent's run of ${record.cells.length === 1 ? 'one cell' : `${record.cells.length} cells`}, at no known price.`
        ];
  }
  const took = time(written.seconds);
  if (known(written.cost_usd)) {
    return took
      ? ['Written for ', { usd: written.cost_usd }, ` in ${took}.`]
      : [
          'Written for ',
          { usd: written.cost_usd },
          '; its time was not recorded.'
        ];
  }
  return took
    ? [`Written in ${took}, at no known price.`]
    : ['Written at no known price; its time was not recorded.'];
}

/** A line of what models did for a cell: the kind, and its sums, or null where no cost was recorded. */
export interface ICellPart {
  kind: CostKind;
  label: string;
  sum: ICostSum | null;
}

/** Whether a model, and not a script in its place, wrote a note. */
function byModel(by: IWrittenBy | undefined | null): boolean {
  return !!by && by.choice !== 'script';
}

/**
 * What models did for a cell, from its sums and from what they wrote for it:
 * its title, the labels of its tables, the summary of a frame it makes. A
 * part that a model wrote before the view kept sums shows with no cost.
 * The answer that wrote the cell's code is in the first line of the
 * section: its answers show here when the cell had more than that one, or
 * when an answer was undone.
 */
export function cellParts(
  meta: IEpiCellMeta,
  summarised: boolean
): ICellPart[] {
  const record = cellRecord(meta);
  const parts: ICellPart[] = [];
  const answers = record.answers;
  const inHead = !!meta.generated_by && !meta.agent;
  if (answers && (!inHead || answers.n + (answers.unpriced ?? 0) > 1)) {
    parts.push({
      kind: 'answers',
      label: CELL_KIND_LABELS.answers,
      sum: answers
    });
  }
  const noted: Record<'titles' | 'labels' | 'summaries', boolean> = {
    titles: byModel(meta.title_note?.by),
    labels: Object.values(meta.tables ?? {}).some(note => byModel(note.by)),
    summaries: summarised
  };
  for (const kind of ['titles', 'labels', 'summaries'] as const) {
    const sum = record[kind] ?? null;
    if (sum || noted[kind]) {
      parts.push({ kind, label: CELL_KIND_LABELS[kind], sum });
    }
  }
  return parts;
}

/** The count of calls without a known price, for the Exploration panel. */
export function unpricedText(count: number): string {
  return `${count} ${count === 1 ? 'call' : 'calls'} without a known price, not counted against the cap.`;
}
