/**
 * The check-up of a notebook, a prototype of design iterations 1.67 to
 * 1.70 (src/model/checkup.ts): the rules of each group, the note of the
 * folded section, the run times from the kernel's messages
 * (src/model/runtimes.ts), and the table of other libraries
 * (src/model/libraries.ts). No kernel starts and no model is called.
 */
import './fakes/quiet';

import { NotebookModel } from '@jupyterlab/notebook';
import { Signal } from '@lumino/signaling';

import type { ICheckupCell } from '../model/checkup';
import {
  Checkup,
  checkupFindings,
  checkupMeta,
  checkupNote,
  checkupQuestions,
  fitsInLoop,
  gapFindings,
  otherLanguage,
  parameterNames,
  pythonsDiffer,
  reproduceFindings,
  reviewFindings,
  runSeconds,
  speedFindings,
  unseeded
} from '../model/checkup';
import {
  cellAlternatives,
  compareLabel,
  compareOption,
  compareWhy
} from '../model/libraries';
import { storedAnalysis } from '../model/restore';
import { RunTimes, recordedSeconds } from '../model/runtimes';
import type { IDecision } from '../tokens';
import { benchModel } from './fakes/bench-fake';

/** A code cell as the rules read it. */
function cell(
  id: string,
  count: number | null,
  source: string,
  analysis: {
    defs?: string[];
    uses?: string[];
    formulas?: string[];
  } | null = {},
  extra: Partial<ICheckupCell> = {}
): ICheckupCell {
  return {
    id,
    label: count === null ? '[ ]' : `[${count}]`,
    title: `Cell ${id}`,
    source,
    count,
    analysis: analysis
      ? {
          defs: analysis.defs ?? [],
          uses: analysis.uses ?? [],
          formulas: analysis.formulas ?? []
        }
      : null,
    decisions: [],
    branchOf: null,
    chosen: [],
    question: null,
    ...extra
  };
}

const never = () => null;

