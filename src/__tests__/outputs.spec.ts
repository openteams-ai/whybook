import type { IOutputModel } from '@jupyterlab/rendermime';

import { outputTile } from '../model/outputs';

/** An output as the notebook model holds it: a stream's text is in its data. */
function output(
  type: string,
  data: Record<string, unknown>,
  json: Record<string, unknown> = {}
): IOutputModel {
  return {
    type,
    data,
    metadata: {},
    trusted: true,
    toJSON: () => ({ output_type: type, ...json })
  } as unknown as IOutputModel;
}

describe('outputTile', () => {
  it('gives a table its size, and a printed text its line count', () => {
    const table = output('execute_result', {
      'text/html':
        '<table><tr><th></th><th>a</th></tr><tr><th>0</th><td>1</td></tr><tr><th>1</th><td>2</td></tr></table>',
      'text/plain': '   a\n0  1\n1  2'
    });
    expect(outputTile(table)).toEqual({
      kind: 'table',
      text: '2 × 1',
      title: 'A table, 2 × 1'
    });
    const printed = output('stream', {
      'application/vnd.jupyter.stdout': 'one\ntwo\nthree\n'
    });
    expect(outputTile(printed)?.text).toBe('3 lines');
  });

  it("gives no tile to IPython's message about its history database alone", () => {
    // The bench leaves this message out; the map drew "0 lines" for it.
    const history = output('stream', {
      'application/vnd.jupyter.stdout':
        'The history saving thread hit an unexpected error ' +
        "(OperationalError('attempt to write a readonly database'))." +
        'History will not be written to the database.\n'
    });
    expect(outputTile(history)).toBeNull();
  });

  it('names an error and leaves out progress', () => {
    const error = output(
      'error',
      {},
      { ename: 'KeyError', evalue: "'age'", traceback: [] }
    );
    expect(outputTile(error)).toEqual({
      kind: 'error',
      text: 'KeyError',
      title: 'An error: KeyError'
    });
    const progress = output('display_data', {
      'application/vnd.epi.progress+json': { fraction: 0.5 }
    });
    expect(outputTile(progress)).toBeNull();
  });
});
