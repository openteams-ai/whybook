import type { IPlotPayload } from '../tokens';

export const PLOTLY_MIME = 'application/vnd.plotly.v1+json';

/** A title in a Plotly figure: a text, or an object with the text. */
type PlotlyTitle = string | { text?: unknown } | null;

/** An axis or the legend of a Plotly layout, as far as the view reads it. */
interface IPlotlyPart {
  type?: string;
  title?: PlotlyTitle;
}

/**
 * What the helpers of the whybook package keep in `layout.meta.whybook`:
 * the frame of the chart and its columns.
 */
interface IPlotlyMeta {
  frame?: unknown;
  x?: string | null;
  y?: string | null;
  color?: string | null;
}

/** The parts of a Plotly layout that the view reads. */
interface IPlotlyLayout {
  title?: PlotlyTitle;
  xaxis?: IPlotlyPart;
  yaxis?: IPlotlyPart;
  legend?: IPlotlyPart;
  dragmode?: unknown;
  meta?: { whybook?: IPlotlyMeta };
}

/** The event of a selection on a Plotly chart: a box gives its ranges. */
export interface IPlotlySelection {
  points?: unknown[];
  range?: { x?: unknown; y?: unknown };
  lassoPoints?: { x?: unknown; y?: unknown };
}

/**
 * The graph div that Plotly's own renderer draws into. plotly.js puts `on`
 * and `removeListener` on the div, and keeps the figure on it.
 */
export interface IPlotlyGraph extends HTMLElement {
  on(event: string, handler: (data: IPlotlySelection) => void): void;
  removeListener?(
    event: string,
    handler: (data: IPlotlySelection) => void
  ): void;
  data?: { type?: string }[];
  layout?: IPlotlyLayout;
  calcdata?: (unknown[] | null)[];
  _fullLayout?: IPlotlyLayout;
}

function titleOf(item: { title?: PlotlyTitle } | undefined): string | null {
  const title = item?.title;
  const text = typeof title === 'string' ? title : title?.text;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

/** Traces that draw one mark per row, so that a box holds whole rows. */
const ROW_TRACES = ['scatter', 'scattergl'];

/**
 * The Whybook plot payload for a Plotly figure, so that a selection on it asks
 * the same questions as a selection on a Whybook plot. Plotly Express names the
 * columns in the axis titles and the column of the colours in the legend
 * title. The frame is named only when `layout.meta.whybook` holds it; otherwise
 * the view looks for the frame with these columns. A chart of bins, bars or
 * boxes gives no payload: its marks are not rows.
 */
export function plotlyPayload(graph: IPlotlyGraph): IPlotPayload | null {
  const layout = graph.layout ?? {};
  const full = graph._fullLayout ?? layout;
  const traces = graph.data ?? [];
  if (!traces.every(trace => ROW_TRACES.includes(trace.type ?? 'scatter'))) {
    return null;
  }
  // A range on dates or categories is not a range of numbers.
  if (full.xaxis?.type && full.xaxis.type !== 'linear') {
    return null;
  }
  const meta = layout.meta?.whybook ?? {};
  const x: string | null = meta.x ?? titleOf(full.xaxis);
  if (!x) {
    return null;
  }
  const y: string | null = meta.y ?? titleOf(full.yaxis);
  const by: string | null =
    meta.color ?? (traces.length > 1 ? titleOf(full.legend) : null);
  const rows = (graph.calcdata ?? []).reduce(
    (count, trace) => count + (trace?.length ?? 0),
    0
  );
  return {
    version: 1,
    kind: 'scatter',
    title: titleOf(layout) ?? (y ? `${y} by ${x}` : x),
    x: { field: x, label: titleOf(full.xaxis) ?? x },
    y: y ? { field: y, label: titleOf(full.yaxis) ?? y } : null,
    source: {
      frame: typeof meta.frame === 'string' ? meta.frame : null,
      x,
      y,
      by,
      rows
    },
    select: 'x'
  };
}

function ordered(range: unknown): [number, number] | null {
  if (
    Array.isArray(range) &&
    typeof range[0] === 'number' &&
    typeof range[1] === 'number'
  ) {
    return [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
  }
  return null;
}

/**
 * The ranges of x and y that a box selection covers. A lasso gives points
 * and no ranges: its rows need row ids in the chart, which it does not have.
 */
export function selectedBox(
  event: IPlotlySelection | undefined
): { x: [number, number]; y: [number, number] | null } | null {
  const x = ordered(event?.range?.x);
  return x ? { x, y: ordered(event?.range?.y) } : null;
}

/**
 * Listen for selections on the Plotly chart that a renderer draws in `host`.
 * The renderer draws the chart when it has no picture of it, or when the
 * pointer first enters the picture, so the listener waits for the graph div.
 * Returns a function that stops listening.
 */
/**
 * In the view a drag on a chart asks about the rows in a box, so a chart
 * whose figure chose no drag mode starts in Box Select, through the button
 * of its own toolbar; Plotly's default is to zoom. A figure that set a drag
 * mode keeps it. True once settled: switched, or kept.
 */
function startInBoxSelect(graph: IPlotlyGraph, host: HTMLElement): boolean {
  if (graph.layout?.dragmode !== undefined) {
    return true;
  }
  const button = host.querySelector(
    '.modebar-btn[data-attr="dragmode"][data-val="select"]'
  ) as HTMLElement | null;
  if (!button) {
    // The toolbar is drawn after the chart: the next change tries again.
    return false;
  }
  button.click();
  return true;
}

export function watchPlotly(
  host: HTMLElement,
  onSelect: (
    plot: IPlotPayload,
    x0: number,
    x1: number,
    anchor: { x: number; y: number },
    y: [number, number] | null
  ) => void
): () => void {
  let graph: IPlotlyGraph | null = null;
  let pointer = { x: 0, y: 0 };
  const onPointerUp = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
  };
  const onSelected = (event: IPlotlySelection) => {
    const box = selectedBox(event);
    const plot = graph && box ? plotlyPayload(graph) : null;
    if (plot && box) {
      // A range on a y axis of dates or categories is not a range of numbers.
      const linear = (graph?._fullLayout?.yaxis?.type ?? 'linear') === 'linear';
      onSelect(plot, box.x[0], box.x[1], pointer, linear ? box.y : null);
    }
  };
  let boxSelect = false;
  const attach = () => {
    const found = host.querySelector('.js-plotly-plot') as IPlotlyGraph | null;
    if (found && found !== graph && typeof found.on === 'function') {
      graph?.removeListener?.('plotly_selected', onSelected);
      graph = found;
      graph.on('plotly_selected', onSelected);
      boxSelect = false;
    }
    if (graph && !boxSelect) {
      boxSelect = startInBoxSelect(graph, host);
    }
  };
  const observer = new MutationObserver(attach);
  observer.observe(host, { childList: true, subtree: true });
  // plotly.js sends the selection on mouse up, after this event.
  host.addEventListener('pointerup', onPointerUp, true);
  attach();
  return () => {
    observer.disconnect();
    host.removeEventListener('pointerup', onPointerUp, true);
    graph?.removeListener?.('plotly_selected', onSelected);
  };
}
