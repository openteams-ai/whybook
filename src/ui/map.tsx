import { launchIcon, markdownIcon } from '@jupyterlab/ui-components';
import * as React from 'react';

import { runStatus } from '../model/agent';
import type { EpiModel, IEpiCell, IMapCamera, IStrip } from '../model/epimodel';
import { TEXT_LINES } from '../model/logs';
import { firstLine, noteBody, outputKind, outputsOf } from '../model/notebook';
import type { IOutputTile, PlotGlyph } from '../model/outputs';
import { outputTile } from '../model/outputs';
import { stripAction } from './bench';
import {
  CellLabel,
  ProgressBar,
  anchorOf,
  carriesItem,
  cellElement,
  dragItem,
  flash,
  modifiersOf,
  useFileDrop,
  useModel,
  useSeconds
} from './common';
import { EmptyStart, LoadingCells } from './empty';
import { Miniature, OutputBoundary, TextOutput } from './outputs';
import { Segmented } from './segmented';
import { TableOutput } from './tables';

/** Wide enough for a title of about 30 characters a line, on two lines. */
const CARD_WIDTH = 260;
/** At Overview a card holds the tiles of the bench's Overview. */
const WIDE_CARD_WIDTH = 300;
const CARD_HEIGHT = 54;
const BRANCH_HEIGHT = 86;
/** The answer to a question about the cell, under it: two lines, a bar and a link. */
const ANSWER_HEIGHT = 60;
const GAP_Y = 30;
const BAND_PAD = 34;
/** The line of output tiles under a cell's title, at Minimal. */
const OUTPUTS_HEIGHT = 20;
/** The tiles of Overview under a cell's title, until the card is measured. */
const OVERVIEW_HEIGHT = 84;
const MAIN_X = 150;
/** Between a cell and its first branch, or between two branches. */
const BRANCH_GAP = 30;

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const ZOOM_STEP = 1.25;
/** However the map moves, at least this much of it stays in view, in pixels. */
const KEEP_IN_VIEW = 80;
/** The spacing of the background dots at 100%, in pixels. */
const GRID = 24;

const MAP_HINT =
  'Top to bottom is execution order. Click a cell, a text or a data node ' +
  'for questions; double-click a cell to show it on the bench; drag a ' +
  'rectangle or Shift/Ctrl-click to select several. Scroll, Space+drag or ' +
  'a middle-button drag moves the map; Ctrl+scroll zooms.';

interface INode {
  id: string;
  /** A code cell, a markdown cell's text, or a frame the notebook loads. */
  kind: 'cell' | 'note' | 'frame';
  cell: IEpiCell | null;
  label: string;
  /** A frame from the last run that the kernel lacks. */
  stale?: boolean;
  x: number;
  y: number;
  w: number;
  /** The height the layout gives it: measured once drawn, at Overview. */
  h: number;
  /** The height the card has at least, before its outputs. */
  min: number;
  /** A cell's outputs as tiles, at Minimal. */
  tiles: IOutputTile[];
}

