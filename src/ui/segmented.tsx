import * as React from 'react';

export interface ISegment<T extends string> {
  value: T;
  /** The text of the segment; an icon-only segment has none. */
  label?: string;
  icon?: JSX.Element;
  /** The tooltip, and the accessible name of an icon-only segment. */
  title: string;
}

/**
 * One choice out of a few, as a segmented control.
 *
 * It is a radio group: Tab reaches the chosen segment, the arrow keys move
 * the choice, Home and End jump to the ends. `toolbar` sizes it for a
 * JupyterLab toolbar, next to the toolbar's own buttons. There the toolbar
 * owns the keys, as its other items do: Tab reaches the toolbar once, the
 * arrow keys move between every item of it, and Enter or Space chooses a
 * segment. The group's own arrow keys kept the focus in its segments, so the
 * rest of the toolbar, the AI button included, could not be reached.
 */
export function Segmented<T extends string>(props: {
  value: T;
  options: ISegment<T>[];
  onChange: (value: T) => void;
  label: string;
  toolbar?: boolean;
  className?: string;
}): JSX.Element {
  const { value, options, onChange } = props;
  const buttons = React.useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (index: number) => {
    const option = options[(index + options.length) % options.length];
    onChange(option.value);
    buttons.current[options.indexOf(option)]?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (props.toolbar) {
      return;
    }
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: options.length - 1
    };
    if (event.key in moves) {
      // The keys move the choice, and do not scroll the panel around it.
      event.preventDefault();
      event.stopPropagation();
      choose(moves[event.key]);
    }
  };
  const classes = ['jp-Epi-segmented'];
  if (props.toolbar) {
    classes.push('jp-mod-toolbar');
  }
  if (props.className) {
    classes.push(props.className);
  }
  return (
    <div
      className={classes.join(' ')}
      role="radiogroup"
      aria-label={props.label}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={node => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.label ? undefined : option.title}
            // In a toolbar, the toolbar sets which item Tab reaches.
            tabIndex={props.toolbar ? undefined : checked ? 0 : -1}
            title={option.title}
            data-value={option.value}
            className={`jp-Epi-segment${option.label ? '' : ' jp-mod-icon'}`}
            onClick={() => onChange(option.value)}
            onKeyDown={event => onKeyDown(event, index)}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A window with the view in the middle and two panels, drawn outside the
 * view's frame when they are in the sidebars and inside it when they are in
 * the view.
 */
function LayoutIcon(props: { left: boolean; right: boolean }): JSX.Element {
  return (
    <svg
      width="18"
      height="14"
      viewBox="0 0 18 14"
      aria-hidden="true"
      className="jp-Epi-layout-icon"
    >
      {layoutRects(props.left, props.right).map((rect, index) => (
        <rect key={index} {...rect} />
      ))}
    </svg>
  );
}

/**
 * The three shapes of a layout's icon: the view's frame, and the left and
 * right panels, inside the frame or outside it.
 */
function layoutRects(
  left: boolean,
  right: boolean
): Record<string, string | number>[] {
  return [
    {
      x: left ? 0.5 : 4.5,
      y: 0.5,
      width: 17 - (left ? 0 : 4) - (right ? 0 : 4),
      height: 13,
      rx: 1.5,
      fill: 'none',
      stroke: 'currentColor'
    },
    {
      x: left ? 2 : 0,
      y: left ? 2 : 0.5,
      width: 3,
      height: left ? 10 : 13,
      rx: 0.75,
      fill: 'currentColor'
    },
    {
      x: right ? 13 : 15,
      y: right ? 2 : 0.5,
      width: 3,
      height: right ? 10 : 13,
      rx: 0.75,
      fill: 'currentColor'
    }
  ];
}

/** Which panels each layout puts inside the view: the left one, the right one. */
const LAYOUT_PANELS = {
  sidebars: [false, false],
  'variables-here': [true, false],
  'all-here': [true, true]
} as const;

export const LAYOUT_ICONS = {
  sidebars: <LayoutIcon left={false} right={false} />,
  'variables-here': <LayoutIcon left={true} right={false} />,
  'all-here': <LayoutIcon left={true} right={true} />
};

/**
 * A layout's icon as the text of an SVG file, drawn as in `LAYOUT_ICONS`, for
 * the icons of JupyterLab's menus.
 */
export function layoutIconSvg(layout: keyof typeof LAYOUT_PANELS): string {
  const [left, right] = LAYOUT_PANELS[layout];
  const rects = layoutRects(left, right).map(
    rect =>
      `<rect ${Object.entries(rect)
        .map(([name, value]) => `${name}="${value}"`)
        .join(' ')}/>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="14" viewBox="0 0 18 14">${rects.join('')}</svg>`;
}
