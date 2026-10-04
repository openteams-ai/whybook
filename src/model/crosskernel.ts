import { PathExt } from '@jupyterlab/coreutils';

import { numbersIn } from './claims';
import { languageOf } from './languages';

/**
 * An agent that works in another notebook (design iteration 1.69): "Would I
 * get the same results in R?" makes a notebook beside the first with another
 * kernel, runs the analysis there, and brings back a comparison of the
 * estimates. This module holds what needs no view: the kernels that the
 * question is offered for, the defaults that differ between Python, R and
 * SAS, and the comparison, checked against the outputs of both notebooks.
 */

/** A kernelspec as the server lists it (`/api/kernelspecs`). */
export interface IKernelSpecLike {
  name: string;
  display_name: string;
  language: string;
  argv?: readonly string[];
  metadata?: { [key: string]: unknown } | null;
}

/** A kernel of the server, as the question and the agent's prompt name it. */
export interface IKernelChoice {
  /** The kernelspec's name, such as xr. */
  name: string;
  /** Its name in JupyterLab, such as "R 4.4.3 (xr)". */
  displayName: string;
  /** The kernelspec's language: python, R, sas. */
  language: string;
  /** The language's name in the view's messages: Python, R, SAS. */
  label: string;
  /** It runs in Whybook's sandbox (design iteration 1.46). */
  sandboxed: boolean;
  /** The program that the kernelspec starts: kernels that share it are one interpreter. */
  program: string;
}

/** The provisioner of Whybook's sandbox, in a kernelspec's metadata. */
const SANDBOX = 'whybook-sandbox';

/** The language's name in the view's messages: python gives Python. */
export function languageLabel(language: string): string {
  const known = languageOf(language)?.label;
  if (known) {
    return known;
  }
  return language ? language.charAt(0).toUpperCase() + language.slice(1) : '';
}

/** The kernels of the server, in the order it lists them. */
export function kernelChoices(
  specs: Record<string, IKernelSpecLike | undefined> | null | undefined
): IKernelChoice[] {
  const choices: IKernelChoice[] = [];
  for (const spec of Object.values(specs ?? {})) {
    if (!spec?.name) {
      continue;
    }
    const argv = spec.argv ?? [];
    const provisioner = (
      spec.metadata?.kernel_provisioner as
        { provisioner_name?: unknown } | undefined
    )?.provisioner_name;
    choices.push({
      name: spec.name,
      displayName: spec.display_name || spec.name,
      language: spec.language ?? '',
      label: languageLabel(spec.language ?? ''),
      sandboxed: provisioner === SANDBOX,
      program: argv[0] ?? spec.name
    });
  }
  return choices;
}

/** "Would I get the same results in R?", with the kernel that would answer it. */
export interface ICrossQuestion {
  /** The id of the question: one per kernel. */
  id: string;
  text: string;
  kernel: IKernelChoice;
  /** Another language, or another version of the same language. */
  kind: 'language' | 'version';
}

/**
 * The questions "Would I get the same results in <language>?" of a notebook
 * whose kernel is `current`: one for each language of the server's kernels
 * other than the notebook's, and one for each other interpreter of the
 * notebook's language, such as a newer Python. A copy of the notebook's own
 * interpreter, such as its sandboxed twin, is never offered. Of the kernels of one interpreter, the one in
 * the sandbox answers for a sandboxed notebook, and the other one otherwise.
 */
export function crossQuestions(
  current: string | null,
  choices: IKernelChoice[]
): ICrossQuestion[] {
  const own = choices.find(choice => choice.name === current) ?? null;
  const lower = (text: string) => text.toLowerCase();
  const groups = new Map<string, IKernelChoice[]>();
  for (const choice of choices) {
    if (choice.name === current) {
      continue;
    }
    if (
      own &&
      lower(own.language) === lower(choice.language) &&
      own.program === choice.program
    ) {
      continue;
    }
    const key = `${lower(choice.language)}\u0000${choice.program}`;
    groups.set(key, [...(groups.get(key) ?? []), choice]);
  }
  const sandboxed = own?.sandboxed ?? false;
  const picked = [...groups.values()].map(
    group => group.find(choice => choice.sandboxed === sandboxed) ?? group[0]
  );
  // A language with two interpreters names each by its kernel.
  const perLanguage = new Map<string, number>();
  for (const choice of picked) {
    const key = lower(choice.language);
    perLanguage.set(key, (perLanguage.get(key) ?? 0) + 1);
  }
  const questions = picked.map((choice): ICrossQuestion => {
    const sameLanguage =
      !!own && lower(own.language) === lower(choice.language);
    const named =
      sameLanguage || (perLanguage.get(lower(choice.language)) ?? 0) > 1;
    return {
      id: `crosskernel:${choice.name}`,
      text: `Would I get the same results in ${named ? choice.displayName : choice.label}?`,
      kernel: choice,
      kind: sameLanguage ? 'version' : 'language'
    };
  });
  return questions.sort(
    (a, b) =>
      Number(a.kind === 'version') - Number(b.kind === 'version') ||
      a.text.localeCompare(b.text)
  );
}

