/**
 * The head of Contents (design iteration 1.11): with a variable selected,
 * the head is the variable's name alone, such as "weekly", with no "of"
 * before it.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContentsSection } from '../ui/variables';

const signal = { connect: () => undefined, disconnect: () => undefined };

/** Contents, drawn for a view model where `selected` is the selected variable. */
function contents(selected: string | null): string {
  const model: any = {
    selected,
    changed: signal,
    variable: (name: string) =>
      name === 'weekly'
        ? {
            name: 'weekly',
            label: 'weekly',
            kind: 'other',
            type: 'list',
            length: 3
          }
        : null,
    variableCells: () => ({ made: [], imported: [], used: [] })
  };
  return renderToStaticMarkup(<ContentsSection model={model} />);
}

/** What the head of the section holds, as markup. */
function head(markup: string): string {
  return /<div class="jp-Epi-section-head[^"]*">([\s\S]*?)<\/div>/.exec(
    markup
  )![1];
}

describe('the head of Contents', () => {
  it('is the name of the selected variable alone, after the title that the side panel hides', () => {
    expect(head(contents('weekly'))).toBe(
      '<span class="jp-Epi-head-label">Contents</span><code>weekly</code>'
    );
  });

  it('has no name with nothing selected, and the side panel hides it', () => {
    const markup = contents(null);
    expect(markup).toContain('class="jp-Epi-section-head jp-mod-empty"');
    expect(head(markup)).toBe(
      '<span class="jp-Epi-head-label">Contents</span>'
    );
  });
});
