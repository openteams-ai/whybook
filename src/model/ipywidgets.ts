import type * as WidgetManager from '@jupyter-widgets/jupyterlab-manager';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { INotebookModel } from '@jupyterlab/notebook';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';

/**
 * Draw widgets in the view as the notebook draws them: a tqdm bar from
 * tqdm.auto, an ipywidgets slider, an ipympl figure. The view's renderers are
 * a clone of JupyterLab's, which holds only a placeholder for widgets, so the
 * widget manager of the kernel is bound to the clone here, shared with a
 * notebook panel on the same kernel.
 *
 * The package comes from ipywidgets' own JupyterLab extension at run time,
 * and is not in the view's bundle. Without ipywidgets it is missing, and
 * widgets show as their text.
 */
export async function bindWidgetManager(
  context: DocumentRegistry.IContext<INotebookModel>,
  rendermime: IRenderMimeRegistry
): Promise<boolean> {
  let widgets: typeof WidgetManager;
  try {
    widgets = await import('@jupyter-widgets/jupyterlab-manager');
  } catch (error) {
    console.info('Widgets show as text: ipywidgets is not installed', error);
    return false;
  }
  // The disposable it returns would dispose the manager that a notebook
  // panel on the same kernel shares, so the view keeps it for the kernel.
  widgets.registerWidgetManager(context, rendermime, [][Symbol.iterator]());
  return true;
}
