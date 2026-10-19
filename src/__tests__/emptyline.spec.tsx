/**
 * A run of empty code cells takes one line on the bench, "6 empty code
 * cells", with no label, where each was a card "Empty cell" with Run and
 * Show code (SectionBlock in src/ui/bench.tsx). An empty cell that holds
 * anything else keeps its card: its code open in the card, outputs, a branch,
 * or what a model wrote about it. The Code view and JupyterLab's notebook
 * still show each cell.
 */
import * as React from 'react';

import { Bench } from '../ui/bench';
import type { IBenchCell } from './fakes/bench-fake';
import { benchModel, typeKey } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

const EMPTY = (id: string, source = ''): IBenchCell => ({ id, source });

/** The cards, the texts and the lines of empty cells on the bench, in order. */
function shown(host: Element): string[] {
  return Array.from(
    host.querySelectorAll(
      '.jp-Epi-bench .jp-Epi-cell, .jp-Epi-bench .jp-Epi-note, .jp-Epi-emptycells'
    )
  ).map(node =>
    node.classList.contains('jp-Epi-emptycells')
      ? `line: ${node.textContent}`
      : node.classList.contains('jp-Epi-note')
        ? 'text'
        : `card: ${node.querySelector('.jp-Epi-title')?.textContent}`
  );
}

async function bench(cells: IBenchCell[]) {
  const { nb, model } = benchModel(cells);
  const view = await mount(
    <Bench model={model} editorServices={null} openFile={() => undefined} />
  );
  await settle();
  return {
    nb,
    model,
    view,
    done: async () => {
      await view.unmount();
      model.dispose();
    }
  };
}

describe('empty code cells on the bench', () => {
  it('take one line for each run, which counts them and has no label', async () => {
    const { view, done } = await bench([
      { id: 'resp', source: 'resp = nsfg.ReadFemResp()', count: 41 },
      EMPTY('e1'),
      EMPTY('e2'),
      EMPTY('e3', '  \n'),
      EMPTY('e4'),
      EMPTY('e5'),
      EMPTY('e6', '\n'),
      {
        id: 'exercise',
        type: 'markdown',
        source: '**Exercise:** select the respondents with two live births.'
      },
      { id: 'live', source: 'live, firsts, others = first.MakeFrames()' },
      EMPTY('last')
    ]);
    const found = shown(view.host);
    const lines = Array.from(
      view.host.querySelectorAll('.jp-Epi-emptycells')
    ).map(line => line.querySelectorAll('.jp-Epi-label').length);
    const text = view.host.textContent ?? '';
    await done();
    expect(found).toEqual([
      'card: resp = nsfg.ReadFemResp()',
      'line: 6 empty code cells',
      'text',
      'card: live, firsts, others = first.MakeFrames()',
      'line: An empty code cell'
    ]);
    expect(lines).toEqual([0, 0]);
    expect(text).not.toContain('Empty cell');
  });

  it('take a line on each side of a text between them', async () => {
    const { view, done } = await bench([
      { id: 'a', source: 'x = 1' },
      EMPTY('e1'),
      EMPTY('e2'),
      { id: 'note', type: 'markdown', source: 'Some words.' },
      EMPTY('e3')
    ]);
    const found = shown(view.host);
    await done();
    expect(found).toEqual([
      'card: x = 1',
      'line: 2 empty code cells',
      'text',
      'line: An empty code cell'
    ]);
  });

  it('take one line across a text that the bench does not draw', async () => {
    const { view, done } = await bench([
      { id: 'a', source: 'x = 1' },
      EMPTY('e1'),
      { id: 'blank', type: 'markdown', source: '' },
      EMPTY('e2')
    ]);
    const found = shown(view.host);
    await done();
    expect(found).toEqual(['card: x = 1', 'line: 2 empty code cells']);
  });

  it('leave a card to an empty cell whose code is open, which has outputs, or which a model wrote about', async () => {
    const { model, view, done } = await bench([
      { id: 'a', source: 'x = 1' },
      EMPTY('e1'),
      EMPTY('open'),
      EMPTY('e2'),
      {
        id: 'printed',
        source: '',
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }]
      },
      {
        id: 'asked',
        source: '',
        meta: {
          question: { id: 'q', text: 'How many rows?', type: 'descriptive' }
        }
      },
      EMPTY('e3')
    ]);
    // Show code of a card: the analyst deletes all its code in the editor.
    await step(() => model.toggleCode('open'));
    await settle();
    const found = shown(view.host);
    await done();
    expect(found).toEqual([
      'card: x = 1',
      'line: An empty code cell',
      'card: Empty cell',
      'line: An empty code cell',
      'card: Empty cell',
      'card: How many rows?',
      'line: An empty code cell'
    ]);
  });

  it('leave the line to a cell that gets code, which takes its card again', async () => {
    const { nb, view, done } = await bench([
      { id: 'a', source: 'x = 1' },
      EMPTY('e1'),
      EMPTY('e2'),
      EMPTY('e3')
    ]);
    const before = shown(view.host);
    // The analyst types in the second empty cell, in JupyterLab's notebook.
    await step(() => typeKey(nb, 'e2', 'y'));
    await settle();
    const after = shown(view.host);
    await done();
    expect(before).toEqual(['card: x = 1', 'line: 3 empty code cells']);
    expect(after).toEqual([
      'card: x = 1',
      'line: An empty code cell',
      'card: y',
      'line: An empty code cell'
    ]);
  });
});
