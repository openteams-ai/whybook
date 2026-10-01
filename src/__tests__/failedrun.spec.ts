/**
 * A cell counts as run only when its run ended without an error
 * (src/model/kernel.ts). A question that edits a cell that raised on its last
 * run offers to run the cells it needs first (_cellNeeds in epimodel.ts).
 */
import type { KernelMessage } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';

import { KernelBridge } from '../model/kernel';
import { RESULT_MIME } from '../tokens';
import { fakeModel, settle } from './fakes/model-fake';

/**
 * A session with a Python kernel without subshells, whose execute requests
 * wait for the test to answer them.
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

/** What the kernel publishes when another client runs this code. */
function ran(
  session: ReturnType<typeof fakeSession>['session'],
  msgId: string,
  code: string,
  error: string | null
): void {
  const parent = { msg_id: msgId, msg_type: 'execute_request' };
  const messages = [
    {
      header: { msg_type: 'execute_input' },
      parent_header: parent,
      content: { code }
    },
    ...(error
      ? [
          {
            header: { msg_type: 'error' },
            parent_header: parent,
            content: { ename: error, evalue: 'x', traceback: [] }
          }
        ]
      : []),
    {
      header: { msg_type: 'status' },
      parent_header: parent,
      content: { execution_state: 'idle' }
    }
  ];
  for (const msg of messages) {
    session.iopubMessage.emit(msg as unknown as KernelMessage.IMessage);
  }
}

async function listed(
  bridge: KernelBridge,
  answers: ((result: unknown) => void)[]
): Promise<void> {
  const refresh = bridge.refreshVariables();
  await settle();
  answers.shift()!({ variables: [], packages: {} });
  await refresh;
}

describe('KernelBridge', () => {
  it('counts a run that raised as run, but not as run without an error', async () => {
    const { session, answers } = fakeSession();
    const bridge = new KernelBridge(session as any);
    ran(session, 'run-1', 'weekly.plot()', 'NameError');
    ran(session, 'run-2', 'x = 1', null);
    await listed(bridge, answers);
    expect(bridge.hasRun('weekly.plot()')).toBe(true);
    expect(bridge.ranWithoutError('weekly.plot()')).toBe(false);
    expect(bridge.ranWithoutError('x = 1')).toBe(true);
    // The same code runs again, and ends well this time; then it raises.
    ran(session, 'run-3', 'weekly.plot()', null);
    await listed(bridge, answers);
    expect(bridge.ranWithoutError('weekly.plot()')).toBe(true);
    ran(session, 'run-4', 'weekly.plot()', 'KeyboardInterrupt');
    await listed(bridge, answers);
    expect(bridge.ranWithoutError('weekly.plot()')).toBe(false);
    bridge.dispose();
  });
});

describe('the wait for the cells a cell needs', () => {
  const cells = [
    { id: 'c13', source: 'weekly = diary.groupby("week").mean()' },
    { id: 'c14', source: 'weekly.plot()', count: 1 }
  ];

  function asking(error: string | null) {
    return async () => {
      const { model } = fakeModel(cells);
      const { session, answers } = fakeSession();
      const bridge = new KernelBridge(session as any);
      model.bridge = bridge;
      // After a restart the analyst runs c14 alone.
      ran(session, 'run-c14', 'weekly.plot()', error);
      await listed(bridge, answers);
      const asked: unknown[] = [];
      model.api = {
        dependencies: async (body: unknown) => {
          asked.push(body);
          return { cells: ['c13', 'c14'], unresolved: [], inputs: ['weekly'] };
        }
      };
      const ask: any = { kind: 'cells', loading: true };
      model.ask = ask;
      const waits = await model._cellNeeds(ask, model.cell('c14'), () => {
        return;
      });
      bridge.dispose();
      return { waits, asked: asked.length, missing: ask.missing ?? null };
    };
  }

  it('offers to run the cells first when the cell raised on its last run', async () => {
    const { waits, asked, missing } = await asking('NameError')();
    expect({ waits, asked }).toEqual({ waits: true, asked: 1 });
    expect(missing).toMatchObject({
      names: ['weekly'],
      from: 'cell',
      cell: '[1]',
      plan: ['c13']
    });
  });

  it('does not wait when the cell ran without an error', async () => {
    const { waits, asked } = await asking(null)();
    expect({ waits, asked }).toEqual({ waits: false, asked: 0 });
  });
});
