/**
 * A section of the bench that holds no cells, such as a heading followed at
 * once by another heading, shows its heading alone: its number and its
 * title, with no "0 cells" count and no expander (SectionBlock in
 * src/ui/bench.tsx). The other sections keep their count and their expander,
 * and every section keeps its number.
 */
import * as React from 'react';

import { Bench } from '../ui/bench';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

/** The top of chapter 12 of Python Polars: The Definitive Guide. */
const CHAPTER = [
  {
    id: 'h0',
    type: 'markdown' as const,
    source: '# Chapter 12. Working with strings'
  },
  { id: 'import', source: 'import polars as pl' },
  { id: 'h1', type: 'markdown' as const, source: '## String' },
  { id: 'h2', type: 'markdown' as const, source: '### String Methods' },
  {
    id: 'h3',
    type: 'markdown' as const,
    source: '### String methods for conversion'
  },
  {
    id: 'h4',
    type: 'markdown' as const,
    source: '## String Examples\n\nA corpus of posts.'
  },
  { id: 'corpus', source: 'corpus = pl.read_csv("data/posts.csv")' },
  { id: 'h5', type: 'markdown' as const, source: '## Notes' },
  { id: 'note', type: 'markdown' as const, source: 'Strings are UTF-8.' }
];

/** Each section head on the bench: what it shows, and what it holds. */
function heads(host: Element) {
  return Array.from(host.querySelectorAll('.jp-Epi-sectionhead')).map(head => ({
    text: head.textContent,
    count: head.querySelector('.jp-Epi-sectioncount')?.textContent ?? null,
    expander: !!head.querySelector('.jp-Epi-chevron'),
    button: head.tagName === 'BUTTON',
    expanded: head.getAttribute('aria-expanded')
  }));
}

describe('a section with no cells', () => {
  it('shows its number and its title alone, with no count and no expander', async () => {
    const { model } = benchModel(CHAPTER);
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await settle();
    const found = heads(view.host);
    await view.unmount();
    model.dispose();
    expect(found).toEqual([
      {
        text: '§0Notebook1 cell',
        count: '1 cell',
        expander: true,
        button: true,
        expanded: 'true'
      },
      {
        text: '§1String',
        count: null,
        expander: false,
        button: false,
        expanded: null
      },
      {
        text: '§2String Methods',
        count: null,
        expander: false,
        button: false,
        expanded: null
      },
      {
        text: '§3String methods for conversion',
        count: null,
        expander: false,
        button: false,
        expanded: null
      },
      {
        text: '§4String Examples1 cell',
        count: '1 cell',
        expander: true,
        button: true,
        expanded: 'true'
      },
      // A section with a text and no code says so, as before.
      {
        text: '§5Notestext',
        count: 'text',
        expander: true,
        button: true,
        expanded: 'true'
      }
    ]);
  });
});
