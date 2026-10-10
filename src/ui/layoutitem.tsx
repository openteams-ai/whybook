/**
 * The layout's item of Whybook's toolbar: the three icons of the layouts, or
 * one menu button (./layoutmenu.tsx) when the toolbar is short of room.
 *
 * JupyterLab's toolbar (`ReactiveToolbar` of @jupyterlab/ui-components) moves
 * its last items into its "⋯" menu when they do not fit, and back when they
 * do: the kernel's status and name first, then AI, Run all and the level of
 * detail, which come after the layout. Room is short when, with the three
 * icons, an item before the toolbar's spacer would go into "⋯" (Run all or AI
 * among them), or when one button leaves room for an item that the three
 * icons push into "⋯". The three icons then fold, and the toolbar never shows
 * them while Run all or AI are in "⋯".
 *
 * The toolbar moves items by widths that it measures once and keeps: it
 * measures again only after a change of zoom. An item that changes its width
 * has to give the toolbar its new width, or the toolbar counts the old one,
 * and items then overflow the toolbar, or go into "⋯" with room left. The
 * item decides before the toolbar lays out its items for a new width, and
 * writes its new width where the toolbar keeps the widths (`toolbarWidths`).
 */
import { ReactWidget } from '@jupyterlab/ui-components';
import type { IMessageHandler, Message } from '@lumino/messaging';
import { MessageLoop } from '@lumino/messaging';
import type { PanelLayout } from '@lumino/widgets';
import { Widget } from '@lumino/widgets';
import * as React from 'react';
import { flushSync } from 'react-dom';

import type { EpiModel } from '../model/epimodel';
import { LayoutSelect } from './document';
import { LayoutMenuButton } from './layoutmenu';

/**
 * What JupyterLab's toolbar counts beside its items: 2 + 5 px of padding, and
 * 32 px for its "⋯" button (`ReactiveToolbar._onResize`).
 */
export const TOOLBAR_PADDING = 7;
export const OPENER_WIDTH = 32;

/** The width that the toolbar counts for a spacer, which takes the room left. */
const SPACER_WIDTH = 2;

const SPACER_CLASS = 'jp-Toolbar-spacer';
const OPENER_CLASS = 'jp-Toolbar-responsive-opener';
const FOLDED_CLASS = 'jp-mod-folded';

/** The frames that the item waits for the toolbar to draw its items. */
const MAX_RETRIES = 30;

/**
 * The widths that JupyterLab's toolbar keeps for its items, by the items'
 * names, or null for a toolbar that keeps none.
 *
 * `ReactiveToolbar` keeps them in a private field, `_widgetWidths`, the same
 * map in JupyterLab 4.1 to 4.6. No public call makes the toolbar measure an
 * item again: JupyterLab 4.6.4 forgets the width of an item taken out of the
 * toolbar, but earlier releases, 4.4 and 4.5 and the Notebook 7 releases
 * built on them among them, keep it. src/__tests__/toolbarwidths.spec.ts
 * fails when the field changes.
 */
export function toolbarWidths(toolbar: Widget): Map<string, number> | null {
  const widths = (toolbar as unknown as { _widgetWidths?: unknown })
    ._widgetWidths;
  return widths instanceof Map ? (widths as Map<string, number>) : null;
}

/**
 * How many items JupyterLab's toolbar keeps in its row, of items of these
 * widths in their order: as many as fit with its padding and its "⋯" button,
 * and the last one too when every item fits with the padding alone
 * (`ReactiveToolbar._onResize`). The rest go into "⋯".
 */
export function rowCount(widths: number[], room: number): number {
  let total = 0;
  let count = 0;
  for (const width of widths) {
    total += width;
    if (TOOLBAR_PADDING + OPENER_WIDTH + total >= room) {
      break;
    }
    count++;
  }
  if (count >= widths.length - 1) {
    const all = widths.reduce((sum, width) => sum + width, 0);
    if (TOOLBAR_PADDING + all < room) {
      return widths.length;
    }
  }
  return Math.min(count, widths.length - 1);
}

/** The toolbar's "⋯" button: its menu holds the items that do not fit. */
interface IOpener extends Widget {
  widgetCount?(): number;
  widgetAt?(index: number): Widget;
}

/**
 * The toolbar's items in their order, those in "⋯" last, without the "⋯"
 * button. Null when the items in "⋯" cannot be read.
 */
