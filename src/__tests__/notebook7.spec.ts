/**
 * Whybook in Jupyter Notebook 7: a notebook's page shows Whybook in place of
 * the notebook editor and back, over one document; an edit page that opens a
 * notebook in Whybook sends the browser to the notebook's page; and
 * Whybook's side panels open and close with Whybook. The fake shell does
 * what NotebookShell of @jupyter-notebook/application does: its main area
 * holds one widget, and it adds none while it holds one.
 */
import './fakes/quiet';

import type { IRouter, JupyterFrontEnd } from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';
import { CommandRegistry } from '@lumino/commands';
import type {
  ReadonlyJSONObject,
  ReadonlyPartialJSONObject
} from '@lumino/coreutils';
import { Token } from '@lumino/coreutils';
import { MessageLoop } from '@lumino/messaging';
import { Signal } from '@lumino/signaling';
import { Panel, PanelLayout, StackedPanel, Widget } from '@lumino/widgets';
import { act } from 'react';

import { addContextMenus } from '../contextmenu';
import type { EpiModel, EpiSettings } from '../model/epimodel';
import {
  EditorSwitch,
  followMain,
  notebookPage,
  notebookPageUrl,
  openInPlace,
  openSettings,
  openSettingsFromAddress,
  redirectEditPage,
  showInMain,
  withFactory
} from '../notebook7';
import { CurrentModel, FollowingWidget } from '../widgets';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Area = 'main' | 'menu' | 'left' | 'right';

/**
 * A side area of Notebook 7's shell, as its SidePanelHandler: one widget
 * shows at a time, and the area starts hidden. `expand` shows the area
 * without clearing the flag that `hide` sets, and each widget that comes or
 * goes sets the area's visibility from that flag again.
 */
class SideAreaFake {
  constructor() {
    this.panel.addWidget(this._stack);
    this._stack.widgetRemoved.connect(() => this._refresh());
    this._refresh();
  }

  readonly panel = new Panel();

  get widgets(): readonly Widget[] {
    return this._stack.widgets;
  }

  add(widget: Widget): void {
    widget.parent = null;
    widget.hide();
    this._stack.addWidget(widget);
    this._refresh();
  }

  expand(id: string): void {
    this.panel.show();
    for (const widget of this._stack.widgets) {
      widget.setHidden(widget.id !== id);
    }
  }

  collapse(): void {
    for (const widget of this._stack.widgets) {
      widget.hide();
    }
    this.panel.hide();
  }

  show(): void {
    this._hiddenByUser = false;
    this._refresh();
  }

  hide(): void {
    this._hiddenByUser = true;
    this._refresh();
  }

  private _refresh(): void {
    this.panel.setHidden(this._hiddenByUser);
  }

  private _hiddenByUser = true;
  private _stack = new StackedPanel();
}

/** The parts of Jupyter Notebook 7's shell that Whybook uses. */
class NotebookShellFake extends Widget {
  constructor() {
    super();
    const layout = new PanelLayout();
    this.layout = layout;
    layout.addWidget(this._menu);
    layout.addWidget(this.leftHandler.panel);
    layout.addWidget(this._main);
    layout.addWidget(this.rightHandler.panel);
  }

  readonly leftHandler = new SideAreaFake();
  readonly rightHandler = new SideAreaFake();
  readonly activated: string[] = [];
  readonly collapsed: string[] = [];
  /** A widget that the main area does not take. */
  refused: Widget | null = null;

  get currentChanged(): Signal<this, { newValue: Widget | null }> {
    return this._currentChanged;
  }

  get currentWidget(): Widget | null {
    return this._main.widgets[0] ?? null;
  }

  add(widget: Widget, area: Area = 'main'): void {
    if (area === 'main') {
      if (widget === this.refused || this._main.widgets.length > 0) {
        return;
      }
      this._main.addWidget(widget);
      this._currentChanged.emit({ newValue: widget });
    } else if (area === 'menu') {
      this._menu.addWidget(widget);
    } else {
      this._side(area).add(widget);
    }
  }

