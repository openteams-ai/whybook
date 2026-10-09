/**
 * The Exploration panel of a notebook that an agent's run made in another
 * kernel (design iteration 1.69): "Would I get the same results in R?" in
 * the NHEFS notebook made nhefs_results_R.ipynb, whose eight cells the run
 * wrote and ran. Before, with the cells run and their outputs on screen,
 * Variables explored said "Run the notebook to see which columns the
 * analysis uses": every name of the notebook was the run's, and the panel
 * leaves the names of runs out (../model/runnames.ts). And the panel warned
 * "Few causal questions so far" in a notebook made to check one estimate.
 */
import './fakes/quiet';

import * as React from 'react';

import { storedAnalysis } from '../model/restore';
import type { IDecision } from '../tokens';
import { coverage, ExplorationPanel } from '../ui/exploration';
import type { IBenchCell } from './fakes/bench-fake';
import { benchModel, notebookOf } from './fakes/bench-fake';
import { mount } from './fakes/bench-render';

const RUN = 'r1';
const QUESTION = {
  id: 'crosskernel:r-sandboxed',
  text: 'Would I get the same results in R?',
  type: 'model'
};
const COVARIATES = [
  'qsmk',
  'wt82_71',
  'sex',
  'race',
  'age',
  'education',
  'smokeintensity',
  'smokeyrs',
  'exercise',
  'active',
  'wt71'
];

/** The decision of R's read.csv that names the file it reads: the chip nhefs.csv. */
function readsFile(file: string, line: number): IDecision {
  return {
    name: 'file',
    value: `"${file}"`,
    provenance: 'literal',
    param: 'file',
    function: 'utils::read.csv',
    calls: [{ line, col: 11, target: file.replace(/\.csv$/, '') }]
  };
}

/** A code cell of the run, with the analysis that the kernel gave it. */
function runCell(
  id: string,
  count: number,
  source: string,
  analysis: {
    defs: string[];
    uses: string[];
    columns?: Record<string, string[]>;
    decisions?: IDecision[];
  }
): IBenchCell {
  return {
    id,
    count,
    source,
    meta: {
      question: QUESTION,
      asked_by: 'user',
      written_by: 'agent',
      agent: { run: RUN, step: count },
      analysis: storedAnalysis(
        {
          defs: analysis.defs,
          uses: analysis.uses,
          formulas: [],
          columns: analysis.columns ?? {},
          decisions: analysis.decisions ?? [],
          attachments: []
        },
        source
      )
    }
  };
}

const READ =
  'nhefs_R <- read.csv("nhefs.csv")\ncodebook_R <- read.csv("nhefs_codebook.csv")';
const PREPARE =
  'vars_R <- c("qsmk","wt82_71")\nanalysis_R <- nhefs_R[complete.cases(nhefs_R[, vars_R]), vars_R]';
const FIT =
  'fit_R <- lm(wt82_71 ~ qsmk, data=analysis_R)\ncore_estimates_R <- data.frame(Variance = c("HC3 robust", "Classical"))';

/** A frame as the notebook keeps it from the last run, with its columns. */
function frame(name: string, cell: string, rows: number, columns: string[]) {
  return {
    name,
    label: name,
    kind: 'dataframe',
    type: 'data.frame',
    rows,
    n_columns: columns.length,
    columns: columns.map(label => ({ label, kind: 'numeric', tag: 'num' })),
    cell
  };
}

