/**
 * An agent that works in another notebook (design iteration 1.69,
 * src/model/crosskernel.ts): the kernels that "Would I get the same results
 * in R?" is offered for, the kernels of the trial menu (1.68, B1), the
 * defaults that differ between Python, R and SAS, and the comparison,
 * checked against the outputs of both notebooks.
 */
import type { IKernelSpecLike } from '../model/crosskernel';
import {
  buildComparison,
  comparisonMarkdown,
  crossQuestions,
  defaultsThatDiffer,
  differenceText,
  framesFolder,
  introText,
  kernelChoices,
  kernelFacts,
  LANGUAGE_DEFAULTS,
  menuKernels,
  newNotebookPath,
  notebookTitle,
  withRecent
} from '../model/crosskernel';

const IPYKERNEL = [
  'python',
  '-m',
  'ipykernel_launcher',
  '-f',
  '{connection_file}'
];
const XR = [
  '/home/me/.cache/future-work/kernels/xeus-r/.pixi/envs/default/bin/xr',
  '-f',
  '{connection_file}'
];
const SANDBOX = { kernel_provisioner: { provisioner_name: 'whybook-sandbox' } };

/** The kernelspecs of this machine, as /api/kernelspecs lists them. */
const SPECS: Record<string, IKernelSpecLike> = {
  python3: {
    name: 'python3',
    display_name: 'Python 3 (ipykernel)',
    language: 'python',
    argv: IPYKERNEL,
    metadata: { debugger: true }
  },
  'python3-sandboxed': {
    name: 'python3-sandboxed',
    display_name: 'Python 3 (sandboxed)',
    language: 'python',
    argv: IPYKERNEL,
    metadata: SANDBOX
  },
  xr: {
    name: 'xr',
    display_name: 'R 4.4.3 (xr)',
    language: 'R',
    argv: XR,
    metadata: { debugger: false }
  },
  'r-sandboxed': {
    name: 'r-sandboxed',
    display_name: 'R 4.4.3 (xr, sandboxed)',
    language: 'R',
    argv: XR,
    metadata: { debugger: false, ...SANDBOX }
  },
  'sas-licence-needed': {
    name: 'sas-licence-needed',
    display_name: 'SAS (licence needed)',
    language: 'sas',
    argv: ['python', '{resource_dir}/sas.py', '-f', '{connection_file}'],
    metadata: {}
  }
};

/** A newer Python in an environment of its own, as Nebi would list it. */
const PY313: IKernelSpecLike = {
  name: 'py313',
  display_name: 'Python 3.13',
  language: 'python',
  argv: [
    '/opt/envs/py313/bin/python',
    '-m',
    'ipykernel_launcher',
    '-f',
    '{connection_file}'
  ]
};

describe('kernelChoices', () => {
  it('reads the sandbox and the program of each kernel', () => {
    const choices = kernelChoices(SPECS);
    expect(
      choices.map(choice => [choice.name, choice.label, choice.sandboxed])
    ).toEqual([
      ['python3', 'Python', false],
      ['python3-sandboxed', 'Python', true],
      ['xr', 'R', false],
      ['r-sandboxed', 'R', true],
      ['sas-licence-needed', 'SAS', false]
    ]);
    expect(choices[2].program).toBe(XR[0]);
    expect(kernelChoices(null)).toEqual([]);
  });
});

