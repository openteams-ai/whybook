/**
 * The level of detail that follows the space, a trial behind the setting
 * "Level of detail follows the space" (design iteration 1.14): the width of
 * the view's column sets the level of the bench and the Code view, and the
 * zoom sets the level of the map (src/model/spacedetail.ts).
 */
import './fakes/quiet';

import * as React from 'react';
import type * as nbformat from '@jupyterlab/nbformat';
import { Sanitizer } from '@jupyterlab/apputils';
import {
  RenderMimeRegistry,
  standardRendererFactories
} from '@jupyterlab/rendermime';

import type { EpiModel } from '../model/epimodel';
import { readSettings } from '../model/settings';
import { levelOfWidth, levelOfZoom } from '../model/spacedetail';
import type { Detail, MapDetail } from '../tokens';
import { DetailSlider, DocumentView } from '../ui/document';
import { MapView } from '../ui/map';
import { benchModel } from './fakes/bench-fake';
import type { IMounted } from './fakes/bench-render';
import { mount, settle, step } from './fakes/bench-render';
import { composed } from './fakes/settings-fake';

/** The levels that the widths give one after the other. */
function byWidth(widths: number[]): Detail[] {
  let level: Detail | null = null;
  return widths.map(width => (level = levelOfWidth(width, level)));
}

/** The levels that the zooms give one after the other. */
function byZoom(zooms: number[]): MapDetail[] {
  let level: MapDetail | null = null;
  return zooms.map(zoom => (level = levelOfZoom(zoom, level)));
}

const PICTURE = 'aVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

/** A cell that prints four lines and draws a picture. */
const OUTPUTS: nbformat.IOutput[] = [
  { output_type: 'stream', name: 'stdout', text: 'one\ntwo\nthree\nfour\n' },
  { output_type: 'display_data', data: { 'image/png': PICTURE }, metadata: {} }
];

function rendermime(): RenderMimeRegistry {
  return new RenderMimeRegistry({
    initialFactories: standardRendererFactories,
    sanitizer: new Sanitizer()
  });
}