describe('Does it run from the top?', () => {
  it('names a cell that uses what only a cell below it makes', () => {
    const { findings } = reproduceFindings(
      [
        cell('a', 1, 'weekly.head()', { uses: ['weekly'] }),
        cell('b', 2, 'weekly = diary.copy()', {
          defs: ['weekly'],
          uses: ['diary']
        }),
        cell('c', 3, 'diary = load()', { defs: ['diary'] })
      ],
      never
    );
    expect(findings.map(finding => finding.text)).toEqual([
      '[1] uses weekly, which only [2] makes, below it.',
      '[2] uses diary, which only [3] makes, below it.'
    ]);
    expect(findings[0].cellId).toBe('a');
  });

  it('names a cell that uses what no cell makes', () => {
    const { findings } = reproduceFindings(
      [cell('a', 1, 'old_df.describe()', { uses: ['old_df'] })],
      never
    );
    expect(findings.map(finding => finding.text)).toEqual([
      '[1] uses old_df, which no cell makes: the kernel keeps it from code that is gone.'
    ]);
  });

  it('says nothing of a name that no cell makes when a star import or %run can make it', () => {
    for (const maker of [
      'from pylab import *',
      '%run setup.py',
      'exec(open("setup.py").read())'
    ]) {
      const { findings } = reproduceFindings(
        [
          cell('a', 1, maker, { defs: [] }),
          cell('b', 2, 'np.mean(x)', { uses: ['np', 'x'] })
        ],
        never
      );
      expect(findings).toEqual([]);
    }
  });

  it("leaves out IPython's names, private names and the parameters of the cell's lambdas and functions", () => {
    const source =
      'df = data.assign(month=lambda d: d["week"] / 4)\ndef scale(x, factor=2):\n    return x * factor\nIn[1]';
    expect([...parameterNames(source)].sort()).toEqual(['d', 'factor', 'x']);
    const { findings, note } = reproduceFindings(
      [
        cell('a', 1, source, {
          defs: ['df', 'scale'],
          uses: ['data', 'd', 'x', 'factor', 'In', '_temp']
        }),
        cell('b', 2, 'data = 1\nd = 2\nx = 3', { defs: ['data', 'd', 'x'] })
      ],
      never
    );
    expect(findings.map(finding => finding.text)).toEqual([
      '[1] uses data, which only [2] makes, below it.'
    ]);
    expect(note).toBeNull();
  });

  it('names a cell that ran after cells below it, and leaves branches out', () => {
    const { findings } = reproduceFindings(
      [
        cell('a', 5, 'a = 1', { defs: ['a'] }),
        cell('b', 2, 'b = 1', { defs: ['b'] }),
        cell('b2', 9, 'b2 = 1', { defs: ['b2'] }, { branchOf: 'b' }),
        cell('c', 3, 'c = 1', { defs: ['c'] })
      ],
      never
    );
    expect(findings.map(finding => finding.text)).toEqual([
      '[5] ran after [2] and [3], which are below it.'
    ]);
  });

  it('counts the cells past three in one line', () => {
    const cells = [8, 1, 7, 2, 6, 3, 5, 4].map((count, index) =>
      cell(`c${index}`, count, `x${index} = 1`, { defs: [`x${index}`] })
    );
    const { findings } = reproduceFindings(cells, never);
    expect(findings.map(finding => finding.text)).toEqual([
      '[8] ran after 7 cells below it, such as [1].',
      '[7] ran after 5 cells below it, such as [2].',
      '[6] ran after 3 cells below it, such as [3].',
      '1 more cell ran after cells below it.'
    ]);
    expect(findings[3].cellId).toBeNull();
  });

  it('names a cell whose code changed after the run that the view saw', () => {
    const { findings } = reproduceFindings(
      [cell('a', 4, 'fit = model(data, alpha=0.1)', { defs: ['fit'] })],
      count => (count === 4 ? 'fit = model(data)' : null)
    );
    expect(findings.map(finding => finding.text)).toEqual([
      '[4] changed after it ran: its outputs come from older code.'
    ]);
  });

  it('names a cell that has not run, once another cell has', () => {
    const cells = [
      cell('a', 1, 'a = 1', { defs: ['a'] }),
      cell('b', null, 'b = a + 1', { defs: ['b'] }),
      cell('c', null, '   ', null)
    ];
    expect(
      reproduceFindings(cells, never).findings.map(finding => finding.text)
    ).toEqual([
      '“Cell b” has not run: a run from the top runs it for the first time.'
    ]);
    const fresh = cells.map(item => ({ ...item, count: null, label: '[ ]' }));
    expect(reproduceFindings(fresh, never).findings).toEqual([]);
  });

  it('says what it checked when it found nothing, and why it cannot tell without the analysis', () => {
    expect(
      reproduceFindings(
        [
          cell('a', 1, 'a = 1', { defs: ['a'] }),
          cell('b', 2, 'b = a', { defs: ['b'], uses: ['a'] })
        ],
        never
      ).note
    ).toBe(
      'Each cell uses only names that cells above it make, and the cells ran in the order they stand.'
    );
    expect(reproduceFindings([cell('a', 1, 'a = 1', null)], never)).toEqual({
      findings: [],
      note: 'The kernel has not read the cells yet. Run them, and the check-up reads the names that each cell uses.'
    });
    // The counts need no analysis.
    expect(
      reproduceFindings(
        [cell('a', 2, 'a = 1', null), cell('b', 1, 'b = 1', null)],
        never
      ).findings.map(finding => finding.text)
    ).toEqual(['[2] ran after [1], which is below it.']);
  });
});

describe('What makes it slow?', () => {
  const ORDINAL =
    'estimates = []\nfor i in range(40):\n    sample = data.sample(frac=1, replace=True, random_state=i)\n    fit = OrderedModel.from_formula("y ~ x", sample).fit(disp=False)\n    estimates.append(fit.params["x"])\nestimates';

  it('finds a model fitted in a loop, and how many times', () => {
    expect(fitsInLoop(ORDINAL)).toEqual({ times: 40 });
    expect(fitsInLoop('for name in names:\n    model.fit(X, y)')).toEqual({
      times: null
    });
    expect(fitsInLoop('fit = smf.ols("y ~ x", df).fit()')).toBeNull();
    expect(fitsInLoop('for i in range(3):\n    print(i)\nfit(1)')).toBeNull();
  });

  it('gives the total of the last runs, the slowest cell with its share, and the next one', () => {
    const cells = [
      cell('load', 1, 'data = load()'),
      cell(
        'lmm',
        2,
        'fit = smf.mixedlm("y ~ x", data).fit()',
        {},
        {
          title: 'Mixed model'
        }
      ),
      cell('ord', 3, ORDINAL, {}, { label: '[2b]', title: 'Ordinal model' })
    ];
    const seconds = new Map([
      ['load', 1],
      ['lmm', 2],
      ['ord', 8]
    ]);
    const { findings } = speedFindings(cells, seconds);
    expect(findings.map(finding => finding.text)).toEqual([
      'The last runs of the 3 cells took 11 s. [2b] “Ordinal model” took 8.0 s of it (73%). It fits a model 40 times, in a loop.',
      '[2] “Mixed model” took 2.0 s (18%).'
    ]);
    expect(findings[0].cellId).toBe('ord');
  });

  it('says how many cells have a time, and when nothing is slow', () => {
    const cells = [cell('a', 1, 'a = 1'), cell('b', 2, 'b = 2')];
    expect(speedFindings(cells, new Map([['a', 0.04]])).findings[0].text).toBe(
      'The last runs of 1 of the 2 cells took under 0.1 s. Nothing here is slow.'
    );
    expect(speedFindings(cells, new Map())).toEqual({
      findings: [],
      note: 'No run times yet. The view times a cell only while "Questions about the notebook" is on and the notebook is open in it. Run the cells again to time them.'
    });
  });

  it('writes seconds as the check-up gives them', () => {
    expect([0.02, 2.44, 11.4, 72].map(runSeconds)).toEqual([
      'under 0.1 s',
      '2.4 s',
      '11 s',
      '1 min 12 s'
    ]);
  });
});