function toolbarItems(toolbar: Widget): Widget[] | null {
  const widgets = (toolbar.layout as PanelLayout | null)?.widgets ?? [];
  const opener = widgets.find(item => item.hasClass(OPENER_CLASS)) as
    IOpener | undefined;
  const row = widgets.filter(item => item !== opener);
  if (!opener) {
    return row;
  }
  const { widgetCount, widgetAt } = opener;
  if (!widgetCount || !widgetAt) {
    return opener.isHidden ? row : null;
  }
  const menu = Array.from({ length: widgetCount.call(opener) }, (_, index) =>
    widgetAt.call(opener, index)
  );
  return [...row, ...menu];
}

/**
 * The width that the toolbar counts for one of its items: the width that it
 * keeps, or the width that it measures when it lays the item out first. Null
 * for an item that is not drawn yet.
 */
function itemWidth(
  toolbar: Widget,
  item: Widget,
  widths: Map<string, number>
): number | null {
  if (item.hasClass(SPACER_CLASS)) {
    return SPACER_WIDTH;
  }
  const kept = widths.get(item.node.dataset.jpItemName ?? '');
  if (kept) {
    return kept;
  }
  // In "⋯", the toolbar counts the width that it keeps: it measures an item
  // in its row.
  if (item.parent !== toolbar) {
    return kept === 0 ? 0 : null;
  }
  if (item instanceof ReactWidget && !item.node.firstChild) {
    return null;
  }
  return item.node.clientWidth;
}

/**
 * The toolbar's item of the layouts: three icons, or one menu button when
 * the toolbar is short of room.
 */
export class LayoutItem extends ReactWidget {
  constructor(options: LayoutItem.IOptions) {
    super();
    this.addClass('jp-Epi-layoutitem');
    this._model = options.model;
    this._toolbar = options.toolbar;
    // The item starts folded, at its narrower width, so that the toolbar
    // never lays out the three icons where they do not fit: it unfolds them
    // once the toolbar has drawn its items with room for them. A toolbar
    // that keeps no widths gets one width: the three icons.
    this._folded = toolbarWidths(options.toolbar) !== null;
    this._shown = this._folded;
    this.toggleClass(FOLDED_CLASS, this._folded);
    MessageLoop.installMessageHook(options.toolbar, this._onToolbarMessage);
  }

  /** Whether the three icons are folded into one menu button. */
  get folded(): boolean {
    return this._folded;
  }

