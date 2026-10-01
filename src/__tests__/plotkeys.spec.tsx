/**
 * Questions from a plot or a picture, from the keyboard: `BarPlot` and
 * `MarkPlot` (src/ui/plot.tsx) and `ImageBrush` (src/ui/imagebrush.tsx) are
 * one Tab stop each, the arrow keys move between the marks, and Enter asks
 * what a click asks.
 */
import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { AXES_MIME } from '../model/axes';
import type { IPlotPayload } from '../tokens';
import { ImageBrush } from '../ui/imagebrush';
import { EpiPlot } from '../ui/plot';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(element: JSX.Element): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(element);
  });
}

async function key(target: Element, name: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true })
    );
  });
}

function status(): string {
  return host.querySelector('[role="status"]')?.textContent ?? '';
}

type Asked = { x0: number; x1: number; y?: [number, number] | null };

const bars: IPlotPayload = {
  version: 1,
  kind: 'bars',
  title: 'Mean pain by arm',
  x: { field: 'arm', label: 'arm' },
  y: { field: 'pain', label: 'pain' },
  source: { frame: 'diary', x: 'arm', y: 'pain', by: null, rows: 40 },
  select: 'x',
  bars: [
    { x: 'A', y: 3.1, n: 20 },
    { x: 'B', y: 4.2, n: 19 }
  ]
};

describe('a bar plot that asks about its bars', () => {
  it('is one Tab stop, and none as a thumbnail', () => {
    const markup = (thumbnail: boolean) =>
      renderToStaticMarkup(
        <EpiPlot
          payload={bars}
          width={400}
          height={220}
          thumbnail={thumbnail}
          onSelect={() => undefined}
        />
      );
    expect(markup(false).match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup(true)).not.toContain('tabindex');
  });

  it('moves between the bars with the arrow keys, and asks with Enter', async () => {
    const asked: Asked[] = [];
    await mount(
      <EpiPlot
        payload={bars}
        width={400}
        height={220}
        onSelect={(x0, x1) => asked.push({ x0, x1 })}
      />
    );
    const svg = host.querySelector('svg')!;
    await act(async () => svg.focus());
    expect(status()).toBe(
      'The arrow keys move between the bars, and Enter asks about one.'
    );
    await key(svg, 'ArrowRight');
    await key(svg, 'ArrowRight');
    expect(status()).toBe('arm B: 4.2 · 19 rows. Enter asks about it.');
    // The current bar is marked while the plot has the focus.
    expect(svg.querySelector('.jp-Epi-plot-current')).not.toBeNull();
    await key(svg, 'Enter');
    expect(asked).toEqual([{ x0: 1, x1: 1 }]);
    await key(svg, 'Home');
    await key(svg, 'Enter');
    expect(asked[1]).toEqual({ x0: 0, x1: 0 });
  });
});

describe('a plot of marks that asks about them', () => {
  async function ask(payload: IPlotPayload, keys: string[]): Promise<Asked[]> {
    const asked: Asked[] = [];
    await mount(
      <EpiPlot
        payload={payload}
        width={400}
        height={220}
        onSelect={(x0, x1, _, y) => asked.push({ x0, x1, y })}
      />
    );
    const svg = host.querySelector('svg')!;
    await act(async () => svg.focus());
    for (const name of keys) {
      await key(svg, name);
    }
    return asked;
  }

  it('moves along x of a line, and asks about a value of x', async () => {
    const asked = await ask(
      {
        version: 1,
        kind: 'ribbon',
        title: 'pain by week',
        x: { field: 'week', label: 'week' },
        y: { field: 'pain', label: 'pain' },
        source: { frame: 'diary', x: 'week', y: 'pain', by: null, rows: 60 },
        select: 'x',
        series: [
          {
            name: 'all',
            points: [1, 2, 3].map(week => ({
              x: week,
              y: 5 - week / 2,
              lo: 4 - week / 2,
              hi: 6 - week / 2,
              n: 20
            }))
          }
        ]
      },
      ['ArrowRight', 'ArrowRight', 'Enter']
    );
    expect(status()).toBe(
      'week 2. pain 4.0, 95% interval 3.0 to 5.0, 20 rows. Enter asks about it.'
    );
    expect(asked).toEqual([{ x0: 2, x1: 2, y: undefined }]);
  });

  it('moves between the points of a scatter plot in the order of x', async () => {
    const asked = await ask(
      {
        version: 1,
        kind: 'scatter',
        title: 'response by dose',
        x: { field: 'dose', label: 'dose' },
        y: { field: 'response', label: 'response' },
        source: { frame: 'trial', x: 'dose', y: 'response', by: null, rows: 3 },
        select: 'xy',
        points: [
          { x: 0.003, y: 2.5, g: null, i: 0 },
          { x: 0.001, y: 1.5, g: null, i: 1 },
          { x: 0.002, y: 2, g: null, i: 2 }
        ]
      },
      ['ArrowRight', 'End', 'Enter']
    );
    expect(status()).toBe('dose 0.003, response 2.5. Enter asks about it.');
    expect(asked).toEqual([{ x0: 0.003, x1: 0.003, y: [2.5, 2.5] }]);
  });

  it('asks about a whole bin of a histogram', async () => {
    const asked = await ask(
      {
        version: 1,
        kind: 'hist',
        title: 'Distribution of age',
        x: { field: 'age', label: 'age' },
        y: null,
        source: { frame: 'diary', x: 'age', y: null, by: null, rows: 30 },
        select: 'x',
        bins: [
          { x0: 20, x1: 40, n: 10 },
          { x0: 40, x1: 60, n: 20 }
        ]
      },
      ['ArrowRight', 'ArrowRight', 'Enter']
    );
    expect(status()).toBe('age 40 to 60: 20 rows. Enter asks about it.');
    expect(asked).toEqual([{ x0: 40, x1: 60, y: undefined }]);
  });
});

