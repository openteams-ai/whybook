/**
 * Questions about a point or an area of a picture that the view cannot map
 * to rows: a PNG, JPEG or SVG output from any library, or a figure whose
 * axes name no column. A click gives the point and a drag gives the area.
 * The questions offered need AI: the request to the AI model carries the
 * picture, and the point or the area as fractions of the picture and in its
 * pixels, since the model reads no position from the picture itself.
 */

import type { IAnchor, IOption } from '../tokens';
import type { EpiModel, IAskBase } from './epimodel';

/** The types of pictures that Claude reads. SVG goes as a PNG made in the browser. */
export type ImageMime = 'image/png' | 'image/jpeg';

/** A point or an area of a picture that the analyst picked. */
export interface IImagePick {
  kind: 'point' | 'area';
  /**
   * The point, or the corners of the area, as fractions of the picture from
   * its top left corner; a point has x0 = x1 and y0 = y1.
   */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The picture as the AI gets it, as base64. */
  image: { mime: ImageMime; data: string; width: number; height: number };
  /** The data of the output the pick is on, to draw the pick on that output alone. */
  source: string;
}

export interface IImageAsk extends IAskBase {
  kind: 'image';
  cellId: string;
  pick: IImagePick;
  /** The pick in a few words, for the head of the popup. */
  title: string;
  /** The pick in a sentence, for the AI model that writes a cell about it. */
  about: string;
  options: IOption[];
}

/** The picture and the pick, as the solve request sends them to the server. */
export interface IImageRequest {
  mime: ImageMime;
  data: string;
  width: number;
  height: number;
  point?: { x: number; y: number; fx: number; fy: number };
  box?: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    fx0: number;
    fy0: number;
    fx1: number;
    fy1: number;
  };
}

let counter = 2000000;

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function round(value: number, digits = 4): number {
  const scale = Math.pow(10, digits);
  return Math.round(value * scale) / scale;
}

/** The pick in the picture's pixels, rounded to whole pixels. */
function pixels(pick: IImagePick): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const { width, height } = pick.image;
  return {
    x0: Math.round(pick.x0 * width),
    y0: Math.round(pick.y0 * height),
    x1: Math.round(pick.x1 * width),
    y1: Math.round(pick.y1 * height)
  };
}

/** What the analyst pointed at, in a sentence for the AI model. */
export function pickAbout(pick: IImagePick, cellLabel: string): string {
  const { width, height } = pick.image;
  const at = pixels(pick);
  const size = `${width} by ${height} px`;
  if (pick.kind === 'point') {
    return (
      `the point ${percent(pick.x0)} across and ${percent(pick.y0)} down the picture ` +
      `that cell ${cellLabel} shows (pixel x ${at.x0}, y ${at.y0} of ${size}, from the top left)`
    );
  }
  return (
    `the area from ${percent(pick.x0)} to ${percent(pick.x1)} across and ` +
    `${percent(pick.y0)} to ${percent(pick.y1)} down the picture that cell ${cellLabel} shows ` +
    `(pixels x ${at.x0} to ${at.x1}, y ${at.y0} to ${at.y1} of ${size}, from the top left)`
  );
}

/** The picture and the pick for the solve request, as fractions and in pixels. */
export function imageRequest(pick: IImagePick): IImageRequest {
  const at = pixels(pick);
  const request: IImageRequest = {
    mime: pick.image.mime,
    data: pick.image.data,
    width: pick.image.width,
    height: pick.image.height
  };
  if (pick.kind === 'point') {
    request.point = {
      x: at.x0,
      y: at.y0,
      fx: round(pick.x0),
      fy: round(pick.y0)
    };
  } else {
    request.box = {
      ...at,
      fx0: round(pick.x0),
      fy0: round(pick.y0),
      fx1: round(pick.x1),
      fy1: round(pick.y1)
    };
  }
  return request;
}

/** The question offered about a pick: the AI reads the picture. */
export function imageOptions(cellId: string, cellLabel: string): IOption[] {
  return [
    {
      id: `image:show:${cellId}`,
      text: 'What does the plot show here?',
      type: 'descriptive',
      origin: 'template',
      probability: null,
      reasons: ['Whybook cannot map this picture to rows'],
      effect: 'AI reads the picture and writes a cell',
      placement: {
        kind: 'new',
        cell: cellId,
        label: `new cell after ${cellLabel}`
      },
      code: null
    }
  ];
}

/** Open the questions about a point or an area of a picture in a cell's output. */
export function askImage(
  model: EpiModel,
  cellId: string,
  pick: IImagePick,
  anchor: IAnchor | null
): void {
  const label = model.cell(cellId)?.label ?? 'the cell';
  const ask: IImageAsk = {
    kind: 'image',
    id: ++counter,
    anchor,
    loading: false,
    error: null,
    cellId,
    pick,
    title:
      pick.kind === 'point'
        ? 'This point of the plot'
        : 'This area of the plot',
    about: pickAbout(pick, label),
    options: imageOptions(cellId, label)
  };
  model.showAsk(ask);
}

/** The pick of the open request, when it is about a picture of this cell. */
export function imagePickOf(
  model: EpiModel,
  cellId: string | null | undefined
): IImagePick | null {
  const ask = model.ask;
  return ask?.kind === 'image' && ask.cellId === cellId ? ask.pick : null;
}
