/**
 * Sections: the first level-one heading is the notebook's title, and every
 * other heading starts a section, whatever its level (sections() and cells()
 * in src/model/epimodel.ts). A text keeps its card on the bench while its
 * editor is open, with or without words (NoteCard and TopCell in
 * src/ui/bench.tsx).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';

import { Bench } from '../ui/bench';
import { MapView } from '../ui/map';
import { benchModel } from './fakes/bench-fake';
import { button, mount, settle, step } from './fakes/bench-render';

/** Editors that are text areas in the editor's host, as CodeMirror is. */
function textEditors() {
  return {
    factoryService: {
      newInlineEditor: ({ host }: { host: HTMLElement }) => {
        const area = document.createElement('textarea');
        host.appendChild(area);
        return {
          focus: () => area.focus(),
          hasFocus: () => document.activeElement === area,
          setOptions: () => undefined,
          undo: () => undefined,
          redo: () => undefined,
          dispose: () => area.remove()
        };
      }
    }
  } as any;
}

const BY_LEVEL_ONE = [
  { id: 'h1', type: 'markdown' as const, source: '# Pain diary study' },
  { id: 'a', source: "diary = pd.read_csv('diary.csv')", count: 1 },
  { id: 'h2', type: 'markdown' as const, source: '# Weekly means' },
  { id: 'b', source: 'weekly = diary.groupby("week").mean()', count: 2 },
  { id: 'h3', type: 'markdown' as const, source: '# Model' },
  { id: 'c', source: 'fit = ols(weekly)', count: 3 }
];

describe('A notebook that uses # for each section', () => {
  it('numbers the sections from 1 after the cells before the first heading', () => {
    // §0 holds the cells before the first heading; the numbers read §0, §2,
    // §3 before 30 September, since §0 counted as the first section.
    const { model } = benchModel(BY_LEVEL_ONE);
    const numbers = model
      .sections()
      .sections.map(section => [section.number, section.title]);
    const label = model.noteLabel(model.cell('h3')!);
    model.dispose();
    expect(numbers).toEqual([
      [0, 'Notebook'],
      [1, 'Weekly means'],
      [2, 'Model']
    ]);
    expect(label).toBe('§2 Model');
  });

  it('numbers the sections from 1 when a heading follows the title', () => {
    const { model } = benchModel(BY_LEVEL_ONE.filter(cell => cell.id !== 'a'));
    const numbers = model
      .sections()
      .sections.map(section => [section.number, section.title]);
    model.dispose();
    expect(numbers).toEqual([
      [1, 'Weekly means'],
      [2, 'Model']
    ]);
  });

  it('starts a section at every heading after the title', () => {
    const { model } = benchModel(BY_LEVEL_ONE);
    const { title, sections } = model.sections();
    const found = {
      title,
      sections: sections.map(section => [
        section.title,
        section.cells.map(cell => cell.id)
      ]),
      b: model.cell('b')?.sectionId,
      // The number of a section is left out: the test above checks it.
      label: model.noteLabel(model.cell('h3')!).replace(/^§\d+ /, '§ ')
    };
    model.dispose();
    expect(found).toEqual({
      title: 'Pain diary study',
      sections: [
        ['Notebook', ['a']],
        ['Weekly means', ['b']],
        ['Model', ['c']]
      ],
      b: 'h2',
      label: '§ Model'
    });
  });

  it('shows every heading on the bench and on the map', async () => {
    const { model } = benchModel(BY_LEVEL_ONE);
    const bench = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await settle();
    const text = bench.host.textContent ?? '';
    await bench.unmount();
    const map = await mount(<MapView model={model} />);
    await settle();
    const bands = Array.from(
      map.host.querySelectorAll('.jp-Epi-map-band span')
    ).map(band => band.textContent?.replace(/^§\d+ /, '§ '));
    await map.unmount();
    model.dispose();
    expect({
      bench: ['Pain diary study', 'Weekly means', 'Model'].filter(
        heading => !text.includes(heading)
      ),
      map: bands
    }).toEqual({
      bench: [],
      map: ['§ Notebook', '§ Weekly means', '§ Model']
    });
  });
});

describe('The demo notebooks', () => {
  const demos = [
    'examples/pain_diary/pain_diary_cohort.ipynb',
    'examples/pain_diary/pain_diary_cohort_6h.ipynb',
    'examples/home_energy/home_energy.ipynb'
  ];

  it.each(demos)('keep their sections: %s', file => {
    const content = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')
    );
    // The sections as they were: a heading of level two to six starts one.
    const expected: string[] = [];
    const home = new Map<string, string>();
    let current = 'top';
    for (const cell of content.cells) {
      const source = Array.isArray(cell.source)
        ? cell.source.join('')
        : cell.source;
      const first =
        source.split('\n').find((line: string) => line.trim()) ?? '';
      const heading = /^(#{2,6})\s+(.+)$/.exec(first);
      if (cell.cell_type === 'markdown' && heading) {
        expected.push(heading[2].trim());
        current = cell.id;
      }
      if (cell.cell_type === 'code') {
        home.set(cell.id, current);
      }
    }
    const { model } = benchModel(content);
    const sections = model
      .sections()
      .sections.filter(section => section.number > 0)
      .map(section => section.title);
    const moved = [...home].filter(
      ([id, sectionId]) => model.cell(id)?.sectionId !== sectionId
    );
    model.dispose();
    expect(expected.length).toBeGreaterThan(2);
    expect({ sections, moved }).toEqual({ sections: expected, moved: [] });
  });
});

describe('A text whose words are deleted in its editor', () => {
  async function editThenEmpty(source: string, emptied: string) {
    const { nb, model } = benchModel([
      { id: 'h', type: 'markdown', source: '## Results' },
      { id: 'a', source: 'fit = ols(diary)', count: 1 },
      { id: 't', type: 'markdown', source }
    ]);
    const view = await mount(
      <Bench
        model={model}
        editorServices={textEditors()}
        openFile={() => undefined}
      />
    );
    await settle();
    const note = () =>
      view.host.querySelector('.jp-Epi-note[data-cell-id="t"]');
    await step(() => button(note()!, 'Edit').click());
    const opened = !!view.host.querySelector('textarea');
    // The analyst deletes the words: the cell's source changes.
    nb.cells.get(2).sharedModel.setSource(emptied);
    await settle();
    const kept = !!view.host.querySelector('textarea');
    // Done closes the editor: a text with no words has no card.
    await step(() => button(note()!, 'Done').click());
    await settle();
    const after = !!note();
    await view.unmount();
    model.dispose();
    return { opened, kept, after };
  }

  it('keeps its card and its editor while the editor is open', async () => {
    expect(await editThenEmpty('Pain drops after week 3.', '')).toEqual({
      opened: true,
      kept: true,
      after: false
    });
  });

  it('keeps them for a text under its own heading too', async () => {
    expect(
      await editThenEmpty(
        '### Week 3\nPain drops after week 3.',
        '### Week 3\n'
      )
    ).toEqual({ opened: true, kept: true, after: false });
  });
});