  *widgets(area: Area = 'main'): IterableIterator<Widget> {
    yield* area === 'main'
      ? this._main.widgets
      : area === 'menu'
        ? this._menu.widgets
        : this._side(area).widgets;
  }

  getWidgetArea(id: string): Area | null {
    for (const area of ['main', 'menu', 'left', 'right'] as Area[]) {
      if (Array.from(this.widgets(area)).some(widget => widget.id === id)) {
        return area;
      }
    }
    return null;
  }

  activateById(id: string): void {
    this.activated.push(id);
    const area = this.getWidgetArea(id);
    if (area === 'left' || area === 'right') {
      this._side(area).expand(id);
    }
  }

  collapse(area: 'left' | 'right'): void {
    this.collapsed.push(area);
    this._side(area).collapse();
  }

  private _side(area: 'left' | 'right'): SideAreaFake {
    return area === 'left' ? this.leftHandler : this.rightHandler;
  }

  private _main = new Panel();
  private _menu = new Panel();
  private _currentChanged = new Signal<this, { newValue: Widget | null }>(this);
}

function named(id: string): Widget {
  const widget = new Widget();
  widget.id = id;
  return widget;
}

/** A shell on the page, with the notebook editor in its main area. */
function notebookPageShell() {
  const shell = new NotebookShellFake();
  Widget.attach(shell, document.body);
  const editor = named('editor');
  shell.add(editor);
  return { shell, editor, ishell: shell as unknown as JupyterFrontEnd.IShell };
}

/** Jupyter Notebook 7's Trusted indicator, in the menu bar. */
function trustedIndicator(): Widget {
  const widget = new Widget();
  const status = document.createElement('div');
  status.className = 'jp-NotebookTrustedStatus';
  widget.node.appendChild(status);
  return widget;
}

afterEach(() => {
  document.body.innerHTML = '';
  PageConfig.setOption('notebookPage', '');
  history.replaceState(null, '', '/');
});

describe('The page of Jupyter Notebook 7', () => {
  it('is the option that Notebook 7 writes in its pages, and none in JupyterLab', () => {
    expect(notebookPage()).toBe('');
    PageConfig.setOption('notebookPage', 'notebooks');
    expect(notebookPage()).toBe('notebooks');
  });
});

describe('The address of a page', () => {
  it('names the widget factory of its document, or leaves it out for the default one', () => {
    const page = 'http://localhost:8936/notebooks/a%20b/cohort.ipynb';
    expect(withFactory(page, 'Whybook')).toBe(`${page}?factory=Whybook`);
    expect(withFactory(`${page}?factory=Whybook`, null)).toBe(page);
    expect(withFactory(`${page}?kernel=x&factory=Whybook#cell`, null)).toBe(
      `${page}?kernel=x#cell`
    );
  });

  it("of an edit page that opens a notebook gives the notebook's page, with its query", () => {
    const base = 'http://localhost:8936/user/me/';
    expect(
      notebookPageUrl(`${base}edit/a%20b/cohort.ipynb?factory=Whybook#x`, base)
    ).toBe(`${base}notebooks/a%20b/cohort.ipynb?factory=Whybook#x`);
    expect(notebookPageUrl(`${base}notebooks/cohort.ipynb`, base)).toBeNull();
    expect(
      notebookPageUrl(`${base}lab/tree/edit/cohort.ipynb`, base)
    ).toBeNull();
    expect(
      notebookPageUrl(
        'http://localhost:8936/edit/cohort.ipynb?factory=Whybook',
        base
      )
    ).toBeNull();
  });
});

