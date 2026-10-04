/**
 * Questions about the notebook itself, a prototype of design iterations
 * 1.67 to 1.70: the check-up of a notebook, about once a week.
 *
 * The rules answer three questions with no model, from the kernel's
 * analysis of the cells, the notebook and the run times that the view
 * recorded (./runtimes.ts): "Does it run from the top?", "What makes it
 * slow?", and the points of a review and the gaps that code can find. They
 * run when the analyst opens the Check-up section, and they run no cell.
 * "What would a reviewer ask?" is one call to the model chosen for More
 * questions, when the analyst presses Ask, never by itself.
 *
 * The notebook's metadata keeps the date of the last check-up, what the
 * rules found, the run times and the reviewer's questions, so the notebook
 * shows them again when it opens. The folded section's note changes its
 * words after the events of 1.70, and nothing else calls for attention.
 *
 * The plugin of ../checkup.ts holds all of it: without the plugin, or with
 * its setting off, the view is as it was.
 */
import type { INotebookModel } from '@jupyterlab/notebook';
import type { IDisposable } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

import type {
  ICellAnalysis,
  IDecision,
  IEpiNotebookMeta,
  IOption,
  IVariable,
  IWrittenBy,
  QuestionType,
  StreamEvent
} from '../tokens';
import { QUESTION_TYPES } from '../tokens';
import type { EpiModel } from './epimodel';
import { describeError } from './epimodel';
import { choiceOf, isRemote } from './models';
import {
  notebookMeta,
  outputKind,
  outputsOf,
  setNotebookMeta
} from './notebook';
import { outputText } from './logs';
import { runnableFirst } from './questionorder';
import { RunTimes, recordedSeconds } from './runtimes';
import { fingerprint } from './tables';
import { writtenBy } from './writtenby';

/** The four groups of 1.67, in the order the section shows them. */
export type CheckupGroup = 'reproduce' | 'speed' | 'review' | 'gaps';

export const CHECKUP_GROUPS: { id: CheckupGroup; label: string }[] = [
  { id: 'reproduce', label: 'Reproduce' },
  { id: 'speed', label: 'Speed' },
  { id: 'review', label: 'Review' },
  { id: 'gaps', label: 'Gaps' }
];

/**
 * A question about the notebook that another part of the view answers,
 * such as "Would I get the same results in R?", which the agent of 1.69
 * answers in a notebook of its own. Its row shows in its group of the
 * section; with no `ask`, it shows as not built yet.
 */
export interface ICheckupQuestion {
  id: string;
  group: CheckupGroup;
  /** The question for this notebook. */
  text: (model: EpiModel) => string;
  /** What answers it. */
  how: string;
  /** What it costs, as the row says it: "needs AI · an agent". */
  cost: string;
  needsAI: boolean;
  /** Opens its flow for the notebook; null while it is not built. */
  ask: ((model: EpiModel) => void) | null;
}

/**
 * The questions that other parts of the view add, by id. The agent that
 * works in another notebook (1.69) sets `ask` of 'other-language'.
 */
export const checkupQuestions = new Map<string, ICheckupQuestion>();

/** The other language of the question, for the kernel's language: R for Python. */
export function otherLanguage(language: string | null | undefined): string {
  const name = (language ?? '').toLowerCase();
  return name === 'python' ? 'R' : name ? 'Python' : 'another language';
}

checkupQuestions.set('other-language', {
  id: 'other-language',
  group: 'reproduce',
  text: model =>
    `Would I get the same results in ${otherLanguage(
      model.bridge.languageName ??
        model.notebook.getMetadata('kernelspec')?.language
    )}?`,
  how: 'An agent writes the cells in a new notebook with the other kernel, and compares the estimates',
  cost: 'needs AI · an agent',
  needsAI: true,
  ask: null
});

/** One thing that a rule found. */
export interface ICheckupFinding {
  /** The rule and what it found: the same while the notebook does not change. */
  id: string;
  text: string;
  /** The cell it is about: a click shows the cell. */
  cellId: string | null;
  /**
   * What it is about, for a suggestion of Worth asking next about the same
   * thing: the question that suggestion asks, or a name it names.
   */
  about?: { texts?: string[]; names?: string[] };
}

export interface ICheckupFindings {
  reproduce: ICheckupFinding[];
  speed: ICheckupFinding[];
  review: ICheckupFinding[];
  gaps: ICheckupFinding[];
  /** What a group says when it found nothing, or why the rules could not read it. */
  notes: Partial<Record<CheckupGroup, string>>;
  /** How many findings of a group were left out, as Worth asking next suggests them now. */
  repeated: { review: number; gaps: number };
}

/** What the rules read of a code cell. */
export interface ICheckupCell {
  id: string;
  /** `[5]`, `[5b]` for a branch, `[ ]` for a cell that has not run. */
  label: string;
  title: string;
  source: string;
  count: number | null;
  analysis: Pick<ICellAnalysis, 'defs' | 'uses' | 'formulas'> | null;
  decisions: IDecision[];
  branchOf: string | null;
  /** The names of the values that the analyst chose in the cell. */
  chosen: string[];
  /** The question the cell answers, when a question made it. */
  question: string | null;
}

/** What the rules read of the notebook and of the kernel. */
export interface ICheckupInput {
  /** The code cells, in the order of the notebook. */
  cells: ICheckupCell[];
  variables: Pick<IVariable, 'name' | 'kind' | 'type' | 'model_class'>[];
  /** The code that ran with an execution count, when the view saw that run. */
  codeOf: (count: number) => string | null;
  /** The seconds of each cell's last run, by the cell's id. */
  seconds: Map<string, number>;
  /** The texts of the suggestions that Worth asking next shows now. */
  suggested: string[];
  /** The suggestions put off with Not now, with the labels of now. */
  putOff: { text: string; cellId: string | null }[];
}

/** At most this many findings of one rule, then one line for the rest. */
const PER_RULE = 3;

/** Names that IPython gives every kernel: no cell needs to make them. */
const KERNEL_NAMES = new Set([
  'In',
  'Out',
  'get_ipython',
  'exit',
  'quit',
  'display'
]);

