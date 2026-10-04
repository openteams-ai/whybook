/**
 * Another library for a cell that calls a known library: "Compare with
 * statsmodels" in the cell's menu (design iteration 1.68, C2, decided by
 * the owner). A small table maps a call to another
 * library, with the reason that the result can differ. A model writes a
 * branch of the cell with the other library, as it writes a what-if
 * branch, and the two results stand side by side.
 */
import type { IOption, IPlacement, QuestionType } from '../tokens';

export interface IAlternative {
  /** The function or the class, as the cell calls it: `LogisticRegression`. */
  call: string;
  /** Its library, as the question names it: `sklearn`. */
  library: string;
  /** The call in the cell's code. */
  pattern: RegExp;
  /** Text of the notebook that shows the call is of that library: an import. */
  imported: RegExp;
  /** The other library, as the menu names it: `statsmodels`. */
  other: string;
  /** The function of the other library that the branch calls: `Logit`. */
  use: string;
  /** Why the result can differ, in one sentence without its full stop. */
  why: string;
  /** The module that the kernel needs, as its listing of packages names it. */
  module: string;
  type: QuestionType;
}

const SKLEARN = (name: string) =>
  new RegExp(
    `\\bfrom\\s+sklearn[\\w.]*\\s+import\\b[^\\n]*\\b${name}\\b|\\bsklearn\\.[\\w.]*\\b${name}\\b|\\blinear_model\\.${name}\\b`
  );
const SCIPY = /\bscipy\b/;
const PINGOUIN = /\bpingouin\b/;
const PANDAS = /\bpandas\b/;
/** A call of a function or a class, and not its definition. */
const CALL = (name: string) => new RegExp(`(?<!\\bdef\\s+)\\b${name}\\s*\\(`);
/** A call of pingouin's function, which the notebook names through the module. */
const PG = (name: string) => new RegExp(`\\b(?:pg|pingouin)\\.${name}\\s*\\(`);

/**
 * The known alternatives. Regressions go from scikit-learn to statsmodels,
 * which fits with no penalty and gives intervals; tests go between
 * scipy.stats and pingouin, whose defaults and outputs differ.
 */
export const ALTERNATIVES: IAlternative[] = [
  {
    call: 'LogisticRegression',
    library: 'sklearn',
    pattern: CALL('LogisticRegression'),
    imported: SKLEARN('LogisticRegression'),
    other: 'statsmodels',
    use: 'Logit',
    why: 'Logit fits with no penalty and gives standard errors, where LogisticRegression applies an L2 penalty, C = 1.0, which shrinks the estimates',
    module: 'statsmodels',
    type: 'model'
  },
  {
    call: 'LinearRegression',
    library: 'sklearn',
    pattern: CALL('LinearRegression'),
    imported: SKLEARN('LinearRegression'),
    other: 'statsmodels',
    use: 'OLS',
    why: 'OLS gives the same estimates with the standard errors, intervals and p-values that LinearRegression does not give',
    module: 'statsmodels',
    type: 'model'
  },
  {
    call: 'ttest_ind',
    library: 'scipy.stats',
    pattern: CALL('ttest_ind'),
    imported: SCIPY,
    other: 'pingouin',
    use: 'ttest',
    why: "pingouin's ttest applies Welch's correction when the groups differ in size, and gives the effect size with its interval, where ttest_ind assumes equal variances by default",
    module: 'pingouin',
    type: 'model'
  },
  {
    call: 'ttest_rel',
    library: 'scipy.stats',
    pattern: CALL('ttest_rel'),
    imported: SCIPY,
    other: 'pingouin',
    use: 'ttest',
    why: "pingouin's ttest, paired, gives the effect size of the difference with its interval",
    module: 'pingouin',
    type: 'model'
  },
  {
    call: 'mannwhitneyu',
    library: 'scipy.stats',
    pattern: CALL('mannwhitneyu'),
    imported: SCIPY,
    other: 'pingouin',
    use: 'mwu',
    why: 'mwu gives the rank-biserial correlation, an effect size that mannwhitneyu does not give',
    module: 'pingouin',
    type: 'model'
  },
  {
    call: 'pearsonr',
    library: 'scipy.stats',
    pattern: CALL('pearsonr'),
    imported: SCIPY,
    other: 'pingouin',
    use: 'corr',
    why: "pingouin's corr gives the 95% interval of r and the power of the test",
    module: 'pingouin',
    type: 'association'
  },
  {
    call: 'spearmanr',
    library: 'scipy.stats',
    pattern: CALL('spearmanr'),
    imported: SCIPY,
    other: 'pingouin',
    use: 'corr',
    why: "pingouin's corr, with method='spearman', gives the 95% interval of the correlation",
    module: 'pingouin',
    type: 'association'
  },
  {
    call: 'f_oneway',
    library: 'scipy.stats',
    pattern: CALL('f_oneway'),
    imported: SCIPY,
    other: 'pingouin',
    use: 'welch_anova',
    why: 'welch_anova does not assume equal variances, where f_oneway does, and it gives the effect size',
    module: 'pingouin',
    type: 'model'
  },
  {
    call: 'chi2_contingency',
    library: 'scipy.stats',
    pattern: CALL('chi2_contingency'),
    imported: SCIPY,
    other: 'pingouin',
    use: 'chi2_independence',
    why: "chi2_independence gives Cramér's V, an effect size, with the test",
    module: 'pingouin',
    type: 'association'
  },
  {
    call: 'corr',
    library: 'pandas',
    // A frame's correlation matrix: a series' corr takes the other series.
    pattern: /\.corr\(\s*\)/,
    imported: PANDAS,
    other: 'pingouin',
    use: 'pairwise_corr',
    why: 'pairwise_corr gives a p-value and an interval for each pair, corrected for many tests, where corr gives the coefficients alone',
    module: 'pingouin',
    type: 'association'
  },
  {
    call: 'ttest',
    library: 'pingouin',
    pattern: PG('ttest'),
    imported: PINGOUIN,
    other: 'scipy.stats',
    use: 'ttest_ind',
    why: "ttest_ind is Student's test by default, which assumes equal variances, where pingouin applies Welch's correction when the groups differ in size",
    module: 'scipy',
    type: 'model'
  },
  {
    call: 'mwu',
    library: 'pingouin',
    pattern: PG('mwu'),
    imported: PINGOUIN,
    other: 'scipy.stats',
    use: 'mannwhitneyu',
    why: 'mannwhitneyu computes the p-value in its own way, and treats ties in its own way',
    module: 'scipy',
    type: 'model'
  }
];

