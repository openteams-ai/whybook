/**
 * The chips of R cells (design iteration 1.79). The R kernel's analysis
 * (whybook/server/kernel_code/r/analyze_cells.R) sends the message of the
 * Python analysis, with each function named with its package, such as
 * `stats::t.test`. The view draws its chips as it draws those of Python:
 * the file that read.csv reads, the join of merge, the sums of squares of
 * anova, the defaults of the analyst's own file, and the defaults that a
 * model finds in a function's formals.
 *
 * The analyses below are what the R kernel sent on 1 October 2026 for cells
 * of research/sas_kernel/sgf2019_gaines/jupyterReport.R.ipynb (in the
 * repository around whybook) and of small frames.
 */
import './fakes/quiet';

import type * as nbformat from '@jupyterlab/nbformat';
import { Signal } from '@lumino/signaling';
import * as React from 'react';

import {
  chipText,
  decisionChips,
  readsFile,
  shortName
} from '../model/decisions';
import type { ISignature } from '../model/founddefaults';
import { foundDecisions } from '../model/founddefaults';
import { KernelBridge } from '../model/kernel';
import type { ICellAnalysis, IDecision } from '../tokens';
import { Bench } from '../ui/bench';
import { benchModel, notebookOf } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

/** The first cell of the R version of the real SAS notebook: two reads and a logistic model. */
const TITANIC_SOURCE = [
  'train <- read.csv("titanicTrainClean.csv")',
  'test  <- read.csv("titanicTestClean.csv")',
  'train$famSize <- train$parch + train$sibsp + 1',
  'test$famSize  <- test$parch + test$sibsp + 1',
  'cat(nrow(train), "train rows;", nrow(test), "test rows\\n"); str(train)',
  'fit <- glm(survived ~ sex * age + pclass + fare + famSize, family = binomial, data = train)',
  'summary(fit)$coefficients'
].join('\n');

const TITANIC: ICellAnalysis = {
  attachments: [],
  columns: {
    test: ['age', 'famSize', 'fare', 'parch', 'pclass', 'sex', 'sibsp'],
    train: ['age', 'famSize', 'fare', 'parch', 'pclass', 'sex', 'sibsp']
  },
  decisions: [
    {
      calls: [
        { col: 9, line: 1, target: 'titanicTrainClean' },
        { col: 9, line: 2, target: 'titanicTestClean' }
      ],
      function: 'utils::read.csv',
      name: 'na.strings',
      note: 'only the text NA reads as missing: in a text column an empty cell stays an empty text, and a value such as n/a turns a column of numbers into text',
      param: 'na.strings',
      provenance: 'library_default',
      value: '"NA"'
    },
    {
      calls: [{ col: 7, line: 6, target: 'train' }],
      function: 'stats::glm',
      name: 'contrasts',
      note: 'treatment coding: each coefficient compares a level with the first level, where SAS compares it with the last',
      param: 'contrasts',
      provenance: 'library_default',
      value: '"contr.treatment"'
    },
    {
      calls: [{ col: 7, line: 6, target: 'train' }],
      function: 'stats::glm',
      name: 'na.action',
      note: 'rows with a missing value in any variable of the model are dropped',
      param: 'na.action',
      provenance: 'library_default',
      value: 'na.omit'
    },
    {
      calls: [{ col: 9, line: 1, target: 'titanicTrainClean' }],
      function: 'utils::read.csv',
      name: 'file',
      param: 'file',
      provenance: 'literal',
      value: '"titanicTrainClean.csv"'
    },
    {
      calls: [{ col: 9, line: 2, target: 'titanicTestClean' }],
      function: 'utils::read.csv',
      name: 'file',
      param: 'file',
      provenance: 'literal',
      value: '"titanicTestClean.csv"'
    },
    {
      calls: [{ col: 7, line: 6, target: 'train' }],
      function: 'stats::glm',
      name: 'family',
      param: 'family',
      provenance: 'literal',
      value: 'binomial'
    }
  ],
  defs: ['fit', 'test', 'train'],
  formulas: ['survived ~ sex * age + pclass + fare + famSize'],
  uses: ['fit', 'test', 'train']
};

