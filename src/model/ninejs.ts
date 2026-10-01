import type { IAxesPayload } from './axes';
import { axesOf } from './axes';

/**
 * ninejs draws a plotnine chart as the SVG that matplotlib writes, in an
 * iframe of its own, with a tooltip for each point. The view sees none of
 * the iframe's events: a box on the chart is drawn on a layer over the
 * frame, and mapped to the chart's rows through the Axes that the kernel's
 * hook describes, in the points of the SVG (plot_hooks.py).
 *
 * That mapping holds only while the frame draws the SVG as ninejs 0.1 does:
 * as wide as the frame, inside the page's default margin of 8 px. Each part
 * of that is checked in the output, and a chart that fails a check shows as
 * ninejs ships it, with no layer, so a later ninejs that draws differently
 * never gets a box mapped to the wrong rows.
 */

/** The page margin around the SVG in the frame, in CSS pixels. */
export const FRAME_MARGIN = 8;

/** The size of the SVG, in its own points, and the Axes on it. */
export interface INinejsChart {
  width: number;
  height: number;
  axes: IAxesPayload;
}

function htmlOf(data: Record<string, unknown>): string {
  const value = data['text/html'];
  return Array.isArray(value)
    ? value.join('')
    : typeof value === 'string'
      ? value
      : '';
}

/**
 * The ninejs chart of an output, when a box on it can be mapped to rows:
 * the frame is ninejs's, its CSS makes the SVG as wide as the frame, and
 * the SVG's size is the size that the hook described. Null otherwise.
 */
export function ninejsChart(
  data: Record<string, unknown>
): INinejsChart | null {
  const axes = axesOf(data);
  if (!axes || axes.library !== 'ninejs') {
    return null;
  }
  const html = htmlOf(data);
  if (!/<iframe\b[^>]*\btitle="ninejs interactive plot"/.test(html)) {
    return null;
  }
  // The document of the frame sits in its srcdoc attribute, escaped.
  const document = html
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  if (!document.includes('svg{width:100%;height:auto;}')) {
    return null;
  }
  if (/body\s*\{/.test(document)) {
    // A rule of its own for the page could change the margin.
    return null;
  }
  const viewBox =
    /<svg\b[^>]*\bviewBox="\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*"/.exec(document);
  if (!viewBox) {
    return null;
  }
  const width = parseFloat(viewBox[1]);
  const height = parseFloat(viewBox[2]);
  const { image } = axes;
  if (
    !(width > 0) ||
    !(height > 0) ||
    Math.abs(image.width - width) > 0.5 ||
    Math.abs(image.height - height) > 0.5
  ) {
    return null;
  }
  return { width, height, axes };
}

/**
 * Where the SVG of a ninejs chart lies on the page: inside the frame's
 * margin, as wide as the frame's content, with the SVG's proportions.
 */
export function ninejsPlace(
  host: HTMLElement | null,
  chart: INinejsChart
): { left: number; top: number; width: number; height: number } | null {
  const frame = host?.querySelector('iframe');
  if (!frame) {
    return null;
  }
  const rect = frame.getBoundingClientRect();
  const width = frame.clientWidth - 2 * FRAME_MARGIN;
  if (width <= 0) {
    return null;
  }
  return {
    left: rect.left + frame.clientLeft + FRAME_MARGIN,
    top: rect.top + frame.clientTop + FRAME_MARGIN,
    width,
    height: (width * chart.height) / chart.width
  };
}