describe('The review that code can find', () => {
  const MODEL = {
    name: 'lmm_fit',
    kind: 'model' as const,
    type: 'statsmodels.regression.mixed_linear_model.MixedLMResultsWrapper',
    model_class: 'MixedLM'
  };

  it('names a fitted model whose residuals no cell reads', () => {
    const fit = cell(
      'm',
      5,
      'lmm_fit = smf.mixedlm("y ~ x", data, groups="id").fit()\nlmm_fit.summary()',
      { defs: ['lmm_fit'], uses: ['lmm_fit', 'data'] }
    );
    expect(reviewFindings([fit], [MODEL]).map(finding => finding.text)).toEqual(
      ['[5] fits lmm_fit, a mixed model, and no cell reads its residuals.']
    );
    const checked = cell('r', 6, 'sm.qqplot(lmm_fit.resid)', {
      uses: ['lmm_fit']
    });
    expect(reviewFindings([fit, checked], [MODEL])).toEqual([]);
    // A model fitted inside a loop is a step of the loop.
    const looped = cell(
      'l',
      7,
      'for i in range(3):\n    lmm_fit = smf.mixedlm("y ~ x", data).fit()',
      { defs: ['lmm_fit'] }
    );
    expect(reviewFindings([looped], [MODEL])).toEqual([]);
  });

  it('names a model of scikit-learn, which gives no interval for its estimates', () => {
    const fit = cell('c', 3, 'clf = LogisticRegression().fit(X, y)', {
      defs: ['clf']
    });
    expect(
      reviewFindings(
        [fit],
        [
          {
            name: 'clf',
            kind: 'other',
            type: 'sklearn.linear_model._logistic.LogisticRegression'
          }
        ]
      ).map(finding => finding.text)
    ).toEqual([
      "[3] fits clf with scikit-learn's LogisticRegression, which gives no interval for its estimates."
    ]);
  });

  it('names many tests with no correction, and a test in a loop', () => {
    const tests = [
      cell('a', 1, 'stats.ttest_ind(a, b)\nstats.mannwhitneyu(a, b)'),
      cell('b', 2, 'pg.corr(x, y)')
    ];
    expect(reviewFindings(tests, []).map(finding => finding.text)).toEqual([
      '3 tests in [1] and [2], and no cell corrects their p-values for multiple tests.'
    ]);
    const corrected = [
      ...tests,
      cell('c', 3, 'multipletests(p, method="fdr_bh")')
    ];
    expect(reviewFindings(corrected, [])).toEqual([]);
    const loop = cell(
      'd',
      4,
      'for column in columns:\n    p.append(stats.pearsonr(df[column], df.y)[1])'
    );
    expect(reviewFindings([loop], []).map(finding => finding.text)).toEqual([
      '[4] runs a test in a loop, and no cell corrects the p-values for multiple tests.'
    ]);
    expect(reviewFindings([tests[1]], [])).toEqual([]);
  });

  it('names a library default that drops rows, as the analysis notes it (1.53)', () => {
    const merge: IDecision = {
      name: 'how',
      value: "'inner'",
      provenance: 'library_default',
      param: 'how',
      function: 'DataFrame.merge',
      note: 'rows without a match in both frames are dropped'
    };
    const pearson: IDecision = {
      name: 'method',
      value: "'pearson'",
      provenance: 'library_default',
      param: 'method',
      function: 'DataFrame.corr',
      note: 'linear correlation, sensitive to outliers'
    };
    const findings = reviewFindings(
      [
        cell('w', 4, 'weekly = a.merge(b)', {}, { decisions: [merge, pearson] })
      ],
      []
    );
    expect(findings.map(finding => finding.text)).toEqual([
      "[4] leaves how='inner' of merge, a library default: rows without a match in both frames are dropped."
    ]);
    expect(findings[0].about).toEqual({
      texts: ["Does how = 'inner' change the result of [4]?"]
    });
  });

  it('names random draws with no seed', () => {
    expect(unseeded('s = df.sample(frac=1, replace=True)', false)).toBe(true);
    expect(
      unseeded('s = df.sample(frac=1, replace=True, random_state=i)', false)
    ).toBe(false);
    expect(unseeded('x = np.random.normal(size=10)', false)).toBe(true);
    expect(unseeded('x = np.random.normal(size=10)', true)).toBe(false);
    expect(
      unseeded('np.random.seed(1)\nx = np.random.normal(size=10)', false)
    ).toBe(false);
    expect(unseeded('rng = np.random.default_rng()', false)).toBe(true);
    expect(
      unseeded('rng = np.random.default_rng(0)\nrng.normal()', false)
    ).toBe(false);
    expect(unseeded('train, test = train_test_split(X, y)', false)).toBe(true);
    expect(
      unseeded(
        'whybook.ribbon(weekly, x="week", ci="bootstrap", n_boot=1000)',
        false
      )
    ).toBe(false);
    const findings = reviewFindings(
      [
        cell('a', 1, 'np.random.seed(0)'),
        cell('b', 2, 'x = np.random.normal(size=5)'),
        cell('c', 3, 'rows = df.sample(5)')
      ],
      []
    );
    expect(findings.map(finding => finding.text)).toEqual([
      '[3] draws random numbers with no seed: another run gives other numbers.'
    ]);
  });
});