/** Code that makes names that the kernel's analysis does not list. */
const HIDDEN_MAKERS =
  /\bimport\s+\*|^\s*%(run|store)\b|\bexec\s*\(|\bglobals\(\)\s*\[/m;

/** A list of phrases: "a", "a and b", "a, b and c". */
function listed(parts: string[]): string {
  return parts.length < 2
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** A cell as the findings name it: its label, or its title when it has not run. */
function nameOf(cell: ICheckupCell): string {
  return cell.label === '[ ]' ? `“${cell.title}”` : cell.label;
}

/** A cell with its title, as the speed of the notebook names it: `[5b] “Ordinal model”`. */
function titled(cell: ICheckupCell): string {
  return cell.label === '[ ]'
    ? `“${cell.title}”`
    : `${cell.label} “${cell.title}”`;
}

/** A name as a whole word, for a test of a text. */
function wordRegExp(name: string): RegExp {
  return new RegExp(
    `(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`
  );
}

/**
 * The names that a cell's functions and lambdas take as parameters, such as
 * `d` of `lambda d: d["week"]`: a use of `d` there is no use of a `d` that
 * another cell makes.
 */
export function parameterNames(source: string): Set<string> {
  const names = new Set<string>();
  const add = (list: string) => {
    for (const part of list.split(',')) {
      const name = /^\s*\**\s*([A-Za-z_]\w*)/.exec(part);
      if (name) {
        names.add(name[1]);
      }
    }
  };
  for (const match of source.matchAll(/\blambda\b([^:]*):/g)) {
    add(match[1]);
  }
  for (const match of source.matchAll(/\bdef\s+\w+\s*\(([^)]*)\)/g)) {
    add(match[1]);
  }
  return names;
}

/**
 * The rules of "Does it run from the top?", from the kernel's analysis and
 * the notebook, with no run: a cell that uses a name that only a cell below
 * it makes, or that no cell makes; a cell that ran after cells below it; a
 * cell whose code changed after the run that the view saw; and a cell that
 * has not run. `codeOf` gives the code of each execution count that the
 * view saw run.
 */
export function reproduceFindings(
  cells: ICheckupCell[],
  codeOf: (count: number) => string | null
): { findings: ICheckupFinding[]; note: string | null } {
  const findings: ICheckupFinding[] = [];
  // The rules of names need the kernel's analysis; the others the counts.
  const read = cells.some(cell => cell.analysis);
  // The first cell that makes each name.
  const maker = new Map<string, number>();
  cells.forEach((cell, index) => {
    for (const name of cell.analysis?.defs ?? []) {
      if (!maker.has(name)) {
        maker.set(name, index);
      }
    }
  });
  const late: ICheckupFinding[] = [];
  const unmade: ICheckupFinding[] = [];
  // A star import, a %run or an exec makes names that the analysis does
  // not list: a name that no cell makes may come from them.
  const hidden = cells.some(cell => HIDDEN_MAKERS.test(cell.source));
  cells.forEach((cell, index) => {
    if (!cell.analysis) {
      return;
    }
    const own = new Set(cell.analysis.defs);
    const params = parameterNames(cell.source);
    const below = new Map<number, string[]>();
    const nowhere: string[] = [];
    for (const name of cell.analysis.uses) {
      if (
        own.has(name) ||
        KERNEL_NAMES.has(name) ||
        name.startsWith('_') ||
        params.has(name)
      ) {
        continue;
      }
      const at = maker.get(name);
      if (at === undefined) {
        nowhere.push(name);
      } else if (at > index) {
        below.set(at, [...(below.get(at) ?? []), name]);
      }
    }
    for (const [at, names] of below) {
      late.push({
        id: `late:${cell.id}:${cells[at].id}`,
        text: `${nameOf(cell)} uses ${listed(names)}, which only ${nameOf(cells[at])} makes, below it.`,
        cellId: cell.id
      });
    }
    if (nowhere.length && !hidden) {
      unmade.push({
        id: `unmade:${cell.id}`,
        text: `${nameOf(cell)} uses ${listed(nowhere)}, which no cell makes: the kernel keeps ${nowhere.length === 1 ? 'it' : 'them'} from code that is gone.`,
        cellId: cell.id
      });
    }
  });
  findings.push(
    ...capped(late, 'late', n =>
      n === 1
        ? '1 more cell uses what only a cell below it makes.'
        : `${n} more cells use what only a cell below them makes.`
    ),
    ...capped(unmade, 'unmade', n =>
      n === 1
        ? '1 more cell uses what no cell makes.'
        : `${n} more cells use what no cell makes.`
    )
  );
  // A notebook that ran from the top has counts that grow down the page.
  // Branches run beside their cell, so their counts do not count.
  const counted = cells.filter(cell => !cell.branchOf && cell.count !== null);
  const early: ICheckupFinding[] = [];
  counted.forEach((cell, index) => {
    const before = counted
      .slice(index + 1)
      .filter(other => (other.count ?? 0) < (cell.count ?? 0));
    if (!before.length) {
      return;
    }
    const which =
      before.length === 1
        ? `${nameOf(before[0])}, which is below it`
        : before.length === 2
          ? `${listed(before.map(nameOf))}, which are below it`
          : `${before.length} cells below it, such as ${nameOf(before[0])}`;
    early.push({
      id: `order:${cell.id}`,
      text: `${nameOf(cell)} ran after ${which}.`,
      cellId: cell.id
    });
  });
  findings.push(
    ...capped(early, 'order', n =>
      n === 1
        ? '1 more cell ran after cells below it.'
        : `${n} more cells ran after cells below them.`
    )
  );
  const changed: ICheckupFinding[] = [];
  for (const cell of cells) {
    const ran = cell.count !== null ? codeOf(cell.count) : null;
    if (ran !== null && ran !== cell.source) {
      changed.push({
        id: `changed:${cell.id}`,
        text: `${nameOf(cell)} changed after it ran: its outputs come from older code.`,
        cellId: cell.id
      });
    }
  }
  findings.push(
    ...capped(changed, 'changed', n =>
      n === 1
        ? '1 more cell changed after it ran.'
        : `${n} more cells changed after they ran.`
    )
  );
  if (cells.some(cell => cell.count !== null)) {
    const idle = cells
      .filter(cell => cell.count === null && cell.source.trim() !== '')
      .map(cell => ({
        id: `notrun:${cell.id}`,
        text: `${nameOf(cell)} has not run: a run from the top runs it for the first time.`,
        cellId: cell.id
      }));
    findings.push(
      ...capped(idle, 'notrun', n =>
        n === 1 ? '1 more cell has not run.' : `${n} more cells have not run.`
      )
    );
  }
  return {
    findings,
    note: !read
      ? 'The kernel has not read the cells yet. Run them, and the check-up reads the names that each cell uses.'
      : findings.length
        ? null
        : 'Each cell uses only names that cells above it make, and the cells ran in the order they stand.'
  };
}

/** The first findings of a rule, and one line that counts the rest. */
function capped(
  findings: ICheckupFinding[],
  rule: string,
  rest: (count: number) => string
): ICheckupFinding[] {
  if (findings.length <= PER_RULE) {
    return findings;
  }
  return [
    ...findings.slice(0, PER_RULE),
    {
      id: `${rule}:more`,
      text: rest(findings.length - PER_RULE),
      cellId: null
    }
  ];
}

/** Seconds as the check-up gives them: "under 0.1 s", "2.4 s", "1 min 12 s". */
export function runSeconds(seconds: number): string {
  if (seconds < 0.1) {
    return 'under 0.1 s';
  }
  if (seconds < 10) {
    return `${seconds.toFixed(1)} s`;
  }
  const whole = Math.round(seconds);
  if (whole < 60) {
    return `${whole} s`;
  }
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** The body of each `for` loop of a cell, as its lines. */
function loops(source: string): { head: string; body: string }[] {
  const lines = source.split('\n');
  const found: { head: string; body: string }[] = [];
  lines.forEach((line, index) => {
    const head = /^(\s*)for\b.*:\s*(#.*)?$/.exec(line);
    if (!head) {
      return;
    }
    const indent = head[1].length;
    const body: string[] = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() === '') {
        continue;
      }
      if ((/^\s*/.exec(next)?.[0].length ?? 0) <= indent) {
        break;
      }
      body.push(next);
    }
    found.push({ head: line, body: body.join('\n') });
  });
  return found;
}

/**
 * Whether a cell fits a model inside a loop, and how many times when its
 * loop counts a written number: 40 for `for i in range(40):`.
 */
export function fitsInLoop(source: string): { times: number | null } | null {
  for (const loop of loops(source)) {
    if (/\bfit(_regularized|_transform)?\s*\(/.test(loop.body)) {
      const times = /\brange\(\s*(\d+)\s*\)/.exec(loop.head);
      return { times: times ? Number(times[1]) : null };
    }
  }
  return null;
}

/**
 * The rules of "What makes it slow?": the last runs of the cells, the
 * slowest cell with its share, and a loop that fits a model in it.
 */
export function speedFindings(
  cells: ICheckupCell[],
  seconds: Map<string, number>
): { findings: ICheckupFinding[]; note: string | null } {
  const timed = cells.filter(cell => seconds.has(cell.id));
  if (!timed.length) {
    return {
      findings: [],
      // The view times the runs that it sees while the Check-up is on: a Run
      // all before the setting turned on left no time (design iteration 1.83).
      note: 'No run times yet. Whybook times a cell only while "Questions about the notebook" is on and the notebook is open in it. Run the cells again to time them.'
    };
  }
  const total = timed.reduce((sum, cell) => sum + seconds.get(cell.id)!, 0);
  const which =
    timed.length === cells.length
      ? `the ${cells.length} cells`
      : `${timed.length} of the ${cells.length} cells`;
  const head = `The last runs of ${which} took ${runSeconds(total)}.`;
  if (total < 1) {
    return {
      findings: [
        {
          id: 'speed:total',
          text: `${head} Nothing here is slow.`,
          cellId: null
        }
      ],
      note: null
    };
  }
  const order = [...timed].sort(
    (a, b) => seconds.get(b.id)! - seconds.get(a.id)!
  );
  const share = (cell: ICheckupCell) =>
    `${Math.round((100 * seconds.get(cell.id)!) / total)}%`;
  const slow = order[0];
  const loop = fitsInLoop(slow.source);
  const why = loop
    ? loop.times
      ? ` It fits a model ${loop.times} times, in a loop.`
      : ' It fits a model in a loop.'
    : '';
  const findings: ICheckupFinding[] = [
    {
      id: `speed:${slow.id}`,
      text: `${head} ${titled(slow)} took ${runSeconds(seconds.get(slow.id)!)} of it (${share(slow)}).${why}`,
      cellId: slow.id
    }
  ];
  const next = order[1];
  if (next && seconds.get(next.id)! >= 0.1 * total) {
    findings.push({
      id: `speed:${next.id}`,
      text: `${titled(next)} took ${runSeconds(seconds.get(next.id)!)} (${share(next)}).`,
      cellId: next.id
    });
  }
  return { findings, note: null };
}

/** What a reviewer asks of a fitted model's checks: its residuals and its influence. */
const RESIDUALS =
  /\.(resid\w*|fittedvalues|plot_diagnostics|get_influence|outlier_test|diagnostic\w*)\b|\b(qqplot|residplot|het_breuschpagan|het_white|het_goldfeldquandt|durbin_watson|acorr_ljungbox|normal_ad|jarque_bera|plot_regress_exog|influence_plot|plot_leverage_resid2|plot_partregress|check_model)\s*\(/;

/** The kinds of statsmodels' models, as the findings name them. */
const MODEL_KINDS: Record<string, string> = {
  MixedLM: 'a mixed model',
  OLS: 'a linear model',
  WLS: 'a linear model',
  GLS: 'a linear model',
  GLM: 'a generalized linear model',
  Logit: 'a logistic model',
  Probit: 'a probit model',
  Poisson: 'a Poisson model',
  NegativeBinomial: 'a negative binomial model',
  OrderedModel: 'an ordinal model',
  QuantReg: 'a quantile regression',
  GEE: 'a GEE model'
};

/** A test whose p-value a correction for multiple tests would change. */
const TEST =
  /\b(ttest_ind|ttest_rel|ttest_1samp|mannwhitneyu|wilcoxon|kruskal|f_oneway|chi2_contingency|fisher_exact|pearsonr|spearmanr|kendalltau|pointbiserialr|ks_2samp|anova_lm|pairwise_tukeyhsd|proportions_ztest)\s*\(|\b(?:pg|pingouin)\.(ttest|mwu|wilcoxon|anova|welch_anova|rm_anova|kruskal|friedman|corr|partial_corr|chi2_independence)\s*\(/;

/** A correction of p-values for multiple tests. */
const CORRECTIONS =
  /\b(multipletests|fdrcorrection\w*|false_discovery_control|p_adjust|padjust|bonferroni|holm|fdr_bh|multicomp|pairwise_tests|pairwise_ttests|pairwise_corr)\b/;

/** The text of a call from its opening parenthesis: `(a, b, random_state=0)`. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) {
        return source.slice(open, index + 1);
      }
    }
  }
  return source.slice(open);
}

/** Calls that draw random numbers, and the arguments that seed them. */
const RANDOM_CALLS =
  /\.sample\s*\(|\b(resample|train_test_split|bootstrap|permutation_test|default_rng)\s*\(|\bnp\.random\.(rand|randn|randint|choice|normal|uniform|shuffle|permutation|binomial|poisson|exponential)\s*\(/g;
const SEEDED = /\b(random_state|seed|rng)\s*=|default_rng\s*\(\s*[^\s)]/;

/**
 * Whether a cell draws random numbers with no seed: a call that samples,
 * with no seed in its arguments, `default_rng()` with none, or numpy's
 * global generator while no cell up to this one seeds it.
 */
export function unseeded(source: string, seededBefore: boolean): boolean {
  for (const match of source.matchAll(RANDOM_CALLS)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = callArguments(source, open);
    if (match[2]) {
      if (!seededBefore && !/\bnp\.random\.seed\s*\(/.test(source)) {
        return true;
      }
      continue;
    }
    if (match[1] === 'default_rng') {
      if (/^\(\s*\)$/.test(args)) {
        return true;
      }
      continue;
    }
    if (!SEEDED.test(args)) {
      return true;
    }
  }
  return false;
}

/** The server's words for a question about an open default: Worth asking next asks it. */
function openQuestion(decision: IDecision, cell: ICheckupCell): string {
  return `Does ${decision.name} = ${decision.value} change the result of ${cell.label}?`;
}

/**
 * The rules of a review that code can find: a fitted model whose residuals
 * no cell reads, a model of scikit-learn whose estimates have no interval,
 * many tests and no correction, a library default that drops rows (1.53),
 * and random draws with no seed.
 */
export function reviewFindings(
  cells: ICheckupCell[],
  variables: ICheckupInput['variables']
): ICheckupFinding[] {
  const findings: ICheckupFinding[] = [];
  const makerOf = (name: string, topLevel: boolean): number => {
    const assigned = new RegExp(`^${name}\\s*(:[^=\\n]*)?=[^=]`, 'm');
    for (let index = cells.length - 1; index >= 0; index--) {
      const cell = cells[index];
      if (
        cell.analysis?.defs.includes(name) &&
        (!topLevel || assigned.test(cell.source))
      ) {
        return index;
      }
    }
    return -1;
  };
  for (const variable of variables) {
    if (variable.kind === 'model') {
      // A model fitted at the top of a cell: one fitted in a loop is a step.
      const at = makerOf(variable.name, true);
      if (at < 0) {
        continue;
      }
      const reads = wordRegExp(variable.name);
      const checked = cells
        .slice(at)
        .some(cell => reads.test(cell.source) && RESIDUALS.test(cell.source));
      if (!checked) {
        const kind = variable.model_class
          ? (MODEL_KINDS[variable.model_class] ??
            `a ${variable.model_class} model`)
          : 'a model';
        findings.push({
          id: `residuals:${variable.name}`,
          text: `${nameOf(cells[at])} fits ${variable.name}, ${kind}, and no cell reads its residuals.`,
          cellId: cells[at].id,
          about: { names: [variable.name] }
        });
      }
    }
    const sklearn = /^sklearn\.linear_model\.[\w.]*?(\w+)$/.exec(
      variable.type ?? ''
    );
    if (sklearn) {
      const at = makerOf(variable.name, false);
      if (at >= 0) {
        findings.push({
          id: `interval:${variable.name}`,
          text: `${nameOf(cells[at])} fits ${variable.name} with scikit-learn's ${sklearn[1]}, which gives no interval for its estimates.`,
          cellId: cells[at].id,
          about: { names: [variable.name] }
        });
      }
    }
  }
  // Many tests, and no correction.
  const tested: ICheckupCell[] = [];
  let tests = 0;
  let looped: ICheckupCell | null = null;
  for (const cell of cells) {
    const found = [...cell.source.matchAll(new RegExp(TEST.source, 'g'))]
      .length;
    if (!found) {
      continue;
    }
    tests += found;
    tested.push(cell);
    if (!looped && loops(cell.source).some(loop => TEST.test(loop.body))) {
      looped = cell;
    }
  }
  const corrected = cells.some(cell => CORRECTIONS.test(cell.source));
  if (!corrected && (tests >= 3 || looped)) {
    findings.push(
      looped
        ? {
            id: 'tests:loop',
            text: `${nameOf(looped)} runs a test in a loop, and no cell corrects the p-values for multiple tests.`,
            cellId: looped.id
          }
        : {
            id: 'tests:many',
            text: `${tests} tests in ${listed(tested.map(nameOf))}, and no cell corrects their p-values for multiple tests.`,
            cellId: tested[0].id
          }
    );
  }
  // Library defaults that drop rows, as the kernel's analysis notes them.
  const drops: ICheckupFinding[] = [];
  for (const cell of cells) {
    for (const decision of cell.decisions) {
      if (
        decision.provenance === 'library_default' &&
        /\bdropped\b/.test(decision.note ?? '')
      ) {
        const call = (decision.function ?? '').split('.').pop() ?? '';
        drops.push({
          id: `drops:${cell.id}:${decision.name}:${call}`,
          text: `${nameOf(cell)} leaves ${decision.name}=${decision.value} of ${call}, a library default: ${decision.note}.`,
          cellId: cell.id,
          about: { texts: [openQuestion(decision, cell)] }
        });
      }
    }
  }
  findings.push(
    ...capped(drops, 'drops', n =>
      n === 1
        ? '1 more library default drops rows.'
        : `${n} more library defaults drop rows.`
    )
  );
  // Random draws with no seed.
  let seeded = false;
  for (const cell of cells) {
    if (unseeded(cell.source, seeded)) {
      findings.push({
        id: `seed:${cell.id}`,
        text: `${nameOf(cell)} draws random numbers with no seed: another run gives other numbers.`,
        cellId: cell.id
      });
    }
    seeded ||= /\bnp\.random\.seed\s*\(/.test(cell.source);
  }
  return findings;
}

/** The strings of the `[[...]]` lists of a cell: the columns it selects. */
function selectedColumns(source: string): string[] {
  const columns: string[] = [];
  for (const list of source.matchAll(/\[\[([^\]]*)\]\]/g)) {
    for (const item of list[1].matchAll(/(['"])([^'"]+)\1/g)) {
      columns.push(item[2]);
    }
  }
  return columns;
}

/** The keys of the joins of a cell: `on="patient_id"`, `on=["a", "b"]`. */
function joinKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const on of source.matchAll(
    /\b(?:on|left_on|right_on|groups)\s*=\s*(\[[^\]]*\]|(['"])[^'"]*\2)/g
  )) {
    for (const item of on[1].matchAll(/(['"])([^'"]+)\1/g)) {
      keys.add(item[2]);
    }
  }
  return keys;
}

/** The names that a formula names: its columns, with `Q("...")` for a name with spaces. */
function formulaNames(formula: string): Set<string> {
  const names = new Set(formula.match(/[A-Za-z_]\w*/g) ?? []);
  for (const quoted of formula.matchAll(/Q\(\s*(['"])(.+?)\1\s*\)/g)) {
    names.add(quoted[2]);
  }
  return names;
}

/**
 * The rules of "What have I forgotten?" over the whole notebook: a frame
 * that no later cell uses, a column merged into a model's data and left out
 * of its formula, and a constant of the analyst's module that no branch
 * varies. The suggestions put off with Not now are gaps too.
 */
export function gapFindings(
  cells: ICheckupCell[],
  variables: ICheckupInput['variables'],
  putOff: ICheckupInput['putOff']
): ICheckupFinding[] {
  const findings: ICheckupFinding[] = [];
  // Frames that nothing uses after the cell that makes them.
  for (const variable of variables) {
    if (variable.kind !== 'dataframe') {
      continue;
    }
    const at = cells.findIndex(cell =>
      cell.analysis?.defs.includes(variable.name)
    );
    if (at < 0) {
      continue;
    }
    const used = cells
      .slice(at)
      .some(cell => cell.analysis?.uses.includes(variable.name));
    if (!used) {
      findings.push({
        id: `unused:${variable.name}`,
        text: `${variable.name} is made in ${nameOf(cells[at])}, and no later cell uses it.`,
        cellId: cells[at].id,
        about: { names: [variable.name] }
      });
    }
  }
  // Columns that a cell selects into a model's data, which its formula leaves out.
  cells.forEach((cell, index) => {
    const formulas = cell.analysis?.formulas ?? [];
    const data = /\bdata\s*=\s*([A-Za-z_]\w*)/.exec(cell.source)?.[1];
    if (!formulas.length || !data) {
      return;
    }
    let at = -1;
    for (let other = index; other >= 0; other--) {
      if (cells[other].analysis?.defs.includes(data)) {
        at = other;
        break;
      }
    }
    if (at < 0) {
      return;
    }
    const maker = cells[at];
    const named = new Set(
      formulas.flatMap(formula => [...formulaNames(formula)])
    );
    const keys = new Set([...joinKeys(maker.source), ...joinKeys(cell.source)]);
    const merged = /\.(merge|join)\s*\(|\bpd\.merge\s*\(/.test(maker.source);
    const left = [...new Set(selectedColumns(maker.source))].filter(
      column => !named.has(column) && !keys.has(column)
    );
    for (const column of left) {
      findings.push({
        id: `formula:${cell.id}:${column}`,
        text: `${column} is ${merged ? 'merged into' : 'kept in'} ${data} in ${nameOf(maker)}, and left out of ${at === index ? 'its formula' : `the formula of ${nameOf(cell)}`}.`,
        cellId: cell.id,
        about: { names: [column] }
      });
    }
  });
  // Constants of the analyst's module that no branch varies.
  const seen = new Set<string>();
  for (const cell of cells) {
    for (const decision of cell.decisions) {
      const file = decision.source?.file;
      const key = `${decision.name}\u0000${file}`;
      if (decision.provenance !== 'defaulted' || !file || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const word = wordRegExp(decision.name);
      const varied = cells.some(
        other =>
          other.chosen.includes(decision.name) ||
          (!!other.branchOf &&
            (word.test(other.title) || word.test(other.question ?? '')))
      );
      if (!varied) {
        findings.push({
          id: `varied:${decision.name}:${file}`,
          text: `${decision.name} = ${decision.value} of ${file} is never varied.`,
          cellId: cell.id,
          about: {
            texts: [openQuestion(decision, cell)],
            names: [decision.name]
          }
        });
      }
    }
  }
  for (const step of putOff) {
    findings.push({
      id: `putoff:${step.text}`,
      text: `You put off “${step.text}” with Not now.`,
      cellId: step.cellId
    });
  }
  return findings;
}

/** Whether Worth asking next suggests now what a finding is about. */
function repeats(finding: ICheckupFinding, suggested: string[]): boolean {
  const about = finding.about;
  if (!about) {
    return false;
  }
  return suggested.some(
    text =>
      !!about.texts?.includes(text) ||
      !!about.names?.some(name => wordRegExp(name).test(text))
  );
}

/**
 * What the rules find in the notebook now. A point of the review or a gap
 * that a suggestion of Worth asking next is about is left out, so that the
 * two do not repeat each other.
 */
export function checkupFindings(input: ICheckupInput): ICheckupFindings {
  const reproduce = reproduceFindings(input.cells, input.codeOf);
  const speed = speedFindings(input.cells, input.seconds);
  const repeated = { review: 0, gaps: 0 };
  const fresh = (group: 'review' | 'gaps', findings: ICheckupFinding[]) =>
    findings.filter(finding => {
      const again = repeats(finding, input.suggested);
      repeated[group] += again ? 1 : 0;
      return !again;
    });
  const review = fresh('review', reviewFindings(input.cells, input.variables));
  const gaps = fresh(
    'gaps',
    gapFindings(input.cells, input.variables, input.putOff)
  );
  const notes: ICheckupFindings['notes'] = {};
  if (reproduce.note) {
    notes.reproduce = reproduce.note;
  }
  if (speed.note) {
    notes.speed = speed.note;
  }
  if (!review.length && !repeated.review) {
    notes.review = 'The rules found no point that a reviewer would raise.';
  }
  if (!gaps.length && !repeated.gaps) {
    notes.gaps = 'The rules found no gap.';
  }
  return {
    reproduce: reproduce.findings,
    speed: speed.findings,
    review,
    gaps,
    notes,
    repeated
  };
}

/** A question that a model asked as a reviewer, as the notebook keeps it. */
export interface IReviewQuestion {
  id: string;
  text: string;
  type: QuestionType;
  why: string;
  /** The cell it is about, by its id; null for the whole notebook. */
  cell: string | null;
}

/** What the notebook keeps of the check-up, under `whybook.checkup`. */
export interface ICheckupMeta {
  /** When the analyst last opened the check-up: an ISO date and time. */
  last?: string;
  /** What the rules found then, one line each. */
  found?: string[];
  /** Each cell's last run time then, with a hash of its code. */
  times?: Record<string, { seconds: number; code: string }>;
  /** The questions that a model last asked as a reviewer. */
  review?: { questions: IReviewQuestion[]; by: IWrittenBy | null; at: string };
}

/** The notebook's metadata with the check-up's key, which only this module reads. */
interface ICheckupNotebookMeta extends IEpiNotebookMeta {
  checkup?: ICheckupMeta;
}

export function checkupMeta(notebook: INotebookModel): ICheckupMeta {
  return (notebookMeta(notebook) as ICheckupNotebookMeta).checkup ?? {};
}

function setCheckupMeta(
  notebook: INotebookModel,
  patch: Partial<ICheckupMeta>
): void {
  const next: Partial<ICheckupNotebookMeta> = {
    checkup: { ...checkupMeta(notebook), ...patch }
  };
  setNotebookMeta(notebook, next);
}

/** The events of 1.70 after which the folded section's note changes its words. */
export interface ICheckupEvents {
  /** The analyst saved the notebook while the view was open. */
  saved: boolean;
  /** The analyst downloaded or exported the notebook. */
  exported: boolean;
  /** The Python of the kernel and the one of the notebook's metadata, when they differ. */
  python: { kernel: string; notebook: string } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
];

/** A day as the note gives it: "23 Sep", with the year when it is not this one. */
function dayText(time: number, now: number): string {
  const date = new Date(time);
  const year =
    date.getFullYear() === new Date(now).getFullYear()
      ? ''
      : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

/** Major and minor: "3.12" of "3.12.13". */
function minor(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

/** Whether two Pythons differ in their major or minor version. */
export function pythonsDiffer(kernel: string, notebook: string): boolean {
  return !!kernel && !!notebook && minor(kernel) !== minor(notebook);
}

/**
 * The note of the folded section, in grey: none before the first check-up
 * (the owner: "never does not need to be shown"), then
 * the day of the last one. Seven days or more after the last check-up, and
 * after one of the events of 1.70, it says how many days: the one hint. A
 * look at the check-up sets the day again, so the hint goes for seven days.
 */
export function checkupNote(
  meta: ICheckupMeta,
  now: number,
  events: ICheckupEvents
): { text: string; title: string; hint: boolean } {
  const last = Date.parse(meta.last ?? '');
  if (!Number.isFinite(last)) {
    return { text: '', title: '', hint: false };
  }
  const days = Math.floor((now - last) / DAY_MS);
  const why = events.python
    ? `The kernel runs Python ${events.python.kernel}, and the notebook was saved with Python ${events.python.notebook}.`
    : events.exported
      ? `You downloaded or exported the notebook ${days} days after its last check-up.`
      : events.saved
        ? `You saved the notebook ${days} days after its last check-up.`
        : null;
  if (days >= 7 && why) {
    return { text: `${days} days since the last`, title: why, hint: true };
  }
  return {
    text: `last on ${dayText(last, now)}`,
    title: `The last check-up was on ${dayText(last, now)}.`,
    hint: false
  };
}

/** The state of the reviewer's question: one call, when the analyst asks. */
export interface IReviewState {
  status: 'idle' | 'asking' | 'done' | 'failed';
  /** The stage of the call, while it works. */
  stage: string | null;
  started: number | null;
  questions: IOption[];
  by: IWrittenBy | null;
  error: string | null;
}

/** At most this many code cells, and this much of each, go to the reviewer. */
export const REVIEW_CELLS = 40;
export const REVIEW_CODE_CHARS = 1500;
export const REVIEW_TEXT_CHARS = 600;

/** What the outputs of a cell show, as text: printed text and plain results, cut. */
function outputsText(cell: ICheckupCell & { outputs: string[] }): string {
  return cell.outputs.join('\n').slice(0, REVIEW_TEXT_CHARS);
}

/**
 * The check-up of one notebook in one view: whether its section is open,
 * the run times that the view records, the events of 1.70, and the call of
 * the reviewer's question.
 */
export class Checkup implements IDisposable {
  constructor(model: EpiModel, options: { now?: () => number } = {}) {
    this._model = model;
    this._now = options.now ?? Date.now;
    this.times = new RunTimes(model.sessionContext);
    this.times.changed.connect(this._onTimes, this);
    // A document of a test may have no save signal.
    model.context.saveState?.connect(this._onSave, this);
    this.review = this._keptReview();
  }

  /** The run times of the cells that the view sees run. */
  readonly times: RunTimes;

  /** The reviewer's question: its call, and the questions it asked. */
  review: IReviewState;

  get model(): EpiModel {
    return this._model;
  }

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  get isOpen(): boolean {
    return this._open;
  }

  /**
   * Unfold the section, run the rules, and keep in the notebook the day and
   * what they found. With `reveal`, the section asks once to be brought into
   * sight: the icon of a notebook's tab opens it that way (src/checkup.ts).
   */
  open(reveal = false): void {
    this._open = true;
    this._reveal ||= reveal;
    this._look();
    this._changed.emit();
  }

  close(): void {
    this._open = false;
    this._changed.emit();
  }

  toggle(): void {
    if (this._open) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Whether the section should bring itself into sight: once per request. */
  takeReveal(): boolean {
    const reveal = this._reveal;
    this._reveal = false;
    return reveal;
  }

  /** The analyst downloaded or exported the notebook: an event of 1.70. */
  exported(): void {
    this._exported = true;
    this._changed.emit();
  }

  /** The note of the folded section. */
  note(): { text: string; title: string; hint: boolean } {
    const kernel = this._model.bridge.snapshot?.python ?? '';
    const saved = String(
      (
        this._model.notebook.getMetadata('language_info') as
          { version?: unknown } | undefined
      )?.version ?? ''
    );
    return checkupNote(checkupMeta(this._model.notebook), this._now(), {
      saved: this._saved,
      exported: this._exported,
      python: pythonsDiffer(kernel, saved) ? { kernel, notebook: saved } : null
    });
  }

  /** What the rules find in the notebook now. */
  findings(): ICheckupFindings {
    return checkupFindings(this.input());
  }

  /** What the rules read: the cells, the variables, the run times and the suggestions. */
  input(): ICheckupInput {
    const model = this._model;
    const cells = this._cells();
    // The suggestions that Worth asking next shows, as the Exploration panel does.
    const shown = runnableFirst(model.nextSteps, !!model.aiOff()).slice(0, 3);
    const dismissed = notebookMeta(model.notebook).exploration?.dismissed ?? [];
    return {
      cells,
      variables: model.variables(),
      codeOf: count => this.times.codeOf(count),
      seconds: this.seconds(),
      suggested: shown.map(step => step.text),
      putOff: dismissed.map(item => {
        const step = typeof item === 'string' ? { text: item } : item;
        const ids = Object.values(step.refs ?? {});
        return {
          text: model.questionText(step),
          cellId: ids.find(id => model.cell(id)) ?? null
        };
      })
    };
  }

  /**
   * The seconds of each code cell's last run: the run that the view saw,
   * else JupyterLab's own record (recordTiming), else what the last
   * check-up kept, while the cell's code is the same.
   */
  seconds(): Map<string, number> {
    const kept = checkupMeta(this._model.notebook).times ?? {};
    const seconds = new Map<string, number>();
    for (const cell of this._model.codeCells()) {
      const source = cell.model.sharedModel.getSource();
      const seen = this.times.timeOf(source)?.seconds;
      const recorded = recordedSeconds(cell.model);
      const old = kept[cell.id];
      const value =
        seen ??
        recorded ??
        (old && old.code === fingerprint(source) ? old.seconds : null);
      if (value !== null && value !== undefined) {
        seconds.set(cell.id, value);
      }
    }
    return seconds;
  }

  /**
   * Why "What would a reviewer ask?" cannot be asked now, or null: the model
   * of More questions does not run, or the notebook's cap holds it.
   */
  reviewOff(): string | null {
    const off = this._model.taskOff('questions');
    if (off) {
      return `A model would ask as a reviewer, and none answers: ${off}.`;
    }
    if (this._model.capHolds('questions')) {
      return "A model would ask as a reviewer, and the notebook's AI answers reached its cap.";
    }
    return null;
  }

  /**
   * Ask the model chosen for More questions what a reviewer would ask: one
   * call, which reads the code of the cells, their titles, what their
   * outputs show and what the rules found. With the data kept on this
   * machine, a model elsewhere gets no output text: the server cuts it.
   * The questions are kept in the notebook, and each is asked as other
   * questions of the view are, with one click.
   */
  async askReviewer(): Promise<void> {
    if (this.review.status === 'asking') {
      return;
    }
    const off = this.reviewOff();
    if (off) {
      this.review = { ...this.review, status: 'failed', error: off };
      this._changed.emit();
      return;
    }
    const model = this._model;
    const choice = choiceOf(model.settings.models, 'questions');
    this.review = {
      status: 'asking',
      stage: 'starting',
      started: Date.now(),
      questions: [],
      by: null,
      error: null
    };
    this._changed.emit();
    const stop = new AbortController();
    this._stop = stop;
    const got: {
      questions: IReviewQuestion[] | null;
      by: IWrittenBy | null;
      failure: string | null;
    } = {
      questions: null,
      by: null,
      failure: null
    };
    try {
      await model.api.reviewQuestions(
        this.reviewBody(choice),
        (event: StreamEvent) => {
          if (event.type === 'progress') {
            this.review = { ...this.review, stage: event.stage };
            this._changed.emit();
          } else if (event.type === 'result') {
            got.by = writtenBy(choice, event.model, event.file);
            got.questions = this._fromServer(event.questions);
          } else if (event.type === 'error') {
            got.failure = event.message;
          }
        },
        stop.signal
      );
    } catch (error) {
      got.failure = describeError(error);
    }
    if (this._isDisposed || stop.signal.aborted) {
      return;
    }
    this._stop = null;
    if (got.questions) {
      const at = new Date(this._now()).toISOString();
      setCheckupMeta(model.notebook, {
        review: { questions: got.questions, by: got.by, at }
      });
      this.review = {
        status: 'done',
        stage: null,
        started: null,
        questions: this._options(got.questions, got.by),
        by: got.by,
        error: null
      };
    } else {
      this.review = {
        ...this.review,
        status: 'failed',
        stage: null,
        error: `The AI model did not ask: ${(got.failure ?? 'it gave no answer').replace(/\.$/, '')}.`
      };
    }
    this._changed.emit();
  }

  /** What the reviewer reads: the code cells, what the rules found, and the notebook's context. */
  reviewBody(choice: string): Record<string, unknown> {
    const cells = this._cells().slice(-REVIEW_CELLS);
    const found = this.findings();
    return {
      model: choice,
      cells: cells.map(cell => ({
        id: cell.id,
        label: cell.label,
        title: cell.title,
        code: cell.source.slice(0, REVIEW_CODE_CHARS),
        outputs: cell.kinds,
        text: outputsText(cell)
      })),
      findings: [...found.reproduce, ...found.review, ...found.gaps].map(
        finding => finding.text
      ),
      context: this._model.serverContext()
    };
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._stop?.abort();
    this.times.changed.disconnect(this._onTimes, this);
    this._model.context.saveState?.disconnect(this._onSave, this);
    this.times.dispose();
    Signal.clearData(this);
  }

  /** The code cells as the rules read them, with the kinds and text of their outputs. */
  private _cells(): (ICheckupCell & { kinds: string[]; outputs: string[] })[] {
    return this._model.codeCells().map(cell => {
      const outputs = outputsOf(cell.model);
      return {
        id: cell.id,
        label: cell.label,
        title: cell.title,
        source: cell.model.sharedModel.getSource(),
        count: cell.count,
        analysis: cell.analysis,
        decisions: cell.decisions,
        branchOf: cell.branchOf,
        chosen: (cell.meta.user_values ?? []).map(value => value.name),
        question: cell.meta.question?.text ?? null,
        kinds: [...new Set(outputs.map(output => outputKind(output)))],
        outputs: outputs
          .map(output => {
            const read =
              output.type === 'error'
                ? null
                : outputText(output.data as Record<string, unknown>);
            return read ? read.lines.join('\n') : '';
          })
          .filter(text => text.trim() !== '')
      };
    });
  }

  /** The reviewer's questions as the server sends them, each with the id of its cell. */
  private _fromServer(questions: unknown): IReviewQuestion[] {
    const cells = this._model.codeCells();
    const kinds = new Set(QUESTION_TYPES.map(type => type.id));
    return (Array.isArray(questions) ? questions : [])
      .filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && typeof item.text === 'string'
      )
      .slice(0, 5)
      .map((item, index) => {
        const label = typeof item.cell === 'string' ? item.cell : null;
        return {
          id: typeof item.id === 'string' ? item.id : `review:${index}`,
          text: String(item.text),
          type: kinds.has(item.type as QuestionType)
            ? (item.type as QuestionType)
            : 'model',
          why: typeof item.why === 'string' ? item.why : '',
          cell: cells.find(cell => cell.label === label)?.id ?? null
        };
      });
  }

  /** The reviewer's questions as options of the view: a cell after the one each is about. */
  private _options(
    questions: IReviewQuestion[],
    by: IWrittenBy | null
  ): IOption[] {
    return questions.map(question => {
      const cell = question.cell ? this._model.cell(question.cell) : null;
      return {
        id: question.id,
        text: question.text,
        type: question.type,
        origin: isRemote(by?.choice) || !by ? 'claude' : 'local',
        ...(by ? { by } : {}),
        probability: null,
        reasons: question.why ? [question.why] : [],
        effect: question.why,
        placement: cell
          ? {
              kind: 'new',
              cell: cell.id,
              label: `new cell after ${cell.label}`
            }
          : null,
        code: null
      };
    });
  }

  /** The questions the notebook kept from the last call, if any. */
  private _keptReview(): IReviewState {
    const kept = checkupMeta(this._model.notebook).review;
    return {
      status: kept ? 'done' : 'idle',
      stage: null,
      started: null,
      questions: kept ? this._options(kept.questions, kept.by) : [],
      by: kept?.by ?? null,
      error: null
    };
  }

  /** The analyst looked: the day, what the rules found and the run times go into the notebook. */
  private _look(): void {
    const model = this._model;
    const found = this.findings();
    const times: ICheckupMeta['times'] = {};
    for (const [cellId, seconds] of this.seconds()) {
      const cell = model.cell(cellId);
      if (cell) {
        times[cellId] = {
          seconds: Math.round(seconds * 100) / 100,
          code: fingerprint(cell.model.sharedModel.getSource())
        };
      }
    }
    setCheckupMeta(model.notebook, {
      last: new Date(this._now()).toISOString(),
      found: [
        ...found.reproduce,
        ...found.speed,
        ...found.review,
        ...found.gaps
      ].map(finding => finding.text),
      times
    });
    this._saved = false;
    this._exported = false;
  }

  private _onTimes(): void {
    if (this._open) {
      this._changed.emit();
    }
  }

  private _onSave(sender: unknown, state: string): void {
    if (state === 'completed' && !this._saved) {
      this._saved = true;
      this._changed.emit();
    }
  }

  private _model: EpiModel;
  private _now: () => number;
  private _open = false;
  private _reveal = false;
  private _saved = false;
  private _exported = false;
  private _stop: AbortController | null = null;
  private _isDisposed = false;
  private _changed = new Signal<this, void>(this);
}

/** The check-up of each view model, made once and kept while the model lives. */
const checkups = new WeakMap<EpiModel, Checkup>();

/** The check-up of a view model: the plugin makes it when the view opens. */
export function checkupOf(model: EpiModel): Checkup {
  let checkup = checkups.get(model);
  if (!checkup || checkup.isDisposed) {
    checkup = new Checkup(model);
    checkups.set(model, checkup);
  }
  return checkup;
}

/** The check-up of a view model, if one was made. */
export function existingCheckup(model: EpiModel): Checkup | null {
  const checkup = checkups.get(model);
  return checkup && !checkup.isDisposed ? checkup : null;
}