/** Move the slider to a level, as the analyst does. */
async function slide(host: Element, index: number): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('.jp-Epi-detail input')!;
  await step(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(input, String(index));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

describe('The level that the width of the view gives', () => {
  it('steps up where the outputs of a level fit, and down only 40 px below', () => {
    expect(byWidth([300])).toEqual(['overview']);
    expect(byWidth([420])).toEqual(['compact']);
    expect(byWidth([719])).toEqual(['compact']);
    expect(byWidth([720])).toEqual(['full']);
    // The window narrows from 1,000 px to 379, then widens again.
    expect(
      byWidth([1000, 700, 681, 679, 500, 381, 379, 400, 419, 420, 719, 720])
    ).toEqual([
      'full',
      'full',
      'full',
      'compact',
      'compact',
      'compact',
      'overview',
      'overview',
      'overview',
      'compact',
      'compact',
      'full'
    ]);
    // A panel that opens or closes can pass two steps at once.
    expect(byWidth([1000, 300, 1000])).toEqual(['full', 'overview', 'full']);
  });
});

describe('The level that the zoom of the map gives', () => {
  it('shows more when zoomed in, and a click out after a click in comes back to the level it left', () => {
    // The zoom buttons multiply the zoom by 1.25 or divide it by 1.25.
    const zooms = [1];
    for (const factor of [1.25, 1 / 1.25, 1 / 1.25, 1 / 1.25, 1.25, 1.25]) {
      zooms.push(zooms[zooms.length - 1] * factor);
    }
    expect(zooms.map(zoom => Math.round(zoom * 100))).toEqual([
      100, 125, 100, 80, 64, 80, 100
    ]);
    expect(byZoom(zooms)).toEqual([
      'minimal',
      'overview',
      'minimal',
      'minimal',
      'none',
      'minimal',
      'minimal'
    ]);
    // A pinch that rests near a step does not switch the level back and
    // forth: Overview holds down to 1.25 / 1.08, None up to 80%.
    expect(byZoom([1.3, 1.2, 1.16, 1.15])).toEqual([
      'overview',
      'overview',
      'overview',
      'minimal'
    ]);
    expect(byZoom([1, 0.76, 0.74, 0.79, 0.8])).toEqual([
      'minimal',
      'minimal',
      'none',
      'none',
      'minimal'
    ]);
  });
});

describe('Level of detail follows the space, the setting', () => {
  it('is read as off unless the analyst turns it on', () => {
    const read = (raw: string) => {
      const { composite, user } = composed(raw);
      return readSettings(composite, user).detailFollowsSpace;
    };
    expect([read('{}'), read('{"detailFollowsSpace": true}')]).toEqual([
      false,
      true
    ]);
  });

  it('changes nothing while it is off: the slider sets the level, and the view does not draw again', () => {
    const { model } = benchModel([{ id: 'a' }]);
    model.settings.update({ detail: 'compact', mapDetail: 'none' });
    const revision = model.revision;
    [200, 500, 900, 1400].forEach(width => model.spaceDetail.setWidth(width));
    [0.3, 1, 1.5, 2].forEach(zoom => model.spaceDetail.setZoom(zoom));
    const found = {
      detail: model.detail,
      mapDetail: model.mapDetail,
      drawn: model.revision !== revision
    };
    model.dispose();
    expect(found).toEqual({
      detail: 'compact',
      mapDetail: 'none',
      drawn: false
    });
  });

  it('turned on, gives the level of the width; a pick holds until the width reaches another level, or until it is turned off', () => {
    const { model } = benchModel([{ id: 'a' }]);
    const saved: [string, unknown][] = [];
    model.settings.save = (key, value) => saved.push([key, value]);
    model.spaceDetail.setWidth(600);
    const off = model.detail;
    model.settings.update({ detailFollowsSpace: true });
    const on = model.detail;
    model.pickDetail('full');
    const levels: Detail[] = [model.detail];
    // Wider, still in Compact's range: the pick holds.
    model.spaceDetail.setWidth(650);
    levels.push(model.detail);
    // Wide enough for Full: the width's level again, and the pick is gone.
    model.spaceDetail.setWidth(800);
    levels.push(model.detail);
    model.spaceDetail.setWidth(600);
    levels.push(model.detail);
    // A pick, then the setting turned off: the slider's saved level.
    model.pickDetail('overview');
    model.settings.update({ detailFollowsSpace: false });
    const turnedOff = model.detail;
    model.settings.update({ detailFollowsSpace: true });
    const again = model.detail;
    model.dispose();
    expect({ off, on, levels, turnedOff, again, saved }).toEqual({
      off: 'full',
      on: 'compact',
      levels: ['full', 'full', 'full', 'compact'],
      turnedOff: 'overview',
      again: 'compact',
      saved: [
        ['detail', 'full'],
        ['detail', 'overview']
      ]
    });
  });

  it('turned on, gives the map the level of its zoom; a pick holds until the zoom reaches another level', () => {
    const { model } = benchModel([{ id: 'a' }]);
    model.settings.update({ detailFollowsSpace: true });
    const changed = [
      model.spaceDetail.setZoom(1),
      model.spaceDetail.setZoom(1.25)
    ];
    const levels: MapDetail[] = [model.mapDetail];
    model.pickMapDetail('none');
    levels.push(model.mapDetail);
    // A move of the map keeps the zoom, and the pick.
    changed.push(model.spaceDetail.setZoom(1.25));
    levels.push(model.mapDetail);
    model.spaceDetail.setZoom(1.6);
    levels.push(model.mapDetail);
    // Out to 100%: Minimal, the zoom's level.
    changed.push(model.spaceDetail.setZoom(1));
    levels.push(model.mapDetail);
    model.dispose();
    expect({ changed, levels }).toEqual({
      changed: [false, true, false, true],
      levels: ['overview', 'none', 'none', 'none', 'minimal']
    });
  });
});

describe('The slider, with the level of detail that follows the space', () => {
  it('shows the level in force, and says the rule in its tooltip', async () => {
    const { model } = benchModel([{ id: 'a' }]);
    const view = await mount(<DetailSlider model={model} />);
    const read = () => {
      const label = view.host.querySelector('.jp-Epi-detail')!;
      return {
        level: label.querySelector('.jp-Epi-detail-value')!.textContent,
        title: label.getAttribute('title')
      };
    };
    const off = read();
    await step(() => {
      model.settings.update({ detailFollowsSpace: true });
      model.spaceDetail.setWidth(300);
    });
    await settle();
    const narrow = read();
    await slide(view.host, 2);
    const picked = read();
    // The map has its own levels, from the zoom.
    await step(() => {
      model.setView('map');
      model.spaceDetail.setZoom(0.5);
    });
    await settle();
    const map = read();
    await view.unmount();
    model.dispose();
    expect({ off, narrow, picked, map }).toEqual({
      off: {
        level: 'Full',
        title:
          'Level of detail of the outputs: Full, small tables in full, printed text in full up to 10 lines, and plots up to 640 px wide; in the Code view, every output as in the notebook'
      },
      narrow: {
        level: 'Overview',
        title:
          'Level of detail of the outputs: Overview, every table and every printed text as a tile, and plots as thumbnails. The width of the view sets the level: Overview when narrow, Compact from 420 px, Full from 720 px. A level you pick holds until the width reaches another level.'
      },
      picked: {
        level: 'Full',
        title:
          'Level of detail of the outputs: Full, small tables in full, printed text in full up to 10 lines, and plots up to 640 px wide; in the Code view, every output as in the notebook. You picked this level. It holds until the width reaches another level. The width of the view sets the level: Overview when narrow, Compact from 420 px, Full from 720 px.'
      },
      map: {
        level: 'None',
        title:
          'Level of detail of the outputs on the map: None, the cells alone, without outputs. The zoom sets the level: None below 80%, Minimal from 80%, Overview from 125%. A level you pick holds until the zoom reaches another level.'
      }
    });
  });
});

describe('The bench and the Code view, with the level that follows the width', () => {
  const Observer = window.ResizeObserver;
  let observers: (() => void)[] = [];
  beforeEach(() => {
    observers = [];
    window.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(() => callback([], this as any));
      }
      observe(): void {
        // The test calls the callbacks.
      }
      unobserve(): void {
        // As above.
      }
      disconnect(): void {
        // As above.
      }
    } as any;
  });
  afterEach(() => {
    window.ResizeObserver = Observer;
  });

  /** The view's column is this wide, as a resize of the window makes it. */
  async function resize(view: IMounted, width: number): Promise<void> {
    const main = view.host.querySelector<HTMLElement>('.jp-Epi-main')!;
    Object.defineProperty(main, 'offsetWidth', {
      configurable: true,
      get: () => width
    });
    await step(() => observers.forEach(observe => observe()));
    await settle();
  }

  /** How the view shows the cell's outputs, and the level on the slider. */
  function shown(view: IMounted): {
    slider: string | null;
    text: string;
    plot: string;
  } {
    const host = view.host;
    const plot = host.querySelector('.jp-Epi-plotout');
    return {
      slider: host.querySelector('.jp-Epi-detail-value')!.textContent,
      text: host.querySelector('.jp-Epi-logtile')
        ? 'a tile'
        : host.querySelector('.jp-Epi-textoutput')
          ? 'its lines'
          : 'none',
      plot: plot
        ? plot.className.replace('jp-Epi-plotout jp-mod-', 'plot at ')
        : host.querySelector('.jp-Epi-miniature.jp-mod-image')
          ? 'a thumbnail'
          : 'none'
    };
  }

  async function mountView(model: EpiModel): Promise<IMounted> {
    return mount(
      <>
        <DetailSlider model={model} />
        <DocumentView
          model={model}
          editorServices={null}
          openFile={() => undefined}
          isVisible={() => true}
        />
      </>
    );
  }

  it("draw the outputs at the level of the width of the view, and at the slider's while it is off", async () => {
    const { model } = benchModel(
      [{ id: 'a', source: 'report(weekly)', count: 1, outputs: OUTPUTS }],
      { rendermime: rendermime() }
    );
    const view = await mountView(model);
    await settle();
    const off: ReturnType<typeof shown>[] = [];
    for (const width of [1000, 500, 300]) {
      await resize(view, width);
      off.push(shown(view));
    }
    await step(() => model.settings.update({ detailFollowsSpace: true }));
    await settle();
    const on = [shown(view)];
    for (const width of [500, 1000]) {
      await resize(view, width);
      on.push(shown(view));
    }
    await view.unmount();
    model.dispose();
    const full = { slider: 'Full', text: 'its lines', plot: 'plot at full' };
    expect({ off, on }).toEqual({
      off: [full, full, full],
      on: [
        { slider: 'Overview', text: 'a tile', plot: 'a thumbnail' },
        { slider: 'Compact', text: 'a tile', plot: 'plot at compact' },
        full
      ]
    });
  });

  it("show the Code view's outputs as the notebook does when the view is wide, and as the bench does when it is narrow", async () => {
    const { model } = benchModel(
      [{ id: 'a', source: 'report(weekly)', count: 1, outputs: OUTPUTS }],
      { rendermime: rendermime() }
    );
    model.settings.update({ detailFollowsSpace: true });
    model.setView('linear');
    const view = await mountView(model);
    await settle();
    const outputs = () =>
      view.host.querySelector('.jp-Epi-linear-outputs')!.className;
    await resize(view, 1000);
    const wide = outputs();
    await resize(view, 500);
    const narrow = outputs();
    await view.unmount();
    model.dispose();
    expect({ wide, narrow }).toEqual({
      wide: 'jp-Epi-linear-outputs',
      narrow: 'jp-Epi-linear-outputs jp-mod-detail'
    });
  });

  it('draw a small table in full, as a miniature or as a tile, at the level of the width', async () => {
    const table: nbformat.IOutput = {
      output_type: 'execute_result',
      execution_count: 1,
      metadata: {},
      data: {
        'text/html':
          '<table><thead><tr><th></th><th>week</th><th>pain</th></tr></thead><tbody>' +
          '<tr><th>0</th><td>1</td><td>4.2</td></tr><tr><th>1</th><td>2</td><td>3.9</td></tr>' +
          '<tr><th>2</th><td>3</td><td>3.5</td></tr></tbody></table>',
        'text/plain': 'weekly'
      }
    };
    const { model } = benchModel(
      [{ id: 'a', source: 'weekly', count: 1, outputs: [table] }],
      { rendermime: rendermime() }
    );
    model.settings.update({ detailFollowsSpace: true });
    // The table is 200 by 100 px at full size.
    const width = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'offsetWidth'
    )!;
    const height = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'offsetHeight'
    )!;
    const sized = (full: number, other: PropertyDescriptor) => ({
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('jp-Epi-tableoutput-content')
          ? full
          : other.get!.call(this);
      }
    });
    Object.defineProperty(
      HTMLElement.prototype,
      'offsetWidth',
      sized(200, width)
    );
    Object.defineProperty(
      HTMLElement.prototype,
      'offsetHeight',
      sized(100, height)
    );
    const levels: string[] = [];
    try {
      const view = await mountView(model);
      await settle();
      for (const columns of [1000, 500, 300]) {
        await resize(view, columns);
        levels.push(view.host.querySelector('.jp-Epi-tableoutput')!.className);
      }
      await view.unmount();
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
    }
    model.dispose();
    expect(levels).toEqual([
      'jp-Epi-tableoutput jp-mod-inline',
      'jp-Epi-tableoutput jp-mod-miniature',
      'jp-Epi-tableoutput jp-mod-tile'
    ]);
  });

  it('read where the cards are only when the width changes the level', async () => {
    const { model } = benchModel(
      Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        source: `report(part_${i})`,
        count: i + 1,
        outputs: OUTPUTS
      })),
      { rendermime: rendermime() }
    );
    const view = await mountView(model);
    await settle();
    const rect = Element.prototype.getBoundingClientRect;
    let reads = 0;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.hasAttribute('data-cell-id')) {
        reads++;
      }
      return rect.call(this);
    };
    const counts: Record<string, number> = {};
    try {
      // Off: the window narrows and widens.
      for (const columns of [1000, 500, 300, 1000]) {
        await resize(view, columns);
      }
      counts.off = reads;
      // On: a resize within Full's range, then one to Compact.
      await step(() => model.settings.update({ detailFollowsSpace: true }));
      await settle();
      reads = 0;
      await resize(view, 900);
      counts.sameLevel = reads;
      await resize(view, 500);
      counts.newLevel = reads;
    } finally {
      Element.prototype.getBoundingClientRect = rect;
    }
    await view.unmount();
    model.dispose();
    expect({
      off: counts.off,
      sameLevel: counts.sameLevel,
      newLevel: counts.newLevel > 0
    }).toEqual({ off: 0, sameLevel: 0, newLevel: true });
  });

  it('keep the card being read where it was when the width changes the level, until the analyst scrolls', async () => {
    const { model } = benchModel(
      Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        source: `report(part_${i})`,
        count: i + 1,
        outputs: OUTPUTS
      })),
      { rendermime: rendermime() }
    );
    model.settings.update({ detailFollowsSpace: true });
    const view = await mountView(model);
    await settle();
    // The view's column starts 100 px down the page and is 800 px tall. The
    // cards are one under the other: 300 px tall at Full, 200 at Compact and
    // 100 at Overview.
    const main = view.host.querySelector<HTMLElement>('.jp-Epi-main')!;
    let scrollTop = 0;
    Object.defineProperty(main, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      }
    });
    const HEIGHT: Record<Detail, number> = {
      full: 300,
      compact: 200,
      overview: 100
    };
    const box = (top: number, height: number) =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 500,
        width: 500,
        x: 0,
        y: top
      }) as DOMRect;
    const rect = Element.prototype.getBoundingClientRect;
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this === main) {
        return box(100, 800);
      }
      // A card is as tall as the level it is drawn at, which the view draws
      // on the frame after the level changes.
      const id = this.getAttribute('data-cell-id');
      if (id) {
        const plot = this.querySelector('.jp-Epi-plotout');
        const drawn: Detail = !plot
          ? 'overview'
          : plot.classList.contains('jp-mod-full')
            ? 'full'
            : 'compact';
        const height = HEIGHT[drawn];
        return box(100 + Number(id.slice(1)) * height - scrollTop, height);
      }
      return rect.call(this);
    };
    const found: Record<string, number> = {};
    try {
      await resize(view, 1000);
      // The analyst reads c5, whose top is 40 px above the top of the view.
      scrollTop = 5 * 300 + 40;
      await resize(view, 600);
      found.compact = scrollTop;
      await resize(view, 300);
      found.overview = scrollTop;
      // The analyst scrolls to c8: the view no longer holds c5.
      main.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      scrollTop = 800;
      await step(() => observers.forEach(observe => observe()));
      found.scrolled = scrollTop;
      await resize(view, 1000);
      found.full = scrollTop;
      // Something else scrolls the view to c9: the view no longer holds c8.
      scrollTop = 2700;
      main.dispatchEvent(new Event('scroll'));
      await resize(view, 600);
      found.otherScroll = scrollTop;
      // A link shows c2: the view no longer holds c9.
      Element.prototype.scrollIntoView = () => {
        scrollTop = 400;
      };
      await step(() => model.showCell('c2'));
      await settle();
      await step(() => observers.forEach(observe => observe()));
      found.link = scrollTop;
    } finally {
      Element.prototype.getBoundingClientRect = rect;
      Element.prototype.scrollIntoView = scrollIntoView;
    }
    await view.unmount();
    model.dispose();
    // The card held stays where it was at each level: 100 + 5 × height - 40
    // for c5, 40 px above the top of the view.
    expect(found).toEqual({
      compact: 1040,
      overview: 540,
      scrolled: 800,
      full: 2400,
      otherScroll: 1800,
      link: 400
    });
  });
});

