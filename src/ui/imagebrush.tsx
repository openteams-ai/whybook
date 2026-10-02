import * as React from 'react';

import type { IAxesInfo, IFraction, IFractionBox } from '../model/axes';
import {
  axesAt,
  axesBox,
  axesOf,
  axesPlot,
  boxRanges,
  dataAt
} from '../model/axes';
import type { IImagePick, ImageMime } from '../model/imageask';
import { numberText } from '../model/numbers';
import type { IAnchor, IPlotPayload } from '../tokens';
import { laidOut } from './common';
import { fromKeyboard, useBrushDrag } from './plot';

/** The picture types an output can show that the brush works on. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/svg+xml'];

/** A click asks about the marks this many pixels around it, as drawn on the page. */
const CLICK_RADIUS = 5;

/** A press that moves less than this, in pixels on the page, is a click. */
const CLICK_SLOP = 3;

/** Claude reads pictures up to this size without scaling them down. */
const LARGEST_SIDE = 1568;

/** How far an arrow key moves the point on a picture: 2% of it, 10% with Shift. */
const KEY_STEP = 0.02;
const SHIFT_STEP = 0.1;

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A point as a box with no size. */
function pointBox(point: IFraction): IFractionBox {
  return { x0: point.x, x1: point.x, y0: point.y, y1: point.y };
}

function ordered(a: IFraction, b: IFraction): IFractionBox {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y)
  };
}

/** Where the picture lies in the brush's frame, in pixels on the page. */
interface IPlace {
  left: number;
  top: number;
  width: number;
  height: number;
}

function sameplace(a: IPlace | null, b: IPlace | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.left === b.left &&
      a.top === b.top &&
      a.width === b.width &&
      a.height === b.height)
  );
}

/** Where a picture lies on the page, as getBoundingClientRect gives it. */
export type Locate = (
  host: HTMLElement | null
) => { left: number; top: number; width: number; height: number } | null;

/** The rendered <img> of an output. */
const locateImage: Locate = host =>
  host?.querySelector('img')?.getBoundingClientRect() ?? null;

/**
 * The place of the picture that the output renderer draws: it comes after
 * the renderer resolves, and moves when the layout does.
 */
function usePlace(
  frame: React.RefObject<HTMLDivElement>,
  picture: React.RefObject<HTMLDivElement>,
  locate: Locate
): IPlace | null {
  const [place, setPlace] = React.useState<IPlace | null>(null);
  React.useLayoutEffect(() => {
    const node = picture.current;
    if (!node) {
      return;
    }
    const measure = () => {
      // A card far from the window is measured once it comes near.
      if (!laidOut(node)) {
        return;
      }
      const outer = frame.current?.getBoundingClientRect();
      const rect = locate(node);
      const next =
        outer && rect && rect.width > 0 && rect.height > 0
          ? {
              left: rect.left - outer.left,
              top: rect.top - outer.top,
              width: rect.width,
              height: rect.height
            }
          : null;
      setPlace(old => (sameplace(old, next) ? old : next));
    };
    const resized =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measure)
        : null;
    resized?.observe(node);
    const changed = new MutationObserver(measure);
    changed.observe(node, { childList: true, subtree: true });
    // An image's size is known once it loads; load does not bubble.
    node.addEventListener('load', measure, true);
    measure();
    return () => {
      resized?.disconnect();
      changed.disconnect();
      node.removeEventListener('load', measure, true);
    };
  }, []);
  return place;
}

/**
 * A PNG made from an SVG picture in the browser: Claude reads PNG, JPEG,
 * GIF and WebP pictures, and not SVG. Null when the browser refuses.
 */
