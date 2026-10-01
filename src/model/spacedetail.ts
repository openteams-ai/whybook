/**
 * A level of detail that follows the space, a trial behind the setting
 * "Level of detail follows the space" (design iteration 1.14). The width of
 * the view's column sets the level of the bench and of the Code view, and
 * the zoom sets the level of the map. A level steps up where its outputs
 * fit, and steps down only a margin below that, so that a width or a zoom
 * that rests at a step does not switch the level back and forth.
 */
import type { Detail, MapDetail } from '../tokens';

/** The levels of the bench and the Code view, from the least detail to the most. */
export const DETAIL_ORDER: readonly Detail[] = ['overview', 'compact', 'full'];

/** The levels of the map, from the least detail to the most. */
export const MAP_DETAIL_ORDER: readonly MapDetail[] = [
  'none',
  'minimal',
  'overview'
];

/**
 * The width of the view's column from which Compact and Full show, in
 * pixels. A card's outputs are 62 px narrower than the column, for the
 * padding of the bench and of the card. Compact from 420 px: a plot of
 * 340 px fits. Full from 720 px: a plot of 640 px fits.
 */
export const WIDTH_STEPS: readonly number[] = [420, 720];

/**
 * How far below its step the width goes before the level steps down, in
 * pixels: more than a scroll bar, which the level's outputs can add or take
 * away.
 */
export const WIDTH_MARGIN = 40;

/**
 * The zoom of the map from which Minimal and Overview show. Minimal from
 * 80%, where the 10 px text of its tiles is 8 px, the smallest text that the
 * view shrinks a table to. Overview from 125%, one step of the zoom buttons
 * in from 100%.
 */
export const ZOOM_STEPS: readonly number[] = [0.8, 1.25];

/**
 * The zoom steps down below its step divided by this: less than one step of
 * the zoom buttons (1.25), so that a click out after a click in comes back
 * to the level it left.
 */
export const ZOOM_MARGIN = 1.08;

/** Rounding of the zoom, as 0.8 × 1.25 × 1.25 gives it back. */
const EPSILON = 1e-6;

/**
 * The index of the level at this value, from the level in force: it steps
 * up at a step, and down only below `below(step)`. Without a level in force,
 * the steps alone decide.
 */
export function stepLevel(
  value: number,
  steps: readonly number[],
  below: (step: number) => number,
  current: number | null
): number {
  let level = current ?? steps.filter(step => value >= step - EPSILON).length;
  while (level < steps.length && value >= steps[level] - EPSILON) {
    level++;
  }
  while (level > 0 && value < below(steps[level - 1]) - EPSILON) {
    level--;
  }
  return level;
}

/**
 * The level of the bench and the Code view for the width of the view's
 * column, from the level that the width gave last, if any.
 */
export function levelOfWidth(width: number, current: Detail | null): Detail {
  const index = stepLevel(
    width,
    WIDTH_STEPS,
    step => step - WIDTH_MARGIN,
    current === null ? null : DETAIL_ORDER.indexOf(current)
  );
  return DETAIL_ORDER[index];
}

/** The level of the map for its zoom, from the level that the zoom gave last, if any. */
export function levelOfZoom(
  zoom: number,
  current: MapDetail | null
): MapDetail {
  const index = stepLevel(
    zoom,
    ZOOM_STEPS,
    step => step / ZOOM_MARGIN,
    current === null ? null : MAP_DETAIL_ORDER.indexOf(current)
  );
  return MAP_DETAIL_ORDER[index];
}

/** The settings that the level reads: the slider's levels, and the setting of the trial. */
export interface IDetailSettings {
  detail: Detail;
  mapDetail: MapDetail;
  detailFollowsSpace: boolean;
}

/**
 * The level of detail in force in one view. With the setting off it is the
 * slider's, as the settings keep it. With the setting on, the width of the
 * view's column sets the level of the bench and the Code view, and the zoom
 * sets the level of the map. A level that the analyst picks on the slider
 * holds until the width or the zoom reaches another level, or until the
 * setting is turned off.
 */
export class SpaceDetail {
  /**
   * @param settings - The view's settings.
   * @param changed - Called when the level in force changes, other than by
   *   a change of the settings.
   */
  constructor(
    private _settings: IDetailSettings,
    private _changed: () => void
  ) {}

  /** Whether the width and the zoom set the level. */
  get follows(): boolean {
    return this._settings.detailFollowsSpace;
  }

  /** The level of the bench and the Code view. */
  get detail(): Detail {
    return this.follows
      ? (this._picked ?? this._byWidth ?? this._settings.detail)
      : this._settings.detail;
  }

  /** The level of the map. */
  get mapDetail(): MapDetail {
    return this.follows
      ? (this._mapPicked ?? this._byZoom ?? this._settings.mapDetail)
      : this._settings.mapDetail;
  }

  /** Whether the analyst's pick sets the level of the bench, rather than the width. */
  get picked(): boolean {
    return this.follows && this._picked !== null;
  }

  /** Whether the analyst's pick sets the level of the map, rather than the zoom. */
  get mapPicked(): boolean {
    return this.follows && this._mapPicked !== null;
  }

  /**
   * The width of the view's column, in pixels. The level is kept while the
   * setting is off too, so that turning it on shows the level at once; the
   * view draws again only for a change of the level in force.
   */
  setWidth(width: number): void {
    const before = this.detail;
    const level = levelOfWidth(width, this._byWidth);
    if (level !== this._byWidth) {
      // The width reached another level: a pick holds no longer.
      if (this._byWidth !== null) {
        this._picked = null;
      }
      this._byWidth = level;
    }
    if (this.detail !== before) {
      this._changed();
    }
  }

  /**
   * The zoom of the map. True when the level in force changed, so that the
   * map can keep in place what the analyst zoomed on.
   */
  setZoom(zoom: number): boolean {
    const before = this.mapDetail;
    const level = levelOfZoom(zoom, this._byZoom);
    if (level !== this._byZoom) {
      if (this._byZoom !== null) {
        this._mapPicked = null;
      }
      this._byZoom = level;
    }
    if (this.mapDetail !== before) {
      this._changed();
      return true;
    }
    return false;
  }

  /** The analyst moved the slider of the bench or the Code view. */
  pick(level: Detail): void {
    if (this.follows && level !== this.detail) {
      this._picked = level;
      this._changed();
    }
  }

  /** The analyst moved the slider of the map. */
  pickMap(level: MapDetail): void {
    if (this.follows && level !== this.mapDetail) {
      this._mapPicked = level;
      this._changed();
    }
  }

  /** The settings changed: turning the setting off drops the picks. */
  settingsChanged(): void {
    if (!this.follows) {
      this._picked = null;
      this._mapPicked = null;
    }
  }

  private _byWidth: Detail | null = null;
  private _byZoom: MapDetail | null = null;
  private _picked: Detail | null = null;
  private _mapPicked: MapDetail | null = null;
}
