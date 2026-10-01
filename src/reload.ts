import type { JupyterFrontEnd } from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';
import { DocumentWidget } from '@jupyterlab/docregistry';
import type { Widget } from '@lumino/widgets';

/** How long after the layout is restored the page may still open the file of its URL. */
const ROUTE_WAIT = 10000;
/** How long the copy may take to draw its cells before it closes anyway. */
const COPY_WAIT = 30000;

/** What a command execution reports, as the command registry emits it. */
interface IExecuted {
  id: string;
  args: { path?: unknown; factory?: unknown };
  result: Promise<unknown>;
}

/**
 * A reload of the page opens the file of its URL, /lab/tree/<path>, in the
 * file's default view. JupyterLab writes the path of the current document
 * there, a Whybook view's too, so each reload opened the notebook of the
 * current Whybook view a second time, in JupyterLab's notebook view, and
 * showed that tab in place of the view.
 *
 * This closes that second tab and shows the Whybook view again. When the
 * layout that the page restores had the file open in the notebook view too,
 * the reload opened a second notebook view beside it, and that one closes.
 */
export function closeReloadCopy(
  app: JupyterFrontEnd,
  factory: string,
  findView: (path: string) => Widget | undefined,
  treePath: string = PageConfig.getOption('treePath')
): void {
  if (!treePath) {
    return;
  }
  // The layout restorer opens each widget it restores with its factory, and
  // the URL's route opens the file with none.
  let otherView = false;
  let routed: Promise<unknown> | null = null;
  let noticeRoute: () => void = () => undefined;
  const watch = (_: unknown, executed: IExecuted) => {
    if (executed.id !== 'docmanager:open' || executed.args.path !== treePath) {
      return;
    }
    if (!executed.args.factory) {
      routed = routed ?? executed.result;
      noticeRoute();
    } else if (executed.args.factory !== factory) {
      otherView = true;
    }
  };
  // The registry's own type of its arguments is looser than this one.
  const signal = app.commands.commandExecuted as unknown as {
    connect: (slot: typeof watch) => void;
    disconnect: (slot: typeof watch) => void;
  };
  signal.connect(watch);
  void app.restored
    .then(async () => {
      // The widget that the layout made current, before the route's copy.
      const shown = app.shell.currentWidget;
      if (!routed) {
        await new Promise<void>(resolve => {
          noticeRoute = resolve;
          window.setTimeout(resolve, ROUTE_WAIT);
        });
      }
      signal.disconnect(watch);
      const view = findView(treePath);
      if (!routed || !view) {
        return;
      }
      const opened = await routed;
      if (
        !(opened instanceof DocumentWidget) ||
        opened === view ||
        opened.context.path !== treePath
      ) {
        return;
      }
      // The widget that already shows what the reload opened: the Whybook
      // view, or a notebook view that the layout restored.
      const twin = otherView
        ? Array.from(app.shell.widgets('main')).find(
            widget =>
              widget !== opened &&
              widget instanceof DocumentWidget &&
              widget.context.path === treePath &&
              widget.constructor === opened.constructor
          )
        : view;
      if (twin) {
        // The widget that was current shows at once. The copy closes once its
        // cells are drawn: JupyterLab's notebook keeps drawing them while the
        // browser is idle, and throws when it has closed in the meantime.
        app.shell.activateById(
          shown && shown !== opened && !shown.isDisposed ? shown.id : view.id
        );
        await opened.revealed;
        const started = Date.now();
        const drawn = () =>
          (
            (opened.content as { widgets?: { isPlaceholder(): boolean }[] })
              .widgets ?? []
          ).every(cell => !cell.isPlaceholder());
        const close = () => {
          if (opened.isDisposed) {
            return;
          }
          if (drawn() || Date.now() - started > COPY_WAIT) {
            window.setTimeout(() => opened.close(), 500);
          } else {
            window.setTimeout(close, 250);
          }
        };
        close();
      }
    })
    .catch(reason => {
      signal.disconnect(watch);
      console.warn(
        'Could not check the notebook that the reload opened',
        reason
      );
    });
}
