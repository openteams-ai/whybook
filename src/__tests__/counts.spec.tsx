import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ExplorationCounts } from '../ui/counts';

/** The counts as the panel reads them: "1 pivot", "2 subanalyses". */
function counts(markup: string): string[] {
  return [...markup.matchAll(/<div[^>]*>(<span[^>]*>.*?<\/span>)+<\/div>/g)]
    .map(match => match[0].replace(/<[^>]+>/g, ' ').trim())
    .map(text => text.replace(/\s+/g, ' '));
}

describe('ExplorationCounts', () => {
  it('writes a count of one in the singular', () => {
    const markup = renderToStaticMarkup(
      <ExplorationCounts pivots={1} branches={1} assumptions={1} guesses={1} />
    );
    expect(counts(markup)).toEqual([
      '1 pivot',
      '1 subanalysis',
      '1 open assumption',
      '1 guess'
    ]);
  });

  it('writes other counts in the plural, and no guesses when that is off', () => {
    const markup = renderToStaticMarkup(
      <ExplorationCounts
        pivots={0}
        branches={2}
        assumptions={13}
        guesses={null}
      />
    );
    expect(counts(markup)).toEqual([
      '0 pivots',
      '2 subanalyses',
      '13 open assumptions'
    ]);
  });
});
