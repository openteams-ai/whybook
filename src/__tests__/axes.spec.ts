import type { IAxesPayload } from '../model/axes';
import {
  AXES_MIME,
  axesAt,
  axesOf,
  axesPlot,
  boxRanges,
  dataAt,
  rangesBox
} from '../model/axes';
import type { IImagePick } from '../model/imageask';
import { imageRequest, pickAbout } from '../model/imageask';

/*
 * A payload that the matplotlib hook wrote for a retina PNG of two Axes, a
 * linear one and one with a log x axis, with four square markers each. The
 * fractions below are the centres of the markers' pixels, measured in that
 * PNG (future/tests/test_plot_hooks.py draws the same figure).
 */
const REAL: IAxesPayload = {
  version: 1,
  library: 'matplotlib',
  image: { width: 872, height: 466, scale: 2 },
  axes: [
    {
      box: [69.4, 56.96, 424.49, 389.6],
      x: { limits: [0.6, 9.4], scale: 'linear', label: 'week', column: null },
      y: { limits: [1.7, 8.3], scale: 'linear', label: 'pain', column: null },
      title: '',
      frame: null,
      marks: 4
    },
    {
      box: [495.51, 56.96, 850.6, 389.6],
      x: {
        limits: [1.473565245410645, 1221.527180833032],
        scale: 'log',
        label: '',
        column: null
      },
      y: { limits: [0.35, 3.65], scale: 'linear', label: '', column: null },
      title: '',
      frame: null,
      marks: 4
    }
  ]
};

const LINEAR_MARKS: [number, number, number, number][] = [
  // fraction across, fraction down, x, y
  [0.09805, 0.80365, 1, 2],
  [0.23739, 0.15451, 4, 8],
  [0.37615, 0.69528, 7, 3],
  [0.46789, 0.37124, 9, 6]
];

const LOG_MARKS: [number, number, number, number][] = [
  [0.58716, 0.80365, 2, 0.5],
  [0.75115, 0.58798, 30, 1.5],
  [0.88991, 0.37124, 300, 2.5],
  [0.957, 0.15451, 900, 3.5]
];

function payload(): IAxesPayload {
  return axesOf({ [AXES_MIME]: REAL })!;
}

describe('axesOf', () => {
  it('reads the Axes of a figure', () => {
    expect(payload().axes).toHaveLength(2);
    expect(axesOf({ 'image/png': 'abc' })).toBeNull();
    expect(axesOf({ [AXES_MIME]: { ...REAL, version: 2 } })).toBeNull();
  });

  it('leaves out Axes it cannot map', () => {
    const broken = {
      ...REAL,
      axes: [
        { ...REAL.axes[0], box: [10, 10, 5, 20] },
        {
          ...REAL.axes[1],
          x: { ...REAL.axes[1].x, limits: [0, 100] }
        }
      ]
    };
    // A box with no width, and a log axis that starts at 0.
    expect(axesOf({ [AXES_MIME]: broken })).toBeNull();
  });
});

describe('the pixels of a real figure', () => {
  it('map to the values of the points drawn there', () => {
    const axes = payload().axes;
    for (const [fx, fy, x, y] of LINEAR_MARKS) {
      expect(axesAt(payload(), { x: fx, y: fy })).toBe(axes[0]);
      const value = dataAt(payload(), axes[0], { x: fx, y: fy });
      // Half a pixel of the PNG is 0.012 on x and 0.01 on y.
      expect(Math.abs(value.x - x)).toBeLessThan(0.03);
      expect(Math.abs(value.y - y)).toBeLessThan(0.03);
    }
    for (const [fx, fy, x, y] of LOG_MARKS) {
      expect(axesAt(payload(), { x: fx, y: fy })).toBe(axes[1]);
      const value = dataAt(payload(), axes[1], { x: fx, y: fy });
      expect(Math.abs(value.x / x - 1)).toBeLessThan(0.02);
      expect(Math.abs(value.y - y)).toBeLessThan(0.01);
    }
  });

  it('find no Axes in the margins', () => {
    expect(axesAt(payload(), { x: 0.02, y: 0.5 })).toBeNull();
    expect(axesAt(payload(), { x: 0.5, y: 0.5 })).toBeNull();
  });
});

