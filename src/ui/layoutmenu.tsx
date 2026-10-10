/**
 * The layout's menu button of Whybook's toolbar: the icon of the current
 * layout and a caret, which the toolbar shows in place of the three icons of
 * the layouts when it is short of room (./layoutitem.tsx). It opens
 * JupyterLab's menu of the three layouts, each with its icon and its title.
 *
 * From the keyboard, Enter, Space or the down arrow opens the menu with the
 * focus on the current layout, and the up arrow on the last one. In the menu,
 * the arrow keys move, Enter picks and Escape closes, as in JupyterLab's other
 * menus, and the focus goes back to the button. Screen readers hear a menu
 * button, collapsed or expanded, and the current layout as checked.
 */
import type { VirtualElement } from '@lumino/virtualdom';
import { h } from '@lumino/virtualdom';
import {
  LabIcon,
  MenuSvg,
  caretDownIcon,
  checkIcon
} from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import type { Menu } from '@lumino/widgets';
import * as React from 'react';

import type { EpiModel } from '../model/epimodel';
import { useModel } from './common';
import type { Layout } from './document';
import { LAYOUTS, layoutOf, setLayout } from './document';
import { LAYOUT_ICONS, layoutIconSvg } from './segmented';

/** The name of the menu button, and of the menu, for screen readers. */
export const LAYOUT_LABEL = 'Layout: where the panels go';

/** The icons of the layouts in JupyterLab's menus, drawn as the toolbar's three icons. */
export const LAYOUT_LABICONS: Record<Layout, LabIcon> = {
  sidebars: new LabIcon({
    name: 'whybook:layout-sidebars',
    svgstr: layoutIconSvg('sidebars')
  }),
  'variables-here': new LabIcon({
    name: 'whybook:layout-variables-here',
    svgstr: layoutIconSvg('variables-here')
  }),
  'all-here': new LabIcon({
    name: 'whybook:layout-all-here',
    svgstr: layoutIconSvg('all-here')
  })
};

/** The check mark at the end of the current layout's row, at the size of a menu's icons. */
const checkMark = checkIcon.bindprops({ stylesheet: 'menuItem' });

/**
 * The rows of the menu: JupyterLab's menu draws a checked item's check mark
 * in place of its icon, and each layout keeps its icon here, with the check
 * mark of the current one at the end of its row.
 */
class LayoutMenuRenderer extends MenuSvg.Renderer {
  renderIcon(data: Menu.IRenderData): VirtualElement {
    const className = this.createIconClass(data);
    const icon = data.item.icon;
    return icon ? h.div({ className }, icon) : h.div({ className });
  }

  renderShortcut(data: Menu.IRenderData): VirtualElement {
    return data.item.isToggled
      ? h.div({ className: 'lm-Menu-itemShortcut' }, checkMark)
      : h.div({ className: 'lm-Menu-itemShortcut' });
  }
}

const RENDERER = new LayoutMenuRenderer();

/** Each menu of a toolbar of an open notebook has an id of its own. */
let menuCount = 0;

/** The menu of the three layouts, whose items put the panels of this view. */
export function createLayoutMenu(model: EpiModel): MenuSvg {
  const commands = new CommandRegistry();
  const menu = new MenuSvg({ commands, renderer: RENDERER });
  menu.addClass('jp-Epi-layoutmenu');
  menu.id = `jp-Epi-layoutmenu-${++menuCount}`;
  menu.contentNode.setAttribute('aria-label', LAYOUT_LABEL);
  for (const layout of LAYOUTS) {
    const id = `whybook-layout:${layout.value}`;
    commands.addCommand(id, {
      label: layout.title,
      icon: LAYOUT_LABICONS[layout.value],
      isToggled: () => layoutOf(model) === layout.value,
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => setLayout(model, layout.value)
    });
    menu.addItem({ command: id });
  }
  return menu;
}

/**
 * The folded layout control: a button with the icon of the current layout
 * and a caret, which opens the menu of the layouts under it. `onClosed` gives
 * the focus back when the menu closed with it, after a pick or Escape: the
 * toolbar can show the three icons by then.
 */
export function LayoutMenuButton(props: {
  model: EpiModel;
  onClosed?: () => void;
}): JSX.Element {
  const { model } = props;
  useModel(model);
  const [menu] = React.useState(() => createLayoutMenu(model));
  const [open, setOpen] = React.useState(false);
  const button = React.useRef<HTMLButtonElement>(null);
  const onClosed = React.useRef(props.onClosed);
  onClosed.current = props.onClosed;
  // A press on the button while the menu is open closes the menu, as
  // Lumino closes it on any press outside it, and the click that follows
  // does not open it again.
  const justClosed = React.useRef(false);
  const skipClick = React.useRef(false);
  React.useEffect(() => {
    const closed = () => {
      setOpen(false);
      justClosed.current = true;
      window.setTimeout(() => {
        justClosed.current = false;
      });
      // Lumino takes the menu out of the page after this signal: the focus
      // that was in the menu goes to the page's body, unless a click put it
      // elsewhere.
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) {
          if (onClosed.current) {
            onClosed.current();
          } else {
            button.current?.focus();
          }
        }
      });
    };
    menu.aboutToClose.connect(closed);
    return () => {
      menu.aboutToClose.disconnect(closed);
      menu.dispose();
    };
  }, [menu]);
  const current = layoutOf(model);
  const title = LAYOUTS.find(layout => layout.value === current)?.title ?? '';
  const openMenu = (focus: 'current' | 'last' | null) => {
    const box = button.current?.getBoundingClientRect();
    if (!box || menu.isAttached) {
      return;
    }
    menu.open(box.left, box.bottom + 1);
    if (focus) {
      const index =
        focus === 'last'
          ? LAYOUTS.length - 1
          : LAYOUTS.findIndex(layout => layout.value === current);
      menu.activeIndex = index;
      // Lumino gives the focus to the whole menu a moment after it opens:
      // the item takes it back, so that a screen reader reads the item.
      menu.node.addEventListener(
        'focus',
        () => {
          if (menu.activeIndex === index) {
            (menu.contentNode.children[index] as HTMLElement).focus();
          }
        },
        { once: true }
      );
    }
    setOpen(true);
  };
  return (
    <button
      ref={button}
      type="button"
      className="jp-Epi-layoutbutton"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menu.id : undefined}
      aria-label={`${LAYOUT_LABEL}. ${title}`}
      title={`${LAYOUT_LABEL}. ${title}`}
      onPointerDown={() => {
        skipClick.current = justClosed.current;
      }}
      onClick={event => {
        if (skipClick.current && event.detail > 0) {
          skipClick.current = false;
          return;
        }
        // A click from Enter or Space has no pointer: the keyboard then
        // reaches the menu's items. JupyterLab's toolbar activates the
        // notebook on a click after which the focus is not in the toolbar,
        // and the notebook would take the focus from the menu's item: that
        // click stops at the button.
        if (event.detail === 0) {
          event.stopPropagation();
        }
        openMenu(event.detail === 0 ? 'current' : null);
      }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          openMenu(event.key === 'ArrowUp' ? 'last' : 'current');
        }
      }}
    >
      {LAYOUT_ICONS[current]}
      <caretDownIcon.react tag="span" className="jp-Epi-layoutbutton-caret" />
    </button>
  );
}