describe('What have I forgotten?', () => {
  const MIN_DAYS: IDecision = {
    name: 'MIN_DAYS',
    value: '14',
    provenance: 'defaulted',
    param: 'min_days',
    function: 'drop_sparse',
    source: { file: 'prep.py', line: 31 }
  };

  it('names a frame that no later cell uses', () => {
    const cells = [
      cell('load', 2, 'diary = load()\nolink = load_olink()', {
        defs: ['diary', 'olink']
      }),
      cell('weekly', 3, 'weekly = diary.copy()', {
        defs: ['weekly'],
        uses: ['diary']
      })
    ];
    const frames = ['diary', 'olink', 'weekly'].map(name => ({
      name,
      kind: 'dataframe' as const
    }));
    expect(gapFindings(cells, frames, []).map(finding => finding.text)).toEqual(
      [
        'olink is made in [2], and no later cell uses it.',
        'weekly is made in [3], and no later cell uses it.'
      ]
    );
  });

  it("names a column merged into a model's data and left out of its formula", () => {
    const source =
      'model_data = weekly.merge(patients[["patient_id", "age", "site"]], on="patient_id", how="left")\nlmm_fit = smf.mixedlm("pain_score ~ treatment_arm * month + age", data=model_data, groups="patient_id").fit()';
    const findings = gapFindings(
      [
        cell('lmm', 5, source, {
          defs: ['model_data', 'lmm_fit'],
          uses: ['weekly', 'patients', 'model_data', 'lmm_fit'],
          formulas: ['pain_score ~ treatment_arm * month + age']
        })
      ],
      [],
      []
    );
    expect(findings.map(finding => finding.text)).toEqual([
      'site is merged into model_data in [5], and left out of its formula.'
    ]);
  });

  it("names a constant of the analyst's module that no branch varies", () => {
    const weekly = cell(
      'w',
      4,
      'weekly = drop_sparse(diary)',
      {},
      {
        decisions: [MIN_DAYS]
      }
    );
    expect(gapFindings([weekly], [], []).map(finding => finding.text)).toEqual([
      'MIN_DAYS = 14 of prep.py is never varied.'
    ]);
    const branch = cell(
      'w2',
      9,
      'weekly_if_21 = drop_sparse(diary, min_days=21)',
      {},
      { branchOf: 'w', title: 'What if MIN_DAYS were 21?' }
    );
    expect(gapFindings([weekly, branch], [], [])).toEqual([]);
    const chosen = cell('w3', 10, 'x = 1', {}, { chosen: ['MIN_DAYS'] });
    expect(gapFindings([weekly, chosen], [], [])).toEqual([]);
  });

  it('counts a suggestion put off with Not now as a gap', () => {
    expect(
      gapFindings(
        [],
        [],
        [{ text: "Does how = 'inner' change the result of [4]?", cellId: 'w' }]
      )
    ).toEqual([
      {
        id: "putoff:Does how = 'inner' change the result of [4]?",
        text: "You put off “Does how = 'inner' change the result of [4]?” with Not now.",
        cellId: 'w'
      }
    ]);
  });

  it('leaves out what Worth asking next suggests now, and counts it', () => {
    const weekly = cell(
      'w',
      4,
      'weekly = drop_sparse(diary)\nolink = load()',
      { defs: ['weekly', 'olink'], uses: ['weekly'] },
      { decisions: [MIN_DAYS] }
    );
    const input = {
      cells: [weekly],
      variables: [{ name: 'olink', kind: 'dataframe' as const }],
      codeOf: never,
      seconds: new Map<string, number>(),
      suggested: [] as string[],
      putOff: []
    };
    expect(checkupFindings(input).gaps.map(finding => finding.text)).toEqual([
      'olink is made in [4], and no later cell uses it.',
      'MIN_DAYS = 14 of prep.py is never varied.'
    ]);
    const shown = checkupFindings({
      ...input,
      suggested: [
        'Does MIN_DAYS = 14 change the result of [4]?',
        'Which Cardiometabolic columns of olink track pain_score?'
      ]
    });
    expect(shown.gaps).toEqual([]);
    expect(shown.repeated).toEqual({ review: 0, gaps: 2 });
    // Nothing to say "no gap" about: the gaps are in Worth asking next.
    expect(shown.notes.gaps).toBeUndefined();
    expect(checkupFindings(input).notes.review).toBe(
      'The rules found no point that a reviewer would raise.'
    );
  });
});

