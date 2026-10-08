/**
 * The notebook's kernelspec and language_info follow its kernel
 * (src/model/kernelmeta.ts), as JupyterLab's notebook panel writes them. A
 * notebook made in Whybook was saved with the empty kernelspec of a new
 * model, and asked for a kernel when it opened again. No kernel starts.
 */
import './fakes/quiet';

import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { INotebookModel } from '@jupyterlab/notebook';
import { NotebookModel } from '@jupyterlab/notebook';
import { Signal } from '@lumino/signaling';

import { followKernel } from '../model/kernelmeta';

interface IFakeKernel {
  name: string;
  spec: Promise<{ display_name: string; language: string }>;
  info: Promise<{ language_info: { name: string; version: string } }>;
}

function kernel(name: string, display: string, language: string): IFakeKernel {
  return {
    name,
    spec: Promise.resolve({ display_name: display, language }),
    info: Promise.resolve({
      language_info: { name: language.toLowerCase(), version: '1.0' }
    })
  };
}

function setup(start: IFakeKernel) {
  const model = new NotebookModel();
  const session = { kernel: start as IFakeKernel | null };
  const kernelChanged = new Signal<
    unknown,
    { newValue: IFakeKernel | null; oldValue: IFakeKernel | null }
  >({});
  const context = {
    model,
    isDisposed: false,
    ready: Promise.resolve(),
    sessionContext: { session, kernelChanged, ready: Promise.resolve() }
  };
  followKernel(context as unknown as DocumentRegistry.IContext<INotebookModel>);
  return { model, session, kernelChanged };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the kernelspec of a notebook in Whybook', () => {
  it('starts out empty in a new notebook model', () => {
    // What every notebook made in Whybook was saved with.
    expect(new NotebookModel().getMetadata('kernelspec')).toEqual({
      name: '',
      display_name: ''
    });
  });

  it('takes the name, display name and language of the kernel that starts', async () => {
    const { model } = setup(
      kernel('python3', 'Python 3 (ipykernel)', 'python')
    );
    await flush();
    expect(model.getMetadata('kernelspec')).toEqual({
      name: 'python3',
      display_name: 'Python 3 (ipykernel)',
      language: 'python'
    });
    expect(model.getMetadata('language_info')).toEqual({
      name: 'python',
      version: '1.0'
    });
  });

  it('follows a change of kernel', async () => {
    const { model, session, kernelChanged } = setup(
      kernel('python3', 'Python 3 (ipykernel)', 'python')
    );
    await flush();
    const r = kernel('xr', 'R 4.4.3 (xr)', 'R');
    const before = session.kernel;
    session.kernel = r;
    kernelChanged.emit({ newValue: r, oldValue: before });
    await flush();
    expect(model.getMetadata('kernelspec')).toEqual({
      name: 'xr',
      display_name: 'R 4.4.3 (xr)',
      language: 'R'
    });
  });

  it('leaves a notebook unchanged when its metadata already says the same', async () => {
    const model = new NotebookModel();
    model.setMetadata('kernelspec', {
      name: 'python3',
      display_name: 'Python 3 (ipykernel)',
      language: 'python'
    });
    model.setMetadata('language_info', { name: 'python', version: '1.0' });
    model.dirty = false;
    const context = {
      model,
      isDisposed: false,
      ready: Promise.resolve(),
      sessionContext: {
        session: {
          kernel: kernel('python3', 'Python 3 (ipykernel)', 'python')
        },
        kernelChanged: new Signal({}),
        ready: Promise.resolve()
      }
    };
    followKernel(
      context as unknown as DocumentRegistry.IContext<INotebookModel>
    );
    await flush();
    expect(model.dirty).toBe(false);
  });

  it('leaves a notebook unchanged when only the version of its language differs', async () => {
    // The later demo was saved with another Python than CI's: its galata test
    // "opens the later demo ... before a run" found the notebook changed on open.
    const model = new NotebookModel();
    model.setMetadata('kernelspec', {
      name: 'python3',
      display_name: 'Python 3',
      language: 'python'
    });
    model.setMetadata('language_info', { name: 'python', version: '0.9' });
    model.dirty = false;
    const context = {
      model,
      isDisposed: false,
      ready: Promise.resolve(),
      sessionContext: {
        session: {
          kernel: kernel('python3', 'Python 3 (ipykernel)', 'python')
        },
        kernelChanged: new Signal({}),
        ready: Promise.resolve()
      }
    };
    followKernel(
      context as unknown as DocumentRegistry.IContext<INotebookModel>
    );
    await flush();
    expect(model.dirty).toBe(false);
    expect(model.getMetadata('language_info')).toEqual({
      name: 'python',
      version: '0.9'
    });
  });
});
