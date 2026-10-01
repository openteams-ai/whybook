/**
 * The Axes of a figure drawn as a picture, as the kernel's matplotlib hook
 * describes them (future/kernel_code/plot_hooks.py), and the mapping from a
 * point of the picture to the values under it.
 *
 * The hook gives each Axes' box in the picture's own pixels. The view works
 * with fractions of the picture: a point 25% across and 40% down the picture
 * as drawn on the page is 25% across and 40% down the PNG, whatever the
 * retina factor and however the page scales the picture.
 */

import type { IPlotPayload } from '../tokens';

/** The MIME type the matplotlib hook adds to a figure's display bundle. */
export const AXES_MIME = 'application/vnd.whybook.axes+json';
/** The type before the rename, in outputs saved then. */
const LEGACY_AXES_MIME = 'application/vnd.epi.axes+json';

export interface IAxis {
  /** The value at the left (or bottom) edge, then at the right (or top). */
  limits: [number, number];
  scale: 'linear' | 'log';
  label: string;
  /** The column of the frame that the axis shows, or null. */
  column: string | null;
}

export interface IAxesInfo {
  /** Left, top, right and bottom of the Axes in the picture, in its pixels. */
  box: [number, number, number, number];
  x: IAxis;
  y: IAxis;
  title: string;
  /** The frame the Axes shows, when the kernel could tell. */
  frame: string | null;
  /** The points it draws, to tell apart frames with the same columns. */
  marks: number | null;
  /** What it draws: a pandas plot's kind, or scatter, bar or line; absent before 25 September 2026. */
  kind?: string | null;
}

export interface IAxesPayload {
  version: number;
  library: string;
  /** The picture's size in its own pixels; `scale` is 2 for a retina PNG. */
  image: { width: number; height: number; scale: number };
  axes: IAxesInfo[];
}

/** A point of a picture, as fractions of its width and height from its top left. */
export interface IFraction {
  x: number;
  y: number;
}

/** A box of a picture, in fractions, with x0 <= x1 and y0 <= y1. */
export interface IFractionBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The payload as the kernel wrote it, before axesOf checks it. */
interface IRawAxesPayload {
  version?: unknown;
  image?: { width: number; height: number; scale: number } | null;
  axes?: unknown;
}

/** The fields of a value, which may be anything, for the checks below. */
function fieldsOf<T>(value: unknown): Partial<T> {
  return value && typeof value === 'object' ? (value as Partial<T>) : {};
}

function isAxis(value: unknown): value is IAxis {
  const { limits, scale } = fieldsOf<{ limits: unknown; scale: unknown }>(
    value
  );
  return (
    Array.isArray(limits) &&
    limits.length === 2 &&
    limits.every(Number.isFinite) &&
    limits[0] !== limits[1] &&
    (scale === 'linear' ||
      (scale === 'log' && limits.every((v: number) => v > 0)))
  );
}

function isAxesInfo(value: unknown): value is IAxesInfo {
  const { box, x, y } = fieldsOf<{ box: unknown; x: unknown; y: unknown }>(
    value
  );
  return (
    Array.isArray(box) &&
    box.length === 4 &&
    box.every(Number.isFinite) &&
    box[2] > box[0] &&
    box[3] > box[1] &&
    isAxis(x) &&
    isAxis(y)
  );
}

/**
 * The Axes of an output, or null when it has none the view can map: the
 * payload is missing, from another version, or has no usable Axes.
 */
export function axesOf(data: Record<string, unknown>): IAxesPayload | null {
  const payload = (data[AXES_MIME] ?? data[LEGACY_AXES_MIME]) as
    IRawAxesPayload | null | undefined;
  if (
    !payload ||
    payload.version !== 1 ||
    !payload.image ||
    !(payload.image.width > 0) ||
    !(payload.image.height > 0) ||
    !Array.isArray(payload.axes)
  ) {
    return null;
  }
  const axes = payload.axes.filter(isAxesInfo);
  // The checks above make the payload one of version 1.
  return axes.length ? ({ ...payload, axes } as IAxesPayload) : null;
}

/** The box of an Axes in fractions of the picture. */
export function axesBox(payload: IAxesPayload, axes: IAxesInfo): IFractionBox {
  const { width, height } = payload.image;
  const [left, top, right, bottom] = axes.box;
  return {
    x0: left / width,
    y0: top / height,
    x1: right / width,
    y1: bottom / height
  };
}