describe('Whybook in place of the notebook editor', () => {
  it('shows a widget in the main area, and the editor stays open off the page', () => {
    const { shell, editor, ishell } = notebookPageShell();
    const changes: (Widget | null)[] = [];
    shell.currentChanged.connect((_, args) => changes.push(args.newValue));
    const whybook = named('whybook');

    expect(showInMain(ishell, whybook)).toBe(true);
    expect(shell.currentWidget).toBe(whybook);
    expect(editor.isDisposed).toBe(false);
    expect(editor.isAttached).toBe(false);
    expect(changes).toEqual([whybook]);
    expect(shell.activated).toEqual(['whybook']);

    // And back: the same editor comes back, and Whybook stays open.
    expect(showInMain(ishell, editor)).toBe(true);
    expect(shell.currentWidget).toBe(editor);
    expect(whybook.isDisposed).toBe(false);
    expect(changes).toEqual([whybook, editor]);
  });

  it('does nothing for the widget that shows', () => {
    const { shell, editor, ishell } = notebookPageShell();
    const changes: unknown[] = [];
    shell.currentChanged.connect(() => changes.push(1));
    expect(showInMain(ishell, editor)).toBe(true);
    expect(changes).toEqual([]);
  });

  it('puts the editor back when the shell does not take the widget', () => {
    const { shell, editor, ishell } = notebookPageShell();
    const whybook = named('whybook');
    shell.refused = whybook;
    expect(showInMain(ishell, whybook)).toBe(false);
    expect(shell.currentWidget).toBe(editor);
    shell.refused = null;
    expect(showInMain(ishell, whybook)).toBe(true);
    expect(shell.currentWidget).toBe(whybook);
  });

  it("takes Notebook 7's Trusted indicator out of the menu bar, which Notebook adds again for the editor", () => {
    const { shell, ishell } = notebookPageShell();
    const trusted = trustedIndicator();
    const other = named('kernel-status');
    shell.add(trusted, 'menu');
    shell.add(other, 'menu');
    showInMain(ishell, named('whybook'));
    expect(trusted.isDisposed).toBe(true);
    expect(other.isDisposed).toBe(false);
  });
});