/** a <- merge(visits, other); b <- merge(..., all = TRUE); c <- merge(..., all.x = TRUE). */
const MERGES: IDecision[] = [
  {
    calls: [{ col: 5, line: 1, target: 'other' }],
    function: 'base::merge',
    name: 'all',
    note: 'rows without a match in both frames are dropped',
    param: 'all',
    provenance: 'library_default',
    value: 'FALSE'
  },
  {
    calls: [{ col: 5, line: 2, target: 'other' }],
    function: 'base::merge',
    name: 'all',
    param: 'all',
    provenance: 'literal',
    value: 'TRUE'
  },
  {
    calls: [{ col: 5, line: 3, target: 'other' }],
    function: 'base::merge',
    name: 'all.x',
    param: 'all.x',
    provenance: 'literal',
    value: 'TRUE'
  }
];

/** MIN_DAYS <- 14; print(anova(lm_fit)); tt <- t.test(pain ~ arm, data = visits, conf.level = 0.9). */
const TESTS: IDecision[] = [
  {
    calls: [{ col: 6, line: 2, target: null }],
    function: 'stats::anova',
    name: 'SS',
    note: 'sequential sums of squares: each term is tested after the terms before it, so their order changes the result; car::Anova tests Type II or III',
    param: null,
    provenance: 'library_default',
    value: 'Type I'
  },
  {
    calls: [{ col: 6, line: 3, target: 'visits' }],
    function: 'stats::t.test',
    name: 'var.equal',
    note: "Welch's t test: the two groups may have different variances, and the degrees of freedom are not whole",
    param: 'var.equal',
    provenance: 'library_default',
    value: 'FALSE'
  },
  {
    function: null,
    name: 'MIN_DAYS',
    param: null,
    provenance: 'literal',
    value: '14'
  },
  {
    calls: [{ col: 6, line: 3, target: 'visits' }],
    function: 'stats::t.test',
    name: 'conf.level',
    param: 'conf.level',
    provenance: 'literal',
    value: '0.9'
  }
];

/** w <- weekly_pain(visits), a function of helpers.R that source() read. */
const OWN_FILE: IDecision[] = [
  {
    calls: [{ col: 5, line: 1, target: 'visits' }],
    function: 'weekly_pain',
    name: 'MIN_WEEK',
    param: 'from',
    provenance: 'defaulted',
    source: { file: 'helpers.R', line: 1 },
    value: '4'
  },
  {
    calls: [{ col: 5, line: 1, target: 'visits' }],
    function: 'weekly_pain',
    name: 'slope',
    param: 'slope',
    provenance: 'defaulted',
    source: { file: 'helpers.R', line: null },
    value: '"week"'
  }
];

/** The formals of t.test that the call of TESTS leaves, as the kernel lists them. */
const TTEST: ISignature = {
  calls: [
    {
      col: 6,
      defaulted: ['na.action', 'y', 'alternative', 'mu', 'paired', 'var.equal'],
      line: 3,
      target: 'visits'
    }
  ],
  function: 'stats::t.test.formula',
  language: 'R',
  library: 'stats',
  module: 'stats',
  name: 'stats::t.test',
  params: [
    { default: 'na.pass', name: 'na.action' },
    { default: 'NULL', name: 'y' },
    { default: '"two.sided"', name: 'alternative' },
    { default: '0', name: 'mu' },
    { default: 'FALSE', name: 'paired' },
    { default: 'FALSE', name: 'var.equal' },
    { default: '0.95', name: 'conf.level' }
  ],
  version: '4.4.3'
};

describe('the name of an R function', () => {
  it('keeps the dot of a name that comes with its package', () => {
    expect(shortName('stats::t.test')).toBe('t.test');
    expect(shortName('utils::read.csv')).toBe('read.csv');
    expect(shortName('base::merge')).toBe('merge');
    // Python's names, as before.
    expect(shortName('DataFrame.merge')).toBe('merge');
    expect(shortName('read_csv')).toBe('read_csv');
  });
});

