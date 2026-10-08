import type { IOutputModel } from '@jupyterlab/rendermime';

import { drawnByExtension, outputKind } from '../model/notebook';
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
      'application/vnd.whybook.progress+json': { fraction: 0.5 }
    });
    expect(outputTile(progress)).toBeNull();
  });
});

describe('outputKind', () => {
  it("draws an output of another extension's type as a chart, where its text is a repr", () => {
    // A causal diagram of jupyterlab-dagitty showed on the bench as its
    // repr, and its box was 0 px wide in the Code view.
    const dag = output('execute_result', {
      'application/x.dagitty.dag': 'dag { qsmk -> wt82_71 }',
      'text/plain': '<jupyterlab_dagitty.dag.DAG at 0x7f0c2a1b3d90>'
    });
    expect(outputKind(dag)).toBe('chart');
    expect(drawnByExtension(dag.data)).toBe(true);
  });

  it("keeps the kinds of JupyterLab's own types and of Whybook's", () => {
    const printed = output('stream', {
      'application/vnd.jupyter.stdout': 'one\n'
    });
    expect(outputKind(printed)).toBe('log');
    const json = output('execute_result', {
      'application/json': { a: 1 },
      'text/plain': "{'a': 1}"
    });
    expect(outputKind(json)).toBe('text');
    const figure = output('display_data', {
      'image/png': 'iVBORw0KGgo=',
      'application/vnd.whybook.axes+json': { axes: [] },
      'text/plain': '<Figure size 640x480 with 1 Axes>'
    });
    expect(outputKind(figure)).toBe('image');
    expect(drawnByExtension(figure.data)).toBe(false);
    const table = output('execute_result', {
      'text/html': '<table><tr><td>1</td></tr></table>',
      'application/vnd.dataresource+json': { data: [] },
      'text/plain': '   a\n0  1'
    });
    expect(outputKind(table)).toBe('table');
  });
});