/** nhefs_results_R.ipynb after the run: its introduction and three of its cells. */
function rNotebook(): any {
  const nhefs = [
    'seqn',
    ...COVARIATES,
    ...Array.from({ length: 52 }, (_, index) => `other_${index}`)
  ];
  const content = notebookOf([
    {
      id: 'intro',
      type: 'markdown',
      source:
        '# Untitled, in R\n\nWhybook’s agent made this notebook for the question "Would I get the same results in R?".',
      meta: {
        question: QUESTION,
        asked_by: 'user',
        written_by: 'agent',
        agent: { run: RUN, step: 1 }
      }
    },
    runCell('read', 1, READ, {
      defs: ['codebook_R', 'nhefs_R'],
      uses: ['codebook_R', 'nhefs_R'],
      decisions: [readsFile('nhefs.csv', 1), readsFile('nhefs_codebook.csv', 2)]
    }),
    runCell('prepare', 4, PREPARE, {
      defs: ['analysis_R', 'vars_R'],
      uses: ['analysis_R', 'nhefs_R', 'vars_R'],
      columns: { analysis_R: COVARIATES, nhefs_R: COVARIATES }
    }),
    runCell('fit', 5, FIT, {
      defs: ['core_estimates_R', 'fit_R'],
      uses: ['analysis_R', 'core_estimates_R', 'fit_R'],
      columns: { analysis_R: ['qsmk', 'wt82_71'] }
    })
  ]);
  content.metadata = {
    kernelspec: {
      name: 'r-sandboxed',
      display_name: 'R 4.4.3 (xr, sandboxed)',
      language: 'R'
    },
    whybook: {
      variables: [
        frame('codebook_R', 'read', 64, ['variable', 'description']),
        frame('nhefs_R', 'read', 1629, nhefs),
        frame('analysis_R', 'prepare', 1566, COVARIATES),
        frame('core_estimates_R', 'fit', 2, [
          'Variance',
          'Adjusted difference (kg)',
          '95% CI lower'
        ]),
        { name: 'fit_R', label: 'fit_R', kind: 'other', cell: 'fit' }
      ],
      agent_runs: {
        [RUN]: {
          question: QUESTION.text,
          provider: 'openrouter',
          model: 'x',
          cost_usd: 0.1,
          cells: ['intro', 'read', 'prepare', 'fit'],
          files: [],
          state: 'done',
          at: '2026-10-08T10:00:00.000Z'
        }
      }
    }
  } as any;
  return content;
}

describe('the Exploration panel of a notebook that an agent’s run made', () => {
  it('lists the tables that the run read from files, with the columns that its cells use, and leaves out the frames of its steps', () => {
    const { model } = benchModel(rNotebook(), {
      path: 'nhefs_results_R.ipynb'
    });
    try {
      // Every name is the run's.
      expect(model.mainVariables()).toEqual([]);
      expect(
        coverage(model).map(row => [row.label, row.used, row.total])
      ).toEqual([
        ['nhefs_R', 11, 64],
        ['codebook_R', 0, 2]
      ]);
    } finally {
      model.dispose();
    }
  });

  it('does not ask to run the notebook, and does not warn of few causal questions in a notebook that asks none', async () => {
    const { model } = benchModel(rNotebook(), {
      path: 'nhefs_results_R.ipynb'
    });
    const view = await mount(<ExplorationPanel model={model} />);
    try {
      const text = view.host.textContent ?? '';
      expect(text).not.toContain('Run the notebook');
      expect(text).not.toContain('Few causal questions');
      expect(text).not.toContain('Good spread');
      // The one question, a model check, counts.
      expect(
        view.host.querySelector('.jp-Epi-block-head .jp-Epi-big')?.textContent
      ).toBe('1');
    } finally {
      await view.unmount();
      model.dispose();
    }
  });
});

/** A notebook whose cells answer these questions, each of its type. */
function askedNotebook(types: string[]): any {
  return notebookOf(
    types.map((type, index) => ({
      id: `q${index}`,
      count: index + 1,
      source: `x${index} = ${index}`,
      meta: { question: { id: `q:${index}`, text: `Question ${index}`, type } }
    }))
  );
}

describe('the line under Questions asked', () => {
  async function caption(types: string[]): Promise<string[]> {
    const { model } = benchModel(askedNotebook(types));
    const view = await mount(<ExplorationPanel model={model} />);
    try {
      const block = view.host.querySelector('.jp-Epi-block')!;
      return Array.from(block.querySelectorAll('.jp-Epi-caption')).map(
        node => node.textContent ?? ''
      );
    } finally {
      await view.unmount();
      model.dispose();
    }
  }

  it('warns of few causal questions once one is asked among many others', async () => {
    expect(
      await caption([
        'causal',
        ...Array.from({ length: 7 }, () => 'descriptive')
      ])
    ).toEqual([
      'Few causal questions so far: the effect estimate rests on untested paths.'
    ]);
  });

  it('says nothing of causal questions while none is asked', async () => {
    expect(await caption(['descriptive', 'descriptive', 'quality'])).toEqual(
      []
    );
  });

  it('praises the spread once causal questions are 15% or more, and says when none is asked', async () => {
    expect(await caption(['causal', 'descriptive', 'association'])).toEqual([
      'Good spread across question types.'
    ]);
    expect(await caption([])).toEqual(['No questions yet.']);
  });
});