describe('crossQuestions', () => {
  const choices = kernelChoices(SPECS);

  it('offers R and SAS to a Python notebook, and not its own sandboxed twin', () => {
    expect(
      crossQuestions('python3', choices).map(question => [
        question.text,
        question.kernel.name,
        question.kind
      ])
    ).toEqual([
      ['Would I get the same results in R?', 'xr', 'language'],
      ['Would I get the same results in SAS?', 'sas-licence-needed', 'language']
    ]);
  });

  it('answers a sandboxed notebook with the sandboxed kernel of the other language', () => {
    expect(
      crossQuestions('python3-sandboxed', choices).map(
        question => question.kernel.name
      )
    ).toEqual(['r-sandboxed', 'sas-licence-needed']);
  });

  it('offers Python and R to a SAS notebook', () => {
    expect(
      crossQuestions('sas-licence-needed', choices).map(question => [
        question.text,
        question.kernel.name
      ])
    ).toEqual([
      ['Would I get the same results in Python?', 'python3'],
      ['Would I get the same results in R?', 'xr']
    ]);
  });

  it('offers another version of the language by its kernel, after the other languages', () => {
    const more = kernelChoices({ ...SPECS, py313: PY313 });
    expect(
      crossQuestions('python3', more).map(question => [
        question.text,
        question.kind
      ])
    ).toEqual([
      ['Would I get the same results in R?', 'language'],
      ['Would I get the same results in SAS?', 'language'],
      ['Would I get the same results in Python 3.13?', 'version']
    ]);
    // Two interpreters of another language: each is named by its kernel.
    const twoR = kernelChoices({
      ...SPECS,
      r45: {
        name: 'r45',
        display_name: 'R 4.5.1',
        language: 'R',
        argv: ['/opt/r45/bin/R']
      }
    });
    expect(
      crossQuestions('python3', twoR).map(question => question.text)
    ).toEqual([
      'Would I get the same results in R 4.4.3 (xr)?',
      'Would I get the same results in R 4.5.1?',
      'Would I get the same results in SAS?'
    ]);
  });

  it('offers every language before the kernel is known', () => {
    expect(
      crossQuestions(null, choices).map(question => question.kernel.name)
    ).toEqual(['python3', 'xr', 'sas-licence-needed']);
  });
});

describe('menuKernels', () => {
  const choices = kernelChoices({ ...SPECS, py313: PY313 });

  it("lists the notebook's own kernel, then three others: the other environments of the language first, then by name", () => {
    expect(
      menuKernels('python3', choices, []).map(choice => choice.name)
    ).toEqual(['python3', 'py313', 'python3-sandboxed', 'xr']);
  });

  it('puts the kernels used most recently first, and lists every kernel when asked for more', () => {
    const recent = withRecent(withRecent([], 'r-sandboxed'), 'xr');
    expect(recent).toEqual(['xr', 'r-sandboxed']);
    expect(
      menuKernels('python3', choices, recent).map(choice => choice.name)
    ).toEqual(['python3', 'xr', 'r-sandboxed', 'py313']);
    expect(
      menuKernels('python3', choices, [], 10).map(choice => choice.name)
    ).toContain('sas-licence-needed');
    expect(withRecent(['a', 'b', 'c'], 'b', 2)).toEqual(['b', 'a']);
  });

  it("lists three kernels on a server that has only three, the notebook's own among them", () => {
    const three = kernelChoices({
      'python3-sandboxed': SPECS['python3-sandboxed'],
      'r-sandboxed': SPECS['r-sandboxed'],
      'sas-licence-needed': SPECS['sas-licence-needed']
    });
    expect(
      menuKernels('python3-sandboxed', three, []).map(choice => choice.name)
    ).toEqual(['python3-sandboxed', 'r-sandboxed', 'sas-licence-needed']);
  });
});

describe('newNotebookPath', () => {
  it('puts the notebook beside the first, and refuses other names', () => {
    expect(
      newNotebookPath(
        'pain_diary/pain_diary_cohort.ipynb',
        'pain_diary_cohort.R.ipynb'
      )
    ).toEqual({ path: 'pain_diary/pain_diary_cohort.R.ipynb' });
    for (const [name, error] of [
      ['pain.R', 'the name must end in .ipynb'],
      [
        '../pain.R.ipynb',
        "the notebook goes beside the analyst's: give a file name alone"
      ],
      [
        'sub/pain.R.ipynb',
        "the notebook goes beside the analyst's: give a file name alone"
      ],
      [
        '.hidden.ipynb',
        "the notebook goes beside the analyst's: give a file name alone"
      ],
      [
        'pain_diary_cohort.ipynb',
        "that is the analyst's notebook: choose another name"
      ]
    ]) {
      expect(
        newNotebookPath('pain_diary/pain_diary_cohort.ipynb', name)
      ).toEqual({
        error
      });
    }
  });

  it('names the folder of the frames after the language that writes them', () => {
    expect(framesFolder('Python')).toBe('from_python');
    expect(framesFolder('R')).toBe('from_r');
  });
});