describe('boxRanges', () => {
  it('orders the ranges and stops at the edges of the Axes', () => {
    const axes = payload().axes[0];
    // From the bottom right corner, past the Axes, to the middle.
    const ranges = boxRanges(payload(), axes, {
      x0: 0.3,
      y0: 0.5,
      x1: 0.6,
      y1: 0.99
    });
    expect(ranges.x[0]).toBeLessThan(ranges.x[1]);
    expect(ranges.x[1]).toBeCloseTo(9.4);
    expect(ranges.y[0]).toBeCloseTo(1.7);
    expect(ranges.y[1]).toBeGreaterThan(ranges.y[0]);
  });

  it('orders a range of an axis drawn from high to low', () => {
    const axes = {
      ...payload().axes[0],
      y: { ...payload().axes[0].y, limits: [8.3, 1.7] as [number, number] }
    };
    const ranges = boxRanges(payload(), axes, {
      x0: 0.2,
      y0: 0.2,
      x1: 0.3,
      y1: 0.4
    });
    expect(ranges.y[0]).toBeLessThan(ranges.y[1]);
    expect(ranges.y[0]).toBeGreaterThan(1.7);
  });

  it('draws again the box it came from', () => {
    for (const axes of payload().axes) {
      const box = { x0: 0.62, y0: 0.3, x1: 0.8, y1: 0.6 };
      const inside =
        axes === payload().axes[0] ? { ...box, x0: 0.2, x1: 0.4 } : box;
      const ranges = boxRanges(payload(), axes, inside);
      const again = rangesBox(payload(), axes, ranges.x, ranges.y);
      for (const key of ['x0', 'y0', 'x1', 'y1'] as const) {
        expect(again[key]).toBeCloseTo(inside[key], 6);
      }
    }
  });
});

describe('axesPlot', () => {
  it('asks about rows only when the x axis names a column', () => {
    expect(axesPlot(payload().axes[0])).toBeNull();
    const axes = {
      ...payload().axes[0],
      x: { ...payload().axes[0].x, column: 'week' },
      y: { ...payload().axes[0].y, column: 'pain' },
      frame: 'visits'
    };
    expect(axesPlot(axes)).toMatchObject({
      kind: 'scatter',
      select: 'xy',
      title: 'pain by week',
      source: { frame: 'visits', x: 'week', y: 'pain', by: null, rows: 4 }
    });
    // A y axis of counts: a range of x alone, and the frame from the columns.
    const counts = {
      ...axes,
      y: { ...axes.y, column: null, label: 'Count' },
      frame: null
    };
    expect(axesPlot(counts)?.y).toBeNull();
    expect(axesPlot(counts)?.source).toMatchObject({ frame: null, y: null });
  });
});

describe('the pick of a picture', () => {
  const image = {
    mime: 'image/png' as const,
    data: 'iVBORw0KGgo=',
    width: 640,
    height: 480
  };

  it('goes to the AI as fractions and in pixels', () => {
    const point: IImagePick = {
      kind: 'point',
      x0: 0.25,
      y0: 0.4,
      x1: 0.25,
      y1: 0.4,
      image,
      source: 'iVBORw0KGgo='
    };
    expect(imageRequest(point)).toEqual({
      mime: 'image/png',
      data: 'iVBORw0KGgo=',
      width: 640,
      height: 480,
      point: { x: 160, y: 192, fx: 0.25, fy: 0.4 }
    });
    expect(pickAbout(point, '[3]')).toBe(
      'the point 25% across and 40% down the picture that cell [3] shows (pixel x 160, y 192 of 640 by 480 px, from the top left)'
    );
    const area: IImagePick = {
      ...point,
      kind: 'area',
      x1: 0.5,
      y1: 0.623456
    };
    expect(imageRequest(area).box).toEqual({
      x0: 160,
      y0: 192,
      x1: 320,
      y1: 299,
      fx0: 0.25,
      fy0: 0.4,
      fx1: 0.5,
      fy1: 0.6235
    });
  });
});