describe('a click on a histogram', () => {
  it('asks about the bin under it, as Enter does', async () => {
    const asked: Asked[] = [];
    await mount(
      <EpiPlot
        payload={{
          version: 1,
          kind: 'hist',
          title: 'Distribution of age',
          x: { field: 'age', label: 'age' },
          y: null,
          source: { frame: 'diary', x: 'age', y: null, by: null, rows: 30 },
          select: 'x',
          bins: [
            { x0: 20, x1: 40, n: 10 },
            { x0: 40, x1: 60, n: 20 }
          ]
        }}
        width={400}
        height={220}
        onSelect={(x0, x1) => asked.push({ x0, x1 })}
      />
    );
    const svg = host.querySelector('svg')!;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 220 }) as DOMRect;
    // The plot spans 44 to 388 px across: 50 px in is the first bin, of
    // age 20 to 40.
    const at = { clientX: 94, clientY: 100, bubbles: true, button: 0 };
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('mousedown', at));
    });
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('mouseup', at));
    });
    expect(asked).toEqual([{ x0: 20, x1: 40 }]);
  });
});

describe('a picture that asks about a point', () => {
  it('moves a point with the arrow keys, and asks about it with Enter', async () => {
    const asked: { x0: number; y0: number; kind: string }[] = [];
    await mount(
      <ImageBrush
        data={{ 'image/png': 'iVBORw0KGgo=' }}
        mime="image/png"
        onAskImage={pick => asked.push(pick)}
      >
        <img src="data:image/png;base64,iVBORw0KGgo=" alt="" />
      </ImageBrush>
    );
    // jsdom decodes no picture: this one is 400 by 300 pixels.
    const img = host.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 400 });
    Object.defineProperty(img, 'naturalHeight', { value: 300 });
    const frame = host.querySelector<HTMLElement>('[tabindex="0"]')!;
    expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await act(async () => frame.focus());
    // The first key puts the point in the middle; each next one moves it 2%.
    await key(frame, 'ArrowRight');
    await key(frame, 'ArrowRight');
    await key(frame, 'ArrowUp');
    expect(status()).toBe(
      'The point 52% across and 48% down the picture. Enter asks about it.'
    );
    await key(frame, 'Enter');
    await act(async () => undefined);
    expect(asked).toHaveLength(1);
    expect(asked[0].kind).toBe('point');
    expect(asked[0].x0).toBeCloseTo(0.52);
    expect(asked[0].y0).toBeCloseTo(0.48);
  });

  it('asks about the rows under the point on a figure whose axes show columns', async () => {
    const asked: Asked[] = [];
    const axes = {
      version: 1,
      library: 'matplotlib',
      image: { width: 400, height: 300, scale: 1 },
      axes: [
        {
          box: [40, 20, 380, 260],
          x: {
            limits: [0, 10],
            scale: 'linear',
            label: 'week',
            column: 'week'
          },
          y: { limits: [0, 8], scale: 'linear', label: 'pain', column: 'pain' },
          title: '',
          frame: 'diary',
          marks: 40
        }
      ]
    };
    await mount(
      <ImageBrush
        data={{ 'image/png': 'iVBORw0KGgo=', [AXES_MIME]: axes }}
        mime="image/png"
        onSelect={(_, x0, x1, __, y) => asked.push({ x0, x1, y })}
      >
        <img src="data:image/png;base64,iVBORw0KGgo=" alt="" />
      </ImageBrush>
    );
    const frame = host.querySelector<HTMLElement>('[tabindex="0"]')!;
    await act(async () => frame.focus());
    // The point starts in the middle of the Axes: week 5, pain 4.
    await key(frame, 'ArrowRight');
    expect(status()).toBe('week 5, pain 4. Enter asks about the rows there.');
    await key(frame, 'Enter');
    expect(asked).toHaveLength(1);
    expect(asked[0].x0).toBeLessThan(5);
    expect(asked[0].x1).toBeGreaterThan(5);
    expect(asked[0].y![0]).toBeLessThan(4);
    expect(asked[0].y![1]).toBeGreaterThan(4);
  });
});