async function svgAsPng(
  img: HTMLImageElement
): Promise<IImagePick['image'] | null> {
  const box = img.getBoundingClientRect();
  const width = img.naturalWidth || box.width;
  const height = img.naturalHeight || box.height;
  if (!width || !height) {
    return null;
  }
  const scale = Math.min(2, LARGEST_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  try {
    await img.decode();
    // A picture with a transparent background reads as drawn on white.
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/png');
    return {
      mime: 'image/png',
      data: url.slice(url.indexOf(',') + 1),
      width: canvas.width,
      height: canvas.height
    };
  } catch (error) {
    console.warn('The view could not turn the SVG picture into a PNG', error);
    return null;
  }
}

/** The pick of a point or an area, with the picture as the AI gets it. */
async function pickOf(
  kind: IImagePick['kind'],
  box: IFractionBox,
  mime: string,
  source: string,
  img: HTMLImageElement
): Promise<IImagePick | null> {
  const image =
    mime === 'image/svg+xml'
      ? await svgAsPng(img)
      : {
          mime: mime as ImageMime,
          data: source.replace(/\s/g, ''),
          width: img.naturalWidth,
          height: img.naturalHeight
        };
  if (!image || !image.width || !image.height) {
    return null;
  }
  return { kind, ...box, image, source };
}

/**
 * A picture in an output that answers a click and a drag. A figure whose
 * Axes the kernel's hook described (src/model/axes.ts) maps them to ranges
 * of the columns its axes show, and asks the region questions of a Whybook
 * scatter plot. Any other picture, and a figure's Axes that name no column,
 * ask about the point or the area of the picture instead, with the AI.
 *
 * From the keyboard, the picture is one Tab stop: the arrow keys move a
 * point over it, 2% of the picture at a time and 10% with Shift, and Enter
 * asks what a click there asks. A line under the picture names the point.
 */
export function ImageBrush(props: {
  data: Record<string, unknown>;
  mime: string;
  /** A range of x, and of y, picked in this cell's plots. */
  selection?: { x0: number; x1: number; y?: [number, number] | null } | null;
  /** The point or the area that the open questions are about. */
  pick?: IImagePick | null;
  onSelect?: (
    plot: IPlotPayload,
    x0: number,
    x1: number,
    anchor: IAnchor,
    y?: [number, number] | null
  ) => void;
  onAskImage?: (pick: IImagePick, anchor: IAnchor) => void;
  /** Where the picture lies, for one that is not an <img>. */
  locate?: Locate;
  /**
   * A picture in a frame of its own, as ninejs draws: a layer over it takes
   * the drag while Select rows is on, and the frame keeps its own tooltips
   * while it is off.
   */
  cover?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const { data, mime, selection, pick, onSelect, onAskImage } = props;
  const locate = props.locate ?? locateImage;
  const frame = React.useRef<HTMLDivElement>(null);
  const picture = React.useRef<HTMLDivElement>(null);
  const place = usePlace(frame, picture, locate);
  const [selecting, setSelecting] = React.useState(false);
  const payload = React.useMemo(() => axesOf(data), [data]);
  const source = typeof data[mime] === 'string' ? (data[mime] as string) : '';
  // The press being dragged, and the Axes it started in.
  const [drag, setDrag] = React.useState<{
    start: IFraction;
    end: IFraction;
    axes: IAxesInfo | null;
  } | null>(null);
  // The box this picture last asked about, and the ranges it asked with.
  const [made, setMade] = React.useState<{
    box: IFractionBox;
    x0: number;
    x1: number;
  } | null>(null);
  // The point that the arrow keys move, and whether the picture has the focus.
  const [point, setPoint] = React.useState<IFraction | null>(null);
  const [focused, setFocused] = React.useState(false);

  const mapped = (axes: IAxesInfo | null) =>
    !!payload && !!axes && !!onSelect && !!axesPlot(axes);
  /** The mapped Axes under a point of the picture, if there is one. */
  const mappedAt = (at: IFraction) => {
    const axes = payload ? axesAt(payload, at) : null;
    return mapped(axes) ? axes : null;
  };
  /**
   * Ask about a box of the picture: the rows in its ranges on a mapped Axes,
   * or else the point or the area of the picture, with the AI.
   */
  const askBox = (
    axes: IAxesInfo | null,
    box: IFractionBox,
    kind: IImagePick['kind'],
    anchor: IAnchor
  ) => {
    if (payload && axes && onSelect) {
      const plot = axesPlot(axes)!;
      const limits = axesBox(payload, axes);
      const ranges = boxRanges(payload, axes, box);
      setMade({
        box: {
          x0: Math.max(box.x0, limits.x0),
          x1: Math.min(box.x1, limits.x1),
          y0: plot.source.y ? Math.max(box.y0, limits.y0) : limits.y0,
          y1: plot.source.y ? Math.min(box.y1, limits.y1) : limits.y1
        },
        x0: ranges.x[0],
        x1: ranges.x[1]
      });
      onSelect(
        plot,
        ranges.x[0],
        ranges.x[1],
        anchor,
        plot.source.y ? ranges.y : null
      );
      return;
    }
    const image = img();
    if (onAskImage && image) {
      void pickOf(kind, box, mime, source, image).then(
        picked => picked && onAskImage(picked, anchor)
      );
    }
  };
  /** The marks a click at a point asks about: those within CLICK_RADIUS of it on the page. */
  const around = (
    at: IFraction,
    rect: { width: number; height: number } | null
  ): IFractionBox => {
    const reach = {
      x: rect?.width ? CLICK_RADIUS / rect.width : 0.01,
      y: rect?.height ? CLICK_RADIUS / rect.height : 0.01
    };
    return {
      x0: at.x - reach.x,
      x1: at.x + reach.x,
      y0: at.y - reach.y,
      y1: at.y + reach.y
    };
  };
  const img = () => picture.current?.querySelector('img') ?? null;
  const at = (event: {
    clientX: number;
    clientY: number;
  }): IFraction | null => {
    const rect = locate(picture.current);
    if (!rect || !rect.width || !rect.height) {
      return null;
    }
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height
    };
  };

  const onMouseDown = (event: React.MouseEvent) => {
    const point = at(event);
    if (
      (props.cover && !selecting) ||
      event.button !== 0 ||
      !point ||
      point.x < 0 ||
      point.x > 1 ||
      point.y < 0 ||
      point.y > 1
    ) {
      return;
    }
    // No drag of the picture itself, and no text selected on the way.
    event.preventDefault();
    const axes = payload ? axesAt(payload, point) : null;
    setDrag({ start: point, end: point, axes: mapped(axes) ? axes : null });
  };
  // The pointer anywhere on the page moves the box and its release ends it,
  // clamped to the picture (design iteration 1.77).
  const onMouseMove = (event: MouseEvent) => {
    const point = at(event);
    if (point) {
      setDrag(current =>
        current
          ? { ...current, end: { x: clamp(point.x), y: clamp(point.y) } }
          : current
      );
    }
  };
  const onMouseUp = (event: MouseEvent) => {
    const image = img();
    const rect = locate(picture.current);
    const point = at(event);
    if (!drag || !rect || !point) {
      setDrag(null);
      return;
    }
    setDrag(null);
    const end = { x: clamp(point.x), y: clamp(point.y) };
    const anchor = { x: event.clientX, y: event.clientY };
    const click =
      Math.abs(end.x - drag.start.x) * rect.width < CLICK_SLOP &&
      Math.abs(end.y - drag.start.y) * rect.height < CLICK_SLOP;
    if (!(payload && drag.axes && onSelect) && !(onAskImage && image)) {
      return;
    }
    const box = !click
      ? ordered(drag.start, end)
      : drag.axes
        ? around(end, rect)
        : { x0: end.x, x1: end.x, y0: end.y, y1: end.y };
    askBox(drag.axes, box, click ? 'point' : 'area', anchor);
  };
  useBrushDrag(!!drag, onMouseMove, onMouseUp, () => setDrag(null));

  // The keyboard: the picture takes the focus where a click would ask.
  const keyed =
    (!!onAskImage || !!payload?.axes.some(axes => mapped(axes))) &&
    (!props.cover || selecting);
  /** Where the arrow keys start: the middle of the first mapped Axes, or of the picture. */
  const start = (): IFraction => {
    const axes = payload?.axes.find(item => mapped(item));
    if (payload && axes) {
      const box = axesBox(payload, axes);
      return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    }
    return { x: 0.5, y: 0.5 };
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!keyed || event.target !== event.currentTarget) {
      return;
    }
    setFocused(true);
    const step = event.shiftKey ? SHIFT_STEP : KEY_STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      event.stopPropagation();
      setPoint(
        point
          ? { x: clamp(point.x + move[0]), y: clamp(point.y + move[1]) }
          : start()
      );
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!point) {
      setPoint(start());
      return;
    }
    const rect = locate(picture.current);
    const anchor = {
      x: (rect?.left ?? 0) + point.x * (rect?.width ?? 0),
      y: (rect?.top ?? 0) + point.y * (rect?.height ?? 0)
    };
    const axes = mappedAt(point);
    askBox(axes, axes ? around(point, rect) : pointBox(point), 'point', anchor);
  };
  // The line under the picture: the keys, or what the point is on.
  let status =
    'The arrow keys move a point over the picture, and Enter asks about it.';
  if (point) {
    const axes = mappedAt(point);
    if (payload && axes) {
      const value = dataAt(payload, axes, point);
      const name = (axis: IAxesInfo['x']) => axis.column ?? axis.label ?? '';
      status = `${name(axes.x)} ${numberText(value.x)}${axes.y.column ? `, ${name(axes.y)} ${numberText(value.y)}` : ''}. Enter asks about the rows there.`;
    } else {
      status = `The point ${Math.round(point.x * 100)}% across and ${Math.round(point.y * 100)}% down the picture. Enter asks about it.`;
    }
  }

  // What to draw over the picture: the box being dragged, the point of the
  // arrow keys while the picture has the focus, the box this picture asked
  // about while its questions are open, or the pick.
  let shown: { box: IFractionBox; point: boolean } | null = null;
  if (drag) {
    shown = { box: ordered(drag.start, drag.end), point: false };
  } else if (focused && point) {
    shown = { box: pointBox(point), point: true };
  } else if (
    made &&
    selection &&
    selection.x0 === made.x0 &&
    selection.x1 === made.x1
  ) {
    shown = { box: made.box, point: false };
  } else if (pick && pick.source === source) {
    shown = { box: pick, point: pick.kind === 'point' };
  }
  const style =
    shown && place
      ? {
          left: place.left + shown.box.x0 * place.width,
          top: place.top + shown.box.y0 * place.height,
          width: (shown.box.x1 - shown.box.x0) * place.width,
          height: (shown.box.y1 - shown.box.y0) * place.height
        }
      : null;
  const asks = payload?.axes.some(axes => mapped(axes));
  return (
    <div className="jp-Epi-imagebrush-wrap">
      <div
        ref={frame}
        className="jp-Epi-imagebrush"
        onMouseDown={onMouseDown}
        {...(keyed
          ? {
              tabIndex: 0,
              role: 'application',
              'aria-label': `${asks ? 'A plot whose axes show columns' : 'A picture'}: the arrow keys move a point, and Enter asks about it.`,
              onKeyDown,
              onFocus: (event: React.FocusEvent<HTMLDivElement>) =>
                setFocused(
                  event.target === event.currentTarget &&
                    fromKeyboard(event.currentTarget)
                ),
              onBlur: () => setFocused(false)
            }
          : {})}
      >
        <div ref={picture}>{props.children}</div>
        {props.cover && selecting && place && (
          // Over the frame, which would take the pointer's events itself.
          <div
            className="jp-Epi-imagebrush-cover"
            style={{
              left: place.left,
              top: place.top,
              width: place.width,
              height: place.height
            }}
          />
        )}
        {style &&
          (shown?.point ? (
            <div
              className="jp-Epi-imagepoint"
              style={{ left: style.left, top: style.top }}
            />
          ) : (
            <div className="jp-Epi-imagebox" style={style} />
          ))}
      </div>
      {asks && props.cover ? (
        <div className="jp-Epi-hint jp-Epi-imagebrush-mode">
          <button
            className={`jp-Epi-button jp-mod-styled${selecting ? ' jp-mod-accept' : ''}`}
            aria-pressed={selecting}
            onClick={() => setSelecting(!selecting)}
          >
            Select rows
          </button>
          {selecting
            ? 'Drag a box over the plot, or click in it, to ask about the rows there.'
            : 'The chart shows its own tooltips; press Select rows to ask about the rows in a box.'}{' '}
          The axes show columns of{' '}
          {payload?.axes.find(axes => axes.frame)?.frame ??
            'a frame in the kernel'}
          .
        </div>
      ) : asks ? (
        <div className="jp-Epi-hint">
          Drag a box over the plot, or click in it, to ask about the rows there.
          The axes show columns of{' '}
          {payload?.axes.find(axes => axes.frame)?.frame ??
            'a frame in the kernel'}
          .
        </div>
      ) : onAskImage ? (
        <div className="jp-Epi-hint">
          Click or drag on the picture to ask about a point or an area: AI reads
          the picture.
        </div>
      ) : null}
      {keyed && (
        <div className="jp-Epi-plot-status" role="status">
          {focused ? status : ''}
        </div>
      )}
    </div>
  );
}
