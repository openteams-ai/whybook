/**
 * Where the popover of a request's questions opens (design iteration 1.83):
 * inside the room that JupyterLab gives its panels, below the menu bar and
 * above the status bar. A popover taller than the room gets the room's
 * height, and its list scrolls inside it. The popover is placed again each
 * time its content grows, as when the model's questions come.
 */
import * as React from 'react';

import type { IAnchor } from '../tokens';

/** The room for a popover, in the pixels of the window. */
export interface IBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Where the popover goes, and the height it may take. */
export interface IPlaced {
  left: number;
  top: number;
  maxHeight: number;
}

/** The gap between a popover and the edges of its room. */
export const POPOVER_MARGIN = 6;

/** How far above the pointer a popover beside it starts, so that its head is level with the pointer. */
const LIFT = 20;

/** The gap between a popover or a tooltip and the element it opens at. */
const GAP = 6;

/**
 * The room under an element that a popover of its own takes for itself, in
 * pixels: with less, and more room above, it opens above.
 */
const ROOM_BELOW = 320;

/**
 * The room for a popover: JupyterLab's panels, between its menu bar and its
 * status bar, less a margin; the window, where the page has no such panels.
 */
export function popoverBounds(): IBounds {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const main = document
    .getElementById('jp-main-content-panel')
    ?.getBoundingClientRect();
  const top = main && main.height > 0 ? Math.max(0, main.top) : 0;
  const bottom =
    main && main.height > 0 ? Math.min(height, main.bottom) : height;
  return {
    top: top + POPOVER_MARGIN,
    bottom: bottom - POPOVER_MARGIN,
    left: POPOVER_MARGIN,
    right: width - POPOVER_MARGIN
  };
}

/**
 * Where a popover of this size opens for this anchor, inside `bounds`.
 * `size.height` is the height of all its content, which may be more than
 * the room: the popover then takes the height of its room, and scrolls.
 *
 * - Beside a pointer, as after a drop or a click: to the right of it, or to
 *   the left with `side: 'left'`, its head level with the pointer. Where it
 *   would run past the bottom of the room, it moves up as far as it needs,
 *   so that more of it lies above the pointer.
 * - Under an element, as a chip (`below`): left-aligned with it. The side is
 *   chosen from the room at each side, and not from the height of the
 *   popover, so that it does not jump from one side to the other when its
 *   questions come and it grows. Under the element unless the room there
 *   is below 320 px and the room above is larger, with the height of that
 *   room at most.
 * - Above an element, as the button that asks about a text: above it when it
 *   fits there; else beside the cell that holds the element; else above or
 *   below the element, wherever the room is larger, with the height of
 *   that room.
 */
export function placePopover(
  anchor: IAnchor,
  size: { width: number; height: number },
  bounds: IBounds
): IPlaced {
  const room = Math.max(0, bounds.bottom - bounds.top);
  const fit = (x: number) =>
    Math.max(bounds.left, Math.min(x, bounds.right - size.width));
  // Beside the anchor: as low as its head wants, and up as far as it must.
  const beside = (left: number): IPlaced => {
    const height = Math.min(size.height, room);
    const top = Math.max(
      bounds.top,
      Math.min(anchor.y - LIFT, bounds.bottom - height)
    );
    return { left, top, maxHeight: room };
  };
  if (anchor.below) {
    const bottom = anchor.bottom ?? anchor.y;
    const roomBelow = Math.max(0, bounds.bottom - (bottom + GAP));
    const roomAbove = Math.max(0, anchor.y - GAP - bounds.top);
    if (roomBelow >= Math.min(roomAbove, ROOM_BELOW)) {
      return {
        left: fit(anchor.x),
        top: bottom + GAP,
        maxHeight: roomBelow
      };
    }
    const height = Math.min(size.height, roomAbove);
    return {
      left: fit(anchor.x),
      top: anchor.y - GAP - height,
      maxHeight: roomAbove
    };
  }
  if (!anchor.above) {
    const wanted =
      anchor.side === 'left' ? anchor.x - 12 - size.width : anchor.x + 12;
    return beside(fit(wanted));
  }
  const gap = GAP;
  const above = anchor.y - gap - bounds.top;
  if (size.height <= above) {
    return {
      left: fit(anchor.x),
      top: anchor.y - gap - size.height,
      maxHeight: above
    };
  }
  const cell = anchor.beside;
  if (cell && cell.right + 8 + size.width <= bounds.right) {
    return beside(cell.right + 8);
  }
  if (cell && cell.left - 8 - size.width >= bounds.left) {
    return beside(cell.left - 8 - size.width);
  }
  // No room above at full height, and none beside: the larger side, with
  // the height of its room.
  const bottom = anchor.bottom ?? anchor.y;
  const below = bounds.bottom - (bottom + gap);
  if (below >= above) {
    return {
      left: fit(anchor.x),
      top: bottom + gap,
      maxHeight: Math.max(0, below)
    };
  }
  const height = Math.min(size.height, above);
  return {
    left: fit(anchor.x),
    top: anchor.y - gap - height,
    maxHeight: Math.max(0, above)
  };
}

/**
 * Where a tooltip of this size opens for an element at `rect`, inside
 * `bounds`: under the element, left-aligned with it and moved left as far as
 * it must; above it when there is no room below.
 */
export function placeTooltip(
  rect: { left: number; top: number; bottom: number },
  size: { width: number; height: number },
  bounds: IBounds
): { left: number; top: number } {
  const left = Math.max(
    bounds.left,
    Math.min(rect.left, bounds.right - size.width)
  );
  const below = rect.bottom + GAP;
  if (below + size.height <= bounds.bottom) {
    return { left, top: below };
  }
  const above = rect.top - GAP - size.height;
  return {
    left,
    top:
      above >= bounds.top
        ? above
        : Math.max(bounds.top, bounds.bottom - size.height)
  };
}

/**
 * Place a popover for its anchor while it shows: before it paints, at each
 * drawing, and again when its content grows or shrinks between drawings,
 * as when a list inside it gets more questions, or when the window changes
 * size. The popover takes the height of its room at most, and scrolls.
 */
export function usePopoverPlace(
  box: React.RefObject<HTMLElement>,
  anchor: IAnchor | null | undefined,
  active: boolean
): void {
  const at = React.useRef(anchor);
  at.current = anchor;
  const place = React.useCallback(() => {
    const node = box.current;
    const anchor = at.current;
    if (!node || !anchor) {
      return;
    }
    // All of its content, with what its own scroll hides, and its borders.
    const height = node.scrollHeight + node.offsetHeight - node.clientHeight;
    const placed = placePopover(
      anchor,
      { width: node.offsetWidth, height },
      popoverBounds()
    );
    node.style.left = `${Math.round(placed.left)}px`;
    node.style.top = `${Math.round(placed.top)}px`;
    node.style.maxHeight = `${Math.floor(placed.maxHeight)}px`;
  }, [box]);
  React.useLayoutEffect(() => {
    if (active) {
      place();
    }
  });
  React.useLayoutEffect(() => {
    const node = box.current;
    if (!active || !node) {
      return;
    }
    // The popover's own height stops at the room's, so its parts are watched.
    const sizes =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => place());
    const watch = () => {
      sizes?.disconnect();
      for (const part of Array.from(node.children)) {
        sizes?.observe(part);
      }
    };
    watch();
    const parts =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            watch();
            place();
          });
    parts?.observe(node, { childList: true });
    window.addEventListener('resize', place);
    return () => {
      sizes?.disconnect();
      parts?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [active, box, place]);
}
