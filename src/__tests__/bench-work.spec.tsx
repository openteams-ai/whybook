/**
 * The work of a change grows with what changed, not with the notebook: the
 * view model keeps the objects of the cells that did not change (cells() in
 * src/model/epimodel.ts), a card draws again only when its cell or the
 * model's revision changes (src/ui/bench.tsx), the map lays itself out once
 * per change (src/ui/map.tsx), and the sections are found once per change.
 * Each test counts reads or drawings at two sizes of notebook.
 */
import * as React from 'react';

import { storedAnalysis } from '../model/restore';
import { Bench } from '../ui/bench';
import { MapView } from '../ui/map';
import type { IBenchCell } from './fakes/bench-fake';
import { benchModel, typeKey } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

/** A notebook of n cells: a section with a text every ten cells, code between. */
function cells(n: number): IBenchCell[] {
  const made: IBenchCell[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) {
      made.push({
        id: `h${i}`,
        type: 'markdown',
        source: `## Step ${i}\n\nWhat step ${i} does.`
      });
    } else {
      const source = `x${i} = diary["pain"].mean() + ${i}`;
      const analysis = {
        defs: [`x${i}`],
        uses: ['diary'],
        formulas: [],
        columns: {},
        decisions: []
      };
      made.push({
        id: `c${i}`,
        source,
        count: i,
        meta: { analysis: storedAnalysis(analysis as any, source) }
      });
    }
  }
  return made;
}

describe('A key typed in one cell', () => {
  it('makes a new object for that cell alone', () => {
    const { nb, model } = benchModel(cells(200));
    const before = model.cells();
    typeKey(nb, 'c7');
    const after = model.cells();
    const changed = after
      .filter((cell, index) => cell !== before[index])
      .map(cell => cell.id);
    model.dispose();
    expect(changed).toEqual(['c7']);
  });

  it('reads each cell of the notebook a bounded number of times', () => {
    const reads = (n: number) => {
      const { nb, model } = benchModel(cells(n));
      model.cells();
      typeKey(nb, 'c1');
      let count = 0;
      const get = nb.cells.get.bind(nb.cells);
      (nb.cells as any).get = (index: number) => {
        count++;
        return get(index);
      };
      model.cells();
      model.dispose();
      return count;
    };
    // Looking up the analysis that each cell kept read the notebook from
    // its start for every code cell: 113,900 reads at 500 cells.
    expect([reads(50), reads(500)]).toEqual([50, 500]);
  });

  it('draws one card of the bench again, however long the notebook', async () => {
    const drawn = async (n: number) => {
      const { nb, model } = benchModel(cells(n));
      const view = await mount(
        <Bench model={model} editorServices={null} openFile={() => undefined} />
      );
      await settle();
      await settle();
      // Each card draws its title once.
      const state = jest.spyOn(model.cellTitles, 'state');
      // In the first line of a cell without a title: its title changes too.
      await step(() => typeKey(nb, 'c1'));
      await settle();
      const cards = state.mock.calls.length;
      await view.unmount();
      model.dispose();
      return cards;
    };
    expect([await drawn(20), await drawn(200)]).toEqual([1, 1]);
  });

  it('reads the code of one text on the bench, however long the notebook', async () => {
    const reads = async (n: number) => {
      const { nb, model } = benchModel(cells(n));
      const view = await mount(
        <Bench model={model} editorServices={null} openFile={() => undefined} />
      );
      await settle();
      await settle();
      let count = 0;
      for (let i = 0; i < nb.cells.length; i++) {
        const shared = nb.cells.get(i).sharedModel;
        const read = shared.getSource.bind(shared);
        shared.getSource = () => {
          count++;
          return read();
        };
      }
      await step(() => typeKey(nb, 'h10', 'W'));
      await settle();
      await view.unmount();
      model.dispose();
      return count;
    };
    const small = await reads(20);
    expect(await reads(200)).toBe(small);
  });
});

describe('The map', () => {
  it('lays itself out once per change, and not for a wheel event', async () => {
    const { nb, model } = benchModel(cells(100));
    const view = await mount(<MapView model={model} />);
    await settle();
    await settle();
    // One layout reads the definitions once, and the tooltip of each text
    // names the text once.
    const layouts = jest.spyOn(model, 'definitions');
    const tooltips = jest.spyOn(model, 'noteLabel');
    const viewport = view.host.querySelector('.jp-Epi-map-viewport')!;
    for (let i = 0; i < 5; i++) {
      await step(() => {
        viewport.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: 40,
            bubbles: true,
            cancelable: true
          })
        );
      });
    }
    const wheel = {
      layouts: layouts.mock.calls.length,
      tooltips: tooltips.mock.calls.length
    };
    await step(() => typeKey(nb, 'c1'));
    await settle();
    const key = {
      layouts: layouts.mock.calls.length,
      tooltips: tooltips.mock.calls.length
    };
    await view.unmount();
    model.dispose();
    expect({ wheel, key }).toEqual({
      wheel: { layouts: 0, tooltips: 0 },
      key: { layouts: 1, tooltips: 10 }
    });
  });
});

describe('The cells of a request and the tooltips of texts', () => {
  it('find the sections once, however long the notebook', () => {
    const checks = (n: number) => {
      const { model } = benchModel(cells(n));
      const texts = model.cells().filter(cell => cell.type === 'markdown');
      // Finding the sections asks once of each text whether it has words.
      const asked = jest.spyOn(model, 'isNote');
      model.codeCells().map(cell => model.cellJSON(cell));
      texts.forEach(text => model.noteLabel(text));
      model.dispose();
      return asked.mock.calls.length / texts.length;
    };
    // Each cell of a request and each tooltip found the sections again: at
    // 1,000 cells each text was asked 1,000 times.
    expect([checks(100), checks(1000)]).toEqual([1, 1]);
  });
});
