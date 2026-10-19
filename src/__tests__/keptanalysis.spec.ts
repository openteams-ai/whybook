/**
 * The analysis that the notebook keeps of each cell that ran
 * (src/model/epimodel.ts, `_keep`), when cells end while the view reads the
 * kernel (src/model/kernel.ts, `refreshAnalysis`). Run all goes on while the
 * view's request for the analysis of the cells waits for the kernel. A cell
 * that ends then counts as run only from the next listing, so the notebook
 * keeps its analysis only if another pass of the analysis follows. Without
 * it, the notebook keeps the cell's decisions and not its analysis, and the
 * next open adds the analysis and marks the notebook as changed. No kernel
 * starts.
 */
import type { KernelMessage } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';

import { KernelBridge } from '../model/kernel';
import { RESULT_MIME } from '../tokens';
import type { ICellAnalysis } from '../tokens';
import { fakeModel, settle } from './fakes/model-fake';

/**
 * A session with a Python kernel without subshells, whose execute requests
 * wait for the test to answer them, in the order they were sent.
 */
function fakeSession() {
  const answers: ((result: unknown) => void)[] = [];
  const kernel = {
    status: 'idle',
    supportsSubshells: false,
    info: Promise.resolve({ language_info: { name: 'python' } }),
    requestExecute() {
      const msgId = `own-${answers.length}`;
      let finish!: (reply: unknown) => void;
      const future: any = {
        msg: { header: { msg_id: msgId } },
        onIOPub: () => undefined,
        done: new Promise(resolve => (finish = resolve))
      };
      answers.push(result => {
        future.onIOPub({
          header: { msg_type: 'display_data' },
          parent_header: { msg_id: msgId },
          content: { data: { [RESULT_MIME]: result }, metadata: {} }
        });
        finish({ content: { status: 'ok' } });
      });
      return future;
    }
  };
  const session = {
    session: { kernel },
    kernelChanged: new Signal<unknown, unknown>({}),
    statusChanged: new Signal<unknown, unknown>({}),
    iopubMessage: new Signal<unknown, unknown>({})
  };
  return { session, answers };
}

/** What the kernel publishes to every client when a cell runs this code. */
function ran(
  session: ReturnType<typeof fakeSession>['session'],
  msgId: string,
  code: string
): void {
  const parent = { msg_id: msgId, msg_type: 'execute_request' };
  for (const msg of [
    {
      header: { msg_type: 'execute_input' },
      parent_header: parent,
      content: { code }
    },
    {
      header: { msg_type: 'status' },
      parent_header: parent,
      content: { execution_state: 'idle' }
    }
  ]) {
    session.iopubMessage.emit(msg as unknown as KernelMessage.IMessage);
  }
}

// The last three code cells of the notebook of the sweep in which the fault
// showed (epi-pzivich-data-management), with their analysis by the kernel.
const SOURCES: Record<string, string> = {
  save: "df.to_csv('saved_file.csv', index=False)",
  cross: "print(pd.crosstab(df['art'], df['dead'], dropna=False))",
  fill: "df.fillna(-99999, inplace=True)\nprint(pd.crosstab(df['art'], df['dead']))"
};

function analysisOf(
  name: string,
  param: string,
  value: string,
  col: number
): ICellAnalysis {
  return {
    defs: [],
    uses: ['df', ...(name === 'to_csv' ? [] : ['pd'])],
    formulas: [],
    columns: {},
    decisions: [
      {
        name: param,
        param,
        function: name,
        value,
        provenance: 'literal',
        calls: [{ line: 1, col, target: 'df' }]
      } as any
    ],
    attachments: []
  };
}

const ANALYSIS = {
  cells: {
    save: analysisOf('to_csv', 'path_or_buf', "'saved_file.csv'", 3),
    cross: analysisOf('crosstab', 'dropna', 'False', 9),
    fill: analysisOf('fillna', 'value', '-99999', 3)
  }
};

describe('the analysis that the notebook keeps', () => {
  it('keeps the analysis of the cells that ended while the view read the analysis', async () => {
    const { model, nb } = fakeModel(
      Object.entries(SOURCES).map(([id, source]) => ({ id, source }))
    );
    const { session, answers } = fakeSession();
    const bridge = new KernelBridge(session as any);
    model.bridge = bridge;
    model.context.sessionContext = session;
    model.plotHooks = { ready: async () => null };
    model._refreshPolicy = {
      changed: () => undefined,
      refreshing: () => undefined,
      dispose: () => undefined
    };
    bridge.changed.connect(model._onBridge, model);
    const kept = () =>
      Array.from(nb.cells).map(cell => {
        const meta = (cell.getMetadata('whybook') as object) ?? {};
        return `${cell.id}:${Object.keys(meta).sort().join('+')}`;
      });

    // Run all: the first cell ends, and the view reads the kernel.
    ran(session, 'run-save', SOURCES.save);
    model._ran.add('save');
    const first = model._readKernel();
    await settle();
    answers.shift()!({ variables: [], packages: {} });
    await settle();
    // The listing came back, and the request for the analysis of the cells
    // waits for the kernel, while the last two cells run and end.
    expect(answers).toHaveLength(1);
    ran(session, 'run-cross', SOURCES.cross);
    model._ran.add('cross');
    ran(session, 'run-fill', SOURCES.fill);
    model._ran.add('fill');
    answers.shift()!(ANALYSIS);
    await first;

    // The ends of the two cells made a refresh due: it lists the kernel, and
    // analyses the cells again when an analysis is due.
    const second = model._readKernel();
    await settle();
    answers.shift()!({ variables: [], packages: {} });
    await settle();
    if (answers.length) {
      answers.shift()!(ANALYSIS);
    }
    await second;

    // Without the second pass, the notebook keeps "cross:decisions" and
    // "fill:decisions", as the notebook of the sweep does.
    expect(kept()).toEqual([
      'save:analysis+decisions',
      'cross:analysis+decisions',
      'fill:analysis+decisions'
    ]);
    bridge.dispose();
  });
});