describe('The note of the folded section', () => {
  const NOW = Date.parse('2026-09-30T12:00:00Z');
  const quiet = { saved: false, exported: false, python: null };

  it('shows nothing before the first check-up, then its day', () => {
    expect(checkupNote({}, NOW, quiet)).toEqual({
      text: '',
      title: '',
      hint: false
    });
    expect(
      checkupNote({ last: '2026-09-27T09:00:00Z' }, NOW, {
        ...quiet,
        saved: true
      })
    ).toEqual({
      text: 'last on 27 Sep',
      title: 'The last check-up was on 27 Sep.',
      hint: false
    });
    expect(checkupNote({ last: '2025-09-23T09:00:00Z' }, NOW, quiet).text).toBe(
      'last on 23 Sep 2025'
    );
  });

  it('says how many days after seven days and an event, in the same place', () => {
    const last = { last: '2026-09-18T09:00:00Z' };
    expect(checkupNote(last, NOW, quiet).text).toBe('last on 18 Sep');
    expect(checkupNote(last, NOW, { ...quiet, saved: true })).toEqual({
      text: '12 days since the last',
      title: 'You saved the notebook 12 days after its last check-up.',
      hint: true
    });
    expect(checkupNote(last, NOW, { ...quiet, exported: true }).title).toBe(
      'You downloaded or exported the notebook 12 days after its last check-up.'
    );
    expect(
      checkupNote(last, NOW, {
        ...quiet,
        python: { kernel: '3.13.1', notebook: '3.12.13' }
      }).title
    ).toBe(
      'The kernel runs Python 3.13.1, and the notebook was saved with Python 3.12.13.'
    );
  });

  it('compares Pythons by their major and minor versions', () => {
    expect(pythonsDiffer('3.12.13', '3.12.1')).toBe(false);
    expect(pythonsDiffer('3.13.0', '3.12.13')).toBe(true);
    expect(pythonsDiffer('', '3.12.13')).toBe(false);
  });
});

/** A session context whose kernel messages a test sends. */
function fakeSession() {
  const owner = {};
  return {
    iopubMessage: new Signal<any, any>(owner),
    statusChanged: new Signal<any, any>(owner),
    kernelChanged: new Signal<any, any>(owner)
  };
}

/** A kernel message of a request: its type, content and date. */
function message(
  type: string,
  parent: string,
  content: Record<string, unknown>,
  date: string
) {
  return {
    header: { msg_type: type, msg_id: `${type}-${parent}`, date },
    parent_header: { msg_id: parent },
    content,
    channel: 'iopub'
  };
}