/** The first Axes whose box holds a point, as matplotlib lists them. */
export function axesAt(
  payload: IAxesPayload,
  point: IFraction
): IAxesInfo | null {
  return (
    payload.axes.find(axes => {
      const box = axesBox(payload, axes);
      return (
        point.x >= box.x0 &&
        point.x <= box.x1 &&
        point.y >= box.y0 &&
        point.y <= box.y1
      );
    }) ?? null
  );
}

/**
 * The value at a place along an axis: 0 at its first limit, 1 at its
 * second. A log axis spreads the powers of ten evenly.
 */
export function valueAt(axis: IAxis, along: number): number {
  const [low, high] = axis.limits;
  if (axis.scale === 'log') {
    const from = Math.log10(low);
    return Math.pow(10, from + along * (Math.log10(high) - from));
  }
  return low + along * (high - low);
}

/** Where a value lies along an axis: the inverse of `valueAt`. */
export function placeOf(axis: IAxis, value: number): number {
  const [low, high] = axis.limits;
  if (axis.scale === 'log') {
    const from = Math.log10(low);
    return (Math.log10(value) - from) / (Math.log10(high) - from);
  }
  return (value - low) / (high - low);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The values of x and y under a point of the picture. */
export function dataAt(
  payload: IAxesPayload,
  axes: IAxesInfo,
  point: IFraction
): { x: number; y: number } {
  const box = axesBox(payload, axes);
  return {
    x: valueAt(axes.x, (point.x - box.x0) / (box.x1 - box.x0)),
    // The pixels count down from the top, and the y axis counts up.
    y: valueAt(axes.y, (box.y1 - point.y) / (box.y1 - box.y0))
  };
}

/**
 * The ranges of x and y that a box of the picture covers, each from its
 * lower to its higher value. The box is cut to the Axes first, so a drag
 * that leaves the Axes stops at its edge.
 */
export function boxRanges(
  payload: IAxesPayload,
  axes: IAxesInfo,
  selected: IFractionBox
): { x: [number, number]; y: [number, number] } {
  const box = axesBox(payload, axes);
  const corner = (x: number, y: number) =>
    dataAt(payload, axes, {
      x: clamp(x, box.x0, box.x1),
      y: clamp(y, box.y0, box.y1)
    });
  const a = corner(selected.x0, selected.y0);
  const b = corner(selected.x1, selected.y1);
  return {
    x: [Math.min(a.x, b.x), Math.max(a.x, b.x)],
    y: [Math.min(a.y, b.y), Math.max(a.y, b.y)]
  };
}

/**
 * The box of the picture that ranges of x and y cover in an Axes, to draw
 * a selection again; without a range of y, the Axes' whole height.
 */
export function rangesBox(
  payload: IAxesPayload,
  axes: IAxesInfo,
  x: [number, number],
  y: [number, number] | null
): IFractionBox {
  const box = axesBox(payload, axes);
  const across = x.map(value =>
    clamp(box.x0 + placeOf(axes.x, value) * (box.x1 - box.x0), box.x0, box.x1)
  );
  const down = y
    ? y.map(value =>
        clamp(
          box.y1 - placeOf(axes.y, value) * (box.y1 - box.y0),
          box.y0,
          box.y1
        )
      )
    : [box.y0, box.y1];
  return {
    x0: Math.min(...across),
    x1: Math.max(...across),
    y0: Math.min(...down),
    y1: Math.max(...down)
  };
}

/**
 * The epi plot payload of an Axes whose x axis names a column, so that a
 * box on it asks the region questions of an epi scatter plot; null when the
 * x axis names no column. The frame is null when the kernel could not tell
 * it, and the view then looks for the frame with these columns.
 */
export function axesPlot(axes: IAxesInfo): IPlotPayload | null {
  const x = axes.x.column;
  if (!x) {
    return null;
  }
  const y = axes.y.column;
  return {
    version: 1,
    kind: 'scatter',
    title: axes.title || (y ? `${y} by ${x}` : x),
    x: { field: x, label: axes.x.label || x },
    y: y ? { field: y, label: axes.y.label || y } : null,
    source: { frame: axes.frame, x, y, by: null, rows: axes.marks ?? 0 },
    select: 'xy'
  };
}