/**
 * The kernels that the menu of the kernel's name lists (design iteration
 * 1.68, B1): the notebook's own first, then at most `count` others to switch
 * to. The kernels used most recently
 * come first, then the other environments of the notebook's language, then
 * the rest by name.
 */
export function menuKernels(
  current: string | null,
  choices: IKernelChoice[],
  recent: string[],
  count = 3
): IKernelChoice[] {
  const own = choices.find(choice => choice.name === current);
  const language = own?.language.toLowerCase() ?? null;
  const sandboxed = own?.sandboxed ?? false;
  const rank = (choice: IKernelChoice) => {
    const used = recent.indexOf(choice.name);
    return used >= 0 ? used : Number.MAX_SAFE_INTEGER;
  };
  // Then a kernel in the sandbox, or out of it, as the notebook's is.
  const others = choices
    .filter(choice => choice.name !== current)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(b.language.toLowerCase() === language) -
          Number(a.language.toLowerCase() === language) ||
        Number(b.sandboxed === sandboxed) - Number(a.sandboxed === sandboxed) ||
        a.displayName.localeCompare(b.displayName)
    )
    .slice(0, count);
  return own ? [own, ...others] : others;
}

/** The kernels used most recently, the newest first, with this one added. */
export function withRecent(
  recent: string[],
  name: string,
  keep = 10
): string[] {
  return [name, ...recent.filter(item => item !== name)].slice(0, keep);
}

/** The kernels as the agent's prompt lists them. */
export function promptKernels(
  choices: IKernelChoice[],
  current: string | null
): Record<string, unknown>[] {
  return choices.map(choice => ({
    name: choice.name,
    display_name: choice.displayName,
    language: choice.language,
    sandboxed: choice.sandboxed,
    ...(choice.name === current ? { current: true } : {})
  }));
}

/**
 * Where the notebook that the agent asks for goes: beside the first, with a
 * name that ends in .ipynb, or why not.
 */
export function newNotebookPath(
  first: string,
  requested: string
): { path: string } | { error: string } {
  const name = requested.trim();
  if (!name.endsWith('.ipynb') || name === '.ipynb') {
    return { error: 'the name must end in .ipynb' };
  }
  if (/[\\/]/.test(name) || name.startsWith('.')) {
    return {
      error: "the notebook goes beside the analyst's: give a file name alone"
    };
  }
  const path = PathExt.join(PathExt.dirname(first), name);
  if (path === first) {
    return { error: "that is the analyst's notebook: choose another name" };
  }
  return { path };
}

/** The folder of the files that a kernel of this language writes: from_python/. */
export function framesFolder(label: string): string {
  return `from_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'kernel'}`;
}

/**
 * The first cell of the notebook that the agent makes: its title, and which
 * question it answers, about which notebook, with which kernel. The view
 * writes it, not the model.
 */
export function introText(options: {
  title: string;
  question: string;
  first: string;
  kernel: IKernelChoice;
}): string {
  const { title, question, first, kernel } = options;
  return [
    `# ${title}, in ${kernel.label}`,
    '',
    `Whybook's agent made this notebook for the question "${question}", asked in ${PathExt.basename(first)}. The cells after this one are the agent's, and ${kernel.displayName} runs them.`
  ].join('\n');
}

/** What a kernel has, as its kernel_facts program says, for the agent. */
export interface IKernelFacts {
  /** The language and its version: "R 4.4.3", "Python 3.12.13". */
  language: string | null;
  parquet: boolean;
  /** The packages installed: "pandas 3.0.6" in Python, "stats" in R. */
  packages: string[];
}

