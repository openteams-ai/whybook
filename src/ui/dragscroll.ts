/**
 * Scrolling during a drag (design iteration 1.77). A list or the view that
 * a drag nears the edge of scrolls, so that a column far down Contents can
 * reach a column at its top, and a file reaches a card below the window.
 * The browser scrolls some lists by itself during an HTML5 drag, and none
 * during the Lumino drag of the file browser.
 */
import * as React from 'react';

/** The elements of the view that a drag scrolls, the innermost first. */
export const DRAG_SCROLL = [
  // Long lists of Variables and Contents.
  '.jp-Epi-list.jp-mod-virtual',
  // The sections of the side panels, and the panels inside the view; the
  // right panel scrolls under its tabs.
  '.jp-Epi-right-scroll',
  '.jp-Epi-sidebar',
  '.jp-Epi-docpanel',
  // The bench and the Code view.
  '.jp-Epi-main'
].join(', ');

/** How near its top or bottom edge, in pixels, a drag scrolls an element. */
export const EDGE = 40;

/** The most a drag scrolls in one frame, in pixels, with the pointer on the edge. */
export const STEP = 18;

/**
 * An HTML5 drag sends a dragover about every 50 ms while the pointer rests:
 * none for this long means that the drag left the page.
 */
const STALE_MS = 250;

/**
 * How far to scroll an element from `top` to `bottom` in one frame, for a
 * pointer at `y`: up (negative) near the top, down near the bottom, faster
 * the nearer the edge, and 0 in the middle or outside the element. The
 * zone near each edge is EDGE pixels, or a quarter of a lower element.
 */
export function edgeStep(y: number, top: number, bottom: number): number {
  const height = bottom - top;
  if (height <= 0 || y < top || y > bottom) {
    return 0;
  }
  const zone = Math.min(EDGE, height / 4);
  if (y < top + zone) {
    return -Math.ceil((STEP * (top + zone - y)) / zone);
  }
  if (y > bottom - zone) {
    return Math.ceil((STEP * (y - (bottom - zone))) / zone);
  }
  return 0;
}

/**
 * The element to scroll for a pointer at (x, y) over `under`: the innermost
 * of DRAG_SCROLL around it whose edge the pointer is near and that can
 * still scroll that way, with the step. An inner list at its end lets the
 * section around it scroll.
 */
export function scrollTarget(
  under: Element | null,
  x: number,
  y: number
): { element: HTMLElement; step: number } | null {
  for (
    let element = under?.closest<HTMLElement>(DRAG_SCROLL) ?? null;
    element;
    element = element.parentElement?.closest<HTMLElement>(DRAG_SCROLL) ?? null
  ) {
    const box = element.getBoundingClientRect();
    if (x < box.left || x > box.right) {
      continue;
    }
    const step = edgeStep(y, box.top, box.bottom);
    const room =
      step < 0
        ? element.scrollTop
        : element.scrollHeight - element.clientHeight - element.scrollTop;
    if (step !== 0 && room > 0) {
      return { element, step };
    }
  }
  return null;
}

/**
 * The element of the page under a point. During a Lumino drag a backdrop
 * covers the page, for the drag's cursor: the element is the one under it.
 */
function underPoint(x: number, y: number): Element | null {
  const elements = document.elementsFromPoint?.(x, y) ?? [];
  return (
    elements.find(
      element => !element.classList.contains('lm-cursor-backdrop')
    ) ?? null
  );
}

/**
 * The listeners of the page: one set, however many views use them.
 */
let users = 0;
let stopListening: (() => void) | null = null;

function listen(): () => void {
  let point: { x: number; y: number } | null = null;
  // Whether the drag is an HTML5 one, and when its last dragover came.
  let html5 = false;
  let seen = 0;
  let frame = 0;
  const stop = () => {
    point = null;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
  const tick = () => {
    frame = 0;
    if (!point || (html5 && performance.now() - seen > STALE_MS)) {
      point = null;
      return;
    }
    const target = scrollTarget(underPoint(point.x, point.y), point.x, point.y);
    if (!target) {
      return;
    }
    target.element.scrollTop += target.step;
    frame = requestAnimationFrame(tick);
  };
  const track = (event: Event) => {
    const drag = event as MouseEvent;
    point = { x: drag.clientX, y: drag.clientY };
    html5 = event.type === 'dragover';
    seen = performance.now();
    if (!frame) {
      frame = requestAnimationFrame(tick);
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      stop();
    }
  };
  // A Lumino drag ends with the release of the pointer, an HTML5 drag with
  // a drop or its end; Escape cancels either.
  const ends: [string, EventListener][] = [
    ['drop', stop],
    ['dragend', stop],
    ['pointerup', stop],
    ['keydown', onKey as EventListener]
  ];
  document.addEventListener('dragover', track, true);
  document.addEventListener('lm-dragover', track, true);
  for (const [type, listener] of ends) {
    document.addEventListener(type, listener, true);
  }
  return () => {
    stop();
    document.removeEventListener('dragover', track, true);
    document.removeEventListener('lm-dragover', track, true);
    for (const [type, listener] of ends) {
      document.removeEventListener(type, listener, true);
    }
  };
}

/**
 * Scroll the lists and the views of Whybook while a drag nears their edges,
 * for as long as a component that calls this is on the page.
 */
export function useDragScroll(): void {
  React.useEffect(() => {
    users++;
    if (users === 1) {
      stopListening = listen();
    }
    return () => {
      users--;
      if (users === 0) {
        stopListening?.();
        stopListening = null;
      }
    };
  }, []);
}
