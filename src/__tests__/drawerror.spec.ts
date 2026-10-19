/**
 * The error of a cell whose output raised while it was drawn
 * (src/model/jobs.ts). A pandas Styler whose `_repr_html_` raises is one:
 * IPython shows the error as an output of the cell, and ipykernel 7.4's
 * reply has the status "error" with no exception, "NoneType: None". No
 * kernel starts.
 */
import './fakes/quiet';

import type { ICodeCellModel } from '@jupyterlab/cells';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Signal } from '@lumino/signaling';

import { JobManager } from '../model/jobs';
import { fakeNotebook } from './fakes/model-fake';

const SOURCE =
  'class Drawing:\n    def _repr_html_(self):\n        raise TypeError("cannot draw this table")\n\nDrawing()';

// The traceback that ipykernel 7.4 sends, in the error output and in the reply.
const TRACEBACK = [
  '\u001b[31m---------------------------------------------------------------------------\u001b[39m',
  '\u001b[31mTypeError\u001b[39m                                 Traceback (most recent call last)',
  '\u001b[36mCell\u001b[39m\u001b[36m \u001b[39m\u001b[32mIn[1]\u001b[39m\u001b[32m, line 3\u001b[39m, in \u001b[36mDrawing._repr_html_\u001b[39m\u001b[34m(self)\u001b[39m\n\u001b[32m      2\u001b[39m     \u001b[38;5;28;01mdef\u001b[39;00m _repr_html_(self):\n\u001b[32m----> \u001b[39m\u001b[32m3\u001b[39m         \u001b[38;5;28;01mraise\u001b[39;00m TypeError(\u001b[33m"cannot draw this table"\u001b[39m)\n',
  '\u001b[31mTypeError\u001b[39m: cannot draw this table'
];

/**
 * A Python kernel without subshells that runs that cell as ipykernel 7.4
 * does: the error output, then the plain text of the object, then a reply
 * with the status "error" and no exception.
 */
function drawingKernel() {
  return {
    status: 'idle',
    supportsSubshells: false,
    info: Promise.resolve({ language_info: { name: 'python' } }),
    requestExecute() {
      const parent = { msg_id: 'run-1', msg_type: 'execute_request' };
      const future: any = {
        msg: { header: { msg_id: 'run-1' } },
        onIOPub: () => undefined,
        onReply: () => undefined,
        onStdin: () => undefined,
        dispose: () => undefined
      };
      future.done = new Promise(resolve =>
        setTimeout(() => {
          future.onIOPub({
            header: { msg_type: 'error' },
            parent_header: parent,
            content: {
              ename: 'TypeError',
              evalue: 'cannot draw this table',
              traceback: TRACEBACK
            }
          });
          future.onIOPub({
            header: { msg_type: 'execute_result' },
            parent_header: parent,
            content: {
              data: { 'text/plain': '<__main__.Drawing at 0x78e41254fb30>' },
              metadata: {},
              execution_count: 1
            }
          });
          resolve({
            content: {
              status: 'error',
              ename: 'NoneType',
              evalue: 'None',
              traceback: TRACEBACK,
              execution_count: 1
            }
          });
        }, 0)
      );
      return future;
    }
  };
}

describe('a cell whose output raises while it is drawn', () => {
  it('fails with the error of its output, and not "NoneType: None"', async () => {
    const nb = fakeNotebook([{ id: 'draw', source: SOURCE }]);
    const cell = nb.cells.get(0) as ICodeCellModel;
    const sessionContext = {
      session: { kernel: drawingKernel() },
      kernelChanged: new Signal({}),
      statusChanged: new Signal({})
    };
    const jobs = new JobManager({
      sessionContext: sessionContext as any,
      // The outputs are kept in the cell, and drawn by no view here.
      rendermime: {
        preferredMimeType: () => undefined
      } as unknown as IRenderMimeRegistry
    });
    const result = await jobs.run(cell, {
      label: '[ ]',
      text: 'Drawing()',
      subshell: false
    });
    expect(result.ok).toBe(false);
    // The card shows the first line of the job's error.
    expect(result.error?.split('\n')[0]).toBe(
      'TypeError: cannot draw this table'
    );
    expect(jobs.jobFor('draw')?.error?.split('\n')[0]).toBe(
      'TypeError: cannot draw this table'
    );
    // The traceback stays, without its colours.
    expect(result.error).toContain('raise TypeError("cannot draw this table")');
    expect(result.error).not.toContain('\u001b[');
    expect(cell.executionCount).toBe(1);
    jobs.dispose();
  });
});
