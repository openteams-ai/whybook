/**
 * Whybook in Jupyter Notebook 7.
 *
 * Notebook 7 runs JupyterLab's extensions on pages of one document each:
 * /tree for the files, /notebooks/<path> for a notebook, /edit/<path> for
 * another file. The main area of a page holds one widget, and the shell
 * adds no second one (`NotebookShell.add` in @jupyter-notebook/application).
 * Notebook's document manager opens a document in a new browser tab, unless
 * the call passes `ref: '_noref'` (@jupyter-notebook/docmanager-extension).
 *
 * A notebook's page shows Whybook in place of the notebook editor, and the
 * editor in place of Whybook, over one document context: the two share the
 * notebook's model and its kernel, as Whybook and the notebook editor do in
 * JupyterLab. Two browser tabs on one notebook have two models, and the save
 * of each tab overwrites the other's.
 */
import type { IRouter, JupyterFrontEnd } from '@jupyterlab/application';
import { PageConfig, URLExt } from '@jupyterlab/coreutils';
import { ReactWidget } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import type { IDisposable } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';
import * as React from 'react';

import { Segmented } from './ui/segmented';

/** The query parameter of a page's address that names its document's widget factory. */
const FACTORY_PARAM = 'factory';

/**
 * The class of the Trusted indicator, which Notebook 7 adds to its menu bar
 * each time a notebook editor comes into the main area
 * (@jupyter-notebook/notebook-extension:trusted).
 */
const TRUSTED_CLASS = 'jp-NotebookTrustedStatus';

/** The command that sends an edit page to the notebook's page. */
const TO_NOTEBOOK_PAGE = 'whybook:open-on-notebook-page';

/**
 * The rank of the rule that sends an edit page to the notebook's page:
 * before Notebook 7's rule, of the default rank 100, which opens the page's
 * document.
 */
const REDIRECT_RANK = 10;

/**
 * A side area of Notebook 7's shell (`SidePanelHandler`). It keeps a flag of
 * whether the user closed it, which `hide` sets and `show` clears. Each
 * widget that comes to the area or leaves it shows or hides the area by that
 * flag again, also after the shell expanded or collapsed the area.
 */
interface ISideArea {
  show(): void;
  hide(): void;
}

/** The parts of Notebook 7's shell that are not in JupyterLab's interface of a shell. */
interface ISidedShell {
  getWidgetArea?(id: string): string | null;
  collapse?(area: string): void;
  readonly leftHandler?: ISideArea;
  readonly rightHandler?: ISideArea;
}

/**
 * The page of Notebook 7 that runs Whybook: `tree`, `notebooks`, `edit`,
 * `consoles` or `terminals`. JupyterLab has no such pages, and this is ''
 * there.
 */
export function notebookPage(): string {
  return PageConfig.getOption('notebookPage');
}

/**
 * A page's address with the widget factory of its document in the query, or
 * without it for the default factory (null). Notebook 7 opens the document
 * of a page with the factory that the query names.
 */
export function withFactory(href: string, factory: string | null): string {
  const url = new URL(href);
  if (factory) {
    url.searchParams.set(FACTORY_PARAM, factory);
  } else {
    url.searchParams.delete(FACTORY_PARAM);
  }
  return url.href;
}

/**
 * The address of a notebook's page for the address of its edit page under
 * `base`: <base>edit/<path>?<query> gives <base>notebooks/<path>?<query>.
 * Null for any other address.
 */
export function notebookPageUrl(href: string, base: string): string | null {
  const edit = `${base}edit/`;
  return href.startsWith(edit)
    ? `${base}notebooks/${href.slice(edit.length)}`
    : null;
}

/**
 * Show a widget in the main area of Notebook 7, in place of the widget
 * there. That widget leaves the page and stays open, so that it can come
 * back. The Trusted indicator of the menu bar goes too: Notebook adds it
 * again when a notebook editor comes back, and would add a second one.
 * True when the widget shows.
 */
export function showInMain(
  shell: JupyterFrontEnd.IShell,
  widget: Widget
): boolean {
  const shown = shell.currentWidget;
  if (shown === widget) {
    return true;
  }
  const trusted = Array.from(shell.widgets('menu')).filter(
    item => !!item.node.querySelector(`.${TRUSTED_CLASS}`)
  );
  if (shown) {
    shown.parent = null;
  }
  shell.add(widget, 'main');
  if (!widget.isAttached) {
    if (shown && !shown.isDisposed) {
      shell.add(shown, 'main');
    }
    return false;
  }
  for (const item of trusted) {
    item.dispose();
  }
  shell.activateById(widget.id);
  return true;
}