/** What a cell can compare with another library: one entry for each other library. */
export interface ICellAlternative {
  /** The other library: `statsmodels`. */
  other: string;
  /** The library of the cell's calls: `sklearn`. */
  library: string;
  /** The alternatives of the cell's calls that this library answers. */
  alternatives: IAlternative[];
  /** The kernel lacks the other library. */
  missing: boolean;
}

/**
 * What a cell can compare with another library, from its code: one entry
 * for each other library, at most two. `notebook` is the code of every
 * cell, where the imports are; `packages` is the kernel's listing, or null
 * before it lists any.
 */
export function cellAlternatives(
  source: string,
  notebook: string,
  packages: Record<string, string | null> | null
): ICellAlternative[] {
  const found: ICellAlternative[] = [];
  for (const alternative of ALTERNATIVES) {
    if (
      !alternative.pattern.test(source) ||
      !alternative.imported.test(notebook)
    ) {
      continue;
    }
    const same = found.find(
      entry =>
        entry.other === alternative.other &&
        entry.library === alternative.library
    );
    if (same) {
      same.alternatives.push(alternative);
      continue;
    }
    found.push({
      other: alternative.other,
      library: alternative.library,
      alternatives: [alternative],
      missing: packages !== null && !(alternative.module in packages)
    });
  }
  return found.slice(0, 2);
}

/**
 * The words of the cell's menu for an entry: "Compare with statsmodels",
 * and "Compare with pingouin, not in this kernel" for a library that the
 * kernel lacks.
 */
export function compareLabel(entry: ICellAlternative): string {
  // A menu shows no tooltip: the item says why it is greyed.
  return entry.missing
    ? `Compare with ${entry.other}, not in this kernel`
    : `Compare with ${entry.other}`;
}

/** A list of names: "a", "a and b", "a, b and c". */
function listed(parts: string[]): string {
  return parts.length < 2
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Why the result can differ, for the item's caption and the question's effect. */
export function compareWhy(entry: ICellAlternative): string {
  return entry.alternatives.map(alternative => alternative.why).join('. ');
}

/**
 * The question of an entry, as a branch of the cell that a model writes. It
 * names the functions, so that the branch calls the right one: "Does Logit
 * of statsmodels agree with LogisticRegression of sklearn?". Its effect
 * says why the result can differ.
 */
export function compareOption(
  entry: ICellAlternative,
  cell: { id: string; label: string }
): IOption {
  const placement: IPlacement = {
    kind: 'branch',
    cell: cell.id,
    label: `branch of ${cell.label}`
  };
  const uses = [...new Set(entry.alternatives.map(item => item.use))];
  const calls = [...new Set(entry.alternatives.map(item => item.call))];
  const verb = uses.length > 1 ? 'Do' : 'Does';
  const effect = compareWhy(entry);
  return {
    id: `library:${cell.id}:${entry.library}:${entry.other}`,
    text: `${verb} ${listed(uses)} of ${entry.other} agree with ${listed(calls)} of ${entry.library}?`,
    type: entry.alternatives[0].type,
    origin: 'library',
    probability: null,
    reasons: [effect],
    effect,
    placement,
    code: null
  };
}
