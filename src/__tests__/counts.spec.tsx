import './fakes/quiet';

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EpiModel } from '../model/epimodel';
import type { IDecision, IVariable } from '../tokens';
import { ExplorationCounts } from '../ui/counts';
import { openAssumptions } from '../ui/exploration';

/** The counts as the panel reads them: "1 subanalysis", "2 subanalyses". */
function counts(markup: string): string[] {
  return [...markup.matchAll(/<div[^>]*>(<span[^>]*>.*?<\/span>)+<\/div>/g)]
    .map(match => match[0].replace(/<[^>]+>/g, ' ').trim())
    .map(text => text.replace(/\s+/g, ' '));
}

describe('ExplorationCounts', () => {
  it('writes a count of one in the singular', () => {
    const markup = renderToStaticMarkup(
      <ExplorationCounts branches={1} assumptions={1} guesses={1} />
    );
    expect(counts(markup)).toEqual([
      '1 subanalysis',
      '1 open assumption',
      '1 guess'
    ]);
  });

  it('writes other counts in the plural, and no guesses when that is off', () => {
    const markup = renderToStaticMarkup(
      <ExplorationCounts branches={2} assumptions={13} guesses={null} />
    );
    expect(counts(markup)).toEqual(['2 subanalyses', '13 open assumptions']);
  });
});

describe('The count of open assumptions', () => {
  // The first cell of the NHEFS video: header infer of Whybook's own list,
  // and sep comma and na_values None that the video's model picked. The
  // panel counted 3 open assumptions after it.
  const call = [{ line: 1, col: 8, target: 'nhefs' }];
  const found = { by: null, library: 'pandas', version: '3.0.6' };
  const read: IDecision[] = [
    {
      name: 'header',
      value: "'infer'",
      provenance: 'library_default',
      param: 'header',
      function: 'pandas.read_csv',
      calls: call
    },
    {
      name: 'sep',
      value: "','",
      provenance: 'library_default',
      param: 'sep',
      function: 'read_csv',
      calls: call,
      found
    },
    {
      name: 'na_values',
      value: 'None',
      provenance: 'library_default',
      param: 'na_values',
      function: 'read_csv',
      calls: call,
      found
    },
    {
      name: 'filepath_or_buffer',
      value: "'nhefs.csv'",
      provenance: 'you',
      param: 'filepath_or_buffer',
      function: 'read_csv',
      calls: call
    }
  ];
  // A later cell: a merge that leaves its inner join, and a constant of the
  // analyst's prep.py that the cell leaves at its default.
  const weekly: IDecision[] = [
    {
      name: 'MIN_DAYS',
      value: '14',
      provenance: 'defaulted',
      param: 'min_days',
      function: 'weekly_means',
      source: { file: 'prep.py', line: 12 }
    },
    {
      name: 'how',
      value: "'inner'",
      provenance: 'library_default',
      param: 'how',
      function: 'DataFrame.merge'
    }
  ];

  /** The two cells, after a run whose read made nhefs with these columns. */
  function model(columns: string[]): EpiModel {
    const nhefs: IVariable = {
      name: 'nhefs',
      label: 'nhefs',
      kind: 'dataframe',
      rows: 1629,
      columns: columns.map(label => ({
        name: `nhefs[${JSON.stringify(label)}]`,
        label,
        parent: 'nhefs',
        kind: 'numeric',
        tag: 'num'
      }))
    };
    return {
      codeCells: () => [
        { decisions: read, analysis: { defs: ['nhefs'] } },
        { decisions: weekly, analysis: { defs: ['weekly'] } }
      ],
      variables: () => [nhefs]
    } as unknown as EpiModel;
  }

  it('leaves out the library defaults that no rule shows to change a result', () => {
    expect(openAssumptions(model(['seqn', 'qsmk', 'wt82_71']))).toBe(1);
  });

  it('counts the defaults of a read whose frame looks wrong', () => {
    expect(openAssumptions(model(['seqn;qsmk;wt82_71']))).toBe(4);
  });
});