describe('Opening the notebook in place', () => {
  /** A command registry whose docmanager:open gives the widgets of a map. */
  function opener(widgets: Record<string, Widget | undefined>) {
    const commands = new CommandRegistry();
    const calls: unknown[] = [];
    commands.addCommand('docmanager:open', {
      execute: args => {
        calls.push(args);
        return widgets[args.factory as string];
      }
    });
    return { commands, calls };
  }
  const docRegistry = {
    defaultWidgetFactory: () => ({ name: 'Notebook' })
  } as unknown as JupyterFrontEnd['docRegistry'];

  it('opens the document with the factory on this page, shows it, and writes the factory in the address', async () => {
    const { shell, editor, ishell } = notebookPageShell();
    const whybook = named('whybook');
    const { commands, calls } = opener({ Whybook: whybook, Notebook: editor });
    history.replaceState(null, '', '/notebooks/cohort.ipynb');
    const app = { commands, shell: ishell, docRegistry };

    expect(await openInPlace(app, 'cohort.ipynb', 'Whybook')).toBe(whybook);
    expect(calls).toEqual([
      {
        path: 'cohort.ipynb',
        factory: 'Whybook',
        options: { ref: '_noref' }
      }
    ]);
    expect(shell.currentWidget).toBe(whybook);
    expect(window.location.href).toBe(
      'http://localhost/notebooks/cohort.ipynb?factory=Whybook'
    );

    // The notebook editor, the default factory, leaves no factory in the address.
    expect(await openInPlace(app, 'cohort.ipynb', 'Notebook')).toBe(editor);
    expect(shell.currentWidget).toBe(editor);
    expect(window.location.href).toBe(
      'http://localhost/notebooks/cohort.ipynb'
    );
  });

  it('leaves the page as it was when the document manager gives no widget', async () => {
    const { shell, editor, ishell } = notebookPageShell();
    const { commands, calls } = opener({});
    history.replaceState(null, '', '/notebooks/cohort.ipynb');
    const app = { commands, shell: ishell, docRegistry };
    expect(await openInPlace(app, 'cohort.ipynb', 'Whybook')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(shell.currentWidget).toBe(editor);
    expect(window.location.href).toBe(
      'http://localhost/notebooks/cohort.ipynb'
    );
  });
});

describe("Whybook's side panels in Notebook 7", () => {
  function withPanels() {
    const page = notebookPageShell();
    const variables = named('epi-variables');
    const toc = named('table-of-contents');
    const exploration = named('epi-exploration');
    page.shell.add(variables, 'left');
    page.shell.add(toc, 'left');
    page.shell.add(exploration, 'right');
    const whybook = named('whybook');
    const update = followMain(page.ishell, widget => widget === whybook, [
      variables,
      exploration
    ]);
    return { ...page, variables, toc, exploration, whybook, update };
  }

  it('open when Whybook shows, and the main area keeps the focus', () => {
    const { shell, ishell, variables, exploration, whybook } = withPanels();
    showInMain(ishell, whybook);
    expect(variables.isVisible).toBe(true);
    expect(exploration.isVisible).toBe(true);
    const { activated } = shell;
    expect(activated[activated.length - 1]).toBe('whybook');
    expect(activated.indexOf('epi-variables')).toBeLessThan(
      activated.indexOf('whybook')
    );
    expect(activated.indexOf('epi-exploration')).toBeLessThan(
      activated.indexOf('whybook')
    );
  });

  it('close when the notebook editor comes back, and leave another panel open', () => {
    const { shell, ishell, editor, variables, exploration, whybook, toc } =
      withPanels();
    showInMain(ishell, whybook);
    // The user shows the table of contents in the left area.
    shell.activateById(toc.id);
    showInMain(ishell, editor);
    expect(exploration.isVisible).toBe(false);
    expect(variables.isVisible).toBe(false);
    expect(toc.isVisible).toBe(true);
    expect(shell.collapsed).toEqual(['right']);
  });

  it('stay open when a widget leaves their side area, as the command palette does as the page starts', () => {
    const { shell, ishell, variables, whybook } = withPanels();
    const palette = named('command-palette');
    shell.add(palette, 'left');
    showInMain(ishell, whybook);
    palette.parent = null;
    expect(variables.isVisible).toBe(true);
  });

  it('stay closed when Notebook adds its Notebook Tools to the right area for the editor', () => {
    const { shell, ishell, editor, exploration, whybook } = withPanels();
    showInMain(ishell, whybook);
    showInMain(ishell, editor);
    const tools = named('notebook-tools');
    shell.add(tools, 'right');
    expect(shell.rightHandler.panel.isVisible).toBe(false);
    expect(exploration.isVisible).toBe(false);
  });

  it('leave out a panel that the layout keeps in the view', () => {
    const { shell, ishell, exploration, whybook } = withPanels();
    exploration.parent = null;
    showInMain(ishell, whybook);
    expect(shell.activated).toContain('epi-variables');
    expect(shell.activated).not.toContain('epi-exploration');
  });

  it('follow a page that opens with Whybook, once the panels are placed', () => {
    const { shell, update, variables, whybook, ishell } = withPanels();
    variables.parent = null;
    showInMain(ishell, whybook);
    shell.add(variables, 'left');
    update();
    expect(variables.isVisible).toBe(true);
  });
});

describe('An edit page that opens a notebook in Whybook', () => {
  function routerFake() {
    const rules: IRouter.IRegisterOptions[] = [];
    const stop = new Token<void>('whybook-test:stop');
    const router = {
      stop,
      register: (options: IRouter.IRegisterOptions) => {
        rules.push(options);
        return { isDisposed: false, dispose: () => undefined };
      }
    } as unknown as IRouter;
    return { router, rules, stop };
  }

  it("sends the browser to the notebook's page before Notebook opens the document there", async () => {
    const { router, rules, stop } = routerFake();
    const commands = new CommandRegistry();
    const visited: string[] = [];
    redirectEditPage(router, commands, 'Whybook', {
      base: 'http://localhost/',
      navigate: url => visited.push(url)
    });
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    // Before Notebook 7's own rule, of rank 100, which opens the document.
    expect(rule.rank).toBeLessThan(100);
    const matches = (request: string) => !!request.match(rule.pattern);
    expect(matches('/edit/a%20b/cohort.ipynb?factory=Whybook')).toBe(true);
    expect(matches('/edit/cohort.ipynb?x=1&factory=Whybook#top')).toBe(true);
    expect(matches('/edit/cohort.ipynb')).toBe(false);
    expect(matches('/edit/prep.py?factory=Editor')).toBe(false);
    expect(matches('/edit/cohort.ipynb?factory=WhybookPlus')).toBe(false);
    expect(matches('/notebooks/cohort.ipynb?factory=Whybook')).toBe(false);

    history.replaceState(null, '', '/edit/a%20b/cohort.ipynb?factory=Whybook');
    expect(await commands.execute(rule.command)).toBe(stop);
    expect(visited).toEqual([
      'http://localhost/notebooks/a%20b/cohort.ipynb?factory=Whybook'
    ]);
  });
});

describe('A side panel without a Whybook view', () => {
  it('shows the text that it is given', async () => {
    const panel = new FollowingWidget(
      new CurrentModel(),
      () => document.createElement('div') as unknown as JSX.Element,
      'Open the notebook in Whybook from its toolbar.'
    );
    await act(async () => {
      Widget.attach(panel, document.body);
      MessageLoop.sendMessage(panel, Widget.Msg.UpdateRequest);
    });
    expect(panel.node.textContent).toBe(
      'Open the notebook in Whybook from its toolbar.'
    );
  });
});

describe('Show in the notebook, from the menu of a cell', () => {
  /** The context menu over the card of cell b, in a view of cohort.ipynb. */
  function menuOverCell(openNotebook?: (path: string) => Promise<unknown>) {
    const commands = new CommandRegistry();
    const node = document.createElement('div');
    node.dataset.cellId = 'b';
    const app = {
      commands,
      contextMenu: { addItem: () => undefined },
      contextMenuHitTest: (test: (node: HTMLElement) => boolean) =>
        test(node) ? node : undefined
    } as unknown as JupyterFrontEnd;
    const model = { context: { path: 'cohort.ipynb' } } as EpiModel;
    addContextMenus(app, () => model, {} as EpiSettings, openNotebook);
    const scrolled: number[] = [];
    const panel = {
      context: { ready: Promise.resolve() },
      content: {
        widgets: [{ model: { id: 'a' } }, { model: { id: 'b' } }],
        activeCellIndex: 0,
        scrollToItem: async (index: number) => {
          scrolled.push(index);
        }
      }
    };
    return { commands, panel, scrolled };
  }

  it('opens the notebook with the opener that it is given, at the cell', async () => {
    const opened: string[] = [];
    const { commands, panel, scrolled } = menuOverCell(async path => {
      opened.push(path);
      return panel;
    });
    await commands.execute('whybook:show-cell-in-notebook');
    expect(opened).toEqual(['cohort.ipynb']);
    expect(panel.content.activeCellIndex).toBe(1);
    expect(scrolled).toEqual([1]);
  });

  it('opens the notebook view of the document manager by default, as in JupyterLab', async () => {
    const { commands, panel, scrolled } = menuOverCell();
    const calls: unknown[] = [];
    commands.addCommand('docmanager:open', {
      execute: args => {
        calls.push(args);
        return panel as unknown as ReadonlyJSONObject;
      }
    });
    await commands.execute('whybook:show-cell-in-notebook');
    expect(calls).toEqual([{ path: 'cohort.ipynb', factory: 'Notebook' }]);
    expect(scrolled).toEqual([1]);
  });
});

describe("The switch in Notebook 7's menu bar", () => {
  /** A switch over the page's shell, whose commands record their runs. */
  async function withSwitch() {
    const page = notebookPageShell();
    const whybook = named('whybook');
    const commands = new CommandRegistry();
    const runs: string[] = [];
    for (const id of ['whybook:open-epinotebook', 'whybook:open-notebook']) {
      commands.addCommand(id, { execute: () => void runs.push(id) });
    }
    const toggle = new EditorSwitch({
      shell: page.ishell,
      commands,
      isWhybook: widget => widget === whybook,
      toWhybook: 'whybook:open-epinotebook',
      toNotebook: 'whybook:open-notebook'
    });
    await act(async () => {
      page.shell.add(toggle, 'menu');
    });
    const segment = (value: string) =>
      toggle.node.querySelector(`[data-value="${value}"]`) as HTMLElement;
    return { ...page, whybook, toggle, runs, segment };
  }

  it('shows the notebook editor while the editor is in the main area, and Whybook while Whybook is', async () => {
    const { ishell, whybook, segment } = await withSwitch();
    expect(segment('notebook').getAttribute('aria-checked')).toBe('true');
    expect(segment('whybook').getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      showInMain(ishell, whybook);
    });
    expect(segment('whybook').getAttribute('aria-checked')).toBe('true');
  });

  it('runs the command of the other one, and none for the one that shows', async () => {
    const { runs, segment } = await withSwitch();
    await act(async () => {
      segment('notebook').click();
    });
    expect(runs).toEqual([]);
    await act(async () => {
      segment('whybook').click();
    });
    expect(runs).toEqual(['whybook:open-epinotebook']);
  });
});