/** The words of a markdown text, without links, emphasis, code and list marks. */
function plain(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/^[#>\s-]+/gm, '');
}

interface IEdge {
  from: string;
  to: string;
  dashed: boolean;
}

interface ILayout {
  nodes: INode[];
  edges: IEdge[];
  bands: { title: string; y: number; h: number }[];
  width: number;
  height: number;
}

/**
 * The outputs of a cell as tiles, when the map shows outputs. An output
 * that cannot be read gives a tile that says so, and the map stays.
 */
function tilesOf(model: EpiModel, cell: IEpiCell): IOutputTile[] {
  if (model.mapDetail === 'none' || cell.type !== 'code') {
    return [];
  }
  const tiles: IOutputTile[] = [];
  for (const output of outputsOf(cell.model)) {
    let tile: IOutputTile | null;
    try {
      tile = outputTile(output);
    } catch (error) {
      console.warn('Could not read an output for the map', error);
      tile = {
        kind: outputKind(output),
        text: 'not drawn',
        title: 'This output could not be drawn'
      };
    }
    if (tile) {
      tiles.push(tile);
    }
  }
  return tiles;
}

/**
 * Place cells top to bottom in execution order: one band per section, the
 * main line on the left, branches to the right of the cell they branch from.
 * A cell with outputs gets a line for their tiles at Minimal, and room for
 * the tiles of the bench's Overview at Overview, where the cards are wider
 * and `measured` gives their heights once they are drawn.
 */
export function mapLayout(
  model: EpiModel,
  measured: ReadonlyMap<string, number> = new Map()
): ILayout {
  // The slider's level, or the zoom's (src/model/spacedetail.ts).
  const detail = model.mapDetail;
  const cardWidth = detail === 'overview' ? WIDE_CARD_WIDTH : CARD_WIDTH;
  // Each cell's outputs are read once per layout.
  const tiles = new Map<string, IOutputTile[]>();
  const tilesFor = (cell: IEpiCell) => {
    let found = tiles.get(cell.id);
    if (!found) {
      found = tilesOf(model, cell);
      tiles.set(cell.id, found);
    }
    return found;
  };
  const extra = (cell: IEpiCell) =>
    !tilesFor(cell).length
      ? 0
      : detail === 'overview'
        ? OVERVIEW_HEIGHT
        : OUTPUTS_HEIGHT;
  const answer = (cell: IEpiCell) =>
    model.strips.has(cell.id) ? ANSWER_HEIGHT : 0;
  const heightOf = (cell: IEpiCell, min: number) =>
    measured.get(cell.id) ?? min + extra(cell) + answer(cell);
  const { title, intro, sections } = model.sections();
  const definitions = model.definitions();
  const nodes: INode[] = [];
  const edges: IEdge[] = [];
  const bands: ILayout['bands'] = [];
  let y = 12;
  if (intro) {
    const h = CARD_HEIGHT + 2 * BAND_PAD - 10;
    bands.push({ title: title ?? 'Introduction', y, h });
    nodes.push({
      id: intro.id,
      kind: 'note',
      cell: intro,
      label: plain(noteBody(intro.model.sharedModel.getSource())),
      x: MAIN_X,
      y: y + BAND_PAD,
      w: cardWidth,
      h: CARD_HEIGHT,
      min: CARD_HEIGHT,
      tiles: []
    });
    y += h;
  }
  // The frames that an agent's run made for its own steps, which no later
  // cell outside the run reads, stay out: the run's cards and their edges
  // show its work (design iteration 1.83).
  const sourceFrames = model
    .mainVariables()
    .filter(
      variable =>
        variable.kind === 'dataframe' &&
        definitions.get(variable.name)?.sectionId === sections[0]?.id
    );
  if (sourceFrames.length) {
    const h = CARD_HEIGHT + 2 * BAND_PAD - 10;
    bands.push({ title: 'data', y, h });
    sourceFrames.forEach((frame, index) => {
      nodes.push({
        id: `frame:${frame.name}`,
        kind: 'frame',
        cell: null,
        label: frame.name,
        stale: frame.stale,
        x: MAIN_X + index * 130,
        y: y + BAND_PAD,
        w: 110,
        h: 34,
        min: 34,
        tiles: []
      });
    });
    y += h;
  }
  for (const section of sections) {
    const main = section.cells.filter(
      cell => (cell.type === 'code' && !cell.branchOf) || model.isNote(cell)
    );
    if (!main.length) {
      continue;
    }
    const top = y;
    let rowY = y + BAND_PAD;
    for (const cell of main) {
      if (cell.type !== 'code') {
        nodes.push({
          id: cell.id,
          kind: 'note',
          cell,
          label: plain(noteBody(cell.model.sharedModel.getSource())),
          x: MAIN_X,
          y: rowY,
          w: cardWidth,
          h: CARD_HEIGHT,
          min: CARD_HEIGHT,
          tiles: []
        });
        rowY += CARD_HEIGHT + GAP_Y;
        continue;
      }
      const branches = cell.branches
        .map(id => model.cell(id))
        .filter(Boolean) as IEpiCell[];
      const rowHeight = Math.max(
        heightOf(cell, CARD_HEIGHT),
        ...branches.map(branch => heightOf(branch, BRANCH_HEIGHT))
      );
      nodes.push({
        id: cell.id,
        kind: 'cell',
        cell,
        label: cell.title,
        x: MAIN_X,
        y: rowY,
        w: cardWidth,
        h: heightOf(cell, CARD_HEIGHT),
        min: CARD_HEIGHT,
        tiles: tilesFor(cell)
      });
      branches.forEach((branch, index) => {
        nodes.push({
          id: branch.id,
          kind: 'cell',
          cell: branch,
          label: branch.title,
          x: MAIN_X + (index + 1) * (cardWidth + BRANCH_GAP),
          y: rowY,
          w: cardWidth,
          h: heightOf(branch, BRANCH_HEIGHT),
          min: BRANCH_HEIGHT,
          tiles: tilesFor(branch)
        });
        edges.push({ from: cell.id, to: branch.id, dashed: true });
      });
      rowY += rowHeight + GAP_Y;
    }
    const h = rowY - top - GAP_Y + BAND_PAD;
    bands.push({ title: `§${section.number} ${section.title}`, y: top, h });
    y = top + h;
  }
  // Data flow: a cell that uses a name another cell defined. The nodes and
  // the edges so far are looked up in sets, so that the layout takes time
  // in proportion to the cells.
  const cells = model.codeCells();
  const byName = new Map<string, string>();
  const placed = new Set(nodes.map(node => node.id));
  const joined = new Set(edges.map(edge => `${edge.from} ${edge.to}`));
  for (const cell of cells) {
    for (const name of cell.analysis?.uses ?? []) {
      const from = byName.get(name);
      if (
        from &&
        from !== cell.id &&
        !joined.has(`${from} ${cell.id}`) &&
        placed.has(cell.id)
      ) {
        const origin = model.cell(from);
        if (origin && origin.id !== cell.branchOf) {
          edges.push({ from, to: cell.id, dashed: false });
          joined.add(`${from} ${cell.id}`);
        }
      }
    }
    for (const name of cell.analysis?.defs ?? []) {
      byName.set(name, cell.id);
      if (placed.has(`frame:${name}`)) {
        byName.set(name, `frame:${name}`);
      }
    }
  }
  const width = Math.max(...nodes.map(node => node.x + node.w), 400) + 40;
  return { nodes, edges, bands, width, height: y + 40 };
}

function edgePath(from: INode, to: INode): string {
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  if (Math.abs(from.y - to.y) < 4) {
    // A branch beside its parent.
    return `M${from.x + from.w},${from.y + from.h / 2} C${from.x + from.w + 20},${from.y + from.h / 2} ${to.x - 20},${to.y + to.h / 2} ${to.x},${to.y + to.h / 2}`;
  }
  const middle = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${middle} ${x2},${middle} ${x2},${y2}`;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The camera, moved back so that some of the map stays in the view. */
function keepInView(
  camera: IMapCamera,
  layout: ILayout,
  width: number,
  height: number
): IMapCamera {
  const zoom = clampZoom(camera.zoom);
  if (!width || !height) {
    return { ...camera, zoom };
  }
  const w = layout.width * zoom;
  const h = layout.height * zoom;
  const keepX = Math.min(KEEP_IN_VIEW, w);
  const keepY = Math.min(KEEP_IN_VIEW, h);
  return {
    zoom,
    x: Math.min(width - keepX, Math.max(keepX - w, camera.x)),
    y: Math.min(height - keepY, Math.max(keepY - h, camera.y))
  };
}

/** The node nearest a point of the map: the one under it, if any. */
function nearestNode(layout: ILayout, x: number, y: number): INode | null {
  let nearest: INode | null = null;
  let best = Infinity;
  for (const node of layout.nodes) {
    const dx = Math.max(node.x - x, 0, x - node.x - node.w);
    const dy = Math.max(node.y - y, 0, y - node.y - node.h);
    const distance = dx * dx + dy * dy;
    if (distance < best) {
      best = distance;
      nearest = node;
    }
  }
  return nearest;
}

/** Dots that move with the map, so a move shows even over empty space. */
function gridStyle(camera: IMapCamera): React.CSSProperties {
  let step = GRID * camera.zoom;
  while (step < GRID / 2) {
    step *= 2;
  }
  return {
    backgroundSize: `${step}px ${step}px`,
    backgroundPosition: `${camera.x}px ${camera.y}px`
  };
}

function ZoomControls(props: {
  zoom: number;
  onZoom: (factor: number) => void;
  onReset: () => void;
  onFit: () => void;
}): JSX.Element {
  const { zoom, onZoom, onReset, onFit } = props;
  return (
    <div
      className="jp-Epi-map-zoom"
      role="group"
      aria-label="Zoom"
      // A click here is not a click on the map: it keeps the selection.
      onClick={event => event.stopPropagation()}
    >
      <button
        className="jp-Epi-map-zoom-button"
        onClick={() => onZoom(1 / ZOOM_STEP)}
        disabled={zoom <= MIN_ZOOM}
        title="Zoom out (Ctrl+scroll)"
        aria-label="Zoom out"
      >
        −
      </button>
      <button
        className="jp-Epi-map-zoom-button jp-mod-level"
        onClick={onReset}
        title="Back to 100%, at the start of the map"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        className="jp-Epi-map-zoom-button"
        onClick={() => onZoom(ZOOM_STEP)}
        disabled={zoom >= MAX_ZOOM}
        title="Zoom in (Ctrl+scroll)"
        aria-label="Zoom in"
      >
        +
      </button>
      <button
        className="jp-Epi-map-zoom-button"
        onClick={onFit}
        title="Show the whole map"
      >
        Fit
      </button>
    </div>
  );
}

export function MapView(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  // At Overview the tiles decide how tall a card is: the cards are measured
  // once drawn, and the layout places the rows with those heights.
  const [measured, setMeasured] = React.useState<ReadonlyMap<string, number>>(
    () => new Map()
  );
  const overview = model.mapDetail === 'overview';
  // The layout follows the notebook: its cells, the frames of the kernel,
  // the answers under cells and the level of detail. A wheel event, a move
  // of the map or a box drawn over it lays nothing out again, unless the
  // zoom sets the level.
  const cells = model.cells();
  const variables = model.variables();
  const answers = [...model.strips.keys()].join('\n');
  const layout = React.useMemo(
    () => mapLayout(model, overview ? measured : undefined),
    [
      model,
      cells,
      variables,
      answers,
      model.mapDetail,
      overview ? measured : null
    ]
  );
  const byId = React.useMemo(
    () => new Map(layout.nodes.map(node => [node.id, node])),
    [layout]
  );
  const canvas = React.useRef<HTMLDivElement>(null);
  const cardIds = React.useMemo(
    () =>
      layout.nodes
        .filter(node => node.kind === 'cell')
        .map(node => node.id)
        .join(' '),
    [layout]
  );
  React.useLayoutEffect(() => {
    const node = canvas.current;
    if (!overview || !node) {
      return;
    }
    const cards = Array.from(
      node.querySelectorAll<HTMLElement>('.jp-Epi-map-cell')
    );
    const read = () => {
      const next = new Map<string, number>();
      for (const card of cards) {
        if (card.dataset.cellId) {
          next.set(card.dataset.cellId, card.offsetHeight);
        }
      }
      setMeasured(current =>
        current.size === next.size &&
        Array.from(next).every(
          ([id, height]) => Math.abs((current.get(id) ?? -9) - height) < 1
        )
          ? current
          : next
      );
    };
    read();
    const observer = new ResizeObserver(read);
    cards.forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [overview, cardIds]);
  const [box, setBox] = React.useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    add: boolean;
  } | null>(null);
  const viewport = React.useRef<HTMLDivElement>(null);
  const boxed = React.useRef(false);
  const [fileOver, setFileOver] = React.useState(false);
  useFileDrop(
    viewport,
    (paths, anchor) => model.askFileDrop(paths, {}, anchor),
    setFileOver
  );

  // The map moves and zooms as a whole over a fixed background, so it moves
  // whether or not it fits the view.
  const [camera, setCameraState] = React.useState<IMapCamera>(model.mapCamera);
  const cameraRef = React.useRef(camera);
  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;
  // When the zoom sets the level of detail, the node nearest the point of
  // the zoom keeps its place in the view while the map is laid out again:
  // its id, and where its corner was, in pixels of the view.
  const held = React.useRef<{ id: string; x: number; y: number } | null>(null);
  // A fit that changed the level fits the map of the new level once more.
  const refit = React.useRef(false);
  const placeCamera = (next: IMapCamera): IMapCamera => {
    const node = viewport.current;
    const kept = node
      ? keepInView(next, layoutRef.current, node.clientWidth, node.clientHeight)
      : next;
    cameraRef.current = kept;
    model.mapCamera = kept;
    setCameraState(kept);
    return kept;
  };
  /**
   * Move or zoom the map; a zoom keeps what is nearest its point in place.
   * True when the zoom changed the level of detail.
   */
  const setCamera = (
    next: IMapCamera,
    point?: { x: number; y: number }
  ): boolean => {
    const kept = placeCamera(next);
    held.current = null;
    refit.current = false;
    const changed = model.spaceDetail.setZoom(kept.zoom);
    if (changed && point) {
      const near = nearestNode(
        layoutRef.current,
        (point.x - kept.x) / kept.zoom,
        (point.y - kept.y) / kept.zoom
      );
      if (near) {
        held.current = {
          id: near.id,
          x: kept.x + near.x * kept.zoom,
          y: kept.y + near.y * kept.zoom
        };
      }
    }
    return changed;
  };
  /** The zoom at which the whole map shows, up to 100%. */
  const fitZoom = (node: HTMLElement, laidOut: ILayout) =>
    clampZoom(
      Math.min(
        1,
        node.clientWidth / laidOut.width,
        node.clientHeight / laidOut.height
      )
    );
  // The layout of another level, and then of the measured cards, puts the
  // node that the zoom held back where it was.
  React.useLayoutEffect(() => {
    const view = viewport.current;
    if (refit.current && view) {
      refit.current = false;
      const zoom = fitZoom(view, layout);
      placeCamera({ x: 0, y: 0, zoom });
      model.spaceDetail.setZoom(zoom);
      return;
    }
    const hold = held.current;
    const node = hold && layout.nodes.find(item => item.id === hold.id);
    if (!hold || !node) {
      return;
    }
    const { zoom } = cameraRef.current;
    placeCamera({ zoom, x: hold.x - node.x * zoom, y: hold.y - node.y * zoom });
  }, [layout]);
  // The level that follows the zoom starts from the zoom the map opens at.
  React.useLayoutEffect(() => {
    model.spaceDetail.setZoom(cameraRef.current.zoom);
  }, [model]);
  /** Zoom by a factor around a point of the view, by default its centre. */
  const zoomBy = (factor: number, x?: number, y?: number) => {
    const node = viewport.current;
    if (!node) {
      return;
    }
    const current = cameraRef.current;
    const zoom = clampZoom(current.zoom * factor);
    const px = x ?? node.clientWidth / 2;
    const py = y ?? node.clientHeight / 2;
    const ratio = zoom / current.zoom;
    setCamera(
      {
        zoom,
        x: px - (px - current.x) * ratio,
        y: py - (py - current.y) * ratio
      },
      { x: px, y: py }
    );
  };
  const fit = () => {
    const node = viewport.current;
    if (node) {
      refit.current = setCamera({
        x: 0,
        y: 0,
        zoom: fitZoom(node, layoutRef.current)
      });
    }
  };
  // Scrolling moves the map and Ctrl+scroll (or a pinch) zooms it. React
  // listens to wheel events passively, so the page zoom cannot be stopped
  // from a React handler.
  React.useEffect(() => {
    const node = viewport.current;
    if (!node) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? node.clientHeight
            : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = node.getBoundingClientRect();
        zoomBy(
          Math.exp(-event.deltaY * unit * 0.002),
          event.clientX - rect.left,
          event.clientY - rect.top
        );
        return;
      }
      // Shift turns a vertical wheel into a horizontal move, as on a page.
      const sideways = event.shiftKey && event.deltaX === 0;
      const current = cameraRef.current;
      setCamera({
        ...current,
        x: current.x - (sideways ? event.deltaY : event.deltaX) * unit,
        y: current.y - (sideways ? 0 : event.deltaY) * unit
      });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  // A link to a cell, as in the cell details: the map centres the cell
  // at the zoom it has and flashes it.
  React.useEffect(() => {
    const show = (_: EpiModel, cellId: string) => {
      const node = viewport.current;
      const target = layoutRef.current.nodes.find(
        item => item.cell?.id === cellId
      );
      if (!node || !target) {
        return;
      }
      const { zoom } = cameraRef.current;
      setCamera({
        zoom,
        x: node.clientWidth / 2 - (target.x + target.w / 2) * zoom,
        y: node.clientHeight / 2 - (target.y + target.h / 2) * zoom
      });
      const element = cellElement(node, cellId);
      if (element) {
        flash(element);
      }
    };
    model.cellShown.connect(show);
    // A cell that the bench asked to show on the map, once the map has drawn.
    const pending = model.takePendingShow();
    if (pending) {
      requestAnimationFrame(() => model.showCell(pending));
    }
    return () => {
      model.cellShown.disconnect(show);
    };
  }, [model]);

  /** A point of the view, in the coordinates of the map's layout. */
  const local = (event: { clientX: number; clientY: number }) => {
    const rect = viewport.current!.getBoundingClientRect();
    const current = cameraRef.current;
    return {
      x: (event.clientX - rect.left - current.x) / current.zoom,
      y: (event.clientY - rect.top - current.y) / current.zoom
    };
  };

  // Space+drag or a middle-button drag moves the map, as in drawing tools;
  // a plain drag keeps drawing a selection rectangle.
  const [spaceHeld, setSpaceHeld] = React.useState(false);
  const [panning, setPanning] = React.useState(false);
  const endPan = React.useRef<(() => void) | null>(null);
  const hovered = React.useRef(false);
  React.useEffect(() => {
    const typing = (event: KeyboardEvent) =>
      (event.target as HTMLElement | null)?.closest?.(
        'input, textarea, [contenteditable="true"], .cm-editor'
      );
    const down = (event: KeyboardEvent) => {
      if (event.key === ' ' && hovered.current && !typing(event)) {
        event.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        setSpaceHeld(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      endPan.current?.();
    };
  }, []);
  // The pan follows the mouse outside the view too, until the button is up.
  const startPan = (event: React.MouseEvent) => {
    event.preventDefault();
    const start = {
      x: event.clientX,
      y: event.clientY,
      camera: cameraRef.current
    };
    const withLeft = event.button === 0;
    const move = (moved: MouseEvent) =>
      setCamera({
        ...start.camera,
        x: start.camera.x + moved.clientX - start.x,
        y: start.camera.y + moved.clientY - start.y
      });
    const end = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      endPan.current = null;
      setPanning(false);
      // The left button ends with a click, which must keep the selection.
      boxed.current = withLeft;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    endPan.current = end;
    setPanning(true);
  };

  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      startPan(event);
      return;
    }
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest('button, [role=dialog]')
    ) {
      return;
    }
    const point = local(event);
    setBox({
      x0: point.x,
      y0: point.y,
      x1: point.x,
      y1: point.y,
      add: event.shiftKey || event.ctrlKey || event.metaKey
    });
  };
  const onMouseMove = (event: React.MouseEvent) => {
    if (box) {
      const point = local(event);
      setBox({ ...box, x1: point.x, y1: point.y });
    }
  };
  const onMouseUp = (event: React.MouseEvent) => {
    if (!box) {
      return;
    }
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    setBox(null);
    if (w * camera.zoom < 4 && h * camera.zoom < 4) {
      return;
    }
    boxed.current = true;
    const hit = layout.nodes
      .filter(
        node =>
          node.kind !== 'frame' &&
          node.x < x + w &&
          node.x + node.w > x &&
          node.y < y + h &&
          node.y + node.h > y
      )
      .map(node => node.id);
    const selection = box.add
      ? [
          ...model.mapSelection,
          ...hit.filter(id => !model.mapSelection.includes(id))
        ]
      : hit;
    model.setMapSelection(selection, anchorOf(event));
  };
  const onClickEmpty = () => {
    if (boxed.current) {
      boxed.current = false;
      return;
    }
    if (model.mapSelection.length) {
      model.setMapSelection([], null);
    }
  };
  return (
    <div className="jp-Epi-map">
      <div
        className={`jp-Epi-map-viewport${fileOver ? ' jp-mod-filedrop' : ''}${spaceHeld ? ' jp-mod-pan' : ''}${panning ? ' jp-mod-panning' : ''}`}
        ref={viewport}
        style={gridStyle(camera)}
        onMouseEnter={() => {
          hovered.current = true;
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          hovered.current = false;
          setBox(null);
        }}
        onClick={onClickEmpty}
      >
        <div
          ref={canvas}
          hidden={model.isBlank()}
          className="jp-Epi-map-canvas"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`
          }}
        >
          <Layer
            model={model}
            layout={layout}
            byId={byId}
            overview={overview}
            revision={model.revision}
          />
          {box &&
            (Math.abs(box.x1 - box.x0) > 3 ||
              Math.abs(box.y1 - box.y0) > 3) && (
              <div
                className="jp-Epi-marquee"
                style={{
                  left: Math.min(box.x0, box.x1),
                  top: Math.min(box.y0, box.y1),
                  width: Math.abs(box.x1 - box.x0),
                  height: Math.abs(box.y1 - box.y0)
                }}
              />
            )}
        </div>
        {model.isLoading() && (
          <div className="jp-Epi-map-start">
            <LoadingCells />
          </div>
        )}
        {model.isBlank() && (
          <div className="jp-Epi-map-start">
            <EmptyStart model={model} />
          </div>
        )}
        <ZoomControls
          zoom={camera.zoom}
          onZoom={factor => zoomBy(factor)}
          onReset={() => setCamera({ x: 0, y: 0, zoom: 1 })}
          onFit={fit}
        />
      </div>
      <div className="jp-Epi-map-hint">
        <span className="jp-Epi-map-hint-text" title={MAP_HINT}>
          {MAP_HINT}
        </span>
        <span className="jp-Epi-map-hint-columns">
          Columns of a data node
          <Segmented
            className="jp-Epi-mapcolumns"
            label="Where the columns of a data node show"
            value={model.settings.mapColumns}
            onChange={value => model.settings.set('mapColumns', value)}
            options={[
              {
                value: 'contents',
                label: 'In Contents',
                title: 'Open the frame in Contents, beside the questions'
              },
              {
                value: 'popover',
                label: 'In the questions',
                title: 'Filter the columns in the question popover'
              }
            ]}
          />
        </span>
      </div>
    </div>
  );
}