  /**
   * Fold the three icons when the toolbar is short of room for them, and
   * unfold them when it has room. After a fold the toolbar lays out its
   * items again, unless `relayout` is false: on a resize it does so next.
   */
  fit(relayout = true): void {
    const widths = toolbarWidths(this._toolbar);
    const room = this._toolbar.node.clientWidth;
    if (!widths || !this._toolbar.isVisible || room <= 0) {
      return;
    }
    const fold = this._mustFold(widths, room);
    if (fold === null) {
      this._retry();
      return;
    }
    this._retries = 0;
    if (fold === this._folded) {
      return;
    }
    this._setFolded(fold, widths);
    if (fold) {
      if (relayout) {
        this._relayout();
      }
      // A layout of the toolbar that was under way counted the old width.
      this._schedule(true);
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    MessageLoop.removeMessageHook(this._toolbar, this._onToolbarMessage);
    if (this._frame) {
      window.cancelAnimationFrame(this._frame);
    }
    super.dispose();
  }

  protected render(): JSX.Element {
    return this._shown ? (
      <LayoutMenuButton
        model={this._model}
        onClosed={() => this._focusControl()}
      />
    ) : (
      <LayoutSelect model={this._model} />
    );
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    this._schedule();
  }

  /**
   * Whether the three icons fold, by the rows that the toolbar lays out with
   * them and with the button: they fold when an item before the spacer would
   * be in "⋯" with them, or when the button keeps more items in the row.
   * Null while the item or another one is not drawn yet.
   */
  private _mustFold(widths: Map<string, number>, room: number): boolean | null {
    const items = toolbarItems(this._toolbar);
    // JupyterLab takes the items out of the toolbar, and does not dispose of
    // them, when its settings change: an item out of the toolbar stays as it
    // is, and leaves the toolbar's widths alone.
    if (items && !items.includes(this)) {
      return this._folded;
    }
    const forms = this._formWidths(widths);
    if (!items || !forms) {
      // In "⋯", or not drawn yet: the narrower form.
      return this.parent !== this._toolbar ? true : null;
    }
    const index = items.indexOf(this);
    const sizes: number[] = [];
    let drawn = true;
    for (const item of items) {
      const width = item === this ? 0 : itemWidth(this._toolbar, item, widths);
      if (width === null) {
        drawn = false;
      }
      sizes.push(width ?? 0);
    }
    const withForm = (width: number) => {
      sizes[index] = width;
      return rowCount(sizes, room);
    };
    const withIcons = withForm(forms.icons);
    const withButton = withForm(forms.button);
    const spacer = items.findIndex(item => item.hasClass(SPACER_CLASS));
    const before = spacer < 0 ? items.length : spacer;
    if (withIcons < before || withButton > withIcons) {
      return true;
    }
    return drawn ? false : null;
  }

  /**
   * The widths of the three icons and of the button, which the item notes
   * while each shows. The item shows the other form once to measure it, in a
   * moment that the browser does not draw. Null before the toolbar draws the
   * item in its row.
   */
  private _formWidths(
    widths: Map<string, number>
  ): { icons: number; button: number } | null {
    this._measure();
    const kept = widths.get(this.node.dataset.jpItemName ?? '');
    if (kept && this._shown && this._button === null) {
      this._button = kept;
    } else if (kept && !this._shown && this._icons === null) {
      this._icons = kept;
    }
    if (
      (this._icons === null || this._button === null) &&
      this.parent === this._toolbar &&
      this.node.clientWidth > 0 &&
      !this.node.contains(document.activeElement)
    ) {
      const folded = this._shown;
      this._show(!folded);
      this._measure();
      this._show(folded);
    }
    return this._icons !== null && this._button !== null
      ? { icons: this._icons, button: this._button }
      : null;
  }

  /** Note the width of the form that shows, once the toolbar draws it. */
  private _measure(): void {
    const width = this.node.clientWidth;
    if (width > 0 && this.node.firstElementChild) {
      if (this._shown) {
        this._button = width;
      } else {
        this._icons = width;
      }
    }
  }

  private _setFolded(fold: boolean, widths: Map<string, number>): void {
    const focused = this.node.contains(document.activeElement);
    this._folded = fold;
    this.toggleClass(FOLDED_CLASS, fold);
    this._show(fold);
    this._measure();
    // The toolbar counts the new width from now on.
    const width = fold ? this._button : this._icons;
    const name = this.node.dataset.jpItemName;
    if (name && width) {
      widths.set(name, width);
    }
    if (focused) {
      this._focusControl();
    }
  }

  /** Draw a form at once, so that its width can be read. */
  private _show(folded: boolean): void {
    if (this._shown === folded || this.isDisposed) {
      return;
    }
    this._shown = folded;
    flushSync(() => MessageLoop.sendMessage(this, Widget.Msg.UpdateRequest));
  }

  /** The focus goes to the control that shows: the button, or the checked icon. */
  private _focusControl(): void {
    this.node
      .querySelector<HTMLElement>(
        '.jp-Epi-layoutbutton, [role="radio"][aria-checked="true"]'
      )
      ?.focus();
  }

  /** The toolbar lays out its items again, as when it gets a new size. */
  private _relayout(): void {
    const node = this._toolbar.node;
    if (this._toolbar.isVisible && node.offsetWidth > 0) {
      MessageLoop.sendMessage(
        this._toolbar,
        new Widget.ResizeMessage(node.offsetWidth, node.offsetHeight)
      );
    }
  }

  /** Fit at the next frame, and with `relayout`, lay out the toolbar again then. */
  private _schedule(relayout = false): void {
    this._relayoutNext = this._relayoutNext || relayout;
    if (this._frame || this.isDisposed) {
      return;
    }
    this._frame = window.requestAnimationFrame(() => {
      this._frame = 0;
      const relayoutNow = this._relayoutNext;
      this._relayoutNext = false;
      this.fit();
      if (relayoutNow) {
        this._relayout();
      }
    });
  }

  /** An item is not drawn yet: the toolbar draws it within a few frames. */
  private _retry(): void {
    if (this._retries < MAX_RETRIES) {
      this._retries++;
      this._schedule();
    }
  }

  private _onToolbarMessage = (_: IMessageHandler, msg: Message): boolean => {
    switch (msg.type) {
      case 'resize':
        // Before the toolbar lays out its items for its new width.
        this.fit(false);
        break;
      case 'after-show':
      case 'child-added':
      case 'child-removed':
      case 'child-shown':
      case 'child-hidden':
        // After the toolbar moved items into "⋯", or out of it.
        this._schedule();
        break;
    }
    return true;
  };

  private _model: EpiModel;
  private _toolbar: Widget;
  private _folded: boolean;
  private _shown: boolean;
  private _icons: number | null = null;
  private _button: number | null = null;
  private _frame = 0;
  private _relayoutNext = false;
  private _retries = 0;
}

export namespace LayoutItem {
  export interface IOptions {
    model: EpiModel;
    /** The toolbar that the item is in, whose "⋯" menu can hold it. */
    toolbar: Widget;
  }
}