describe('kernelFacts and introText', () => {
  it("reads Python's packages with their versions and R's by name", () => {
    expect(
      kernelFacts({
        language: 'Python 3.12.13',
        parquet: true,
        packages: { pandas: '3.0.6', sklearn: null }
      })
    ).toEqual({
      language: 'Python 3.12.13',
      parquet: true,
      packages: ['pandas 3.0.6', 'sklearn']
    });
    expect(
      kernelFacts({
        language: 'R 4.4.3',
        parquet: false,
        packages: ['base', 'stats']
      })
    ).toEqual({
      language: 'R 4.4.3',
      parquet: false,
      packages: ['base', 'stats']
    });
    expect(kernelFacts(null)).toEqual({
      language: null,
      parquet: false,
      packages: []
    });
  });

  it('writes the first cell of the new notebook: its title, the question and the kernel', () => {
    const [xr] = kernelChoices({ xr: SPECS.xr });
    expect(
      introText({
        title: 'Pain diary cohort',
        question: 'Would I get the same results in R?',
        first: 'pain_diary/pain_diary_cohort.ipynb',
        kernel: xr
      })
    ).toBe(
      '# Pain diary cohort, in R\n\nWhybook\'s agent made this notebook for the question "Would I get the same results in R?", asked in pain_diary_cohort.ipynb. The cells after this one are the agent\'s, and R 4.4.3 (xr) runs them.'
    );
  });
});

describe('notebookTitle', () => {
  const title = (first: string, given = '', requested = 'x.R.ipynb') =>
    notebookTitle({ heading: null, first, given, requested, label: 'R' });

  it("takes the heading of the analyst's notebook, else its name", () => {
    expect(
      notebookTitle({
        heading: 'Pain diary cohort',
        first: 'Untitled.ipynb',
        given: 'Other',
        requested: 'x.R.ipynb',
        label: 'R'
      })
    ).toBe('Pain diary cohort');
    expect(title('pain_diary/pain_diary_cohort.ipynb', 'Other')).toBe(
      'pain_diary_cohort'
    );
  });

  it("gives an untitled notebook's reproduction the agent's title, else the words of its name", () => {
    // "Untitled, in R" headed the R notebook of the first NHEFS video.
    expect(title('Untitled.ipynb', ' Quitting smoking and  weight gain ')).toBe(
      'Quitting smoking and weight gain'
    );
    expect(title('Untitled3.ipynb', '', 'smoking_weight_gain.R.ipynb')).toBe(
      'Smoking weight gain'
    );
    expect(title('Untitled.ipynb', '', 'nhefs_results_R.ipynb')).toBe(
      'Nhefs results'
    );
  });

  it('keeps the name when the agent gave nothing better', () => {
    expect(title('Untitled.ipynb', 'Untitled', 'Untitled.R.ipynb')).toBe(
      'Untitled'
    );
  });
});

// The code of the demo's cells [4] and [5], and of the cells that the
// designer's R notebook ran (website/tools/iterations_meta.js).
const WEEKLY =
  'weekly = (\n    diary.pipe(drop_sparse)\n    .merge(patients[["patient_id", "treatment_arm"]], on="patient_id")\n    .groupby(["patient_id", "treatment_arm", "week"], as_index=False, observed=True)["pain_score"]\n    .mean()\n)\nwhybook.ribbon(weekly, x="week", y="pain_score", by="treatment_arm", ci="bootstrap", n_boot=1000)';
const LMM =
  'lmm_fit = smf.mixedlm(\n    "pain_score ~ treatment_arm * month + age",\n    data=model_data,\n    groups="patient_id",\n    re_formula="~month",\n    missing="drop",\n).fit()\nlmm_fit.summary().tables[1]';