/**
 * Select a node, or add it to the selection or take it out with Shift, Ctrl
 * or Cmd. A second click on the only node selected lets go of it.
 */
function selectNode(
  model: EpiModel,
  node: INode,
  event: React.MouseEvent | React.KeyboardEvent,
  anchor: { x: number; y: number }
): void {
  event.stopPropagation();
  const multi = event.shiftKey || event.ctrlKey || event.metaKey;
  let selection: string[];
  if (multi) {
    selection = model.mapSelection.includes(node.id)
      ? model.mapSelection.filter(id => id !== node.id)
      : [...model.mapSelection, node.id];
  } else {
    selection =
      model.mapSelection.length === 1 && model.mapSelection[0] === node.id
        ? []
        : [node.id];
  }
  model.setMapSelection(selection, anchor);
}

/**
 * The bands, the edges and the nodes of the map. They draw again when the
 * layout or the model changes, and not when the map moves or zooms, or
 * while a box is drawn over it.
 */
function MapLayer(props: {
  model: EpiModel;
  layout: ILayout;
  byId: ReadonlyMap<string, INode>;
  overview: boolean;
  /** The model's `revision`: the selection, the jobs and the answers. */
  revision: number;
}): JSX.Element {
  const { model, layout, byId, overview } = props;
  return (
    <>
      {layout.bands.map(band => (
        <div
          key={band.title}
          className="jp-Epi-map-band"
          style={{ top: band.y, height: band.h }}
        >
          <span>{band.title}</span>
        </div>
      ))}
      <svg
        className="jp-Epi-map-edges"
        width={layout.width}
        height={layout.height}
        aria-hidden="true"
      >
        {layout.edges.map(edge => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          return from && to ? (
            <path
              key={`${edge.from}-${edge.to}`}
              d={edgePath(from, to)}
              className={edge.dashed ? 'jp-mod-dashed' : ''}
            />
          ) : null;
        })}
      </svg>
      {layout.nodes.map(node => {
        if (node.kind === 'frame') {
          // Data is a question too: its own questions, and its columns.
          return (
            <button
              key={node.id}
              className={`jp-Epi-map-frame${model.selected === node.label ? ' jp-mod-selected' : ''}${node.stale ? ' jp-mod-stale' : ''}`}
              style={{ left: node.x, top: node.y, width: node.w }}
              title={
                node.stale
                  ? `${node.label}, from the last run: not in the kernel`
                  : `Ask about ${node.label}`
              }
              data-variable={node.label}
              onClick={event => {
                event.stopPropagation();
                model.askData(node.label, anchorOf(event));
              }}
            >
              {node.label}
            </button>
          );
        }
        const cell = node.cell!;
        const selected = model.mapSelection.includes(node.id);
        if (node.kind === 'note') {
          return (
            <button
              key={node.id}
              className={`jp-Epi-map-note${selected ? ' jp-mod-selected' : ''}`}
              style={{
                left: node.x,
                top: node.y,
                width: node.w,
                height: node.h
              }}
              aria-pressed={selected}
              data-cell-id={cell.id}
              title={`Ask about ${model.noteLabel(cell)}`}
              onClick={event => selectNode(model, node, event, anchorOf(event))}
            >
              <markdownIcon.react tag="span" className="jp-Epi-map-note-icon" />
              <span className="jp-Epi-map-note-text">{node.label}</span>
            </button>
          );
        }
        return (
          <MapCard
            key={node.id}
            model={model}
            node={node}
            cell={cell}
            selected={selected}
            overview={overview}
          />
        );
      })}
    </>
  );
}

