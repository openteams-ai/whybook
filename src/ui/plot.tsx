import * as React from 'react';

import type { ITicks } from '../model/numbers';
import {
  axisValueText,
  countText,
  dateTicks,
  estimateText,
  finestUnit,
  numberText,
  numberTicks
} from '../model/numbers';
import type { IPlotAxis, IPlotPayload } from '../tokens';

/**
 * Series colours from the JupyterLab theme. SVG presentation attributes do
 * not accept var(), so the marks set them in `style`.
 */
const PALETTE = [
  'var(--jp-brand-color1)',
  'var(--jp-warn-color1)',
  'var(--jp-accent-color1)',
  'var(--jp-error-color1)',
  'var(--jp-info-color1)'
];

let measureCanvas: HTMLCanvasElement | null = null;

/** The width of a text in a font, as a canvas measures it; null without a canvas. */
function textWidth(text: string, font: string): number | null {
  measureCanvas ??= document.createElement('canvas');
  const context = measureCanvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.font = font;
  return context.measureText(text).width;
}

/**
 * The names of the series over a plot, one after another: each starts after
 * the text of the one before, in the font the legend shows. A card far from
 * the window is not laid out, so the width comes from a canvas, not from the
 * text element. Before the measure, and without a canvas, the entries are
 * 70 px apart. The groups of a scatter show a dot of their colour, and the
 * lines of a ribbon a line, dashed for every second one as the line is.
 */
function Legend(props: {
  names: string[];
  x: number;
  y: number;
  dots?: boolean;
}): JSX.Element {
  const { names, dots } = props;
  const ref = React.useRef<SVGGElement>(null);
  const [offsets, setOffsets] = React.useState<number[] | null>(null);
  const key = names.join('\u0000');
  React.useLayoutEffect(() => {
    const text = ref.current?.querySelector('text');
    if (!text) {
      return;
    }
    const style = getComputedStyle(text);
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    let x = 0;
    const next: number[] = [];
    for (const name of names) {
      const width = textWidth(name, font);
      if (width === null) {
        return;
      }
      next.push(x);
      // The line, the gap after it, the name and a gap before the next.
      x += 18 + width + 14;
    }
    setOffsets(next);
  }, [key]);
  return (
    <g
      ref={ref}
      transform={`translate(${props.x},${props.y})`}
      className="jp-Epi-legend"
    >
      {names.map((name, index) => (
        <g
          key={name}
          transform={`translate(${offsets?.[index] ?? index * 70},0)`}
        >
          {dots ? (
            <circle
              cx={7}
              cy={6}
              r={4}
              style={{ fill: PALETTE[index % PALETTE.length] }}
            />
          ) : (
            <line
              x1={0}
              x2={14}
              y1={6}
              y2={6}
              style={{ stroke: PALETTE[index % PALETTE.length] }}
              strokeWidth={2}
              strokeDasharray={index % 2 ? '5 3' : undefined}
            />
          )}
          <text x={18} y={9}>
            {name}
          </text>
        </g>
      ))}
    </g>
  );
}

interface IScale {
  (value: number): number;
  invert(pixel: number): number;
}

/** A day, in milliseconds: the room around the one date of a date axis. */
const DAY = 24 * 60 * 60 * 1000;

/** A domain with room around a single value. */
function padded(
  domain: [number, number],
  axis?: IPlotAxis | null
): [number, number] {
  const room = axis?.type === 'date' ? DAY : 1;
  return domain[0] === domain[1]
    ? [domain[0] - room, domain[1] + room]
    : domain;
}

function linear(domain: [number, number], range: [number, number]): IScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const scale = ((value: number) =>
    r0 + ((value - d0) / (d1 - d0)) * (r1 - r0)) as IScale;
  scale.invert = (pixel: number) => d0 + ((pixel - r0) / (r1 - r0)) * (d1 - d0);
  return scale;
}

/**
 * The ticks of an axis over a padded domain: dates on a date axis, none
 * finer than its values need.
 */
function ticksOf(
  domain: [number, number],
  count: number,
  axis: IPlotAxis | null | undefined,
  values: number[]
): ITicks {
  return axis?.type === 'date'
    ? dateTicks(domain, count, finestUnit(values))
    : numberTicks(domain, count);
}

/** An axis label, with the note that its ticks share: "conc (×10⁻⁷)", "day (2024)". */
function labelWith(label: string, ticks: ITicks): string {
  return ticks.note ? `${label} (${ticks.note})` : label;
}

/**
 * The title of a vertical axis, along the left edge of the plot: the
 * trajectory of pain named only its x axis (design iteration 1.85). A title
 * longer than the axis ends in an ellipsis, with the whole of it on hover.
 */