/**
 * Open a document with a widget factory on this page of Notebook 7, in
 * place of the widget in the main area, and write the factory in the page's
 * address, so that a reload shows the same. The document manager finds the
 * widget of the factory that is open, or makes one over the document's
 * context. Null when it gives none.
 */
export async function openInPlace(
  app: Pick<JupyterFrontEnd, 'commands' | 'shell' | 'docRegistry'>,
  path: string,
  factory: string
): Promise<Widget | null> {
  const widget = (await app.commands.execute('docmanager:open', {
    path,
    factory,
    options: { ref: '_noref' }
  })) as Widget | undefined;
  if (!widget || widget.isDisposed || !showInMain(app.shell, widget)) {
    return null;
  }
  const fallback = app.docRegistry.defaultWidgetFactory(path)?.name;
  window.history.replaceState(
    window.history.state,
    '',
    withFactory(window.location.href, factory === fallback ? null : factory)
  );
  return widget;
}

/**
 * Open Whybook's side panels when Whybook shows in the main area of
 * Notebook 7, and close them when another widget, such as the notebook
 * editor, shows there. Notebook's side areas start closed, and show one
 * widget at a time. The flag of the user's choice changes with the area:
 * JupyterLab's command palette leaves the left area as the page starts, and
 * Notebook adds its Notebook Tools to the right area each time the editor
 * shows, and each of these sets the area's visibility from the flag again.
 * The main area keeps the focus. A panel in no side area, as when the
 * layout keeps it in the view, stays where it is. Returns the update, for a
 * page whose panels are placed after its first widget shows.
 */
export function followMain(
  shell: JupyterFrontEnd.IShell,
  isWhybook: (widget: Widget | null) => boolean,
  panels: Widget[]
): () => void {
  const sided = shell as JupyterFrontEnd.IShell & ISidedShell;
  const sideArea = (area: string | null | undefined) =>
    area === 'left'
      ? sided.leftHandler
      : area === 'right'
        ? sided.rightHandler
        : undefined;
  const update = () => {
    const main = shell.currentWidget;
    const whybook = isWhybook(main);
    for (const panel of panels) {
      if (!panel.isAttached) {
        continue;
      }
      const area = sided.getWidgetArea?.(panel.id);
      if (whybook) {
        sideArea(area)?.show();
        shell.activateById(panel.id);
      } else if (panel.isVisible && area) {
        sided.collapse?.(area);
        sideArea(area)?.hide();
      }
    }
    if (whybook && main) {
      shell.activateById(main.id);
    }
  };
  shell.currentChanged?.connect(update);
  return update;
}

/**
 * The switch between the notebook editor and Whybook on a notebook's page of
 * Notebook 7. It shows which of the two is in the main area, and a click on
 * the other runs the command that shows it there. It sits in the menu bar,
 * which keeps its items in the order of their ranks. A toolbar takes its
 * items from the settings after the document opens, and moves its last
 * items into its overflow menu.
 */
export class EditorSwitch extends ReactWidget {
  constructor(private _options: EditorSwitch.IOptions) {
    super();
    this.addClass('jp-Epi-editorswitch');
    _options.shell.currentChanged?.connect(this._onCurrentChanged, this);
  }

  render(): JSX.Element {
    const { shell, commands, isWhybook, toWhybook, toNotebook } = this._options;
    const shown = isWhybook(shell.currentWidget) ? 'whybook' : 'notebook';
    return React.createElement(Segmented<'notebook' | 'whybook'>, {
      label: 'Show the notebook in',
      value: shown,
      options: [
        {
          value: 'notebook',
          label: 'Notebook',
          title: "Show the notebook in Jupyter Notebook's editor"
        },
        {
          value: 'whybook',
          label: 'Whybook',
          title: 'Show the notebook in Whybook'
        }
      ],
      onChange: value => {
        if (value !== shown) {
          void commands.execute(value === 'whybook' ? toWhybook : toNotebook);
        }
      }
    });
  }