const Layer = React.memo(MapLayer);

/**
 * A code cell on the map. A file from the file browser dropped on it asks
 * about the file with this cell, as on the bench.
 */
function MapCard(props: {
  model: EpiModel;
  node: INode;
  cell: IEpiCell;
  selected: boolean;
  overview: boolean;
}): JSX.Element {
  const { model, node, cell, selected, overview } = props;
  const card = React.useRef<HTMLDivElement>(null);
  const [over, setOver] = React.useState(false);
  useFileDrop(
    card,
    (paths, anchor) => model.askFileDrop(paths, { cellId: cell.id }, anchor),
    setOver
  );
  const job = model.jobs.jobFor(cell.id);
  const strip = model.strips.get(cell.id);
  // Not a <button>: at Overview it holds the bench's tiles, which are buttons.
  return (
    <div
      ref={card}
      role="button"
      tabIndex={0}
      className={`jp-Epi-map-cell${selected ? ' jp-mod-selected' : ''}${cell.branchOf ? ' jp-mod-branch' : ''}${overview ? ' jp-mod-overview' : ''}${over ? ' jp-mod-over' : ''}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.w,
        minHeight: overview ? node.min : node.h
      }}
      aria-pressed={selected}
      data-cell-id={cell.id}
      onClick={event => selectNode(model, node, event, anchorOf(event))}
      onDoubleClick={event => {
        event.stopPropagation();
        model.showIn('bench', cell.id);
      }}
      onKeyDown={event => {
        // The buttons on the card take their own keys.
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          selectNode(model, node, event, {
            x: box.left + box.width / 2,
            y: box.bottom
          });
        }
      }}
      onDragOver={event => {
        if (carriesItem(event)) {
          event.preventDefault();
        }
      }}
      onDrop={event => {
        const item = dragItem(event);
        if (item) {
          event.preventDefault();
          model.arm(null);
          void model.askDrop(
            item,
            { cellId: cell.id },
            modifiersOf(event, model),
            anchorOf(event)
          );
        }
      }}
    >
      <span className="jp-Epi-map-cell-head">
        <CellLabel cell={cell} />
        <span className="jp-Epi-map-cell-title" title={cell.title}>
          {cell.title}
        </span>
        <button
          className="jp-Epi-map-show"
          title="Show on the bench (or double-click the cell)"
          aria-label={`Show ${cell.label} on the bench`}
          onClick={event => {
            event.stopPropagation();
            model.showIn('bench', cell.id);
          }}
        >
          <launchIcon.react tag="span" />
        </button>
      </span>
      {overview ? (
        <MapOverview model={model} cell={cell} width={node.w - 22} />
      ) : (
        <MapOutputs tiles={node.tiles} />
      )}
      {cell.branchOf && (
        <>
          <ProgressBar
            value={
              job?.status === 'done' || (!job && cell.count)
                ? 1
                : (job?.progress ?? (job ? null : 0))
            }
            label={cell.title}
            wide
          />
          <span className="jp-Epi-map-cell-stage">
            <span>
              {job?.status === 'running'
                ? (job.stage ?? 'running')
                : job?.status === 'queued'
                  ? 'queued'
                  : cell.count
                    ? 'done · open result'
                    : 'not run'}
            </span>
            <span>
              {job?.progress !== null && job?.progress !== undefined
                ? `${Math.round(job.progress * 100)}%`
                : ''}
            </span>
          </span>
        </>
      )}
      {strip && <MapAnswer model={model} strip={strip} />}
    </div>
  );
}

/**
 * The answer to a question asked about a cell, under the cell on the map, as
 * the strip under its card on the bench says it: the AI writing the cell,
 * with the seconds and a bar, then what the answer did, such as "Added [16]
 * after [15]", or that it failed and why. The link shows the strip on the
 * bench, with the code change, Undo and the error in full.
 */
function MapAnswer(props: { model: EpiModel; strip: IStrip }): JSX.Element {
  const { model, strip } = props;
  const run = strip.agent ?? null;
  const busy = run
    ? run.state === 'starting' || run.state === 'working'
    : strip.status === 'writing' || strip.status === 'running';
  const seconds = useSeconds(run?.started ?? strip.started, busy);
  const failed = run ? run.state === 'failed' : strip.status === 'error';
  const error = firstLine((run ? run.error : strip.error) ?? '');
  const time = seconds !== null ? `, ${seconds} s` : '';
  const text = run
    ? failed
      ? `Agent: failed${error ? `. ${error}` : ''}`
      : `Agent: ${runStatus(run).toLowerCase()}${busy ? time : ''}`
    : strip.status === 'held'
      ? "Not started: the notebook's cost cap is reached"
      : strip.status === 'writing'
        ? `Writing the cell${time}`
        : strip.status === 'running'
          ? `Running the cell${time}`
          : failed
            ? `Failed${error ? `: ${error}` : ''}`
            : stripAction(model, strip);
  return (
    <span
      className={`jp-Epi-map-answer${failed ? ' jp-mod-error' : ''}`}
      role="status"
    >
      <span className="jp-Epi-map-answer-text" title={text}>
        {text}
      </span>
      {busy && <ProgressBar value={null} label={strip.text} wide />}
      <button
        className="jp-Epi-link jp-Epi-map-answer-link"
        onClick={event => {
          event.stopPropagation();
          model.showIn('bench', strip.cellId);
        }}
      >
        Show on the bench
      </button>
    </span>
  );
}

/**
 * A cell's outputs on the map at Minimal: one line of tiles, cut at the
 * card's edge. A plot's tile has an icon of what it draws.
 */
function MapOutputs(props: { tiles: IOutputTile[] }): JSX.Element | null {
  if (!props.tiles.length) {
    return null;
  }
  return (
    <span className="jp-Epi-map-outputs">
      {props.tiles.map((tile, index) => (
        <span
          key={index}
          className={`jp-Epi-map-output jp-mod-${tile.kind}`}
          title={tile.title}
        >
          {tile.glyph && <PlotGlyphIcon glyph={tile.glyph} />}
          <span className="jp-Epi-map-output-text">{tile.text}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * A cell's outputs on the map at Overview, as the bench shows them at its
 * Overview: a table as a tile with its description and headline, printed
 * text as a tile of lines, a plot as a thumbnail. The card takes the clicks,
 * so the tiles are inert here.
 */
function MapOverview(props: {
  model: EpiModel;
  cell: IEpiCell;
  width: number;
}): JSX.Element | null {
  const { model, cell } = props;
  if (cell.type !== 'code') {
    return null;
  }
  const outputs = outputsOf(cell.model).filter(
    output => outputKind(output) !== 'progress'
  );
  if (!outputs.length) {
    return null;
  }
  const none = () => undefined;
  return (
    <span
      className="jp-Epi-map-overview"
      ref={node => node?.setAttribute('inert', '')}
    >
      {outputs.map((output, index) => {
        const kind = outputKind(output);
        return (
          <OutputBoundary key={index} output={output}>
            {kind === 'table' ? (
              <TableOutput
                model={model}
                cellId={cell.id}
                output={output}
                available={props.width}
                active={false}
                onOpen={none}
                detail="overview"
              />
            ) : kind === 'log' || kind === 'text' ? (
              <TextOutput
                output={output}
                active={false}
                onOpen={none}
                limit={TEXT_LINES.overview}
              />
            ) : (
              <Miniature
                output={output}
                active={false}
                onClick={none}
                rendermime={model.rendermime}
              />
            )}
          </OutputBoundary>
        );
      })}
    </span>
  );
}

/** The drawing of each icon, in a box of 12 by 12. */
const GLYPHS: Record<PlotGlyph, JSX.Element> = {
  scatter: (
    <g fill="currentColor">
      <circle cx="3" cy="8.5" r="1.3" />
      <circle cx="5.5" cy="4.5" r="1.3" />
      <circle cx="8" cy="7" r="1.3" />
      <circle cx="10" cy="3" r="1.3" />
    </g>
  ),
  line: (
    <polyline
      points="1,10 4,5.5 7,7.5 11,2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  ),
  bars: (
    <g fill="currentColor">
      <rect x="1.5" y="6" width="2.5" height="5" />
      <rect x="5" y="2.5" width="2.5" height="8.5" />
      <rect x="8.5" y="7" width="2.5" height="4" />
    </g>
  ),
  hist: (
    <g fill="currentColor">
      <rect x="1" y="7" width="2.4" height="4" />
      <rect x="3.6" y="4" width="2.4" height="7" />
      <rect x="6.2" y="2" width="2.4" height="9" />
      <rect x="8.8" y="6" width="2.4" height="5" />
    </g>
  ),
  ribbon: (
    <g>
      <path
        d="M1 7.5 4 5 7 6 11 2.5V6L7 9.5 4 8.5 1 10.5Z"
        fill="currentColor"
        opacity="0.35"
      />
      <polyline
        points="1,9 4,6.8 7,7.8 11,4.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </g>
  ),
  area: <path d="M1 11V8L4 5l3 2 4-4v8Z" fill="currentColor" opacity="0.6" />,
  box: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="3" y="4" width="6" height="4.5" />
      <path d="M6 1v3M6 8.5V11M3 6.3h6" />
    </g>
  ),
  heatmap: (
    <g fill="currentColor">
      <rect x="1" y="1" width="4.6" height="4.6" opacity="0.9" />
      <rect x="6.4" y="1" width="4.6" height="4.6" opacity="0.35" />
      <rect x="1" y="6.4" width="4.6" height="4.6" opacity="0.55" />
      <rect x="6.4" y="6.4" width="4.6" height="4.6" opacity="0.8" />
    </g>
  ),
  pie: (
    <g>
      <circle
        cx="6"
        cy="6"
        r="4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M6 6V1.4A4.6 4.6 0 0 1 10.3 7.6Z" fill="currentColor" />
    </g>
  ),
  chart: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    >
      <path d="M1.5 1v9.5H11" />
      <path d="M3 8c2-5 4 1 7.5-5" />
    </g>
  )
};

/** What a plot draws, as a small icon. */
export function PlotGlyphIcon(props: { glyph: PlotGlyph }): JSX.Element {
  return (
    <svg
      className="jp-Epi-glyph"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
    >
      {GLYPHS[props.glyph]}
    </svg>
  );
}