function YTitle(props: {
  label: string;
  left: number;
  height: number;
}): JSX.Element {
  const { label, left, height } = props;
  const fits = Math.max(4, Math.floor(height / CHAR_PX));
  // A class of its own: `.jp-Epi-axis-label` names the label under the plot.
  return (
    <text
      className="jp-Epi-axis-title"
      transform={`translate(${12 - left},${height / 2}) rotate(-90)`}
      textAnchor="middle"
    >
      {label.length > fits ? (
        <>
          <title>{label}</title>
          {`${label.slice(0, fits - 1)}…`}
        </>
      ) : (
        label
      )}
    </text>
  );
}

function extent(values: number[]): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    if (Number.isFinite(value)) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  return low === Infinity ? [0, 1] : [low, high];
}

/**
 * The x values a plot draws, to snap a brushed range to real data.
 */
export function plotXValues(payload: IPlotPayload): number[] {
  if (payload.series) {
    return [
      ...new Set(
        payload.series.flatMap(series => series.points.map(point => point.x))
      )
    ].sort((a, b) => a - b);
  }
  if (payload.bins) {
    return payload.bins.flatMap(bin => [bin.x0, bin.x1]);
  }
  return (payload.points ?? []).map(point => point.x);
}

export interface IPlotProps {
  payload: IPlotPayload;
  width: number;
  height: number;
  thumbnail?: boolean;
  /**
   * A range of x, and for a plot that selects boxes a range of y; for bars,
   * the first and the last bar, counted from 0.
   */
  selection?: { x0: number; x1: number; y?: [number, number] | null } | null;
  /** `y` is the range of y of a box, on a plot that selects boxes. */
  onSelect?: (
    x0: number,
    x1: number,
    anchor: { x: number; y: number },
    y?: [number, number] | null
  ) => void;
}

/** The width of one character of an axis label, in pixels. */
const CHAR_PX = 6.5;

/**
 * How a label under the x axis hangs from its tick: centred, or from its end
 * or its start where half of it would pass the edge of the plot. "Mar 14" at
 * the right edge ends at its tick, where centred it showed as "Mar 1".
 */
function tickAnchor(
  position: number,
  label: string,
  inner: number,
  margin: { left: number; right: number }
): 'start' | 'middle' | 'end' {
  const half = (label.length * CHAR_PX) / 2;
  if (position + half > inner + margin.right) {
    return 'end';
  }
  if (position - half < -margin.left) {
    return 'start';
  }
  return 'middle';
}

/**
 * Whether a press is on a label: a drag from there selects its text, and a
 * drag from anywhere else in the plot brushes.
 */
function onLabel(event: React.MouseEvent): boolean {
  return !!(event.target as Element).closest?.('text');
}

/**
 * Whether the bars lie across the plot, one row per bar: when a label is
 * too long to fit under its bar.
 */
export function barsAcross(payload: IPlotPayload): boolean {
  return (payload.bars ?? []).some(bar => bar.x.length > 8);
}

/**
 * While a brush goes on, the pointer anywhere on the page moves it and its
 * release ends it, so that a box dragged a few pixels past the plot's edge
 * ends at the edge instead of being dropped (design iteration 1.77). Escape
 * drops it.
 */
export function useBrushDrag(
  active: boolean,
  onMove: (event: MouseEvent) => void,
  onEnd: (event: MouseEvent) => void,
  onCancel: () => void
): void {
  const handlers = React.useRef({ onMove, onEnd, onCancel });
  handlers.current = { onMove, onEnd, onCancel };
  React.useEffect(() => {
    if (!active) {
      return;
    }
    const move = (event: MouseEvent) => handlers.current.onMove(event);
    const end = (event: MouseEvent) => handlers.current.onEnd(event);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handlers.current.onCancel();
      }
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', end, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', end, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [active]);
}

/**
 * The keyboard path of a plot: the plot is one Tab stop, the arrow keys move
 * between its marks, Home and End go to the first and the last, Page Up and
 * Page Down a tenth of the way, and Enter or Space asks what a click on the
 * current mark asks. The current mark shows while the plot has the focus,
 * and a line under the plot names it, for the eye and for screen readers.
 */
function usePlotKeys(
  count: number,
  enabled: boolean,
  ask: (index: number) => void
): {
  current: number | null;
  focused: boolean;
  props: React.SVGProps<SVGSVGElement>;
} {
  const [current, setCurrent] = React.useState<number | null>(null);
  const [focused, setFocused] = React.useState(false);
  // The marks of a plot drawn again can be fewer.
  const shown = current !== null && current < count ? current : null;
  if (!enabled || !count) {
    return { current: null, focused: false, props: {} };
  }
  const last = count - 1;
  const page = Math.max(1, Math.round(count / 10));
  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    // A plot that a click on a label focused shows the keys once one is pressed.
    setFocused(true);
    let next: number | null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = shown === null ? 0 : Math.min(last, shown + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = shown === null ? 0 : Math.max(0, shown - 1);
        break;
      case 'PageDown':
        next = shown === null ? 0 : Math.min(last, shown + page);
        break;
      case 'PageUp':
        next = shown === null ? 0 : Math.max(0, shown - page);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'Enter':
      case ' ':
        // With no mark current yet, Enter marks the first one.
        if (shown === null) {
          next = 0;
          break;
        }
        event.preventDefault();
        event.stopPropagation();
        ask(shown);
        return;
      default:
        return;
    }
    // Stop the keys here, so that the view's arrow keys between cells do
    // not also move the focus.
    event.preventDefault();
    event.stopPropagation();
    setCurrent(next);
  };
  return {
    current: shown,
    focused,
    props: {
      tabIndex: 0,
      onKeyDown,
      onFocus: event => setFocused(fromKeyboard(event.currentTarget)),
      onBlur: () => setFocused(false)
    }
  };
}