/** The facts of kernel_facts.py or kernel_facts.R, in one form. */
export function kernelFacts(value: unknown): IKernelFacts {
  const facts = (value ?? {}) as {
    language?: unknown;
    parquet?: unknown;
    packages?: unknown;
  };
  const packages = Array.isArray(facts.packages)
    ? facts.packages.map(String)
    : facts.packages && typeof facts.packages === 'object'
      ? Object.entries(facts.packages as Record<string, unknown>).map(
          ([name, version]) =>
            typeof version === 'string' ? `${name} ${version}` : name
        )
      : [];
  return {
    language: typeof facts.language === 'string' ? facts.language : null,
    parquet: facts.parquet === true,
    packages: packages.slice(0, 300)
  };
}

/** A language of the table of defaults. */
export type DefaultsLanguage = 'python' | 'r' | 'sas';

/** A default that differs between Python, R and SAS: a row of 1.69's table. */
export interface ILanguageDefault {
  id: string;
  /** What the default is about. */
  topic: string;
  python: string;
  r: string;
  sas: string;
  /** The pairs of languages whose defaults agree. */
  same: [DefaultsLanguage, DefaultsLanguage][];
  /** Code that makes the default matter, in any of the three languages. */
  calls: RegExp;
}

/**
 * The defaults that differ between the languages, as design iteration 1.69
 * keeps them. The rows on numpy, pandas, patsy, scikit-learn, statsmodels
 * and base R were checked with those packages; those on lme4, lmerTest,
 * car, MASS, ordinal and SAS come from their documentation.
 */
