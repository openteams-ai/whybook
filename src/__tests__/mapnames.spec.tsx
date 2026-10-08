/**
 * The data nodes of the map grow with the names of their frames, up to a
 * limit, and a longer name is cut inside its node (design iteration 1.104).
 * In the YRBS demo video, yrbs2025_codebook ran past the edge of its node,
 * which was 110 px wide whatever its name. jsdom has no canvas, so the map
 * counts 7.8 px a character of the code font here; the browser measures the
 * names (ui-tests/tests/map-names.spec.ts).
 */
import './fakes/quiet';

import * as React from 'react';

import type { IStoredVariable } from '../model/restore';
import { fingerprint } from '../model/tables';
import { MapView, mapLayout } from '../ui/map';
import { benchModel, notebookOf } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

const LONG = 'stdint_standardized_bootstrap_result';
const NAMES = ['d', 'yrbs2025', 'yrbs2025_codebook', LONG];

/** A notebook whose first cell made frames of these names, kept from its last run. */
function framesNotebook(names: string[]) {
  const source = names.map(name => `${name} = pd.DataFrame()`).join('\n');
  const content = notebookOf([
    {
      id: 'load',
      source,
      count: 1,
      meta: {
        analysis: {
          defs: names,
          uses: ['pd'],
          formulas: [],
          columns: {},
          decisions: [],
          attachments: [],
          source: fingerprint(source)
        }
      }
    },
    { id: 'next', source: 'n = len(d)', count: 2 }
  ]);
  const variables: IStoredVariable[] = names.map(
    name =>
      ({
        name,
        kind: 'dataframe',
        type: 'pandas.DataFrame',
        rows: 10,
        n_columns: 3,
        cell: 'load'
      }) as IStoredVariable
  );
  content.metadata = { whybook: { variables } } as any;
  return content;
}

describe('the data nodes of the map', () => {
  it('keep 110 px for a short name, grow with a longer one up to 180 px, and stand 20 px apart', () => {
    const { model } = benchModel(framesNotebook(NAMES));
    try {
      const layout = mapLayout(model);
      const frames = layout.nodes.filter(node => node.kind === 'frame');
      expect(frames.map(node => node.label)).toEqual(NAMES);
      const width = Object.fromEntries(
        frames.map(node => [node.label, node.w])
      );
      // d and yrbs2025 fit the node they had.
      expect(width['d']).toBe(110);
      expect(width['yrbs2025']).toBe(110);
      // 17 characters, and 23 px of padding, border and a pixel to spare.
      expect(width['yrbs2025_codebook']).toBe(Math.ceil(17 * 7.8 + 23));
      expect(width[LONG]).toBe(180);
      // In a row, each one 20 px after the one before.
      frames.slice(1).forEach((node, index) => {
        const before = frames[index];
        expect(node.x - (before.x + before.w)).toBe(20);
        expect(node.y).toBe(before.y);
      });
      // The map is as wide as the row.
      const last = frames[frames.length - 1];
      expect(layout.width).toBeGreaterThanOrEqual(last.x + last.w);
    } finally {
      model.dispose();
    }
  });

  it('draw the whole name, which the stylesheet cuts, with the whole name in the title', async () => {
    const { model } = benchModel(framesNotebook(NAMES));
    const view = await mount(<MapView model={model} />);
    try {
      await settle();
      const node = view.host.querySelector<HTMLButtonElement>(
        `.jp-Epi-map-frame[data-variable="${LONG}"]`
      )!;
      expect(node.style.width).toBe('180px');
      // A screen reader reads the button's text, the whole name: the
      // ellipsis is drawn by the stylesheet alone.
      const name = node.querySelector('.jp-Epi-map-frame-name')!;
      expect(name.textContent).toBe(LONG);
      expect(node.textContent).toBe(LONG);
      // The frames come from the notebook, and no kernel runs here.
      expect(node.title).toBe(`${LONG}, from the last run: not in the kernel`);
    } finally {
      await view.unmount();
      model.dispose();
    }
  });
});
