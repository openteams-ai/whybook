/**
 * A code cell of whitespace alone does not go to the kernel, as in
 * JupyterLab's notebook, and has no count once it is run
 * (src/model/epimodel.ts, `_run`). IPython answers such a cell with the
 * count of the last execution: sent to the kernel by Run all, each empty
 * cell takes the label of the cell above it. No kernel starts.
 */
import './fakes/quiet';

import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Signal } from '@lumino/signaling';

import { reproduceFindings } from '../model/checkup';
import { JobManager } from '../model/jobs';
import { RunTimes } from '../model/runtimes';
import { fakeModel } from './fakes/model-fake';

/**
 * A Python kernel without subshells that answers each execute request as
 * IPython 9 with ipykernel 7.4 does. Code that is not blank takes the next
 * count. A blank code is published with the next count, and its reply
 * carries the count of the last execution. The kernel publishes the input
 * and the idle status of each request to every client. Code that starts
 * with `raise` fails.
 */
function ipythonKernel() {
  const owner = {};
  const session = {
    session: null as unknown,
    kernelChanged: new Signal<any, any>(owner),
    statusChanged: new Signal<any, any>(owner),
    iopubMessage: new Signal<any, any>(owner)
  };
  const codes: string[] = [];
  let count = 0;
  const publish = (type: string, parent: string, content: unknown) =>
    session.iopubMessage.emit({
      header: { msg_type: type, msg_id: `${type}-${parent}` },
      parent_header: { msg_id: parent },
      content,
      channel: 'iopub'
    });
  const kernel = {
    status: 'idle',
    supportsSubshells: false,
    info: Promise.resolve({ language_info: { name: 'python' } }),
    requestExecute(content: { code: string }) {
      codes.push(content.code);
      const msgId = `run-${codes.length}`;
      publish('execute_input', msgId, {
        code: content.code,
        execution_count: count + 1
      });
      if (content.code.trim()) {
        count++;
      }
      publish('status', msgId, { execution_state: 'idle' });
      const reply = content.code.startsWith('raise')
        ? { status: 'error', ename: 'ValueError', evalue: 'no', traceback: [] }
        : { status: 'ok' };
      return {
        msg: { header: { msg_id: msgId } },
        onIOPub: () => undefined,
        onReply: () => undefined,
        onStdin: () => undefined,
        done: Promise.resolve({
          content: { ...reply, execution_count: count }
        }),
        dispose: () => undefined
      };
    }
  };
  session.session = { kernel };
  return { session, codes };
}

/** A view model over these cells, whose cells run in that kernel. */
function view(cells: { id: string; source: string; count?: number }[]) {
  const { model } = fakeModel(cells);
  const { session, codes } = ipythonKernel();
  model.context.sessionContext = session;
  model.jobs = new JobManager({
    sessionContext: session as any,
    // No cell here shows an output.
    rendermime: {
      preferredMimeType: () => undefined
    } as unknown as IRenderMimeRegistry
  });
  model._runningAll = 0;
  const times = new RunTimes(session as any);
  return { model, codes, times };
}

const CELLS = [
  { id: 'c0', source: 'x = 1' },
  { id: 'c1', source: '' },
  // A count from an earlier kernel goes, as in JupyterLab's notebook.
  { id: 'c2', source: '  \n', count: 7 },
  { id: 'c3', source: 'y = 2' }
];

describe('Run all over empty cells', () => {
  it('runs only the cells with code, and leaves the empty ones without a count, as JupyterLab does', async () => {
    const { model, codes, times } = view(CELLS);
    await model.runAll();
    expect(codes).toEqual(['x = 1', 'y = 2']);
    // JupyterLab's notebook gives the counts [1, null, null, 2].
    expect(model.cells().map((cell: any) => cell.label)).toEqual([
      '[1]',
      '[ ]',
      '[ ]',
      '[2]'
    ]);
    // The toolbar's kernel status counts the cells that ran: "Executed 2 cells".
    expect(model.jobs.tally.run).toMatchObject({ total: 2, done: 2 });
    model.jobs.dispose();
    times.dispose();
  });

  it('gives the check-up no empty cell that changed after it ran', async () => {
    const { model, times } = view(CELLS);
    await model.runAll();
    const cells = model.codeCells().map((cell: any) => ({
      id: cell.id,
      label: cell.label,
      title: cell.title,
      source: cell.model.sharedModel.getSource(),
      count: cell.count,
      analysis: null,
      decisions: [],
      branchOf: null,
      chosen: [],
      question: null
    }));
    // An empty cell with the count of x = 1 reads as "[1] changed after it
    // ran: its outputs come from older code."
    const { findings } = reproduceFindings(cells, count => times.codeOf(count));
    expect(findings.map(finding => finding.text)).toEqual([]);
    model.jobs.dispose();
    times.dispose();
  });
});

describe('an empty cell that the analyst runs', () => {
  it('has no count, and shows no error of an earlier run', async () => {
    const { model, codes, times } = view([
      { id: 'c0', source: 'raise ValueError("no")' }
    ]);
    await model.runCell('c0');
    expect(model.cell('c0').label).toBe('[1]');
    expect(model.jobs.jobFor('c0')?.status).toBe('error');
    // The analyst deletes the code, and runs the cell again.
    model.cell('c0').model.sharedModel.setSource('');
    await model.runCell('c0');
    expect(codes).toEqual(['raise ValueError("no")']);
    expect(model.cell('c0').label).toBe('[ ]');
    // The card shows the error line of the cell's last job, when it failed.
    expect(model.jobs.jobFor('c0')?.status).not.toBe('error');
    model.jobs.dispose();
    times.dispose();
  });
});
