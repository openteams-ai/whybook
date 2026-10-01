/**
 * A tooltip of the view (design iteration 1.86), in place of the browser's
 * `title`: the browser shows it late, in its own style, and not at all when
 * the keyboard focuses the element. This one has JupyterLab's colours and
 * fonts (style/chips.css). It shows when the pointer has rested on the
 * element for a short time, and at once when the keyboard focuses it. It
 * hides when the pointer or the focus leaves, when a key activates the
 * element, when a pointer presses it, and on Escape. It stays inside the
 * window: under the element, left-aligned with it, or above it where the
 * room below is too small (./popoverplace.ts).
 */
import * as React from 'react';
import * as ReactDOM from 'react-dom';

import { placeTooltip, popoverBounds } from './popoverplace';

/** How long the pointer rests on an element before its tooltip shows, in milliseconds. */
export const TOOLTIP_DELAY = 400;

/** What an element needs to show a tooltip. */
export interface ITooltip {
  /** The events and the description to spread on the element. */
  props: {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onPointerDown: () => void;
    onFocus: (event: React.FocusEvent<HTMLElement>) => void;
    onBlur: () => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
    'aria-describedby': string | undefined;
  };
  /** The tooltip, drawn into the page's body; null while it is hidden. Render it in the element. */
  node: React.ReactNode;
  /** Hide it, as an element does when it opens something at the same place. */
  hide: () => void;
}

/** Whether the keyboard moved the focus to the element, as `:focus-visible` says; a click is no keyboard. */
function focusedByKeyboard(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    // A browser or a test environment that does not know the selector.
    return false;
  }
}

/**
 * The tooltip of an element: the lines of text it shows, the first as code
 * when `code` is true. Without lines, it shows nothing.
 */
export function useTooltip(
  lines: string[] | null | undefined,
  options: { code?: boolean; delay?: number } = {}
): ITooltip {
  const id = React.useId();
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  const timer = React.useRef<number | null>(null);
  const delay = options.delay ?? TOOLTIP_DELAY;
  const clear = React.useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const hide = React.useCallback(() => {
    clear();
    setRect(null);
  }, [clear]);
  React.useEffect(() => clear, [clear]);
  const show = (element: HTMLElement, wait: number) => {
    clear();
    const open = () => {
      timer.current = null;
      // The questions of a chip, open under it, tell more than its tooltip would.
      if (element.isConnected && !document.querySelector('.jp-Epi-popover')) {
        setRect(element.getBoundingClientRect());
      }
    };
    if (wait <= 0) {
      open();
    } else {
      timer.current = window.setTimeout(open, wait);
    }
  };
  const shown = rect !== null && !!lines && lines.length > 0;
  return {
    props: {
      onPointerEnter: event => {
        // A touch has no pointer that rests on an element.
        if (event.pointerType !== 'touch') {
          show(event.currentTarget, delay);
        }
      },
      onPointerLeave: hide,
      onPointerDown: hide,
      onFocus: event => {
        if (focusedByKeyboard(event.currentTarget)) {
          show(event.currentTarget, 0);
        }
      },
      onBlur: hide,
      onKeyDown: event => {
        if (['Escape', 'Enter', ' '].includes(event.key)) {
          hide();
        }
      },
      'aria-describedby': shown ? id : undefined
    },
    node:
      shown && lines ? (
        <TooltipBox
          id={id}
          rect={rect}
          lines={lines}
          code={options.code ?? false}
          onEscape={hide}
        />
      ) : null,
    hide
  };
}

/** The tooltip, placed before it paints and hidden on Escape, wherever the focus is. */
function TooltipBox(props: {
  id: string;
  rect: DOMRect;
  lines: string[];
  code: boolean;
  onEscape: () => void;
}): JSX.Element {
  const { id, rect, lines, code, onEscape } = props;
  const box = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const node = box.current;
    if (!node) {
      return;
    }
    const placed = placeTooltip(
      rect,
      { width: node.offsetWidth, height: node.offsetHeight },
      popoverBounds()
    );
    node.style.left = `${Math.round(placed.left)}px`;
    node.style.top = `${Math.round(placed.top)}px`;
    // Hidden until it has its place, so that it does not flash at the corner.
    node.style.visibility = 'visible';
  }, [rect, lines]);
  React.useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onEscape();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [onEscape]);
  return ReactDOM.createPortal(
    <div className="jp-Epi-tooltip" role="tooltip" id={id} ref={box}>
      {lines.map((line, index) => (
        <div key={index}>
          {code && index === 0 ? <code>{line}</code> : line}
        </div>
      ))}
    </div>,
    document.body
  );
}