describe('The map, with the level that follows the zoom', () => {
  const CELLS = [
    { id: 'load', source: 'diary = load()', count: 1, outputs: OUTPUTS },
    {
      id: 'weekly',
      source: 'weekly = by_week(diary)',
      count: 2,
      outputs: OUTPUTS
    },
    { id: 'fit', source: 'fit = model(weekly)', count: 3, outputs: OUTPUTS },
    { id: 'check', source: 'check(fit)', count: 4, outputs: OUTPUTS }
  ];

  /** Where a card's corner is in the view, from the camera and its place on the map. */
  function corner(view: IMounted, id: string): { x: number; y: number } {
    const canvas = view.host.querySelector<HTMLElement>('.jp-Epi-map-canvas')!;
    const match =
      /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(
        canvas.style.transform
      )!;
    const [x, y, zoom] = match.slice(1).map(Number);
    const card = view.host.querySelector<HTMLElement>(
      `.jp-Epi-map-cell[data-cell-id="${id}"]`
    )!;
    return {
      x: x + parseFloat(card.style.left) * zoom,
      y: y + parseFloat(card.style.top) * zoom
    };
  }

  /** Ctrl+scroll up at a point of the view: a zoom in by 1.25. */
  async function zoomIn(view: IMounted, x: number, y: number): Promise<void> {
    const viewport = view.host.querySelector('.jp-Epi-map-viewport')!;
    await step(() => {
      viewport.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -Math.log(1.25) / 0.002,
          ctrlKey: true,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true
        })
      );
    });
    await settle();
    await settle();
  }

  const round = (point: { x: number; y: number }) => ({
    x: Math.round(point.x),
    y: Math.round(point.y)
  });

  it('shows the tiles of Overview when zoomed in, and keeps the card under the pointer where the zoom put it', async () => {
    const { model } = benchModel(CELLS, { rendermime: rendermime() });
    model.settings.update({ detailFollowsSpace: true });
    const view = await mount(<MapView model={model} />);
    await settle();
    const before = corner(view, 'fit');
    // The pointer is on the card of 'fit', 10 px into it.
    const point = { x: before.x + 10, y: before.y + 10 };
    await zoomIn(view, point.x, point.y);
    // Where the zoom put the corner, before the cards grew.
    const expected = {
      x: point.x - (point.x - before.x) * 1.25,
      y: point.y - (point.y - before.y) * 1.25
    };
    const found = {
      level: model.mapDetail,
      overview: view.host.querySelectorAll('.jp-Epi-map-cell.jp-mod-overview')
        .length,
      corner: round(corner(view, 'fit'))
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      level: 'overview',
      overview: 4,
      corner: round(expected)
    });
  });

  it('keeps its level while the setting is off, however far it zooms', async () => {
    const { model } = benchModel(CELLS, { rendermime: rendermime() });
    const view = await mount(<MapView model={model} />);
    await settle();
    const before = corner(view, 'fit');
    await zoomIn(view, before.x + 10, before.y + 10);
    await zoomIn(view, before.x + 10, before.y + 10);
    const found = {
      level: model.mapDetail,
      overview: view.host.querySelectorAll('.jp-Epi-map-cell.jp-mod-overview')
        .length,
      tiles: view.host.querySelectorAll('.jp-Epi-map-output').length
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({ level: 'minimal', overview: 0, tiles: 8 });
  });

  it('fits the whole map of the level that its fit gives', async () => {
    const cells = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      source: `step_${i} = run(${i})`,
      count: i + 1,
      outputs: OUTPUTS
    }));
    const { model } = benchModel(cells, { rendermime: rendermime() });
    model.settings.update({ detailFollowsSpace: true });
    const view = await mount(<MapView model={model} />);
    await settle();
    // The view is 800 by 500 px: the map is too tall for it at 100%.
    const viewport = view.host.querySelector<HTMLElement>(
      '.jp-Epi-map-viewport'
    )!;
    Object.defineProperty(viewport, 'clientWidth', { value: 800 });
    Object.defineProperty(viewport, 'clientHeight', { value: 500 });
    const canvas = view.host.querySelector<HTMLElement>('.jp-Epi-map-canvas')!;
    const minimal = parseFloat(canvas.style.height);
    await step(() =>
      Array.from(view.host.querySelectorAll('button'))
        .find(button => button.textContent === 'Fit')!
        .click()
    );
    await settle();
    await settle();
    const height = parseFloat(canvas.style.height);
    const zoom = Number(/scale\(([-\d.e]+)\)/.exec(canvas.style.transform)![1]);
    const found = {
      level: model.mapDetail,
      shorter: height < minimal,
      shown: Math.round(height * zoom)
    };
    await view.unmount();
    model.dispose();
    // The map of None, without its tiles, is as tall as the view.
    expect(found).toEqual({ level: 'none', shorter: true, shown: 500 });
  });
});