describe('Run times from the kernel', () => {
  it("times each run from its input to its idle status, by the kernel's clock", () => {
    const session = fakeSession();
    const times = new RunTimes(session as any);
    let changed = 0;
    times.changed.connect(() => changed++);
    const send = (type: string, parent: string, content: any, at: string) =>
      session.iopubMessage.emit(message(type, parent, content, at));
    send(
      'status',
      'p1',
      { execution_state: 'busy' },
      '2026-09-30T10:00:00.000Z'
    );
    send(
      'execute_input',
      'p1',
      { code: 'fit()', execution_count: 3 },
      '2026-09-30T10:00:00.100Z'
    );
    // A branch in a subshell runs at the same time.
    send(
      'execute_input',
      'p2',
      { code: 'boot()', execution_count: 4 },
      '2026-09-30T10:00:01.000Z'
    );
    send(
      'error',
      'p2',
      { ename: 'ValueError', evalue: 'x', traceback: [] },
      '2026-09-30T10:00:01.500Z'
    );
    send(
      'status',
      'p1',
      { execution_state: 'idle' },
      '2026-09-30T10:00:02.600Z'
    );
    send(
      'status',
      'p2',
      { execution_state: 'idle' },
      '2026-09-30T10:00:03.000Z'
    );
    // A silent request of the view publishes no input: it is no run.
    send(
      'status',
      'p3',
      { execution_state: 'idle' },
      '2026-09-30T10:00:04.000Z'
    );
    expect(times.timeOf('fit()')).toEqual({
      seconds: 2.5,
      count: 3,
      at: Date.parse('2026-09-30T10:00:02.600Z'),
      ok: true
    });
    expect(times.timeOf('boot()')).toMatchObject({ seconds: 2, ok: false });
    expect(times.codeOf(3)).toBe('fit()');
    expect(times.codeOf(4)).toBe('boot()');
    expect(changed).toBe(2);
    // A restart counts from 1 again: the codes of the counts go, the times stay.
    session.statusChanged.emit('restarting');
    expect(times.codeOf(3)).toBeNull();
    expect(times.timeOf('fit()')?.seconds).toBe(2.5);
    times.dispose();
    send(
      'execute_input',
      'p4',
      { code: 'late()', execution_count: 1 },
      '2026-09-30T10:01:00.000Z'
    );
    send(
      'status',
      'p4',
      { execution_state: 'idle' },
      '2026-09-30T10:01:01.000Z'
    );
    expect(times.timeOf('late()')).toBeNull();
  });

  it("reads the times that JupyterLab's recordTiming keeps in a cell", () => {
    const nb = new NotebookModel();
    nb.sharedModel.insertCell(0, { cell_type: 'code', source: 'x = 1' });
    const model = nb.cells.get(0);
    expect(recordedSeconds(model)).toBeNull();
    model.setMetadata('execution', {
      'iopub.execute_input': '2026-09-30T10:00:00.000Z',
      'shell.execute_reply': '2026-09-30T10:00:04.250Z'
    });
    expect(recordedSeconds(model)).toBe(4.25);
  });
});

describe('Another library for a cell', () => {
  const IMPORTS =
    'import pandas as pd\nfrom scipy import stats\nfrom sklearn.linear_model import LogisticRegression';

  it('offers statsmodels for a regression of scikit-learn, and says why', () => {
    const source = 'clf = LogisticRegression().fit(X, y)';
    const [entry, ...rest] = cellAlternatives(source, `${IMPORTS}\n${source}`, {
      statsmodels: '0.15.0',
      sklearn: '1.9.1'
    });
    expect(rest).toEqual([]);
    expect(compareLabel(entry)).toBe('Compare with statsmodels');
    expect(entry.missing).toBe(false);
    expect(compareWhy(entry)).toBe(
      'Logit fits with no penalty and gives standard errors, where LogisticRegression applies an L2 penalty, C = 1.0, which shrinks the estimates'
    );
    expect(compareOption(entry, { id: 'c3', label: '[3]' })).toEqual({
      id: 'library:c3:sklearn:statsmodels',
      text: 'Does Logit of statsmodels agree with LogisticRegression of sklearn?',
      type: 'model',
      origin: 'library',
      probability: null,
      reasons: [compareWhy(entry)],
      effect: compareWhy(entry),
      placement: { kind: 'branch', cell: 'c3', label: 'branch of [3]' },
      code: null
    });
  });

  it('gathers the tests of a cell under one other library, and says when the kernel lacks it', () => {
    const source = 'stats.ttest_ind(a, b)\nstats.mannwhitneyu(a, b)';
    const entries = cellAlternatives(source, IMPORTS, { scipy: '1.16' });
    expect(entries).toHaveLength(1);
    expect(entries[0].other).toBe('pingouin');
    expect(entries[0].missing).toBe(true);
    expect(compareLabel(entries[0])).toBe(
      'Compare with pingouin, not in this kernel'
    );
    expect(entries[0].alternatives.map(item => item.call)).toEqual([
      'ttest_ind',
      'mannwhitneyu'
    ]);
    expect(compareOption(entries[0], { id: 'c1', label: '[1]' }).text).toBe(
      'Do ttest and mwu of pingouin agree with ttest_ind and mannwhitneyu of scipy.stats?'
    );
    // Before the kernel lists its packages, nothing is known to be missing.
    expect(cellAlternatives(source, IMPORTS, null)[0].missing).toBe(false);
  });

  it('offers nothing for a call of another library, a definition, or a series', () => {
    expect(
      cellAlternatives(
        'm = LogisticRegression(x)',
        'from mylib import LogisticRegression',
        {}
      )
    ).toEqual([]);
    expect(
      cellAlternatives('def ttest_ind(a, b):\n    return 0', IMPORTS, {})
    ).toEqual([]);
    expect(cellAlternatives('r = a.corr(b)', IMPORTS, {})).toEqual([]);
    expect(cellAlternatives('m = df.corr()', IMPORTS, {})[0].other).toBe(
      'pingouin'
    );
  });
});