export const LANGUAGE_DEFAULTS: ILanguageDefault[] = [
  {
    id: 'reference-level',
    topic: 'The reference level of a factor',
    python:
      'The first level: patsy sorts the levels, and keeps a pandas category\'s order. Its sort puts "B" before "a".',
    r: 'The first level of the factor, sorted in the locale\'s order: in an English locale, "a" before "B".',
    sas: 'The last level, in PROC GLM and PROC MIXED: the estimate of a factor with two levels changes its sign.',
    same: [],
    calls:
      /~|\bC\(|factor\(|relevel\(|Categorical|category|\bCLASS\b|PROC\s+(GLM|MIXED|GENMOD|LOGISTIC|GLIMMIX)/i
  },
  {
    id: 'sums-of-squares',
    topic: 'Sums of squares',
    python: "Type I in statsmodels' anova_lm, by default.",
    r: "Type I in anova(); type II in car's Anova().",
    sas: 'Types I and III in PROC GLM; type 3 tests in PROC MIXED.',
    same: [['python', 'r']],
    calls: /anova_lm|\banova\(|\bAnova\(|PROC\s+(GLM|ANOVA|MIXED)/i
  },
  {
    id: 'mixed-df',
    topic: 'The degrees of freedom of a mixed model',
    python: "None: statsmodels' MixedLM gives z tests.",
    r: "lme4 gives no p-value; lmerTest gives Satterthwaite's, and Kenward and Roger's on request.",
    sas: "The containment method by default when the model has a RANDOM statement; Satterthwaite's or Kenward and Roger's on request.",
    same: [],
    calls: /mixedlm|MixedLM|\blmer\(|\bglmer\(|\blme\(|PROC\s+(MIXED|GLIMMIX)/i
  },
  {
    id: 'random-covariance',
    topic: 'The covariance of random effects',
    python:
      'Estimated: MixedLM with a random slope (re_formula) estimates both variances and their covariance.',
    r: "Estimated: lme4's (month | patient_id) does the same.",
    sas: "Left out by default: the RANDOM statement's TYPE=VC; TYPE=UN estimates it.",
    same: [['python', 'r']],
    calls: /re_formula|\(\s*[\w.]+\s*\|\s*[\w.]+\s*\)|\bRANDOM\b/i
  },
  {
    id: 'percentile',
    topic: 'A percentile',
    python:
      "Linear between the ordered values, Hyndman and Fan's type 7, in numpy and pandas.",
    r: 'Type 7 in quantile(), and the eight others on request.',
    sas: "PCTLDEF=5 in PROC UNIVARIATE: the average at a jump of the empirical distribution, Hyndman and Fan's type 2.",
    same: [['python', 'r']],
    calls: /quantile|percentile|PCTLDEF|PROC\s+UNIVARIATE|bootstrap/i
  },
  {
    id: 'logistic-level',
    topic: 'The level that a logistic model predicts',
    python:
      "y = 1 in statsmodels' Logit; the second of the sorted classes in scikit-learn.",
    r: 'The second level of a factor in glm(), since the first counts as failure.',
    sas: "The lower value by default in PROC LOGISTIC, y = 0 for 0 and 1, unless DESCENDING or EVENT='1'.",
    same: [['python', 'r']],
    calls: /Logit|\blogit\(|LogisticRegression|binomial|PROC\s+LOGISTIC/i
  },
  {
    id: 'ordinal-sign',
    topic: 'The sign of an ordinal model',
    python: "statsmodels' OrderedModel: logit P(Y ≤ j) = cut_j - xβ.",
    r: "MASS's polr and ordinal's clm: the same.",
    sas: 'PROC LOGISTIC: logit P(Y ≤ j) = α_j + xβ, the opposite sign.',
    same: [['python', 'r']],
    calls: /OrderedModel|\bpolr\(|\bclm\(|PROC\s+LOGISTIC/i
  },
  {
    id: 'standard-deviation',
    topic: 'A standard deviation',
    python: 'numpy.std divides by n, pandas by n - 1.',
    r: 'sd() divides by n - 1.',
    sas: 'n - 1 by default (VARDEF=DF).',
    same: [['r', 'sas']],
    calls: /\bnp\.std\(|\bnumpy\.std\(|ddof\s*=/i
  },
  {
    id: 'random-draws',
    topic: 'Random draws',
    python:
      "numpy's generator. The same seed draws other samples in each language, so a bootstrap agrees only to its Monte Carlo error.",
    r: "R's own generator, seeded by set.seed.",
    sas: 'Its own generator, seeded by CALL STREAMINIT.',
    same: [],
    calls:
      // Not SAS's RANDOM statement, which names random effects.
      /\brandom\.|random_state|\bseed\b|\bsample\(|bootstrap|n_boot|resample|default_rng|set\.seed|STREAMINIT|\bRAND\(|SURVEYSELECT/i
  }
];

/** A language of the table, from a kernel's language: null for another one. */
export function defaultsLanguage(language: string): DefaultsLanguage | null {
  const lower = language.trim().toLowerCase();
  return lower === 'python' || lower === 'r' || lower === 'sas' ? lower : null;
}

/**
 * The defaults that differ between two languages, for the code of the cells
 * compared: the rows of the table whose defaults are not the same in both,
 * and whose calls the code makes. Two versions of one language share every
 * default.
 */
export function defaultsThatDiffer(
  first: string,
  second: string,
  code: string[]
): ILanguageDefault[] {
  const a = defaultsLanguage(first);
  const b = defaultsLanguage(second);
  if (!a || !b || a === b) {
    return [];
  }
  const text = code.join('\n');
  return LANGUAGE_DEFAULTS.filter(
    row =>
      !row.same.some(
        ([x, y]) => (x === a && y === b) || (x === b && y === a)
      ) && row.calls.test(text)
  );
}

/** One side of an estimate: the cell whose output prints it, and the number. */
export interface IComparedValue {
  /** The cell's label as the agent named it, such as [4]. */
  cell: string;
  /** The number as the agent cited it, or null when that side has no result. */
  text: string | null;
  value: number | null;
  /**
   * Whether the output of that cell prints the number, to the digits cited:
   * null for a side without a result.
   */
  found: boolean | null;
}

export interface IComparisonRow {
  estimate: string;
  first: IComparedValue;
  second: IComparedValue;
  /** The second value less the first, when both have one. */
  difference: number | null;
  note: string | null;
}

/** A notebook of the comparison. */
export interface IComparedNotebook {
  /** Its path from the server's root. */
  path: string;
  /** Its kernel's name in the view, such as "R 4.4.3 (xr)". */
  kernel: string;
  /** The kernel's language: python, R, sas. */
  language: string;
  /** Whether any of its code cells has an output: a notebook saved without them has no results. */
  results: boolean;
}

/** The comparison that a run brings back to the first notebook. */
export interface IComparison {
  first: IComparedNotebook;
  second: IComparedNotebook;
  rows: IComparisonRow[];
  /** The defaults that differ between the two languages, for the cells compared. */
  defaults: ILanguageDefault[];
  /** The packages that the comparison needed and the second kernel lacks. */
  missing: string[];
}

/** A cell of a notebook, as the comparison reads it. */
export interface IComparedCell {
  label: string;
  code: string;
  /** The text of its outputs, errors included. */
  outputs: string;
}

/** The comparison of finish, as the server passes it on. */
export interface IRawComparison {
  rows?: {
    estimate?: unknown;
    first?: { cell?: unknown; value?: unknown };
    second?: { cell?: unknown; value?: unknown };
    note?: unknown;
  }[];
  missing?: unknown;
}

/** Whether a number printed in an output is the number cited, to its digits, with its sign. */
function printedAs(cited: number, digits: number, shown: number): boolean {
  if (cited === 0) {
    return Math.abs(shown) < 0.5 * 10 ** -Math.max(0, digits - 1);
  }
  const rounded = Number(shown.toPrecision(digits));
  return (
    Math.abs(rounded - cited) <=
    1e-9 * Math.max(1, Math.abs(rounded), Math.abs(cited))
  );
}

/**
 * The label of a cell that a row cites, as the view writes it: "2", "[2"
 * and "[2]" are [2], and so are "R [2]" and "Python [2]", the form that the
 * prompt asks for in the answer for a cell of the notebook that the run
 * made. "[ ]" stays the label of a cell that has not run.
 */
function citedLabel(cited: unknown): string {
  const named = String(cited ?? '').trim();
  if (!named) {
    return '';
  }
  const bracketed = named.match(/\[([^[\]]*)\]\s*$/);
  const inner = bracketed
    ? bracketed[1]
    : (named.split(/\s+/).pop() ?? '').replace(/^\[|\]$/g, '');
  return inner.trim() ? `[${inner.trim()}]` : '[ ]';
}

/** One side of an estimate, checked against the outputs of the cell it names. */
function side(
  raw: { cell?: unknown; value?: unknown } | undefined,
  cells: IComparedCell[]
): IComparedValue {
  const cell = citedLabel(raw?.cell);
  const text = String(raw?.value ?? '').trim();
  const [number] = numbersIn(text);
  if (!number) {
    return { cell, text: null, value: null, found: null };
  }
  const found = cells.find(item => item.label === cell);
  const shown = found ? numbersIn(found.outputs) : [];
  return {
    cell,
    text: number.text,
    value: number.value,
    found: shown.some(item =>
      printedAs(number.value, number.digits, item.value)
    )
  };
}

/**
 * The comparison of a run: each estimate that the agent cites, checked
 * against the outputs of the cell it names in each notebook, with the
 * difference that the view computes; the defaults that differ between the
 * two languages, for the code of the cells compared; and the packages that
 * the second kernel lacks. The model names the numbers, and the view checks
 * them: a number that the named output does not print is marked.
 */
export function buildComparison(options: {
  raw: IRawComparison | null | undefined;
  first: IComparedNotebook;
  second: IComparedNotebook;
  firstCells: IComparedCell[];
  secondCells: IComparedCell[];
}): IComparison {
  const { raw, first, second, firstCells, secondCells } = options;
  const rows: IComparisonRow[] = [];
  for (const item of raw?.rows ?? []) {
    if (typeof item?.estimate !== 'string') {
      continue;
    }
    const a = side(item.first, firstCells);
    const b = side(item.second, secondCells);
    rows.push({
      estimate: item.estimate,
      first: a,
      second: b,
      difference:
        a.value !== null && b.value !== null ? b.value - a.value : null,
      note: typeof item.note === 'string' && item.note ? item.note : null
    });
  }
  // The code of the cells compared, in both notebooks: every cell of the
  // second, and the cells of the first that a row names, or all of them.
  const named = new Set(rows.map(row => row.first.cell));
  const firstCode = firstCells
    .filter(cell => !rows.length || named.has(cell.label))
    .map(cell => cell.code);
  const code = [...firstCode, ...secondCells.map(cell => cell.code)];
  const missing = Array.isArray(raw?.missing)
    ? raw.missing.filter((name): name is string => typeof name === 'string')
    : [];
  return {
    first,
    second,
    rows,
    defaults: defaultsThatDiffer(first.language, second.language, code),
    missing
  };
}

/** A difference as the comparison writes it: 0 when the two agree, else three significant digits. */
export function differenceText(row: IComparisonRow): string {
  if (row.difference === null) {
    return '';
  }
  const a = row.first.value ?? 0;
  const b = row.second.value ?? 0;
  if (
    Math.abs(row.difference) <=
    1e-12 * Math.max(1, Math.abs(a), Math.abs(b))
  ) {
    return '0';
  }
  const text = Number(row.difference.toPrecision(3)).toString();
  return row.difference > 0 ? `+${text}` : text.replace('-', '−');
}

/**
 * A side of an estimate in the comparison's table: the number and its cell,
 * or that it has none, with the note that says why.
 */
function sideText(
  value: IComparedValue,
  notebook: IComparedNotebook,
  prefix: string,
  note: string | null
): string {
  if (value.text === null) {
    const why = !notebook.results ? 'no outputs saved' : note;
    return why ? `no result: ${why}` : 'no result';
  }
  const cell = value.cell ? ` (${prefix}${value.cell})` : '';
  const shown = value.text.replace(/^-/, '−');
  return value.found
    ? `${shown}${cell}`
    : `${shown}${cell}, not found in that output`;
}

/** Text safe inside a cell of a markdown table. */
function cellText(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * The text cell that a run writes into the first notebook: the estimates
 * side by side with their difference, the defaults that differ, what the
 * second kernel lacks, and the agent's answer.
 */
export function comparisonMarkdown(options: {
  question: string;
  comparison: IComparison;
  answer: string | null;
  /** The cells that the run ran in the second notebook. */
  ran: number;
}): string {
  const { question, comparison, answer, ran } = options;
  const { first, second } = comparison;
  const firstLabel = languageLabel(first.language);
  const secondLabel = languageLabel(second.language);
  const secondName = PathExt.basename(second.path);
  // The second notebook's cells are named with its language, as R [2].
  const prefix =
    firstLabel === secondLabel ? `${secondName} ` : `${secondLabel} `;
  const lines = [
    `## ${question}`,
    '',
    `Whybook's agent ran ${ran === 1 ? '1 cell' : `${ran} cells`} in [${secondName}](${encodeURI(secondName)}), with ${second.kernel}. It cites each estimate from the output of a cell of each notebook, and Whybook checked that the output prints it.`
  ];
  if (!first.results) {
    lines.push(
      '',
      `${PathExt.basename(first.path)} saved no outputs: its side has no results to compare.`
    );
  }
  if (!second.results) {
    lines.push(
      '',
      `${secondName} has no outputs: its side has no results to compare.`
    );
  }
  if (comparison.rows.length) {
    // Two versions of one language are named by their kernels.
    const same = firstLabel === secondLabel;
    const heads = same
      ? [first.kernel, second.kernel]
      : [firstLabel, secondLabel];
    lines.push(
      '',
      `| Estimate | ${cellText(heads[0])} | ${cellText(heads[1])} | Difference |`,
      '| --- | --- | --- | --- |',
      ...comparison.rows.map(row => {
        // A note says why a side has no result, or else why the two differ.
        const missing = row.first.text === null || row.second.text === null;
        const difference = differenceText(row);
        const note = row.note && !missing ? ` (${row.note})` : '';
        return `| ${cellText(row.estimate)} | ${cellText(sideText(row.first, first, '', row.note))} | ${cellText(sideText(row.second, second, prefix, row.note))} | ${cellText(difference + note)} |`;
      })
    );
  }
  if (comparison.defaults.length) {
    lines.push(
      '',
      `**Defaults that differ between ${firstLabel} and ${secondLabel}, for the calls of these cells**`,
      ''
    );
    const of = (language: string) =>
      (defaultsLanguage(language) ?? 'python') as DefaultsLanguage;
    for (const row of comparison.defaults) {
      lines.push(
        `- **${row.topic}.** ${firstLabel}: ${row[of(first.language)]} ${secondLabel}: ${row[of(second.language)]}`
      );
    }
  }
  if (comparison.missing.length) {
    lines.push(
      '',
      `**Missing in ${second.kernel}:** ${comparison.missing.join(', ')}. The agent installs no package.`
    );
  }
  if (answer) {
    lines.push('', `**The agent's answer.** ${answer}`);
  }
  return lines.join('\n');
}
