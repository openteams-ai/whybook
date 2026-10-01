import * as React from 'react';

import type { EpiModel } from '../model/epimodel';

/** The sizes of the minimap's parts at full size, in pixels. */
const BAR = 6;
const GAP = 2;
const BAND_PADDING = 2;
/** The gap between two bands: 1 px that does not scale, and 3 px that do. */
const BAND_GAP = 3;
/** The padding and the border of the minimap, which do not scale. */
const FRAME = 12;
/** The title and the gap under it, shown while the minimap is pointed at. */
const TITLE = 18;
/**
 * Below this scale the bars of a section touch, as one block as tall as its
 * cells, so that the sections stay apart: 3 px between two blocks, and 1 px
 * of padding around each.
 */
const DENSE = 0.5;
const DENSE_BAND_GAP = 3;
const DENSE_PADDING = 1;

/** At rest the minimap is at most 120 px tall, and at most a fifth of the view. */
const REST_HEIGHT = 120;
const REST_SHARE = 0.2;
/** Pointed at, it is at most 60% of the view. */
const OPEN_SHARE = 0.6;

/** The sizes of the parts of the minimap, in pixels. */
export interface IMinimapSizes {
  /** The height of the bar of a cell. */
  bar: number;
  /** The gap between two bars of a section. */
  gap: number;
  /** The padding of the band of a section. */
  padding: number;
  /** The gap between two bands. */
  bandGap: number;
}

/**
 * The sizes that fit the minimap's bands, one per section with its number
 * of code cells, in `limit` pixels: the full sizes when they fit, or else
 * every part scaled down by the same factor, or, below half size, blocks
 * of touching bars with a gap of 3 px between the sections, less when the
 * gaps of many sections would take more than half of the room.
 */
export function minimapSizes(
  bands: number[],
  limit: number,
  title = 0
): IMinimapSizes {
  const gaps = Math.max(0, bands.length - 1);
  const cells = bands.reduce((total, count) => total + count, 0);
  const scaled =
    cells * BAR +
    bands.reduce(
      (total, count) => total + Math.max(0, count - 1) * GAP + 2 * BAND_PADDING,
      0
    ) +
    gaps * BAND_GAP;
  const scale =
    scaled > 0
      ? Math.max(0, Math.min(1, (limit - FRAME - gaps - title) / scaled))
      : 1;
  if (scale >= DENSE || cells === 0) {
    return {
      bar: BAR * scale,
      gap: GAP * scale,
      padding: BAND_PADDING * scale,
      bandGap: 1 + BAND_GAP * scale
    };
  }
  // With many sections, the padding and the gaps between the blocks would
  // take the whole room and more: 40 sections took 209 px of a 120 px limit
  // and left the bars 0 px. They get at most half of the room, and the bars
  // the rest.
  const room = Math.max(0, limit - FRAME - title);
  const spacing = bands.length * 2 * DENSE_PADDING + gaps * DENSE_BAND_GAP;
  const shrink = spacing > room / 2 ? room / 2 / spacing : 1;
  const padding = DENSE_PADDING * shrink;
  const bandGap = DENSE_BAND_GAP * shrink;
  return {
    bar: Math.max(0, (room - spacing * shrink) / cells),
    gap: 0,
    padding,
    bandGap
  };
}

/** The sizes as the custom properties of one state of the minimap in base.css. */
function sizesStyle(state: 'rest' | 'open', sizes: IMinimapSizes) {
  return {
    [`--epi-minimap-${state}-bar`]: `${sizes.bar}px`,
    [`--epi-minimap-${state}-gap`]: `${sizes.gap}px`,
    [`--epi-minimap-${state}-padding`]: `${sizes.padding}px`,
    [`--epi-minimap-${state}-band-gap`]: `${sizes.bandGap}px`
  };
}

/** The height of the view that scrolls the element, as it changes. */
function useViewHeight(ref: React.RefObject<HTMLElement>): number {
  const [height, setHeight] = React.useState(0);
  React.useEffect(() => {
    const view = ref.current?.closest('.jp-Epi-main');
    if (!view || typeof ResizeObserver === 'undefined') {
      return;
    }
    const read = () => setHeight(view.clientHeight);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(view);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

/**
 * The sections of the notebook and their code cells, over the bench's
 * bottom right corner, when the setting "Minimap" is on; a click opens the
 * map view. Each bar has the colour
 * of the type of the question its cell answers, muted until the minimap is
 * pointed at, and a branch is a shorter bar under its cell. At rest it is at most
 * 120 px tall, and pointed at, or focused, at most 60% of the view:
 * minimapSizes shrinks the bars and the gaps until the notebook fits.
 */
export function Minimap(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  const { sections } = model.sections();
  const ref = React.useRef<HTMLButtonElement>(null);
  const view = useViewHeight(ref);
  const bands = sections.map(section => ({
    id: section.id,
    cells: section.cells.filter(cell => cell.type === 'code')
  }));
  const counts = bands.map(band => band.cells.length);
  const rest = minimapSizes(
    counts,
    view ? Math.min(REST_HEIGHT, view * REST_SHARE) : REST_HEIGHT
  );
  const open = minimapSizes(
    counts,
    Math.max(REST_HEIGHT, view * OPEN_SHARE),
    TITLE
  );
  // The dock has no height: the minimap rises from it over the last cards,
  // and the bench ends where its last card ends.
  return (
    <div className="jp-Epi-minimap-dock">
      <button
        ref={ref}
        className="jp-Epi-minimap"
        style={
          {
            ...sizesStyle('rest', rest),
            ...sizesStyle('open', open)
          } as React.CSSProperties
        }
        onClick={() => model.setView('map')}
        aria-label="Open the map view"
        title="Map · click to expand"
      >
        <span className="jp-Epi-minimap-title">Map · click to expand</span>
        {bands.map(band => (
          <span key={band.id} className="jp-Epi-minimap-band">
            {band.cells.map(cell => (
              <span
                key={cell.id}
                data-minimap-cell={cell.id}
                data-type={cell.meta.question?.type}
                className={`jp-Epi-minimap-cell${cell.branchOf ? ' jp-mod-branch' : ''}${model.jobs.jobFor(cell.id)?.status === 'running' ? ' jp-mod-running' : ''}`}
              />
            ))}
          </span>
        ))}
      </button>
    </div>
  );
}