describe('The check-up of a view', () => {
  const NOW = Date.parse('2026-09-30T12:00:00Z');

  function notebook(extra: Record<string, unknown> = {}) {
    const source = 'olink = load_olink()';
    return {
      cells: [
        {
          cell_type: 'code',
          id: 'load',
          source,
          metadata: {
            whybook: {
              title: 'Load',
              analysis: storedAnalysis(
                {
                  defs: ['olink'],
                  uses: [],
                  formulas: [],
                  columns: {},
                  decisions: [],
                  attachments: []
                },
                source
              )
            }
          },
          execution_count: 2,
          outputs: []
        },
        {
          cell_type: 'code',
          id: 'fit',
          source: 'fit = model()',
          metadata: {},
          execution_count: 3,
          outputs: [
            {
              output_type: 'stream',
              name: 'stdout',
              text: 'coef -0.857\n'
            }
          ]
        }
      ],
      metadata: {
        whybook: {
          variables: [
            { name: 'olink', label: 'olink', kind: 'dataframe', cell: 'load' }
          ],
          ...extra
        }
      },
      nbformat: 4,
      nbformat_minor: 5
    } as any;
  }

  function connected(model: any): void {
    model.status = {
      claude_available: true,
      claude: {
        available: true,
        cli: null,
        credential: null,
        reason: null,
        setup: null,
        priced: true
      },
      local_models: []
    };
  }

  it('asks nothing when it opens, and keeps the day and what the rules found', () => {
    const { model, nb } = benchModel(notebook());
    const checkup = new Checkup(model, { now: () => NOW });
    const review = jest.fn();
    (model.api as any).reviewQuestions = review;
    expect(checkup.isOpen).toBe(false);
    expect(checkup.note().text).toBe('');
    checkup.open();
    expect(checkup.isOpen).toBe(true);
    const kept = checkupMeta(nb);
    expect(kept.last).toBe('2026-09-30T12:00:00.000Z');
    expect(kept.found).toContain(
      'olink is made in [2], and no later cell uses it.'
    );
    expect(checkup.note().text).toBe('last on 30 Sep');
    expect(review).not.toHaveBeenCalled();
    checkup.dispose();
  });

  it('keeps the seconds of each cell: the run it saw, then the last check-up while the code is the same', () => {
    const { model } = benchModel(notebook());
    const checkup = new Checkup(model, { now: () => NOW });
    const session = model.sessionContext as any;
    session.iopubMessage.emit(
      message(
        'execute_input',
        'p1',
        { code: 'fit = model()', execution_count: 3 },
        '2026-09-30T10:00:00.000Z'
      )
    );
    session.iopubMessage.emit(
      message(
        'status',
        'p1',
        { execution_state: 'idle' },
        '2026-09-30T10:00:06.000Z'
      )
    );
    expect([...checkup.seconds()]).toEqual([['fit', 6]]);
    checkup.open();
    checkup.dispose();
    // A new view of the notebook reads the times of the last check-up.
    const again = new Checkup(model, { now: () => NOW });
    expect([...again.seconds()]).toEqual([['fit', 6]]);
    model.cell('fit')!.model.sharedModel.setSource('fit = model(alpha=1)');
    expect([...again.seconds()]).toEqual([]);
    again.dispose();
  });

  it('says why the reviewer cannot ask: no model, or the cap', async () => {
    const { model } = benchModel(
      notebook({ costs: { answers: { usd: 1, n: 1 } }, cost_cap_usd: 0.5 })
    );
    const checkup = new Checkup(model, { now: () => NOW });
    const review = jest.fn();
    (model.api as any).reviewQuestions = review;
    expect(checkup.reviewOff()).toBe(
      'A model would ask as a reviewer, and none answers: the server did not answer.'
    );
    await checkup.askReviewer();
    expect(review).not.toHaveBeenCalled();
    expect(checkup.review.status).toBe('failed');
    connected(model);
    expect(checkup.reviewOff()).toBeNull();
    model.settings.showCost = true;
    expect(checkup.reviewOff()).toBe(
      "A model would ask as a reviewer, and the notebook's AI answers reached its cap."
    );
    checkup.dispose();
  });

  it("asks the model of More questions once, with the cells, their outputs and the rules' findings, and keeps its questions", async () => {
    const { model, nb } = benchModel(notebook());
    connected(model);
    const checkup = new Checkup(model, { now: () => NOW });
    const bodies: any[] = [];
    (model.api as any).reviewQuestions = async (
      body: any,
      onEvent: (event: any) => void
    ) => {
      bodies.push(body);
      onEvent({ type: 'progress', stage: 'thinking', elapsed: 1 });
      expect(checkup.review.status).toBe('asking');
      expect(checkup.review.stage).toBe('thinking');
      onEvent({
        type: 'result',
        elapsed: 2,
        model: 'fake-model',
        questions: [
          {
            id: 'review:1',
            text: 'Does the estimate of fit hold without the outliers?',
            type: 'model',
            cell: '[3]',
            why: 'One patient has extreme pain.'
          },
          {
            id: 'review:2',
            text: 'Is olink needed?',
            type: 'descriptive',
            cell: null,
            why: 'No cell reads it.'
          }
        ]
      });
    };
    await checkup.askReviewer();
    expect(bodies).toHaveLength(1);
    // The default of More questions: the fast model of the connected provider.
    expect(bodies[0].model).toBe('remote:fast');
    expect(bodies[0].cells).toEqual([
      {
        id: 'load',
        label: '[2]',
        title: 'Load',
        code: 'olink = load_olink()',
        outputs: [],
        text: ''
      },
      {
        id: 'fit',
        label: '[3]',
        title: 'fit = model()',
        code: 'fit = model()',
        outputs: ['log'],
        text: 'coef -0.857'
      }
    ]);
    expect(bodies[0].findings).toContain(
      'olink is made in [2], and no later cell uses it.'
    );
    expect(checkup.review.status).toBe('done');
    expect(
      checkup.review.questions.map(option => [
        option.text,
        option.placement?.label ?? null,
        option.origin,
        option.code
      ])
    ).toEqual([
      [
        'Does the estimate of fit hold without the outliers?',
        'new cell after [3]',
        'claude',
        null
      ],
      ['Is olink needed?', null, 'claude', null]
    ]);
    expect(checkupMeta(nb).review?.questions.map(item => item.cell)).toEqual([
      'fit',
      null
    ]);
    // Another view of the notebook shows the kept questions, with no call.
    const again = new Checkup(model, { now: () => NOW });
    expect(again.review.status).toBe('done');
    expect(again.review.questions).toHaveLength(2);
    checkup.dispose();
    again.dispose();
  });

  it('says how many days after a save seven days or more after the last check-up', () => {
    const { model } = benchModel(
      notebook({ checkup: { last: '2026-09-20T09:00:00Z' } })
    );
    const context = model.context as any;
    context.saveState = new Signal<any, string>({});
    const checkup = new Checkup(model, { now: () => NOW });
    expect(checkup.note().text).toBe('last on 20 Sep');
    context.saveState.emit('completed');
    expect(checkup.note().text).toBe('10 days since the last');
    // A look sets the day again: the hint goes.
    checkup.open();
    expect(checkup.note().text).toBe('last on 30 Sep');
    checkup.dispose();
  });

  it('keeps a place for the question in another language, which the agent of 1.69 fills', () => {
    const question = checkupQuestions.get('other-language')!;
    expect(question.group).toBe('reproduce');
    expect(question.ask).toBeNull();
    const { model } = benchModel(notebook());
    expect(question.text(model)).toBe(
      'Would I get the same results in another language?'
    );
    expect(otherLanguage('python')).toBe('R');
    expect(otherLanguage('R')).toBe('Python');
    expect(otherLanguage('sas')).toBe('Python');
  });
});
