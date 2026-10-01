import * as React from 'react';

import type { EpiModel } from '../model/epimodel';

/** Where the card that the analyst reads was, in pixels from the top of the view. */
interface IReading {
  card: Element;
  top: number;
}

/**
 * The card being read: of the cards in sight, the one whose top is nearest
 * the top of the view. Of a card and a branch inside it with their tops as
 * near, the branch.
 */
export function readingCard(view: HTMLElement): IReading | null {
  const box = view.getBoundingClientRect();
  let reading: Element | null = null;
  let best = Infinity;
  for (const card of Array.from(view.querySelectorAll('[data-cell-id]'))) {
    const rect = card.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= box.top || rect.top >= box.bottom) {
      continue;
    }
    const distance = Math.abs(rect.top - box.top);
    // A branch's card comes after the card that holds it.
    if (distance <= best) {
      best = distance;
      reading = card;
    }
  }
  return reading
    ? { card: reading, top: reading.getBoundingClientRect().top - box.top }
    : null;
}

/**
 * The level of detail that follows the width of the view's column, for the
 * bench and the Code view: the column's width goes to the model, and a
 * change of level keeps the card being read where it was, while the outputs
 * of the new level are drawn. The hold ends when the analyst scrolls or
 * clicks, and when anything else scrolls the view, such as a link to a cell.
 */
export function useDetailFollowsWidth(
  main: React.RefObject<HTMLDivElement>,
  model: EpiModel
): void {
  const held = React.useRef<IReading | null>(null);
  // Where the hold left the view: a scroll to elsewhere is not the hold's.
  const scrolled = React.useRef(0);
  const hold = (reading: IReading | null) => {
    const node = main.current;
    held.current = reading;
    if (node) {
      scrolled.current = node.scrollTop;
      // The browser's own anchoring moves the view too, to another element.
      node.style.overflowAnchor = reading ? 'none' : '';
    }
  };
  // Scroll the view so that the card read is where it was.
  const restore = () => {
    const node = main.current;
    const reading = held.current;
    if (!node || !reading) {
      return;
    }
    if (!reading.card.isConnected) {
      hold(null);
      return;
    }
    const top =
      reading.card.getBoundingClientRect().top -
      node.getBoundingClientRect().top;
    if (Math.abs(top - reading.top) >= 1) {
      node.scrollTop += top - reading.top;
    }
    scrolled.current = node.scrollTop;
  };
  React.useLayoutEffect(() => {
    const node = main.current;
    if (!node) {
      return;
    }
    // Its outer width: a scroll bar that the outputs add or take away does
    // not change it. A hidden view has none, and keeps its level. The first
    // width sets the level before anything is read. The view draws a new
    // level on the next frame, so the card read is still where it was. A
    // card held since an earlier change of level stays the one read.
    let measured = false;
    const measure = () => {
      if (node.offsetWidth <= 0) {
        return;
      }
      const level = model.detail;
      model.spaceDetail.setWidth(node.offsetWidth);
      const first = !measured;
      measured = true;
      if (first || model.detail === level || model.view === 'map') {
        return;
      }
      const reading = held.current ?? readingCard(node);
      if (reading) {
        hold(reading);
      }
    };
    measure();
    const observer = new ResizeObserver(() => {
      measure();
      restore();
    });
    observer.observe(node);
    // The outputs of the new level change the height of what the view shows.
    const content = new ResizeObserver(restore);
    const watch = () => {
      content.disconnect();
      Array.from(node.children).forEach(child => content.observe(child));
    };
    watch();
    const children = new MutationObserver(watch);
    children.observe(node, { childList: true });
    // The analyst's own scroll or click ends the hold, and so does a link
    // that brings a cell into sight, or any scroll that the hold did not make.
    const release = () => {
      if (held.current) {
        hold(null);
      }
    };
    const events = ['wheel', 'keydown', 'pointerdown', 'touchstart'];
    events.forEach(name =>
      node.addEventListener(name, release, { passive: true })
    );
    const onScroll = () => {
      if (!held.current) {
        return;
      }
      const moved = Math.abs(node.scrollTop - scrolled.current) > 1;
      // A view that became too short to scroll as far is no one's scroll.
      const clamped =
        node.scrollTop < scrolled.current &&
        node.scrollTop >= node.scrollHeight - node.clientHeight - 1;
      if (moved && !clamped) {
        release();
      }
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    model.cellShown.connect(release);
    return () => {
      observer.disconnect();
      content.disconnect();
      children.disconnect();
      events.forEach(name => node.removeEventListener(name, release));
      node.removeEventListener('scroll', onScroll);
      model.cellShown.disconnect(release);
      node.style.overflowAnchor = '';
    };
  }, [model]);
  // Each drawing of the view, as the one of the new level.
  React.useLayoutEffect(restore);
}
