import type { IOutputModel } from '@jupyterlab/rendermime';

import { plotPayload } from '../tokens';
import { axesOf } from './axes';
import { outputText } from './logs';
import type { OutputKind } from './notebook';
import { WIDGET_MIME, outputKind } from './notebook';
import { PLOTLY_MIME } from './plotly';
import { htmlOf, tableInfo } from './tables';

/**
 * An output as small as it can be shown: its kind and a few words, such as
 * the size of a table, the title of a plot or the line count of a text.
 */
export interface IOutputTile {
  kind: OutputKind;
  text: string;
  /** The same in a sentence, for the tooltip. */
  title: string;
  /** What a plot draws, for its icon. */
  glyph?: PlotGlyph;
}

/** What a plot draws, as its icon on the map shows it. */
export type PlotGlyph =
  | 'scatter'
  | 'line'
  | 'bars'
  | 'hist'
  | 'ribbon'
  | 'area'
  | 'box'
  | 'heatmap'
  | 'pie'
  | 'chart';

/** The words of each icon, where a plot has no title. */
export const GLYPH_WORDS: Record<PlotGlyph, string> = {
  scatter: 'scatter',
  line: 'line',
  bars: 'bars',
  hist: 'histogram',
  ribbon: 'ribbon',
  area: 'area',
  box: 'box plot',
  heatmap: 'heatmap',
  pie: 'pie',
  chart: 'plot'
};

// The kinds of pandas and matplotlib plots, and of Plotly traces, by icon.
const KIND_GLYPHS: Record<string, PlotGlyph> = {
  scatter: 'scatter',
  scattergl: 'scatter',
  line: 'line',
  kde: 'line',
  density: 'line',
  bar: 'bars',
  barh: 'bars',
  hist: 'hist',
  histogram: 'hist',
  area: 'area',
  box: 'box',
  violin: 'box',
  hexbin: 'heatmap',
  heatmap: 'heatmap',
  pie: 'pie'
};

/**
 * What the plot of an output draws, and its title where the output tells:
 * the view's own plots, Plotly's traces, and the Axes that the matplotlib
 * hook describes. Other pictures and charts are a plot of no known kind.
 */
export function plotGlyph(data: Record<string, unknown>): {
  glyph: PlotGlyph;
  title: string;
} {
  const plot = plotPayload(data);
  if (plot) {
    const glyph: PlotGlyph = plot.kind === 'bars' ? 'bars' : plot.kind;
    return { glyph, title: plot.title };
  }
  const plotly = data[PLOTLY_MIME] as
    | {
        data?: { type?: string; mode?: string }[];
        layout?: { title?: string | { text?: string } };
      }
    | undefined;
  if (plotly) {
    const trace = plotly.data?.[0];
    const type = trace?.type ?? 'scatter';
    const glyph =
      type === 'scatter' || type === 'scattergl'
        ? /markers/.test(trace?.mode ?? 'markers') &&
          !/lines/.test(trace?.mode ?? '')
          ? 'scatter'
          : 'line'
        : (KIND_GLYPHS[type] ?? 'chart');
    const title = plotly.layout?.title;
    return {
      glyph,
      title: (typeof title === 'string' ? title : title?.text) ?? ''
    };
  }
  const axes = axesOf(data)?.axes[0];
  if (axes) {
    return {
      glyph: (axes.kind && KIND_GLYPHS[axes.kind]) || 'chart',
      title: axes.title
    };
  }
  return { glyph: 'chart', title: '' };
}

// Reading a table's size parses its HTML, so each table is read once. A
// stream grows in the same output model, so its tile is read each time.
const tiles = new WeakMap<IOutputModel, IOutputTile | null>();

export function outputTile(output: IOutputModel): IOutputTile | null {
  if (output.streamText) {
    return readTile(output);
  }
  if (!tiles.has(output)) {
    tiles.set(output, readTile(output));
  }
  return tiles.get(output) ?? null;
}

function readTile(output: IOutputModel): IOutputTile | null {
  const kind = outputKind(output);
  switch (kind) {
    case 'progress':
      return null;
    case 'table': {
      const info = tableInfo(htmlOf(output));
      const text =
        info.rows !== null && info.columns !== null
          ? `${info.rows.toLocaleString()} × ${info.columns.toLocaleString()}`
          : `${info.tables} tables`;
      return { kind, text, title: `A table, ${text}` };
    }
    case 'plot':
    case 'image':
    case 'chart': {
      const { glyph, title } = plotGlyph(output.data);
      const word = GLYPH_WORDS[glyph];
      const label = word[0].toUpperCase() + word.slice(1);
      return {
        kind,
        text: title || word,
        title: title ? `${label}: ${title}` : label,
        glyph
      };
    }
    case 'log':
    case 'text': {
      const total = outputText(output.data)?.total ?? 0;
      // Nothing left to show, such as IPython's message about its history
      // database alone, which the bench leaves out too.
      if (total === 0) {
        return null;
      }
      const text = `${total.toLocaleString()} line${total === 1 ? '' : 's'}`;
      return {
        kind,
        text,
        title: `${kind === 'log' ? 'Printed' : 'A text'}, ${text}`
      };
    }
    case 'error': {
      const name = String((output.toJSON() as { ename?: string }).ename ?? '');
      return { kind, text: name || 'error', title: `An error: ${name}` };
    }
    case 'widget':
    default:
      return { kind, text: kind, title: `A ${kind}` };
  }
}

/** What pictureOf reads of an output, and gives back. */
export interface IPictureLike {
  type: string;
  data: IOutputModel['data'];
  metadata: IOutputModel['metadata'];
  trusted: boolean;
}

/**
 * The height over the width of the first SVG in an iframe's document, from
 * its viewBox, or null.
 */
export function svgRatio(srcdoc: string | null): number | null {
  const match =
    srcdoc &&
    /<svg\b[^>]*\bviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(
      srcdoc
    );
  if (!match) {
    return null;
  }
  const width = parseFloat(match[1]);
  const height = parseFloat(match[2]);
  return width > 0 && height > 0 ? height / width : null;
}

/**
 * The picture that a live figure keeps of itself, as ipympl's does: what
 * the figure shows where there is no room for it to be live. Null for other
 * outputs.
 */
export function pictureOf(output: IPictureLike): IPictureLike | null {
  const png = output.data['image/png'];
  if (!output.data[WIDGET_MIME] || typeof png !== 'string') {
    return null;
  }
  return {
    type: output.type,
    data: { 'image/png': png },
    metadata: output.metadata,
    trusted: output.trusted
  };
}
