import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { INotebookModel } from '@jupyterlab/notebook';
import type { Kernel } from '@jupyterlab/services';
import type { PartialJSONObject } from '@lumino/coreutils';
import { JSONExt } from '@lumino/coreutils';

/**
 * Keep the notebook's `kernelspec` and `language_info` in step with its
 * kernel, as JupyterLab's notebook panel does when its kernel connects. A
 * notebook made or opened in Whybook alone otherwise keeps the empty
 * kernelspec of a new notebook model, `{"name": "", "display_name": ""}`: it
 * opens again with a dialog that asks for a kernel, and tools that run a
 * notebook from its file, such as nbconvert, cannot tell which kernel to start.
 * A value is written only when it differs, so the notebook is not marked as
 * changed for nothing.
 */
export function followKernel(
  context: DocumentRegistry.IContext<INotebookModel>
): void {
  const sessionContext = context.sessionContext;
  const current = (kernel: Kernel.IKernelConnection) =>
    !context.isDisposed && sessionContext.session?.kernel === kernel;
  const update = async (
    kernel: Kernel.IKernelConnection | null | undefined
  ): Promise<void> => {
    if (!kernel || !current(kernel)) {
      return;
    }
    const spec = await kernel.spec;
    if (!current(kernel)) {
      return;
    }
    const kernelspec: PartialJSONObject = {
      name: kernel.name,
      display_name: spec?.display_name ?? kernel.name
    };
    if (spec?.language) {
      kernelspec.language = spec.language;
    }
    setIfChanged(context.model, 'kernelspec', kernelspec);
    const info = await kernel.info;
    if (!current(kernel) || !info?.language_info) {
      return;
    }
    setIfChanged(
      context.model,
      'language_info',
      info.language_info as unknown as PartialJSONObject
    );
  };
  sessionContext.kernelChanged.connect((_, change) => {
    void update(change.newValue);
  });
  void context.ready
    .then(() => sessionContext.ready)
    .then(() => update(sessionContext.session?.kernel));
}

function setIfChanged(
  model: INotebookModel,
  key: string,
  value: PartialJSONObject
): void {
  const before = model.getMetadata(key) as PartialJSONObject | undefined;
  if (!before || !JSONExt.deepEqual(before, value)) {
    model.setMetadata(key, value);
  }
}
