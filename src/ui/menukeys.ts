/**
 * The keyboard's way to a context menu: the Menu key, or Shift+F10, on an
 * element that takes the focus opens the menu that a right click on it
 * opens, JupyterLab's context menu of the element.
 */

/** Whether this key opens the context menu: the Menu key, or Shift+F10. */
export function isMenuKey(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  return (
    (event.key === 'ContextMenu' && !event.shiftKey) ||
    (event.key === 'F10' && event.shiftKey)
  );
}

/** The menus that Lumino has open: it attaches each to the page's body. */
function openMenus(): Element[] {
  return Array.from(document.body.children).filter(child =>
    child.classList.contains('lm-Menu')
  );
}

/**
 * Open the context menu of this element under it, as a right click does,
 * and give the focus back to the element when the menu closes without
 * sending it elsewhere.
 *
 * JupyterLab opens its context menu on the `contextmenu` event: Lumino
 * attaches the menu to the page's body at once, and gives it the focus a
 * moment later. When the menu closes, after a pick, Escape or a click
 * elsewhere, Lumino takes it out of the page, and the focus goes to the body
 * unless the click put it elsewhere.
 */
export function openContextMenu(node: HTMLElement): void {
  const before = new Set(openMenus());
  const box = node.getBoundingClientRect();
  node.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: box.left,
      clientY: box.bottom,
      button: 2
    })
  );
  const menu = openMenus().find(item => !before.has(item));
  if (!menu) {
    return;
  }
  const watch = new MutationObserver(() => {
    if (menu.isConnected) {
      return;
    }
    watch.disconnect();
    const now = document.activeElement;
    if ((!now || now === document.body) && node.isConnected) {
      node.focus();
    }
  });
  watch.observe(document.body, { childList: true });
}