const R_WEEKLY =
  'set.seed(0)\nweekly_ci <- do.call(rbind, lapply(split(weekly, list(weekly$treatment_arm, weekly$week)), function(d) {\n  draws <- replicate(1000, mean(sample(d$pain_score, replace = TRUE)))\n  data.frame(arm = d$treatment_arm[1], week = d$week[1], mean = mean(d$pain_score),\n             lo = quantile(draws, 0.025), hi = quantile(draws, 0.975), n = nrow(d))\n}))';
const R_LMM =
  'library(lme4)\nfit <- lmer(pain_score ~ treatment_arm * month + age + (month | patient_id), data = model_data)\nsummary(fit)$coefficients';

describe('the defaults that differ between the languages', () => {
  it("keeps the nine rows of 1.69's table, with a value for each language", () => {
    expect(LANGUAGE_DEFAULTS).toHaveLength(9);
    for (const row of LANGUAGE_DEFAULTS) {
      expect([row.python, row.r, row.sas].every(text => text.length > 10)).toBe(
        true
      );
    }
  });

  it("names the designer's three for the demo's [4] and [5] in R: draws, p-values and the reference level", () => {
    expect(
      defaultsThatDiffer('python', 'R', [WEEKLY, LMM, R_WEEKLY, R_LMM]).map(
        row => row.id
      )
    ).toEqual(['reference-level', 'mixed-df', 'random-draws']);
  });

  it('names more rows for SAS, none for two versions of one language, and only the calls made', () => {
    expect(
      defaultsThatDiffer('sas', 'python', [LMM]).map(row => row.id)
    ).toEqual(['reference-level', 'mixed-df', 'random-covariance']);
    expect(defaultsThatDiffer('python', 'python', [LMM])).toEqual([]);
    expect(defaultsThatDiffer('python', 'julia', [LMM])).toEqual([]);
    // numpy's standard deviation divides by n; pandas' and R's by n - 1.
    expect(
      defaultsThatDiffer('python', 'R', ['sd = np.std(x)']).map(row => row.id)
    ).toEqual(['standard-deviation']);
    expect(defaultsThatDiffer('python', 'R', ['x.std()'])).toEqual([]);
  });
});

