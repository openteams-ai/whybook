import type {
  IMovableSectionSource,
  ISectionEntry
} from '@jupyterlab/apputils';
import { SidePanel } from '@jupyterlab/ui-components';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';
import type { AccordionPanel, Widget } from '@lumino/widgets';

/**
 * The side panel of Variables, Contents and Questions. With JupyterLab 4.6
 * the user can move each section to another panel, such as the file browser,
 * from the context menu of its header, and back again.
 */
export class EpiSidePanel extends SidePanel implements IMovableSectionSource {
  constructor(options: EpiSidePanel.IOptions) {
    super(options);
    this._onMoved = options.onMoved;
  }

  get accordionPanel(): AccordionPanel {
    return this.content as unknown as AccordionPanel;
  }

  get sectionAdded(): ISignal<this, ISectionEntry> {
    return this._sectionAdded;
  }

  /**
   * Add a section. Its widget id names it when it moves, and when JupyterLab
   * puts it back where the user moved it after a reload.
   */
  addSection(widget: Widget): void {
    this._sections.set(widget.id, widget);
    this.addWidget(widget);
    const entry = this._entry(widget);
    if (entry) {
      this._sectionAdded.emit(entry);
    }
  }

  getSections(): ISectionEntry[] {
    return [...this._sections.values()]
      .map(widget => this._entry(widget))
      .filter((entry): entry is ISectionEntry => entry !== null);
  }

  removeSectionById(id: string): Widget | null {
    const widget = this._sections.get(id) ?? null;
    if (widget) {
      widget.parent = null;
      this._onMoved(id, true);
    }
    return widget;
  }

  reinsertSection(widget: Widget): void {
    this.addWidget(widget);
    this._onMoved(widget.id, false);
  }

  private _entry(widget: Widget): ISectionEntry | null {
    const panel = this.accordionPanel;
    const index = panel.widgets.indexOf(widget);
    return index >= 0
      ? { id: widget.id, titleNode: panel.titles[index], widget }
      : null;
  }

  private _sections = new Map<string, Widget>();
  private _sectionAdded = new Signal<this, ISectionEntry>(this);
  private _onMoved: (id: string, moved: boolean) => void;
}

export namespace EpiSidePanel {
  export interface IOptions extends SidePanel.IOptions {
    /** Called when a section leaves the panel for another one, and when it comes back. */
    onMoved: (id: string, moved: boolean) => void;
  }
}