describe('the chips of an R cell', () => {
  it('shows the file that read.csv reads, the model and the defaults that the cell leaves', () => {
    const chips = decisionChips(TITANIC.decisions);
    expect(chips.map(chip => chip.text)).toEqual([
      'na.strings NA',
      'contrasts contr.treatment',
      'na.action na.omit',
      'titanicTrainClean.csv',
      'titanicTestClean.csv',
      'family binomial'
    ]);
    expect(chips.map(chip => chip.count)).toEqual([2, 1, 1, 1, 1, 1]);
    expect(readsFile(TITANIC.decisions[3])).toBe(true);
    // The tooltip gives the value as code and the calls; the reason is in the popover.
    expect(chips[0].tooltip).toBe(
      [
        'na.strings = "NA"',
        'In both reads: the read of titanicTrainClean (line 1) and the read of titanicTestClean (line 2).'
      ].join('\n')
    );
    expect(chips[0].decision.note).toBe(
      'only the text NA reads as missing: in a text column an empty cell stays an empty text, and a value such as n/a turns a column of numbers into text'
    );
  });

  it("names the join that R's merge makes", () => {
    const chips = decisionChips(MERGES);
    expect(chips.map(chip => chip.text)).toEqual([
      'inner join',
      'outer join',
      'left join'
    ]);
    expect(chips[0].tooltip).toBe(
      ['all = FALSE', 'In the merge with other (line 1).'].join('\n')
    );
    // all.y keeps the rows of the other frame; all.x = FALSE is no join of its own.
    expect(chipText({ ...MERGES[2], name: 'all.y', param: 'all.y' })).toBe(
      'right join'
    );
    expect(chipText({ ...MERGES[2], value: 'FALSE' })).toBe('all.x FALSE');
  });

  it('names the sums of squares of anova with its function, as no parameter holds them', () => {
    const [anova, welch, constant, level] = decisionChips(TESTS);
    expect([anova.text, welch.text, constant.text, level.text]).toEqual([
      'SS Type I',
      'var.equal FALSE',
      'MIN_DAYS 14',
      'conf.level 0.9'
    ]);
    expect(anova.tooltip.split('\n')).toEqual([
      'SS: Type I',
      'stats::anova, line 2'
    ]);
    expect(welch.tooltip.split('\n')).toEqual([
      'var.equal = FALSE',
      'parameter var.equal of stats::t.test, line 3'
    ]);
    expect(constant.tooltip).toBe('MIN_DAYS = 14');
  });

  it('tells two functions whose names end alike apart', () => {
    const correct = (fn: string): IDecision => ({
      calls: [{ col: 0, line: fn === 'stats::chisq.test' ? 1 : 2 }],
      function: fn,
      name: 'correct',
      note: "Yates' continuity correction",
      param: 'correct',
      provenance: 'library_default',
      value: 'TRUE'
    });
    // One chip each, with no line to tell them apart: t.test, chisq.test
    // and prop.test are three functions.
    const chips = decisionChips([
      correct('stats::chisq.test'),
      correct('stats::prop.test')
    ]);
    expect(chips.map(chip => chip.target)).toEqual([null, null]);
  });

  it("shows a default of the analyst's own file as the Python view does", () => {
    const [constant, slope] = decisionChips(OWN_FILE);
    expect([constant.text, slope.text]).toEqual(['MIN_WEEK 4', 'slope week']);
    expect(constant.tooltip.split('\n')).toEqual([
      'MIN_WEEK = 4',
      'parameter from of weekly_pain, line 1'
    ]);
  });

  it("adds the defaults that a model picks from an R function's formals, and not the one the table shows", () => {
    const found = foundDecisions(
      [TTEST],
      () => ({
        picks: [
          { param: 'var.equal', why: 'Welch is the default.' },
          { param: 'alternative', why: 'Both tails are tested.' }
        ],
        by: null
      }),
      TESTS
    );
    expect(found.map(decision => chipText(decision))).toEqual([
      'alternative two.sided'
    ]);
    expect(found[0].function).toBe('stats::t.test');
    expect(found[0].found).toEqual({
      by: null,
      library: 'stats',
      version: '4.4.3'
    });
  });
});