  dispose(): void {
    this._options.shell.currentChanged?.disconnect(
      this._onCurrentChanged,
      this
    );
    super.dispose();
  }

  private _onCurrentChanged(): void {
    this.update();
  }
}

export namespace EditorSwitch {
  export interface IOptions {
    shell: JupyterFrontEnd.IShell;
    commands: CommandRegistry;
    /** Whether a widget of the main area is a Whybook view. */
    isWhybook: (widget: Widget | null) => boolean;
    /** The command that shows Whybook in place of the editor. */
    toWhybook: string;
    /** The command that shows the editor in place of Whybook. */
    toNotebook: string;
  }
}

/**
 * Send an edit page of Notebook 7 that opens a notebook with a factory to
 * the notebook's page, before Notebook opens the document there. Notebook
 * opens a document in a new tab at /edit/<path>?factory=<name>, for a factory
 * whose name does not hold "Notebook": the file browser's Open With, and
 * File › New. An edit page has no Kernel and Run menus, and no notebook
 * editor to come back to. The notebook's page opens the notebook with the
 * same factory. `base` is the server's base URL.
 */
export function redirectEditPage(
  router: IRouter,
  commands: CommandRegistry,
  factory: string,
  options: { base: string; navigate?: (url: string) => void }
): IDisposable {
  const { base } = options;
  const navigate =
    options.navigate ?? ((url: string) => window.location.replace(url));
  const command = commands.addCommand(TO_NOTEBOOK_PAGE, {
    label: "Open on the notebook's page",
    describedBy: { args: { type: 'object', properties: {} } },
    execute: () => {
      const url = notebookPageUrl(window.location.href, base);
      if (!url) {
        return;
      }
      navigate(url);
      return router.stop;
    }
  });
  const escaped = encodeURIComponent(factory).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );
  const rule = router.register({
    command: TO_NOTEBOOK_PAGE,
    pattern: new RegExp(
      `^/edit/[^?#]+\\.ipynb\\?(?:[^#]*&)?${FACTORY_PARAM}=${escaped}(?:[&#]|$)`
    ),
    rank: REDIRECT_RANK
  });
  return {
    get isDisposed() {
      return command.isDisposed && rule.isDisposed;
    },
    dispose: () => {
      rule.dispose();
      command.dispose();
    }
  };
}

/** The command that opens JupyterLab's settings editor, on Notebook 7's files page alone. */
const SETTINGS_COMMAND = 'settingeditor:open';

/** The query parameter of the files page's address that opens Whybook's settings there. */
const SETTINGS_PARAM = 'whybook-settings';

/** The address of Notebook 7's files page that opens Whybook's settings. `base` is the server's base URL. */
export function settingsPageUrl(base: string): string {
  return `${URLExt.join(base, 'tree')}?${SETTINGS_PARAM}`;
}

/**
 * Open the settings editor at Whybook's settings. Notebook 7 has the
 * editor on its files page alone (@jupyter-notebook/tree-extension), and no
 * address opens it there: on another page, the files page opens in a new
 * tab, with a query that `openSettingsFromAddress` reads.
 */
export function openSettings(
  commands: CommandRegistry,
  base: string,
  open: (url: string) => void = url => void window.open(url, '_blank')
): void {
  if (commands.hasCommand(SETTINGS_COMMAND)) {
    void commands.execute(SETTINGS_COMMAND, { query: 'Whybook' });
  } else if (notebookPage()) {
    open(settingsPageUrl(base));
  }
}

/**
 * On Notebook 7's files page, open the settings editor at Whybook's settings
 * when the page's address asks for them, and take the query out of the
 * address, so that a reload shows the files. Whether the editor opened.
 */
export async function openSettingsFromAddress(
  app: Pick<JupyterFrontEnd, 'commands' | 'restored'>,
  location: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
  history: Pick<History, 'state' | 'replaceState'> = window.history
): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  if (!params.has(SETTINGS_PARAM)) {
    return false;
  }
  params.delete(SETTINGS_PARAM);
  const search = params.toString();
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${search ? `?${search}` : ''}${location.hash}`
  );
  await app.restored;
  if (!app.commands.hasCommand(SETTINGS_COMMAND)) {
    return false;
  }
  await app.commands.execute(SETTINGS_COMMAND, { query: 'Whybook' });
  return true;
}