/**
 * Whether an element that took the focus shows it, as after Tab: a click on
 * a plot's label focuses the plot too, and shows neither the mark of the
 * keys nor the line under it.
 */
export function fromKeyboard(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * The line under a plot that names its current mark while the plot has the
 * keyboard focus, and names the keys that move before a mark is current.
 */
function PlotStatus(props: { focused: boolean; text: string }): JSX.Element {
  return (
    <div className="jp-Epi-plot-status" role="status">
      {props.focused ? props.text : ''}
    </div>
  );
}

/** A point of the plot's own coordinates, on the page: where its questions open. */
function pageAnchor(
  svg: SVGSVGElement | null,
  width: number,
  x: number,
  y: number
): { x: number; y: number } {
  const box = svg?.getBoundingClientRect();
  const scale = box && box.width ? box.width / width : 1;
  return { x: (box?.left ?? 0) + x * scale, y: (box?.top ?? 0) + y * scale };
}

/**
 * Bars, standing or lying across when their labels are long. A click picks
 * a bar and a drag picks the bars it crosses: `onSelect` gets the first and
 * the last of them. From the keyboard, the arrow keys move between the bars
 * and Enter picks one.
 */
function BarPlot(props: IPlotProps): JSX.Element {
  const { payload, width, thumbnail, selection, onSelect } = props;
  const bars = payload.bars ?? [];
  const count = Math.max(1, bars.length);
  const across = barsAcross(payload);
  const longest = Math.max(1, ...bars.map(bar => bar.x.length));
  // The axis holds the interval of each mean too (design iteration 1.85).
  const domain = padded(
    extent([
      0,
      ...bars.flatMap(bar => [bar.y, bar.lo ?? bar.y, bar.hi ?? bar.y])
    ])
  );
  const ticks = numberTicks(domain, across ? 5 : 4);
  const margin = thumbnail
    ? { top: 4, right: 4, bottom: 4, left: 4 }
    : {
        // Room over the value axis for the power of ten its ticks share.
        top: ticks.note && !across ? 22 : 10,
        right: 12,
        bottom: 34,
        // Standing bars: room for the title of the value axis.
        left: across
          ? Math.min(
              Math.round(width * 0.45),
              Math.ceil(longest * CHAR_PX) + 12
            )
          : 56
      };
  const height =
    thumbnail || !across
      ? props.height
      : Math.max(props.height, count * 20 + margin.top + margin.bottom);
  const inner = {
    width: width - margin.left - margin.right,
    height: height - margin.top - margin.bottom
  };
  const value = linear(domain, across ? [0, inner.width] : [inner.height, 0]);
  const band = (across ? inner.height : inner.width) / count;
  const thickness = band * 0.7;
  const [brush, setBrush] = React.useState<{
    start: number;
    end: number;
  } | null>(null);
  const svg = React.useRef<SVGSVGElement>(null);
  const selectable = !!onSelect && !thumbnail && bars.length > 0;
  const zero = value(0);
  const keys = usePlotKeys(bars.length, selectable, index => {
    const end = value(bars[index].y);
    const middle = band * (index + 0.5);
    const anchor = across
      ? pageAnchor(
          svg.current,
          width,
          margin.left + Math.max(zero, end),
          margin.top + middle
        )
      : pageAnchor(
          svg.current,
          width,
          margin.left + middle,
          margin.top + Math.min(zero, end)
        );
    onSelect?.(index, index, anchor);
  });

  /** The pointer along the bars, in pixels from the first bar. */
  const along = (event: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect();
    const scale = box.width / width;
    const pixel = across
      ? (event.clientY - box.top) / scale - margin.top
      : (event.clientX - box.left) / scale - margin.left;
    return Math.max(0, Math.min(across ? inner.height : inner.width, pixel));
  };
  const barAt = (pixel: number) =>
    Math.min(bars.length - 1, Math.max(0, Math.floor(pixel / band)));
  const onMouseDown = (event: React.MouseEvent) => {
    if (selectable && event.button === 0 && !onLabel(event)) {
      // Brushing: the browser selects no label text on the way.
      event.preventDefault();
      const start = along(event);
      setBrush({ start, end: start });
    }
  };
  // The brush ends where the pointer is released, on the plot or past it.
  useBrushDrag(
    !!brush,
    event => setBrush(current => current && { ...current, end: along(event) }),
    event => {
      if (!brush) {
        return;
      }
      setBrush(null);
      const end = along(event);
      const first = barAt(Math.min(brush.start, end));
      const last = barAt(Math.max(brush.start, end));
      onSelect?.(first, last, { x: event.clientX, y: event.clientY });
    },
    () => setBrush(null)
  );
  // A click on a label picks its bar; a drag over it selects its text.
  const pickLabel = (index: number, event: React.MouseEvent) => {
    if (selectable && window.getSelection()?.isCollapsed !== false) {
      onSelect?.(index, index, { x: event.clientX, y: event.clientY });
    }
  };
  const picked = brush
    ? {
        first: barAt(Math.min(brush.start, brush.end)),
        last: barAt(Math.max(brush.start, brush.end))
      }
    : selection
      ? { first: selection.x0, last: selection.x1 }
      : null;
  // Under a standing bar, a label shows when it fits; one in `every` shows.
  const every = Math.max(1, Math.ceil((longest * CHAR_PX + 6) / band));
  const fits = Math.max(2, Math.floor((margin.left - 12) / CHAR_PX));
  const valueLabel = payload.y?.label ?? 'rows';
  // A bar of one mean per unit counts units: "159 patients".
  const counted = (n: number) =>
    payload.unit
      ? `${payload.unit}${n === 1 ? '' : 's'}`
      : n === 1
        ? 'row'
        : 'rows';
  const barText = (bar: (typeof bars)[number]) =>
    `${bar.x}: ${numberText(bar.y)}${
      typeof bar.lo === 'number' && typeof bar.hi === 'number'
        ? `, 95% interval ${numberText(bar.lo)} to ${numberText(bar.hi)}`
        : ''
    } · ${countText(bar.n)} ${counted(bar.n)}`;
  const current = keys.current === null ? null : bars[keys.current];
  const plot = (
    <svg
      ref={svg}
      className={`jp-Epi-plot${thumbnail ? ' jp-mod-thumbnail' : ''}${selectable ? ' jp-mod-selectable' : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={selectable ? 'application' : 'img'}
      aria-label={
        selectable
          ? `${payload.title}. The arrow keys move between the bars, and Enter asks about one.`
          : payload.title
      }
      onMouseDown={onMouseDown}
      {...keys.props}
    >
      <g transform={`translate(${margin.left},${margin.top})`}>
        {!thumbnail && (
          <g className="jp-Epi-axis">
            {ticks.ticks.map((tick, index) =>
              across ? (
                <g key={`v${tick}`} transform={`translate(${value(tick)},0)`}>
                  <line y1={0} y2={inner.height} />
                  <text
                    y={inner.height + 16}
                    textAnchor={tickAnchor(
                      value(tick),
                      ticks.labels[index],
                      inner.width,
                      margin
                    )}
                  >
                    {ticks.labels[index]}
                  </text>
                </g>
              ) : (
                <g key={`v${tick}`} transform={`translate(0,${value(tick)})`}>
                  <line x1={0} x2={inner.width} />
                  <text x={-6} dy="0.32em" textAnchor="end">
                    {ticks.labels[index]}
                  </text>
                </g>
              )
            )}
            {ticks.note && !across && (
              <text className="jp-Epi-axis-note" x={-6} y={-8} textAnchor="end">
                {ticks.note}
              </text>
            )}
            {bars.map((bar, index) =>
              across ? (
                <text
                  key={bar.x}
                  className="jp-Epi-bar-label"
                  x={-6}
                  y={band * (index + 0.5)}
                  dy="0.32em"
                  textAnchor="end"
                  onClick={event => pickLabel(index, event)}
                >
                  <title>{bar.x}</title>
                  {bar.x.length > fits ? `${bar.x.slice(0, fits - 1)}…` : bar.x}
                </text>
              ) : index % every === 0 ? (
                <text
                  key={bar.x}
                  className="jp-Epi-bar-label"
                  x={band * (index + 0.5)}
                  y={inner.height + 16}
                  textAnchor="middle"
                  onClick={event => pickLabel(index, event)}
                >
                  {bar.x}
                </text>
              ) : null
            )}
            <text
              className="jp-Epi-axis-label"
              x={inner.width / 2}
              y={inner.height + 30}
              textAnchor="middle"
            >
              {across ? labelWith(valueLabel, ticks) : payload.x.label}
            </text>
            {!across && (
              <YTitle
                label={valueLabel}
                left={margin.left}
                height={inner.height}
              />
            )}
          </g>
        )}
        {picked && (
          <rect
            className="jp-Epi-brush"
            x={across ? 0 : picked.first * band}
            y={across ? picked.first * band : 0}
            width={
              across ? inner.width : (picked.last - picked.first + 1) * band
            }
            height={
              across ? (picked.last - picked.first + 1) * band : inner.height
            }
          />
        )}
        {bars.map((bar, index) => {
          const start = band * index + (band - thickness) / 2;
          const end = value(bar.y);
          return (
            <rect
              key={bar.x}
              x={across ? Math.min(zero, end) : start}
              y={across ? start : Math.min(zero, end)}
              width={across ? Math.abs(end - zero) : thickness}
              height={across ? thickness : Math.abs(end - zero)}
              style={{ fill: PALETTE[0] }}
              opacity={0.75}
            >
              {!thumbnail && <title>{barText(bar)}</title>}
            </rect>
          );
        })}
        {!thumbnail &&
          bars.map((bar, index) => {
            // The 95% interval of the mean, as a line with a cap at each end.
            if (typeof bar.lo !== 'number' || typeof bar.hi !== 'number') {
              return null;
            }
            const middle = band * (index + 0.5);
            const cap = Math.min(6, thickness / 4);
            const [low, high] = [value(bar.lo), value(bar.hi)];
            return (
              <path
                key={`interval-${bar.x}`}
                className="jp-Epi-bar-interval"
                d={
                  across
                    ? `M${low},${middle}H${high}M${low},${middle - cap}V${middle + cap}M${high},${middle - cap}V${middle + cap}`
                    : `M${middle},${low}V${high}M${middle - cap},${low}H${middle + cap}M${middle - cap},${high}H${middle + cap}`
                }
              />
            );
          })}
        {keys.focused && keys.current !== null && (
          // A frame around the current bar's band, drawn as a path so that
          // it counts as no bar.
          <path
            className="jp-Epi-plot-current"
            d={
              across
                ? `M0,${band * keys.current + 1}h${inner.width}v${band - 2}h${-inner.width}Z`
                : `M${band * keys.current + 1},0h${band - 2}v${inner.height}h${2 - band}Z`
            }
          />
        )}
        <line
          className="jp-Epi-plot-zero"
          x1={across ? zero : 0}
          x2={across ? zero : inner.width}
          y1={across ? 0 : zero}
          y2={across ? inner.height : zero}
        />
      </g>
    </svg>
  );
  if (!selectable) {
    return plot;
  }
  return (
    <>
      {plot}
      <PlotStatus
        focused={keys.focused}
        text={
          current
            ? `${payload.x.label} ${barText(current)}. Enter asks about it.`
            : 'The arrow keys move between the bars, and Enter asks about one.'
        }
      />
    </>
  );
}

/**
 * A Whybook plot as SVG. Every mark keeps its link to the rows behind it, so a
 * brushed range of x selects rows.
 */
export function EpiPlot(props: IPlotProps): JSX.Element {
  if (props.payload.kind === 'bars') {
    return <BarPlot {...props} />;
  }
  return <MarkPlot {...props} />;
}

/**
 * The marks that the arrow keys move between: the values of x of a line,
 * the points of a scatter plot in the order of x, or the bins.
 */
type Mark =
  | { kind: 'x'; x: number }
  | { kind: 'point'; index: number }
  | { kind: 'bin'; index: number };

function marksOf(payload: IPlotPayload): Mark[] {
  if (payload.series) {
    return plotXValues(payload).map(x => ({ kind: 'x', x }));
  }
  if (payload.bins) {
    return payload.bins.map((_, index) => ({ kind: 'bin', index }));
  }
  const points = payload.points ?? [];
  return points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => a.point.x - b.point.x || a.point.y - b.point.y)
    .map(({ index }) => ({ kind: 'point', index }));
}

/** Lines with their bands, points and histograms. */
function MarkPlot(props: IPlotProps): JSX.Element {
  const { payload, width, height, thumbnail, selection, onSelect } = props;
  // A brush from where the press started to where the pointer is, in the
  // plot's own coordinates; a plot that selects boxes uses its y too.
  const [brush, setBrush] = React.useState<{
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null>(null);
  const svg = React.useRef<SVGSVGElement>(null);

  const xs: number[] = [];
  const ys: number[] = [];
  if (payload.series) {
    for (const series of payload.series) {
      for (const point of series.points) {
        xs.push(point.x);
        ys.push(point.lo ?? point.y, point.hi ?? point.y);
      }
    }
    // The line of a unit reaches past the band of the mean: the axes hold it too.
    for (const line of payload.lines ?? []) {
      for (const point of line.points) {
        xs.push(point.x);
        ys.push(point.y);
      }
    }
  } else if (payload.points) {
    for (const point of payload.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
  } else if (payload.bins) {
    for (const bin of payload.bins) {
      xs.push(bin.x0, bin.x1);
      ys.push(0, bin.n);
    }
  }
  const yExtent = extent(ys);
  const xDomain = padded(extent(xs), payload.x);
  const yDomain = padded(
    [
      Math.min(0, yExtent[0]) === 0 &&
      payload.kind !== 'ribbon' &&
      payload.kind !== 'scatter'
        ? 0
        : yExtent[0],
      yExtent[1]
    ],
    payload.y
  );
  const yTicks = ticksOf(yDomain, 4, payload.y, ys);
  const margin = thumbnail
    ? { top: 4, right: 4, bottom: 4, left: 4 }
    : // Room over the y axis for what its ticks share, and beside it for its title.
      {
        top: yTicks.note ? 22 : 10,
        right: 12,
        bottom: 34,
        left: payload.y ? 56 : 44
      };
  const inner = {
    width: width - margin.left - margin.right,
    height: height - margin.top - margin.bottom
  };
  // A date reads longer than a number: fewer ticks fit across.
  const xTicks = ticksOf(
    xDomain,
    payload.x.type === 'date' ? Math.max(2, Math.round(inner.width / 70)) : 5,
    payload.x,
    xs
  );
  const x = linear(xDomain, [0, inner.width]);
  const y = linear(yDomain, [inner.height, 0]);
  // The colour of each group of points: the kernel's order, which is that of
  // a ribbon's lines, or the order of the points in an older payload.
  const groups = payload.groups ?? [
    ...new Set((payload.points ?? []).map(point => point.g ?? ''))
  ];

  const local = (event: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect();
    const scale = box.width / width;
    return {
      x: Math.max(
        0,
        Math.min(inner.width, (event.clientX - box.left) / scale - margin.left)
      ),
      y: Math.max(
        0,
        Math.min(inner.height, (event.clientY - box.top) / scale - margin.top)
      )
    };
  };
  // A scatter plot selects a box: its rows lie in a range of x and of y.
  const boxes = payload.select === 'xy';
  const selectable = !!onSelect && (payload.select === 'x' || boxes);
  const marks = React.useMemo(() => marksOf(payload), [payload]);
  const keys = usePlotKeys(marks.length, selectable && !thumbnail, index => {
    const mark = marks[index];
    if (mark.kind === 'x') {
      const top = Math.min(
        ...(payload.series ?? []).flatMap(series =>
          series.points.filter(p => p.x === mark.x).map(p => y(p.y))
        )
      );
      onSelect?.(
        mark.x,
        mark.x,
        pageAnchor(
          svg.current,
          width,
          margin.left + x(mark.x),
          margin.top + (Number.isFinite(top) ? top : 0)
        )
      );
    } else if (mark.kind === 'bin') {
      const bin = payload.bins![mark.index];
      onSelect?.(
        bin.x0,
        bin.x1,
        pageAnchor(
          svg.current,
          width,
          margin.left + x((bin.x0 + bin.x1) / 2),
          margin.top + y(bin.n)
        )
      );
    } else {
      const point = payload.points![mark.index];
      const anchor = pageAnchor(
        svg.current,
        width,
        margin.left + x(point.x),
        margin.top + y(point.y)
      );
      onSelect?.(
        point.x,
        point.x,
        anchor,
        boxes ? [point.y, point.y] : undefined
      );
    }
  });
  const onMouseDown = (event: React.MouseEvent) => {
    if (!selectable || event.button !== 0 || onLabel(event)) {
      return;
    }
    // Brushing: the browser selects no label text on the way.
    event.preventDefault();
    const start = local(event);
    setBrush({ start, end: start });
  };
  // The brush ends where the pointer is released, on the plot or past it:
  // a box dragged past an edge ends at the edge (design iteration 1.77).
  const onMouseUp = (event: MouseEvent) => {
    if (!brush) {
      return;
    }
    setBrush(null);
    const end = local(event);
    const anchor = { x: event.clientX, y: event.clientY };
    const low = Math.min(brush.start.x, end.x);
    const high = Math.max(brush.start.x, end.x);
    if (boxes) {
      const top = Math.min(brush.start.y, end.y);
      const bottom = Math.max(brush.start.y, end.y);
      if (high - low < 4 && bottom - top < 4) {
        // A click selects the nearest point.
        const nearest = (payload.points ?? []).reduce<{
          x: number;
          y: number;
        } | null>((best, point) => {
          const distance = (p: { x: number; y: number }) =>
            (x(p.x) - low) ** 2 + (y(p.y) - top) ** 2;
          return !best || distance(point) < distance(best) ? point : best;
        }, null);
        if (nearest) {
          onSelect?.(nearest.x, nearest.x, anchor, [nearest.y, nearest.y]);
        }
        return;
      }
      // The y axis grows upwards: the bottom of the box is its lower value.
      onSelect?.(x.invert(low), x.invert(high), anchor, [
        y.invert(bottom),
        y.invert(top)
      ]);
      return;
    }
    const values = plotXValues(payload);
    let x0 = x.invert(low);
    let x1 = x.invert(high);
    const bin =
      high - low < 4
        ? payload.bins?.find(item => x0 >= item.x0 && x0 <= item.x1)
        : undefined;
    if (bin) {
      // A click on a histogram selects the bin under it.
      x0 = bin.x0;
      x1 = bin.x1;
    } else if (high - low < 4) {
      // A click selects the nearest data point.
      const nearest = values.reduce(
        (best, value) =>
          Math.abs(value - x0) < Math.abs(best - x0) ? value : best,
        values[0] ?? x0
      );
      x0 = x1 = nearest;
    } else if (values.length) {
      const inside = values.filter(value => value >= x0 && value <= x1);
      if (inside.length) {
        x0 = inside[0];
        x1 = inside[inside.length - 1];
      }
    }
    onSelect?.(x0, x1, anchor);
  };
  useBrushDrag(
    !!brush,
    event => setBrush(current => current && { ...current, end: local(event) }),
    onMouseUp,
    () => setBrush(null)
  );

  const selected = brush
    ? {
        left: Math.min(brush.start.x, brush.end.x),
        right: Math.max(brush.start.x, brush.end.x),
        top: boxes ? Math.min(brush.start.y, brush.end.y) : 0,
        bottom: boxes ? Math.max(brush.start.y, brush.end.y) : inner.height
      }
    : selection
      ? {
          left: x(selection.x0) - 3,
          right: x(selection.x1) + 3,
          top: boxes && selection.y ? y(selection.y[1]) - 3 : 0,
          bottom: boxes && selection.y ? y(selection.y[0]) + 3 : inner.height
        }
      : null;

  const current = keys.current === null ? null : marks[keys.current];
  const xText = (value: number) => axisValueText(value, payload.x);
  const yLabel = payload.y?.label ?? 'rows';
  // The keys that move, and the line under the plot for the current mark.
  const hint =
    payload.kind === 'hist'
      ? 'The arrow keys move between the bins, and Enter asks about one.'
      : payload.series
        ? `The arrow keys move along ${payload.x.label}, and Enter asks about a value.`
        : 'The arrow keys move between the points, and Enter asks about one.';
  let status = hint;
  if (current?.kind === 'x') {
    const parts = (payload.series ?? []).flatMap(series =>
      series.points
        .filter(point => point.x === current.x)
        .map(point => {
          const mean = estimateText(point.y, point.lo, point.hi);
          const interval =
            mean.lo !== null && point.lo !== point.hi
              ? `, 95% interval ${mean.lo} to ${mean.hi}`
              : '';
          const name =
            (payload.series?.length ?? 0) > 1 ? `${series.name}: ` : '';
          return `${name}${yLabel} ${mean.estimate}${interval}, ${countText(point.n)} ${point.n === 1 ? 'row' : 'rows'}`;
        })
    );
    status = `${payload.x.label} ${xText(current.x)}. ${parts.join('; ')}. Enter asks about it.`;
  } else if (current?.kind === 'bin') {
    const bin = payload.bins![current.index];
    status = `${payload.x.label} ${xText(bin.x0)} to ${xText(bin.x1)}: ${countText(bin.n)} ${bin.n === 1 ? 'row' : 'rows'}. Enter asks about it.`;
  } else if (current?.kind === 'point') {
    const point = payload.points![current.index];
    status = `${payload.x.label} ${xText(point.x)}, ${yLabel} ${axisValueText(point.y, payload.y)}${point.g ? `, ${point.g}` : ''}. Enter asks about it.`;
  }

  const plot = (
    <svg
      ref={svg}
      className={`jp-Epi-plot${thumbnail ? ' jp-mod-thumbnail' : ''}${selectable ? ' jp-mod-selectable' : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={keys.props.tabIndex === 0 ? 'application' : 'img'}
      aria-label={
        keys.props.tabIndex === 0 ? `${payload.title}. ${hint}` : payload.title
      }
      onMouseDown={onMouseDown}
      {...keys.props}
    >
      <g transform={`translate(${margin.left},${margin.top})`}>
        {!thumbnail && (
          <g className="jp-Epi-axis">
            {yTicks.ticks.map((tick, index) => (
              <g key={`y${tick}`} transform={`translate(0,${y(tick)})`}>
                <line x1={0} x2={inner.width} />
                <text x={-6} dy="0.32em" textAnchor="end">
                  {yTicks.labels[index]}
                </text>
              </g>
            ))}
            {yTicks.note && (
              <text className="jp-Epi-axis-note" x={-6} y={-8} textAnchor="end">
                {yTicks.note}
              </text>
            )}
            {xTicks.ticks.map((tick, index) => (
              <text
                key={`x${tick}`}
                x={x(tick)}
                y={inner.height + 16}
                textAnchor={tickAnchor(
                  x(tick),
                  xTicks.labels[index],
                  inner.width,
                  margin
                )}
              >
                {xTicks.labels[index]}
              </text>
            ))}
            <text
              className="jp-Epi-axis-label"
              x={inner.width / 2}
              y={inner.height + 30}
              textAnchor="middle"
            >
              {labelWith(payload.x.label, xTicks)}
            </text>
            {payload.y && (
              <YTitle
                label={payload.y.label}
                left={margin.left}
                height={inner.height}
              />
            )}
          </g>
        )}
        {payload.lines?.map(line => (
          // A thin grey line per unit, under the mean and its band.
          <path
            key={`unit-${line.name}`}
            className="jp-Epi-plot-unitline"
            d={line.points
              .map((p, i) => `${i ? 'L' : 'M'}${x(p.x)},${y(p.y)}`)
              .join(' ')}
            fill="none"
            style={{ stroke: 'var(--jp-ui-font-color2)' }}
            strokeWidth={thumbnail ? 0.5 : 1}
            opacity={0.35}
          />
        ))}
        {payload.series?.map((series, index) => {
          const color = PALETTE[index % PALETTE.length];
          const band =
            series.points.map(p => `${x(p.x)},${y(p.hi)}`).join(' ') +
            ' ' +
            [...series.points]
              .reverse()
              .map(p => `${x(p.x)},${y(p.lo)}`)
              .join(' ');
          const line = series.points
            .map((p, i) => `${i ? 'L' : 'M'}${x(p.x)},${y(p.y)}`)
            .join(' ');
          return (
            <g key={series.name}>
              <polygon points={band} style={{ fill: color }} opacity={0.15} />
              <path
                d={line}
                fill="none"
                style={{ stroke: color }}
                strokeWidth={thumbnail ? 1.5 : 2}
                strokeDasharray={index % 2 ? '5 3' : undefined}
              />
            </g>
          );
        })}
        {payload.points?.map(point => (
          <circle
            key={point.i}
            cx={x(point.x)}
            cy={y(point.y)}
            r={thumbnail ? 1 : 2.2}
            style={{
              fill: PALETTE[groups.indexOf(point.g ?? '') % PALETTE.length]
            }}
            opacity={0.55}
          />
        ))}
        {payload.bins?.map(bin => (
          <rect
            key={bin.x0}
            x={x(bin.x0)}
            y={y(bin.n)}
            width={Math.max(0.5, x(bin.x1) - x(bin.x0) - 1)}
            height={Math.max(0, y(0) - y(bin.n))}
            style={{ fill: PALETTE[0] }}
            opacity={0.75}
          />
        ))}
        {selected && (
          <rect
            className="jp-Epi-brush"
            x={selected.left}
            y={selected.top}
            width={Math.max(2, selected.right - selected.left)}
            height={Math.max(2, selected.bottom - selected.top)}
          />
        )}
        {keys.focused && current && (
          <CurrentMark
            payload={payload}
            mark={current}
            x={x}
            y={y}
            height={inner.height}
          />
        )}
      </g>
      {!thumbnail && payload.series && payload.series.length > 1 && (
        <Legend
          names={payload.series.map(series => series.name)}
          x={margin.left + 8}
          y={margin.top + 4}
        />
      )}
      {!thumbnail && payload.points && groups.length > 1 && (
        <Legend names={groups} x={margin.left + 8} y={margin.top + 4} dots />
      )}
    </svg>
  );
  if (keys.props.tabIndex !== 0) {
    return plot;
  }
  return (
    <>
      {plot}
      <PlotStatus focused={keys.focused} text={status} />
    </>
  );
}

/**
 * The mark that the arrow keys are on: a line across the plot at a value of
 * x, with a ring on each line there; a ring on a point; a frame on a bin.
 */
function CurrentMark(props: {
  payload: IPlotPayload;
  mark: Mark;
  x: IScale;
  y: IScale;
  height: number;
}): JSX.Element {
  const { payload, mark, x, y } = props;
  if (mark.kind === 'bin') {
    const bin = payload.bins![mark.index];
    const left = x(bin.x0);
    const top = y(bin.n);
    return (
      <path
        className="jp-Epi-plot-current"
        d={`M${left},${top}h${Math.max(1, x(bin.x1) - left - 1)}V${y(0)}H${left}Z`}
      />
    );
  }
  if (mark.kind === 'point') {
    const point = payload.points![mark.index];
    return (
      <circle
        className="jp-Epi-plot-current"
        cx={x(point.x)}
        cy={y(point.y)}
        r={6}
      />
    );
  }
  return (
    <g className="jp-Epi-plot-current">
      <line x1={x(mark.x)} x2={x(mark.x)} y1={0} y2={props.height} />
      {(payload.series ?? []).flatMap(series =>
        series.points
          .filter(point => point.x === mark.x)
          .map(point => (
            <circle key={series.name} cx={x(point.x)} cy={y(point.y)} r={5} />
          ))
      )}
    </g>
  );
}
