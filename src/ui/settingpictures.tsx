import * as React from 'react';

/*
 * The pictures of the settings whose choices JupyterLab's settings editor
 * shows as cards (./settingcards.tsx): one schematic drawing per choice,
 * 96 by 64 px. The shapes take their colours from the classes of
 * style/settingcards.css, which read JupyterLab's theme variables, so every
 * picture follows the light and the dark theme.
 */

const WIDTH = 96;
const HEIGHT = 64;

function Picture(props: { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      className="jp-Epi-pic"
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

/** The outline of a window, filled with the colour of `className`. */
function Frame(props: { className?: string }): JSX.Element {
  return (
    <rect
      className={props.className ?? 'jp-Epi-pic-ground jp-Epi-pic-edge'}
      x="0.5"
      y="0.5"
      width={WIDTH - 1}
      height={HEIGHT - 1}
      rx="4"
    />
  );
}

/** A line of text. */
function Text(props: {
  x: number;
  y: number;
  width: number;
  accent?: boolean;
}): JSX.Element {
  return (
    <rect
      className={props.accent ? 'jp-Epi-pic-accent' : 'jp-Epi-pic-ink'}
      x={props.x}
      y={props.y}
      width={props.width}
      height="2"
      rx="1"
    />
  );
}

/** A card of the bench, or a cell on the map. */
function Card(props: {
  x: number;
  y: number;
  width: number;
  height: number;
  accent?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <rect
      className={
        props.className ??
        `jp-Epi-pic-card${props.accent ? ' jp-Epi-pic-accent-edge' : ''}`
      }
      x={props.x}
      y={props.y}
      width={props.width}
      height={props.height}
      rx="2"
    />
  );
}

/** A table: a header row in the accent colour, then rows of cells. */
function Table(props: {
  x: number;
  y: number;
  columns: number;
  rows: number;
  cell: number;
  gap?: number;
}): JSX.Element {
  const gap = props.gap ?? 2;
  const shapes: JSX.Element[] = [];
  for (let row = 0; row <= props.rows; row++) {
    for (let column = 0; column < props.columns; column++) {
      shapes.push(
        <rect
          key={`${row}-${column}`}
          className={row === 0 ? 'jp-Epi-pic-accent' : 'jp-Epi-pic-ink'}
          x={props.x + column * (props.cell + gap)}
          y={props.y + row * 4}
          width={props.cell}
          height="2"
          rx="0.5"
        />
      );
    }
  }
  return <g>{shapes}</g>;
}

/** A bar chart over an axis. */
function Plot(props: {
  x: number;
  y: number;
  width: number;
  height: number;
}): JSX.Element {
  const { x, y, width, height } = props;
  const shares = [0.45, 0.8, 0.6, 0.95, 0.35];
  const step = (width - 3) / shares.length;
  return (
    <g>
      <path
        className="jp-Epi-pic-ink-line"
        d={`M${x + 0.5} ${y}V${y + height - 0.5}H${x + width}`}
      />
      {shares.map((share, index) => (
        <rect
          key={index}
          className="jp-Epi-pic-accent"
          x={x + 2.5 + index * step}
          y={y + height - 1.5 - share * (height - 3)}
          width={Math.max(step - 1.5, 1)}
          height={share * (height - 3)}
          rx="0.5"
        />
      ))}
    </g>
  );
}

/** An output shown as a tile: a small card with a glyph of its kind. */
function Tile(props: {
  x: number;
  y: number;
  kind: 'table' | 'plot' | 'text';
}): JSX.Element {
  const { x, y, kind } = props;
  return (
    <g>
      <Card x={x} y={y} width={16} height={14} className="jp-Epi-pic-tile" />
      {kind === 'table' && (
        <Table x={x + 3} y={y + 3} columns={3} rows={2} cell={2.6} gap={1} />
      )}
      {kind === 'plot' && <Plot x={x + 3} y={y + 3} width={10} height={8} />}
      {kind === 'text' && (
        <g>
          <Text x={x + 3} y={y + 3.5} width={10} />
          <Text x={x + 3} y={y + 6.5} width={8} />
          <Text x={x + 3} y={y + 9.5} width={9} />
        </g>
      )}
    </g>
  );
}

/** The mouse pointer, with its tip at x, y. */
function Pointer(props: { x: number; y: number }): JSX.Element {
  return (
    <path
      className="jp-Epi-pic-pointer"
      d={`M${props.x} ${props.y}v10.5l2.6-2.4 1.8 4.1 1.7-.8-1.8-4h3.5z`}
    />
  );
}

/** A side panel's strip of icons, at the window's edge. */
function ActivityBar(props: { x: number; active: boolean }): JSX.Element {
  return (
    <g>
      <rect
        className="jp-Epi-pic-ground"
        x={props.x}
        y="1"
        width="6"
        height={HEIGHT - 2}
      />
      {[6, 13, 20].map((y, index) => (
        <rect
          key={y}
          className={
            props.active && index === 0 ? 'jp-Epi-pic-accent' : 'jp-Epi-pic-ink'
          }
          x={props.x + 1.5}
          y={y}
          width="3"
          height="3"
          rx="0.6"
        />
      ))}
    </g>
  );
}

/** Rows of a panel: a section title in the accent colour, then lines. */
function PanelRows(props: { x: number; y: number; width: number }) {
  const { x, y, width } = props;
  return (
    <g>
      <Text x={x} y={y} width={width * 0.55} accent />
      <Text x={x} y={y + 6} width={width * 0.8} />
      <Text x={x} y={y + 11} width={width * 0.65} />
      <Text x={x} y={y + 16} width={width * 0.75} />
      <Text x={x} y={y + 25} width={width * 0.5} accent />
      <Text x={x} y={y + 31} width={width * 0.7} />
      <Text x={x} y={y + 36} width={width * 0.6} />
    </g>
  );
}

/**
 * Where a group of panels goes: JupyterLab's side panel at the window's
 * edge, or a column inside the Whybook view, below the view's tab.
 */
function Placement(props: {
  side: 'left' | 'right';
  inView: boolean;
}): JSX.Element {
  const left = props.side === 'left';
  const bar = left ? 1 : WIDTH - 7;
  // The main area, with the view's tab, beside the side panel or with the
  // panel's column inside it.
  const viewStart = left ? (props.inView ? 7 : 31) : 1;
  const viewEnd = left ? WIDTH - 1 : props.inView ? WIDTH - 7 : WIDTH - 31;
  const column = props.inView
    ? {
        x: left ? viewStart + 3 : viewEnd - 25,
        y: 13,
        width: 22,
        height: 47
      }
    : { x: left ? 7 : WIDTH - 31, y: 1, width: 24, height: HEIGHT - 2 };
  const cardsStart =
    left && props.inView ? column.x + column.width + 4 : viewStart + 4;
  const cardsEnd = !left && props.inView ? column.x - 4 : viewEnd - 4;
  const cardsWidth = cardsEnd - cardsStart;
  return (
    <Picture>
      <Frame className="jp-Epi-pic-window" />
      <ActivityBar x={bar} active={!props.inView} />
      <rect
        className="jp-Epi-pic-ground"
        x={viewStart}
        y="1"
        width={viewEnd - viewStart}
        height="9"
      />
      <rect
        className="jp-Epi-pic-window"
        x={viewStart + 3}
        y="3"
        width="24"
        height="7"
        rx="1"
      />
      <Text x={viewStart + 6} y={5.5} width={14} />
      <Card x={cardsStart} y={15} width={cardsWidth} height={18} />
      <Text x={cardsStart + 3} y={19} width={cardsWidth * 0.5} />
      <Text x={cardsStart + 3} y={24} width={cardsWidth * 0.7} />
      <Card x={cardsStart} y={37} width={cardsWidth} height={21} />
      <Text x={cardsStart + 3} y={41} width={cardsWidth * 0.4} />
      <Text x={cardsStart + 3} y={46} width={cardsWidth * 0.6} />
      <rect
        className="jp-Epi-pic-tint jp-Epi-pic-accent-edge"
        x={column.x}
        y={column.y}
        width={column.width}
        height={column.height}
        rx={props.inView ? 2 : 0}
      />
      <PanelRows x={column.x + 3} y={column.y + 5} width={column.width - 6} />
      <Frame className="jp-Epi-pic-edge jp-Epi-pic-edge-only" />
    </Picture>
  );
}

/** One cell of the bench with its code, and room for its outputs. */
function BenchCell(props: { children: React.ReactNode }): JSX.Element {
  return (
    <Picture>
      <Frame />
      <Card x={7} y={5} width={82} height={54} />
      <Text x={12} y={9} width={24} accent />
      <Text x={39} y={9} width={16} />
      {props.children}
    </Picture>
  );
}

/** Three cells on the map, joined by the data that flows between them. */
function MapNodes(props: { level: 'none' | 'minimal' | 'overview' }) {
  const { level } = props;
  const size =
    level === 'overview'
      ? { width: 30, height: 21 }
      : level === 'minimal'
        ? { width: 26, height: 13 }
        : { width: 26, height: 8 };
  const places =
    level === 'overview'
      ? [
          [5, 4],
          [33, 21],
          [61, 38]
        ]
      : [
          [8, 8],
          [35, 26],
          [62, 44]
        ];
  return (
    <Picture>
      <Frame />
      {places.slice(1).map(([x, y], index) => {
        const [fromX, fromY] = places[index];
        const startX = fromX + size.width / 2;
        const startY = fromY + size.height;
        const endY = y + size.height / 2;
        return (
          <path
            key={x}
            className="jp-Epi-pic-ink-line"
            d={`M${startX} ${startY}C${startX} ${endY} ${startX} ${endY} ${x} ${endY}`}
          />
        );
      })}
      {places.map(([x, y]) => (
        <g key={x}>
          <Card x={x} y={y} width={size.width} height={size.height} />
          <Text x={x + 3} y={y + 3} width={size.width * 0.55} />
          {level === 'minimal' && (
            <g>
              <rect
                className="jp-Epi-pic-accent"
                x={x + 3}
                y={y + 7.5}
                width="7"
                height="3"
                rx="1"
              />
              <rect
                className="jp-Epi-pic-accent"
                x={x + 11.5}
                y={y + 7.5}
                width="5"
                height="3"
                rx="1"
              />
              <rect
                className="jp-Epi-pic-ink"
                x={x + 18}
                y={y + 7.5}
                width="5"
                height="3"
                rx="1"
              />
            </g>
          )}
          {level === 'overview' && (
            <g>
              <Table
                x={x + 3}
                y={y + 8}
                columns={3}
                rows={2}
                cell={3}
                gap={1}
              />
              <Plot x={x + 18} y={y + 7.5} width={9} height={10} />
            </g>
          )}
        </g>
      ))}
    </Picture>
  );
}

/** The Detail slider of the view's toolbar, with its knob at `at`. */
function Slider(props: { x: number; y: number; at: number }) {
  const { x, y, at } = props;
  return (
    <g>
      <path
        className="jp-Epi-pic-ink-line"
        d={`M${x} ${y}h28M${x + 0.5} ${y - 2}v4M${x + 14} ${y - 2}v4M${x + 27.5} ${y - 2}v4`}
      />
      <circle className="jp-Epi-pic-accent" cx={x + at * 28} cy={y} r="3" />
    </g>
  );
}

/** A width, as a line with an arrow at each end. */
function Span(props: { x: number; y: number; width: number }) {
  const { x, y, width } = props;
  return (
    <path
      className="jp-Epi-pic-ink-line"
      d={`M${x} ${y}h${width}M${x + 2.5} ${y - 2}l-2.5 2 2.5 2M${x + width - 2.5} ${y - 2}l2.5 2-2.5 2`}
    />
  );
}

/** A variable picked in the Variables panel, at the window's left. */
function VariablesPanel(): JSX.Element {
  return (
    <g>
      <rect
        className="jp-Epi-pic-window"
        x="1"
        y="1"
        width="27"
        height={HEIGHT - 2}
        rx="3"
      />
      <Text x={5} y={6} width={13} accent />
      <Text x={5} y={22} width={15} />
      <Text x={5} y={28} width={12} />
      <Text x={5} y={34} width={16} />
      <Text x={5} y={40} width={11} />
    </g>
  );
}

/** A variable, as the panel draws it: a pill. */
function Pill(props: { x: number; y: number; ghost?: boolean }) {
  return (
    <rect
      className={props.ghost ? 'jp-Epi-pic-ghost' : 'jp-Epi-pic-accent'}
      x={props.x}
      y={props.y}
      width="18"
      height="6"
      rx="3"
    />
  );
}

/** A numbered step of a click. */
function Step(props: { x: number; y: number; n: number }) {
  return (
    <g>
      <circle className="jp-Epi-pic-accent" cx={props.x} cy={props.y} r="4" />
      <text
        className="jp-Epi-pic-number"
        x={props.x}
        y={props.y}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {props.n}
      </text>
    </g>
  );
}

/** A click: three short strokes around the pointer's tip. */
function Click(props: { x: number; y: number }) {
  const { x, y } = props;
  return (
    <path
      className="jp-Epi-pic-accent-line"
      d={`M${x - 3} ${y - 3}l-2-2M${x} ${y - 4}v-2.5M${x - 4} ${y}h-2.5`}
    />
  );
}

/** A data node on the map: a frame drawn as a small table in a card. */
function DataNode(props: { x: number; y: number }) {
  const { x, y } = props;
  return (
    <g>
      <Card x={x} y={y} width={22} height={14} accent />
      <Table x={x + 3} y={y + 3.5} columns={3} rows={1} cell={4} gap={1.5} />
      <Text x={x + 3} y={y + 9.5} width={10} />
    </g>
  );
}

/** Columns of a frame, as Contents and the question popover list them. */
function ColumnRows(props: { x: number; y: number; width: number }) {
  const { x, y, width } = props;
  return (
    <g>
      {[0, 1, 2, 3].map(index => (
        <g key={index}>
          <rect
            className="jp-Epi-pic-ink"
            x={x}
            y={y + index * 5}
            width="2"
            height="2"
            rx="0.5"
          />
          <Text
            x={x + 4}
            y={y + index * 5}
            width={(width - 4) * [0.7, 0.5, 0.85, 0.6][index]}
          />
        </g>
      ))}
    </g>
  );
}

/** A running cell: its code, and the bar of its run, half done. */
function RunningCell(props: { y: number }) {
  const { y } = props;
  return (
    <g>
      <Card x={7} y={y} width={82} height={20} />
      <Text x={12} y={y + 4} width={30} accent />
      <Text x={45} y={y + 4} width={18} />
      <rect
        className="jp-Epi-pic-ground"
        x="12"
        y={y + 12}
        width="72"
        height="3"
        rx="1.5"
      />
      <rect
        className="jp-Epi-pic-accent"
        x="12"
        y={y + 12}
        width="34"
        height="3"
        rx="1.5"
      />
    </g>
  );
}

/** The four guesses under a running cell: higher, lower, the same, not sure. */
function Guesses(props: { y: number }) {
  const { y } = props;
  const glyphs = [
    `M19.5 ${y + 8}v-5M17.3 ${y + 5}l2.2-2.2 2.2 2.2`,
    `M39.5 ${y + 3}v5M37.3 ${y + 6}l2.2 2.2 2.2-2.2`,
    `M57 ${y + 4.5}h5M57 ${y + 6.5}h5`
  ];
  return (
    <g>
      {[11, 31, 51, 71].map(x => (
        <rect
          key={x}
          className="jp-Epi-pic-window jp-Epi-pic-accent-edge"
          x={x}
          y={y}
          width="17"
          height="11"
          rx="5.5"
        />
      ))}
      {glyphs.map(d => (
        <path key={d} className="jp-Epi-pic-accent-line" d={d} />
      ))}
      <text
        className="jp-Epi-pic-glyph"
        x="79.5"
        y={y + 5.7}
        textAnchor="middle"
        dominantBaseline="central"
      >
        ?
      </text>
    </g>
  );
}

/** A notebook's toolbar, with the kernel's name at its right. */
function KernelToolbar(): JSX.Element {
  return (
    <g>
      <rect
        className="jp-Epi-pic-ground"
        x="1"
        y="1"
        width={WIDTH - 2}
        height="11"
      />
      {[6, 13, 20].map(x => (
        <rect
          key={x}
          className="jp-Epi-pic-ink"
          x={x}
          y="5"
          width="4"
          height="3"
          rx="0.6"
        />
      ))}
      <rect
        className="jp-Epi-pic-window jp-Epi-pic-edge"
        x="56"
        y="3"
        width="28"
        height="7"
        rx="2"
      />
      <Text x={59} y={5.5} width={18} />
      <circle className="jp-Epi-pic-ink" cx="89" cy="6.5" r="2.5" />
    </g>
  );
}

/** The steps of an agent's run: a dot and a line for each. */
function RunSteps(props: { x: number; y: number; width: number }) {
  const { x, y, width } = props;
  return (
    <g>
      {[0, 1, 2].map(index => (
        <g key={index}>
          <circle
            className="jp-Epi-pic-accent"
            cx={x + 1.5}
            cy={y + 1 + index * 5}
            r="1.5"
          />
          <Text
            x={x + 5}
            y={y + index * 5}
            width={(width - 5) * [0.8, 0.6, 0.7][index]}
          />
        </g>
      ))}
    </g>
  );
}

/** A tab of the main area, with an icon and its label. */
function Tab(props: {
  x: number;
  icon: 'whybook' | 'notebook' | 'checkup';
  active: boolean;
}) {
  const { x, icon, active } = props;
  return (
    <g>
      <rect
        className={active ? 'jp-Epi-pic-window' : 'jp-Epi-pic-tab'}
        x={x}
        y="5"
        width="42"
        height="16"
        rx="2"
      />
      {icon === 'checkup' ? (
        <svg x={x + 4} y="8" width="10" height="10" viewBox="0 0 24 24">
          {/* checkupIcon of src/icons.ts */}
          <g className="jp-Epi-pic-checkup">
            <path d="M5.5 2.5h-1a2 2 0 0 0-2 2V8a5 5 0 0 0 10 0V4.5a2 2 0 0 0-2-2h-1M7.5 13v2a5.75 5.75 0 0 0 11.5 0v-1.8" />
            <circle cx="19" cy="10.2" r="3" />
          </g>
        </svg>
      ) : (
        <rect
          className="jp-Epi-pic-notebook"
          x={x + 4}
          y="8"
          width="10"
          height="10"
          rx={icon === 'whybook' ? 2.5 : 1}
        />
      )}
      {icon === 'whybook' && (
        // The view's [?], in short.
        <path
          className="jp-Epi-pic-notebook-mark"
          d={`M${x + 7} 10.5h-.8v5h.8M${x + 11} 10.5h.8v5h-.8`}
        />
      )}
      {icon === 'notebook' && (
        <path
          className="jp-Epi-pic-notebook-mark"
          d={`M${x + 6.5} 11h5M${x + 6.5} 13h5M${x + 6.5} 15h3`}
        />
      )}
      <Text x={x + 18} y={12} width={19} />
    </g>
  );
}

/**
 * Two tabs, a Whybook view's and a notebook's, with the pointer on the
 * first, and the Check-up's icon on the tabs that get it.
 */
function Tabs(props: { whybook: boolean; notebooks: boolean }) {
  return (
    <Picture>
      <Frame className="jp-Epi-pic-window" />
      <rect
        className="jp-Epi-pic-ground"
        x="1"
        y="1"
        width={WIDTH - 2}
        height="20"
      />
      <Tab x={4} icon={props.whybook ? 'checkup' : 'whybook'} active={true} />
      <Tab
        x={49}
        icon={props.notebooks ? 'checkup' : 'notebook'}
        active={false}
      />
      <Text x={8} y={29} width={44} />
      <Text x={8} y={35} width={60} />
      <Text x={8} y={41} width={34} />
      <Text x={8} y={50} width={52} />
      <Pointer x={16} y={17} />
      <Frame className="jp-Epi-pic-edge jp-Epi-pic-edge-only" />
    </Picture>
  );
}

/** A row of Variables explored, and what an order compares in it. */
interface IExploredRow {
  /** The width of the frame's name. */
  name: number;
  /** Its squares, and how many of them are used. */
  squares: number;
  used: number;
  /** How many cells use it, as dots. */
  uses?: number;
  /** Its size, as the length of a bar. */
  size?: number;
  /** The first letter of its name. */
  letter?: string;
}

/**
 * The block Variables explored: its head with the count, and four rows,
 * each with its name, its squares, and the marks of what the order compares.
 */
function ExploredRows(props: { rows: IExploredRow[] }): JSX.Element {
  return (
    <Picture>
      <Frame className="jp-Epi-pic-window jp-Epi-pic-edge" />
      <Text x={7} y={6} width={36} />
      <Text x={83} y={6} width={6} />
      {props.rows.map((row, index) => {
        const y = 14 + index * 12;
        const left = row.letter ? 15 : 7;
        return (
          <g key={index}>
            {row.letter && (
              <text
                className="jp-Epi-pic-glyph"
                x="7"
                y={y + 1}
                dominantBaseline="central"
              >
                {row.letter}
              </text>
            )}
            <Text x={left} y={y} width={row.name} />
            {Array.from({ length: row.squares }, (_, square) => (
              <rect
                key={square}
                className={
                  square < row.used ? 'jp-Epi-pic-accent' : 'jp-Epi-pic-ground'
                }
                x={left + square * 5.5}
                y={y + 4}
                width="4"
                height="3"
                rx="0.5"
              />
            ))}
            {Array.from({ length: row.uses ?? 0 }, (_, dot) => (
              <circle
                key={`use-${dot}`}
                className="jp-Epi-pic-accent"
                cx={88 - dot * 5}
                cy={y + 1}
                r="1.6"
              />
            ))}
            {row.size !== undefined && (
              <rect
                className="jp-Epi-pic-ink"
                x={89.6 - row.size}
                y={y + 4.5}
                width={row.size}
                height="2.5"
                rx="1"
              />
            )}
          </g>
        );
      })}
    </Picture>
  );
}

/**
 * The picture of each choice, by the setting's id in the settings registry,
 * `<plugin>.<key>`, and by the choice's value as text.
 */
export const SETTING_PICTURES: Record<string, Record<string, JSX.Element>> = {
  'whybook:plugin.interaction': {
    drag: (
      <Picture>
        <Frame />
        <VariablesPanel />
        <Card x={42} y={26} width={48} height={30} />
        <Text x={46} y={30} width={22} accent />
        <Text x={46} y={35} width={34} />
        <Pill x={5} y={13} />
        <path
          className="jp-Epi-pic-accent-line jp-mod-dashed"
          d="M23 16C38 16 46 19 50 27"
        />
        <path className="jp-Epi-pic-accent-line" d="M47.4 25.6l2.8 1.9.6-3.3" />
        <Pill x={48} y={40} ghost />
        <Pointer x={58} y={43} />
      </Picture>
    ),
    click: (
      <Picture>
        <Frame />
        <VariablesPanel />
        <Card x={42} y={26} width={48} height={30} />
        <Text x={46} y={30} width={22} accent />
        <Text x={46} y={35} width={34} />
        <Pill x={5} y={13} />
        <Click x={16} y={17} />
        <Pointer x={16} y={17} />
        <Step x={32} y={9} n={1} />
        <Click x={66} y={45} />
        <Pointer x={66} y={45} />
        <Step x={82} y={37} n={2} />
      </Picture>
    )
  },
  'whybook:plugin.variablesPlacement': {
    sidebar: <Placement side="left" inView={false} />,
    document: <Placement side="left" inView={true} />
  },
  'whybook:plugin.explorationPlacement': {
    sidebar: <Placement side="right" inView={false} />,
    document: <Placement side="right" inView={true} />
  },
  // Dots for the cells that use a frame, a bar for its size.
  'whybook:plugin.exploredOrder': {
    auto: (
      <ExploredRows
        rows={[
          { name: 30, squares: 6, used: 5, uses: 3, size: 8 },
          { name: 22, squares: 9, used: 3, uses: 2, size: 26 },
          { name: 26, squares: 6, used: 2, uses: 2, size: 12 },
          { name: 18, squares: 4, used: 1, uses: 1, size: 20 }
        ]}
      />
    ),
    used: (
      <ExploredRows
        rows={[
          { name: 30, squares: 6, used: 5, uses: 3 },
          { name: 22, squares: 9, used: 3, uses: 2 },
          { name: 26, squares: 6, used: 2, uses: 2 },
          { name: 18, squares: 4, used: 1, uses: 1 }
        ]}
      />
    ),
    size: (
      <ExploredRows
        rows={[
          { name: 22, squares: 9, used: 3, size: 26 },
          { name: 18, squares: 4, used: 1, size: 20 },
          { name: 26, squares: 6, used: 2, size: 12 },
          { name: 30, squares: 6, used: 5, size: 8 }
        ]}
      />
    ),
    name: (
      <ExploredRows
        rows={[
          { name: 26, squares: 6, used: 2, letter: 'a' },
          { name: 18, squares: 4, used: 1, letter: 'b' },
          { name: 30, squares: 6, used: 5, letter: 'c' },
          { name: 22, squares: 9, used: 3, letter: 'd' }
        ]}
      />
    )
  },
  'whybook:plugin.mapColumns': {
    contents: (
      <Picture>
        <Frame className="jp-Epi-pic-window jp-Epi-pic-edge" />
        <rect
          className="jp-Epi-pic-ground"
          x="31"
          y="1"
          width={WIDTH - 32}
          height={HEIGHT - 2}
        />
        <rect
          className="jp-Epi-pic-tint jp-Epi-pic-accent-edge"
          x="1"
          y="1"
          width="30"
          height={HEIGHT - 2}
        />
        <Text x={5} y={6} width={15} accent />
        <ColumnRows x={5} y={13} width={22} />
        <path className="jp-Epi-pic-ink-line" d="M57 30C57 44 63 46 66 46" />
        <DataNode x={46} y={16} />
        <Card x={66} y={41} width={24} height={10} />
        <Text x={69} y={45} width={14} />
        <Pointer x={60} y={22} />
      </Picture>
    ),
    popover: (
      <Picture>
        <Frame />
        <path className="jp-Epi-pic-ink-line" d="M17 22C17 40 20 48 24 48" />
        <Card x={24} y={43} width={10} height={10} />
        <DataNode x={6} y={8} />
        <rect
          className="jp-Epi-pic-window jp-Epi-pic-accent-edge"
          x="36"
          y="5"
          width="54"
          height="54"
          rx="3"
        />
        <Text x={41} y={10} width={34} />
        <Text x={41} y={15} width={26} />
        <rect
          className="jp-Epi-pic-field"
          x="41"
          y="22"
          width="44"
          height="7"
          rx="1.5"
        />
        <Text x={44} y={24.5} width={12} />
        <ColumnRows x={41} y={34} width={42} />
        <Pointer x={14} y={14} />
      </Picture>
    )
  },
  'whybook:plugin.outputDetail': {
    overview: (
      <BenchCell>
        <Tile x={12} y={17} kind="table" />
        <Text x={13} y={34} width={14} />
        <Tile x={34} y={17} kind="plot" />
        <Text x={35} y={34} width={12} />
        <Tile x={56} y={17} kind="text" />
        <Text x={57} y={34} width={10} />
      </BenchCell>
    ),
    compact: (
      <BenchCell>
        <Table x={12} y={17} columns={4} rows={3} cell={6} />
        <Plot x={48} y={16} width={22} height={17} />
        <Text x={12} y={40} width={44} />
        <Text x={12} y={45} width={30} />
      </BenchCell>
    ),
    full: (
      <BenchCell>
        <Table x={12} y={16} columns={4} rows={8} cell={8} gap={2} />
        <Plot x={54} y={15} width={30} height={38} />
      </BenchCell>
    )
  },
  'whybook:plugin.mapDetail': {
    none: <MapNodes level="none" />,
    minimal: <MapNodes level="minimal" />,
    overview: <MapNodes level="overview" />
  },
  'whybook:plugin.minimap': {
    false: (
      <Picture>
        <Frame />
        <Card x={7} y={6} width={82} height={24} />
        <Text x={12} y={10} width={24} accent />
        <Card x={7} y={34} width={82} height={24} />
        <Text x={12} y={38} width={20} accent />
      </Picture>
    ),
    true: (
      <Picture>
        <Frame />
        <Card x={7} y={6} width={66} height={24} />
        <Text x={12} y={10} width={24} accent />
        <Card x={7} y={34} width={66} height={24} />
        <Text x={12} y={38} width={20} accent />
        <Card x={77} y={38} width={12} height={20} />
        <Text x={79} y={41} width={8} accent />
        <Text x={79} y={45} width={8} />
        <Text x={79} y={50} width={8} accent />
        <Text x={79} y={54} width={8} />
      </Picture>
    )
  },
  'whybook:plugin.detailFollowsSpace': {
    false: (
      <Picture>
        <Frame />
        <rect
          className="jp-Epi-pic-window"
          x="1"
          y="1"
          width={WIDTH - 2}
          height="13"
          rx="3"
        />
        <Text x={36} y={6.5} width={14} />
        <Slider x={56} y={7.5} at={0.5} />
        <Pointer x={70} y={8} />
        <Card x={7} y={19} width={82} height={40} />
        <Text x={12} y={23} width={24} accent />
        <Table x={12} y={30} columns={4} rows={3} cell={6} />
        <Plot x={48} y={29} width={22} height={17} />
      </Picture>
    ),
    true: (
      <Picture>
        <Frame className="jp-Epi-pic-edge-only" />
        <rect
          className="jp-Epi-pic-ground jp-Epi-pic-edge"
          x="4"
          y="5"
          width="26"
          height="46"
          rx="2"
        />
        <Tile x={9} y={10} kind="table" />
        <Tile x={9} y={28} kind="plot" />
        <rect
          className="jp-Epi-pic-ground jp-Epi-pic-edge"
          x="35"
          y="5"
          width="57"
          height="46"
          rx="2"
        />
        <Card x={39} y={9} width={49} height={38} />
        <Table x={43} y={14} columns={4} rows={6} cell={7} gap={2} />
        <Span x={4} y={57} width={26} />
        <Span x={35} y={57} width={57} />
      </Picture>
    )
  },
  'whybook:plugin.agentView': {
    strip: (
      <Picture>
        <Frame />
        <Card x={7} y={5} width={82} height={14} />
        <Text x={12} y={9} width={30} accent />
        <rect
          className="jp-Epi-pic-tint jp-Epi-pic-accent-edge"
          x="7"
          y="19"
          width="82"
          height="18"
          rx="2"
        />
        <RunSteps x={12} y={22} width={60} />
        <Card x={7} y={42} width={82} height={16} />
        <Text x={12} y={46} width={22} />
        <Text x={12} y={51} width={36} />
      </Picture>
    ),
    card: (
      <Picture>
        <Frame />
        <Card x={7} y={4} width={82} height={12} />
        <Text x={12} y={8} width={30} />
        <rect
          className="jp-Epi-pic-tint jp-Epi-pic-accent-edge"
          x="7"
          y="20"
          width="82"
          height="40"
          rx="2"
        />
        <Text x={12} y={24} width={36} accent />
        <Card x={12} y={30} width={72} height={11} />
        <Text x={16} y={34.5} width={30} />
        <Card x={12} y={44} width={72} height={11} />
        <Text x={16} y={48.5} width={40} />
      </Picture>
    ),
    sidebar: (
      <Picture>
        <Frame className="jp-Epi-pic-window jp-Epi-pic-edge" />
        <rect
          className="jp-Epi-pic-ground"
          x="1"
          y="1"
          width="61"
          height={HEIGHT - 2}
        />
        <Card x={5} y={6} width={53} height={14} />
        <Text x={9} y={10} width={26} accent />
        <Card x={5} y={24} width={53} height={14} />
        <Text x={9} y={28} width={20} />
        <Card x={5} y={42} width={53} height={14} />
        <Text x={9} y={46} width={30} />
        <rect
          className="jp-Epi-pic-tint jp-Epi-pic-accent-edge"
          x="62"
          y="1"
          width="27"
          height={HEIGHT - 2}
        />
        <RunSteps x={65} y={8} width={21} />
        <ActivityBar x={WIDTH - 7} active={true} />
      </Picture>
    )
  },
  'whybook:checkup.tabQuestion': {
    off: <Tabs whybook={false} notebooks={false} />,
    whybook: <Tabs whybook={true} notebooks={false} />,
    notebooks: <Tabs whybook={true} notebooks={true} />
  },
  'whybook:plugin.answers': {
    agent: (
      <Picture>
        <Frame />
        <Text x={7} y={5} width={46} accent />
        <RunSteps x={9} y={10} width={44} />
        <Card x={7} y={26} width={39} height={12} />
        <Text x={10} y={30} width={22} />
        <Card x={50} y={26} width={39} height={12} />
        <Text x={53} y={30} width={18} />
        <Card x={7} y={41} width={82} height={10} />
        <Text x={10} y={45} width={30} />
        <Text x={7} y={55} width={70} accent />
      </Picture>
    ),
    cell: (
      <Picture>
        <Frame />
        <Text x={7} y={5} width={46} accent />
        <Card x={7} y={12} width={82} height={22} />
        <Text x={12} y={16} width={34} />
        <Text x={12} y={21} width={52} />
        <Text x={12} y={26} width={26} />
      </Picture>
    )
  },
  'whybook:plugin.guessFirst': {
    false: (
      <Picture>
        <Frame />
        <RunningCell y={8} />
      </Picture>
    ),
    true: (
      <Picture>
        <Frame />
        <RunningCell y={8} />
        <Guesses y={36} />
      </Picture>
    )
  },
  'whybook:reproduce.kernelMenu': {
    false: (
      <Picture>
        <Frame className="jp-Epi-pic-window" />
        <KernelToolbar />
        <rect
          className="jp-Epi-pic-shade"
          x="1"
          y="12"
          width={WIDTH - 2}
          height={HEIGHT - 13}
        />
        <rect
          className="jp-Epi-pic-window jp-Epi-pic-edge"
          x="20"
          y="17"
          width="56"
          height="40"
          rx="2.5"
        />
        <Text x={25} y={22} width={30} accent />
        <rect
          className="jp-Epi-pic-field"
          x="25"
          y="28"
          width="46"
          height="8"
          rx="1.5"
        />
        <Text x={28} y={31} width={20} />
        <rect
          className="jp-Epi-pic-ground"
          x="41"
          y="46"
          width="14"
          height="6"
          rx="1.5"
        />
        <rect
          className="jp-Epi-pic-accent"
          x="58"
          y="46"
          width="14"
          height="6"
          rx="1.5"
        />
        <Pointer x={70} y={7} />
        <Frame className="jp-Epi-pic-edge jp-Epi-pic-edge-only" />
      </Picture>
    ),
    true: (
      <Picture>
        <Frame className="jp-Epi-pic-window" />
        <KernelToolbar />
        <Text x={8} y={20} width={40} />
        <Text x={8} y={26} width={30} />
        <rect
          className="jp-Epi-pic-window jp-Epi-pic-edge"
          x="48"
          y="12"
          width="44"
          height="44"
          rx="2"
        />
        <Text x={52} y={17} width={26} />
        <Text x={52} y={24} width={30} />
        <Text x={52} y={31} width={22} />
        <path className="jp-Epi-pic-ink-line" d="M50 37.5h40" />
        <rect className="jp-Epi-pic-tint" x="49" y="41" width="42" height="9" />
        <Text x={52} y={44.5} width={34} accent />
        <Pointer x={70} y={7} />
        <Frame className="jp-Epi-pic-edge jp-Epi-pic-edge-only" />
      </Picture>
    )
  }
};