describe("Whybook's settings in Notebook 7", () => {
  const base = 'http://localhost:8888/';

  /** A command registry with the settings editor's command, and the arguments of its calls. */
  function withSettingEditor() {
    const commands = new CommandRegistry();
    const calls: ReadonlyPartialJSONObject[] = [];
    commands.addCommand('settingeditor:open', {
      execute: args => {
        calls.push(args);
      }
    });
    return { commands, calls };
  }

  it('open in the settings editor where the page has one, as in JupyterLab', () => {
    const { commands, calls } = withSettingEditor();
    const opened: string[] = [];
    openSettings(commands, base, url => opened.push(url));
    expect(calls).toEqual([{ query: 'Whybook' }]);
    expect(opened).toEqual([]);
  });

  it("open the files page in a new tab from a notebook's page, which has no settings editor", () => {
    PageConfig.setOption('notebookPage', 'notebooks');
    const opened: string[] = [];
    openSettings(new CommandRegistry(), base, url => opened.push(url));
    expect(opened).toEqual(['http://localhost:8888/tree?whybook-settings']);
  });

  it('open no page in JupyterLab when its settings editor is disabled', () => {
    const opened: string[] = [];
    openSettings(new CommandRegistry(), base, url => opened.push(url));
    expect(opened).toEqual([]);
  });

  it('open on the files page when its address asks, and take the query out of the address', async () => {
    const { commands, calls } = withSettingEditor();
    history.replaceState(null, '', '/tree?whybook-settings&path=data#top');
    const opened = await openSettingsFromAddress({
      commands,
      restored: Promise.resolve()
    });
    expect(opened).toBe(true);
    expect(calls).toEqual([{ query: 'Whybook' }]);
    const { pathname, search, hash } = window.location;
    expect(`${pathname}${search}${hash}`).toBe('/tree?path=data#top');
  });

  it('leave the files page as it is when its address does not ask', async () => {
    const { commands, calls } = withSettingEditor();
    history.replaceState(null, '', '/tree');
    const opened = await openSettingsFromAddress({
      commands,
      restored: Promise.resolve()
    });
    expect(opened).toBe(false);
    expect(calls).toEqual([]);
    expect(window.location.pathname + window.location.search).toBe('/tree');
  });
});