describe('an R notebook in the view', () => {
  function rNotebook(): nbformat.INotebookContent {
    return {
      ...notebookOf([{ id: 'load', source: TITANIC_SOURCE }]),
      metadata: {
        kernelspec: { display_name: 'R 4.4.3 (xr)', language: 'R', name: 'xr' }
      }
    };
  }

  it('reads the columns that each cell uses in an R kernel', () => {
    const { model } = benchModel(rNotebook());
    // Until 1 October 2026: "The columns each cell uses are read in a
    // Python kernel. This kernel runs R."
    expect(model.unsupported('analysis')).toBeNull();
    expect(model.unsupported('questions')).toContain('need a Python kernel');
    model.dispose();
  });

  it('draws the chips and the formula of the analysis of an R cell', async () => {
    const { model } = benchModel(rNotebook());
    jest.spyOn(model.bridge, 'freshAnalysis').mockReturnValue(TITANIC);
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await step(() =>
      (model.bridge.changed as Signal<KernelBridge, string>).emit('analysis')
    );
    await settle();
    const card = view.host.querySelector('.jp-Epi-cell[data-cell-id="load"]')!;
    const chips = [...card.querySelectorAll('.jp-Epi-chip')];
    expect(chips.map(chip => chip.textContent)).toEqual([
      'na.strings NA ×2',
      'contrasts contr.treatment',
      'na.action na.omit',
      'titanicTrainClean.csv',
      'titanicTestClean.csv',
      'family binomial'
    ]);
    // The defaults in the warning colour, the values that the cell writes plain.
    expect(chips.map(chip => chip.classList.contains('jp-mod-open'))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false
    ]);
    expect(card.querySelector('.jp-Epi-formula')?.textContent).toBe(
      'survived ~ sex * age + pclass + fare + famSize'
    );
    await view.unmount();
    model.dispose();
  });
});

/** A session whose kernel answers that it runs R, as xeus-r does. */
function rSession() {
  const context: any = {
    session: {
      kernel: {
        status: 'idle',
        connectionStatus: 'connected',
        info: Promise.resolve({ language_info: { name: 'R' } })
      }
    }
  };
  context.kernelChanged = new Signal<any, any>(context);
  context.statusChanged = new Signal<any, any>(context);
  context.iopubMessage = new Signal<any, any>(context);
  return context;
}

describe('the kernel bridge of an R kernel', () => {
  it('asks the R kernel for the analysis of its cells, with the signatures', async () => {
    const bridge = new KernelBridge(rSession());
    const asked: unknown[] = [];
    jest.spyOn(bridge, 'run').mockImplementation(async (name, args: any) => {
      asked.push([name, args]);
      return { cells: { load: TITANIC } } as any;
    });
    bridge.signatures = true;
    const cells = [{ id: 'load', source: TITANIC_SOURCE }];
    await bridge.refreshAnalysis(cells);
    expect(asked).toEqual([['analyze_cells', { cells, signatures: true }]]);
    expect(bridge.freshAnalysis('load', TITANIC_SOURCE)).toEqual(TITANIC);
    bridge.dispose();
  });

  it('fails with the message of an error of the R program, which comes back as its result', async () => {
    const bridge = new KernelBridge(rSession());
    jest
      .spyOn(bridge, 'run')
      .mockResolvedValue({ error: 'could not find function "fromJSON"' });
    await expect(
      bridge.refreshAnalysis([{ id: 'load', source: TITANIC_SOURCE }])
    ).rejects.toThrow('could not find function "fromJSON"');
    bridge.dispose();
  });
});
