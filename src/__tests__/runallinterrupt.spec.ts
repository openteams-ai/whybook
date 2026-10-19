/**
 * An interrupt of the kernel during Run all stops the run, as Run All Cells
 * of JupyterLab's notebook stops: the cells after the interrupted one stay
 * not run (`_runAllCells` in src/model/epimodel.ts, Interrupt Kernel in
 * src/kernelmenu.ts). JupyterLab's notebook sends every cell at once, and
 * the kernel drops the cells queued behind the cell that the interrupt
 * stops. Whybook sends the cells one at a time. No kernel starts.
 */
import './fakes/quiet';

import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Signal } from '@lumino/signaling';

import { interruptKernel } from '../model/interrupts';
import { JobManager } from '../model/jobs';
import { fakeModel, until } from './fakes/model-fake';

/**
 * A Python kernel without subshells. A cell that starts with `time.sleep`
 * runs until an interrupt reaches it, and then fails with KeyboardInterrupt,
 * as IPython does. An interrupt that reaches the kernel between two cells
 * does nothing, as in ipykernel. A cell that starts with `raise` fails with
 * a ValueError.
 */
function sleepingKernel() {
  const owner = {};
  const session = {
    session: null as unknown,
    kernelChanged: new Signal<any, any>(owner),
    statusChanged: new Signal<any, any>(owner),
    iopubMessage: new Signal<any, any>(owner)
  };
  const codes: string[] = [];
  let count = 0;
  let sleeping: (() => void) | null = null;
  const kernel = {
    status: 'idle',
    supportsSubshells: false,
    info: Promise.resolve({ language_info: { name: 'python' } }),
    interrupt: async () => {
      sleeping?.();
    },
    requestExecute(content: { code: string }) {
      codes.push(content.code);
      const execution = ++count;
      const failed = (ename: string) => ({
        content: {
          status: 'error',
          ename,
          evalue: '',
          traceback: [],
          execution_count: execution
        }
      });
      const done = content.code.startsWith('time.sleep')
        ? new Promise(resolve => {
            sleeping = () => {
              sleeping = null;
              resolve(failed('KeyboardInterrupt'));
            };
          })
        : Promise.resolve(
            content.code.startsWith('raise')
              ? failed('ValueError')
              : { content: { status: 'ok', execution_count: execution } }
          );
      return {
        msg: { header: { msg_id: `run-${execution}` } },
        onIOPub: () => undefined,
        onReply: () => undefined,
        onStdin: () => undefined,
        done,
        dispose: () => undefined
      };
    }
  };
  session.session = { kernel };
  return {
    session,
    codes,
    // JupyterLab's notebook of the same file interrupts the kernel: the
    // sleeping cell fails, and Whybook's command did not run.
    interruptFromAnotherClient: () => sleeping?.()
  };
}

/**
 * A view model over these cells, whose cells run in that kernel. `prepare`
 * runs before each cell, as the plot hooks do.
 */
function view(
  sources: string[],
  prepare?: () => Promise<void>,
  kernel = sleepingKernel()
) {
  const { model } = fakeModel(
    sources.map((source, index) => ({ id: `c${index}`, source }))
  );
  model.context.sessionContext = kernel.session;
  model.jobs = new JobManager({
    sessionContext: kernel.session as any,
    rendermime: {
      preferredMimeType: () => undefined
    } as unknown as IRenderMimeRegistry,
    prepare
  });
  model._runningAll = 0;
  return { model, kernel };
}

const SOURCES = [
  "import time\nprint('cell 0 ran')",
  "time.sleep(15)\nprint('cell 1 ran')",
  "print('cell 2 ran')",
  "print('cell 3 ran')"
];

const labels = (model: any) =>
  model.cells().map((cell: any) => cell.label as string);

describe('an interrupt during Run all', () => {
  it('stops the run: the cells after the interrupted cell do not run', async () => {
    const { model, kernel } = view(SOURCES);
    const run = model.runAll();
    await until(() => kernel.codes.length === 2);
    // Interrupt Kernel of the Kernel menu or the toolbar.
    await interruptKernel(model.context.sessionContext);
    await run;
    expect(kernel.codes).toEqual(SOURCES.slice(0, 2));
    expect(labels(model)).toEqual(['[1]', '[2]', '[ ]', '[ ]']);
    expect(model.jobs.jobFor('c1')?.status).toBe('error');
    // The toolbar's kernel status counts the cells that ran: "Executed 2 cells".
    expect(model.jobs.tally.run).toMatchObject({ total: 2, done: 2 });
    model.jobs.dispose();
  });

  it('stops the run when the interrupt comes from another client of the kernel', async () => {
    const { model, kernel } = view(SOURCES);
    const run = model.runAll();
    await until(() => kernel.codes.length === 2);
    kernel.interruptFromAnotherClient();
    await run;
    expect(kernel.codes).toEqual(SOURCES.slice(0, 2));
    expect(labels(model)).toEqual(['[1]', '[2]', '[ ]', '[ ]']);
    model.jobs.dispose();
  });

  it('stops the run after the next cell when the interrupt reaches the kernel between two cells, from another view of the notebook', async () => {
    const sources = ['x = 1', 'y = 2', 'z = 3', 'w = 4'];
    let release: () => void = () => undefined;
    let prepared = 0;
    // The second cell waits before it goes to the kernel, which is idle.
    const prepare = () => {
      prepared++;
      return prepared === 2
        ? new Promise<void>(resolve => (release = resolve))
        : Promise.resolve();
    };
    const { model, kernel } = view(sources, prepare);
    // A second view of the same notebook shares its session.
    const other = view(sources, undefined, kernel).model;
    const run = model.runAll();
    await until(() => prepared === 2);
    await interruptKernel(other.context.sessionContext);
    release();
    await run;
    expect(kernel.codes).toEqual(['x = 1', 'y = 2']);
    expect(labels(model)).toEqual(['[1]', '[2]', '[ ]', '[ ]']);
    model.jobs.dispose();
    other.jobs.dispose();
  });

  it('leaves the next Run all to run every cell', async () => {
    const { model, kernel } = view(SOURCES);
    // Until the sleeping cell of this run went to the kernel.
    const sleeping = (count: number) => () =>
      kernel.codes.filter(code => code.startsWith('time.sleep')).length ===
        count && kernel.codes[kernel.codes.length - 1].startsWith('time.sleep');
    const run = model.runAll();
    await until(sleeping(1));
    await interruptKernel(model.context.sessionContext);
    await run;
    const again = model.runAll();
    await until(sleeping(2));
    await interruptKernel(model.context.sessionContext);
    await again;
    // The second run started from the first cell, and the interrupt stopped
    // it at the sleeping cell again.
    expect(kernel.codes).toEqual([
      ...SOURCES.slice(0, 2),
      ...SOURCES.slice(0, 2)
    ]);
    model.jobs.dispose();
  });
});

describe('an error during Run all that is not an interrupt', () => {
  it('does not stop the run, as before', async () => {
    const sources = ['x = 1', 'raise ValueError("no")', 'z = 3'];
    const { model, kernel } = view(sources);
    await model.runAll();
    expect(kernel.codes).toEqual(sources);
    expect(labels(model)).toEqual(['[1]', '[2]', '[3]']);
    model.jobs.dispose();
  });
});