describe('buildComparison', () => {
  const first = {
    path: 'pain_diary/pain_diary_cohort.ipynb',
    kernel: 'Python 3 (ipykernel)',
    language: 'python',
    results: true
  };
  const second = {
    path: 'pain_diary/pain_diary_cohort.R.ipynb',
    kernel: 'R 4.4.3 (xr)',
    language: 'R',
    results: true
  };
  // The outputs as xeus-r prints them, and as the demo's model prints.
  const firstCells = [
    { label: '[4]', code: WEEKLY, outputs: '' },
    {
      label: '[5]',
      code: LMM,
      outputs:
        '                          Coef.  Std.Err.       z  P>|z|\ntreatment_arm[T.B]       -0.857     0.160  -5.357  0.000\ntreatment_arm[T.B]:month -0.318     0.050  -6.360  0.000'
    }
  ];
  const secondCells = [
    {
      label: '[2]',
      code: R_WEEKLY,
      outputs:
        '   arm week mean        lo        hi         n  \n12 A   12   2.636743341 2.3286214 2.93552613 118\n40 B   12   0.750694444 0.5901108 0.92855489 144'
    },
    {
      label: '[3]',
      code: R_LMM,
      outputs: "ERROR: there is no package called 'lme4'"
    }
  ];
  const raw = {
    rows: [
      {
        estimate: 'lower 95% bound, week 12, arm B',
        first: { cell: '[4]', value: '' },
        second: { cell: '[2]', value: '0.590' },
        note: 'the ribbon draws it and prints no number'
      },
      {
        estimate: 'arm B × month',
        first: { cell: '[5]', value: '-0.318' },
        second: { cell: '[3]', value: '' },
        note: 'lme4 is not installed'
      },
      {
        estimate: 'mean pain, week 12, arm B',
        first: { cell: '[5]', value: '0.7507' },
        second: { cell: '2', value: '0.7507' }
      },
      {
        estimate: 'the sign is checked',
        first: { cell: '[5]', value: '0.318' },
        second: { cell: '[2]', value: '0.59012' }
      }
    ],
    missing: ['lme4', 3]
  };

  it('checks each number against the output of the cell it names, with its sign and to its digits', () => {
    const comparison = buildComparison({
      raw,
      first,
      second,
      firstCells,
      secondCells
    });
    expect(
      comparison.rows.map(row => [
        row.first.text,
        row.first.found,
        row.second.text,
        row.second.found
      ])
    ).toEqual([
      [null, null, '0.590', true],
      ['-0.318', true, null, null],
      // [5] does not print the weekly mean; R's [2] prints 0.750694444.
      ['0.7507', false, '0.7507', true],
      // [5] prints -0.318, not 0.318; R prints 0.5901108, which is 0.59011.
      ['0.318', false, '0.59012', false]
    ]);
    expect(comparison.rows[2].difference).toBe(0);
    expect(differenceText(comparison.rows[2])).toBe('0');
    expect(differenceText(comparison.rows[3])).toBe('+0.272');
    // 0.5901108 rounds to 0.59011: that number is in the output.
    const printed = buildComparison({
      raw: {
        rows: [
          {
            estimate: 'lower bound',
            first: { cell: '[5]', value: '-0.318' },
            second: { cell: '[2]', value: '0.59011' }
          }
        ]
      },
      first,
      second,
      firstCells,
      secondCells
    });
    expect(printed.rows[0].second.found).toBe(true);
    expect(comparison.rows[1].difference).toBeNull();
    expect(comparison.missing).toEqual(['lme4']);
    expect(comparison.defaults.map(row => row.id)).toEqual([
      'reference-level',
      'mixed-df',
      'random-draws'
    ]);
  });

  it('writes the text cell: the table, the defaults, what is missing and the answer', () => {
    const comparison = buildComparison({
      raw,
      first,
      second,
      firstCells,
      secondCells
    });
    const text = comparisonMarkdown({
      question: 'Would I get the same results in R?',
      comparison,
      answer: 'The means agree ([4]); [5] did not run in R.',
      ran: 3
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('## Would I get the same results in R?');
    expect(text).toContain(
      "Whybook's agent ran 3 cells in [pain_diary_cohort.R.ipynb](pain_diary_cohort.R.ipynb), with R 4.4.3 (xr)."
    );
    expect(lines).toContain('| Estimate | Python | R | Difference |');
    expect(lines).toContain(
      '| arm B × month | −0.318 ([5]) | no result: lme4 is not installed |  |'
    );
    expect(lines).toContain(
      '| mean pain, week 12, arm B | 0.7507 ([5]), not found in that output | 0.7507 (R [2]) | 0 |'
    );
    expect(text).toContain(
      '**Defaults that differ between Python and R, for the calls of these cells**'
    );
    expect(text).toContain(
      "- **Random draws.** Python: numpy's generator. The same seed draws other samples in each language, so a bootstrap agrees only to its Monte Carlo error. R: R's own generator, seeded by set.seed."
    );
    expect(text).toContain(
      '**Missing in R 4.4.3 (xr):** lme4. The agent installs no package.'
    );
    expect(lines[lines.length - 1]).toBe(
      "**The agent's answer.** The means agree ([4]); [5] did not run in R."
    );
  });

  it('finds a cell of the new notebook that a row cites as the answer cites it, R [2]', () => {
    // The prompt asks the agent to cite a cell of the notebook it made with
    // its language in front. A run of the SAS demo with Claude Opus 5.5 cited
    // the rows of its comparison the same way, "Python [2]", and the view
    // read "[Python [2]": every number was "not found in that output".
    const comparison = buildComparison({
      raw: {
        rows: [
          {
            estimate: 'mean pain, week 12, arm B',
            first: { cell: '[5]', value: '' },
            second: { cell: 'R [2]', value: '0.7507' }
          },
          {
            estimate: 'arm B × month',
            first: { cell: '[5]', value: '-0.318' },
            second: { cell: 'pain_diary_cohort.R.ipynb [3]', value: '' },
            note: 'lme4 is not installed'
          },
          {
            estimate: 'lower bound',
            first: { cell: '5', value: '-0.318' },
            second: { cell: 'R [2', value: '0.59011' }
          }
        ]
      },
      first,
      second,
      firstCells,
      secondCells
    });
    expect(
      comparison.rows.map(row => [
        row.first.cell,
        row.first.found,
        row.second.cell,
        row.second.found
      ])
    ).toEqual([
      ['[5]', null, '[2]', true],
      ['[5]', true, '[3]', null],
      ['[5]', true, '[2]', true]
    ]);
    const text = comparisonMarkdown({
      question: 'Would I get the same results in R?',
      comparison,
      answer: null,
      ran: 2
    });
    expect(text).toContain(
      '| mean pain, week 12, arm B | no result | 0.7507 (R [2]) |  |'
    );
    expect(text).not.toContain('R [R');
  });

  it('says which side has no results: a SAS notebook saved without outputs', () => {
    const sas = {
      ...first,
      kernel: 'SAS (licence needed)',
      language: 'sas',
      results: false
    };
    const comparison = buildComparison({
      raw: {
        rows: [
          {
            estimate: 'arm B',
            first: { cell: '[2]', value: '' },
            second: { cell: '[3]', value: '-0.857' }
          }
        ]
      },
      first: sas,
      second: { ...second, kernel: 'Python 3 (ipykernel)', language: 'python' },
      firstCells: [
        {
          label: '[2]',
          code: 'proc mixed data=visits;\n  class arm;\n  model pain = arm;\n  random intercept / subject=patient_id;\nrun;',
          outputs: ''
        }
      ],
      secondCells: [
        { label: '[3]', code: LMM, outputs: 'arm[T.B] -0.857 0.160' }
      ]
    });
    const text = comparisonMarkdown({
      question: 'Would I get the same results in Python?',
      comparison,
      answer: null,
      ran: 2
    });
    expect(text).toContain(
      'pain_diary_cohort.ipynb saved no outputs: its side has no results to compare.'
    );
    expect(text).toContain(
      '| arm B | no result: no outputs saved | −0.857 (Python [3]) |  |'
    );
    // PROC MIXED gives type 3 tests; its RANDOM statement is no random draw.
    expect(comparison.defaults.map(row => row.id)).toEqual([
      'reference-level',
      'sums-of-squares',
      'mixed-df',
      'random-covariance'
    ]);
    expect(text).not.toContain("The agent's answer");
  });

  it('puts a note on the side without a result, else after the difference, and names two versions by their kernels', () => {
    const comparison = buildComparison({
      raw: {
        rows: [
          {
            estimate: 'upper end',
            first: { cell: '[1]', value: '0.92' },
            second: { cell: '[1]', value: '0.93' },
            note: 'another random generator'
          }
        ]
      },
      first,
      second: { ...second, kernel: 'Python 3.13', language: 'python' },
      firstCells: [{ label: '[1]', code: 'x', outputs: '0.92' }],
      secondCells: [{ label: '[1]', code: 'x', outputs: '0.93' }]
    });
    const text = comparisonMarkdown({
      question: 'Q?',
      comparison,
      answer: null,
      ran: 1
    });
    expect(text).toContain(
      '| Estimate | Python 3 (ipykernel) | Python 3.13 | Difference |'
    );
    expect(text).toContain(
      '| upper end | 0.92 ([1]) | 0.93 (pain_diary_cohort.R.ipynb [1]) | +0.01 (another random generator) |'
    );
    // Two versions of one language share every default.
    expect(text).not.toContain('Defaults that differ');
  });

  it("keeps a pipe in a name out of the table's columns", () => {
    const comparison = buildComparison({
      raw: {
        rows: [
          {
            estimate: 'a | b',
            first: { cell: '[1]', value: '1.5' },
            second: { cell: '[1]', value: '1.5' }
          }
        ]
      },
      first,
      second,
      firstCells: [{ label: '[1]', code: 'x', outputs: '1.5' }],
      secondCells: [{ label: '[1]', code: 'x', outputs: '1.5' }]
    });
    const text = comparisonMarkdown({
      question: 'Q?',
      comparison,
      answer: null,
      ran: 1
    });
    expect(text).toContain('| a \\| b | 1.5 ([1]) | 1.5 (R [1]) | 0 |');
  });
});
