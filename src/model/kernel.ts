import type { ISessionContext } from '@jupyterlab/apputils';
import type { IChangedArgs } from '@jupyterlab/coreutils';
import * as nbformat from '@jupyterlab/nbformat';
import type { Kernel } from '@jupyterlab/services';
import { KernelMessage } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

import type {
  ICellAnalysis,
  IKernelSnapshot,
  IStoredVariable,
  IVariable
} from '../tokens';
import { PROGRESS_MIME, RESULT_MIME } from '../tokens';
import type { ISignature } from './founddefaults';
import type { ILanguage, Snippet } from './languages';
import {
  PYTHON,
  languageOf,
  pythonString,
  supports,
  usesSubshells
} from './languages';

export { pythonString };

/**
 * Code that defines a kernel snippet's function, calls it with JSON
 * arguments, and deletes it again.
 */
export function snippetCall(
  name: Snippet,
  args: unknown,
  language: ILanguage = PYTHON
): string {
  const code = language.call(name, args);
  if (code === null) {
    throw new Error(`The view has no ${name} for ${language.label}`);
  }
  return code;
}

/** The data of an output: a result and display data have it, a stream or an error does not. */
function dataOf(output: nbformat.IOutput): nbformat.IMimeBundle | undefined {
  return nbformat.isExecuteResult(output) || nbformat.isDisplayData(output)
    ? output.data
    : undefined;
}

/**
 * How long the view waits for the reply to the first request of a new
 * connection, once it is open, before the notebook's connection sends a
 * request that gets ipykernel 7.3 to read it; the wait doubles after each
 * such request. In the galata runs of 30 September, at a load of 11 on 8
 * cores, a new connection got that reply 0.11 s at most after the page
 * made it.
 */
export const WAKE_MS = 1000;

/**
 * How long the view waits for the kernel to create a subshell, and for the
 * first reply to the new connection to it, before it gives up.
 */
export const SUBSHELL_WAIT_MS = 15000;

/**
 * How long the view waits for the kernel's history of its session, which
 * tells which codes ran in a kernel that ran before the view connected to it.
 */
export const HISTORY_WAIT_MS = 5000;

/** The value of the promise, or null when it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise<null>(resolve => {
      timer = window.setTimeout(() => resolve(null), ms);
    })
  ]).finally(() => window.clearTimeout(timer));
}

/**
 * Whether the connection opens: its WebSocket waits for the handshakes of
 * the page's other WebSockets to the server, which Chromium sends one at a
 * time. False once JupyterLab stops trying.
 */
function opened(connection: Kernel.IKernelConnection): Promise<boolean> {
  if (connection.connectionStatus === 'connected') {
    return Promise.resolve(true);
  }
  return new Promise<boolean>(resolve => {
    const changed = (
      _: Kernel.IKernelConnection,
      status: Kernel.ConnectionStatus
    ) => {
      if (status === 'connected' || status === 'disconnected') {
        connection.connectionStatusChanged.disconnect(changed);
        resolve(status === 'connected');
      }
    };
    connection.connectionStatusChanged.connect(changed);
  });
}

/**
 * The reply to a request on the control channel. Its `done` also waits for
 * the kernel's idle status on iopub, which a connection can miss: in galata,
 * the notebook's connection keeps its WebSocket through a restart, since
 * galata answers the restart request with the status of a new kernel, 201,
 * and JupyterLab takes only 200 before it opens a new one.
 */
function replyTo<REPLY extends KernelMessage.IControlMessage>(
  future: Kernel.IControlFuture<KernelMessage.IControlMessage, REPLY>
): Promise<REPLY> {
  return new Promise<REPLY>(resolve => {
    future.onReply = resolve;
  });
}

/**
 * Send a request on the kernel's shell channel from the notebook's
 * connection. Its arrival gets ipykernel 7.3 to read the requests that it
 * left unread (ipython/ipykernel#1554); the reply does not matter.
 */
function wake(kernel: Kernel.IKernelConnection): void {
  kernel.requestKernelInfo().catch(() => undefined);
}

/** Delete a subshell from the notebook's connection, if it can still ask. */
function deleteSubshell(
  kernel: Kernel.IKernelConnection,
  subshellId: string
): void {
  try {
    kernel
      .requestDeleteSubshell({ subshell_id: subshellId })
      .done.catch(() => undefined);
  } catch {
    // The connection was disposed, and the subshell went with its kernel.
  }
}

/**
 * Open a second connection to the kernel, bound to a new subshell when the
 * kernel supports subshells (ipykernel 7 and later), else the kernel itself.
 * In a language whose kernels run one session behind the subshells they
 * list, such as SAS, the view uses none (`usesSubshells`).
 *
 * The notebook's connection asks for the subshell, on the control channel,
 * and the new connection sends even its kernel info request to that
 * subshell: a cell that runs in the main shell holds up neither reply.
 *
 * ipykernel 7.3 can leave the first request of a new connection unread
 * until another request comes to the kernel (ipython/ipykernel#1554, fixed
 * in 7.4). For each new connection, jupyter_server sends the kernel a
 * request of its own, and a request that arrives while the kernel sends the
 * reply to it stays unread. When the kernel info reply of the new
 * connection does not come in `WAKE_MS` after it opened, the notebook's
 * connection sends a request. A second new connection would bring a second
 * request of jupyter_server, and the same risk. The promise rejects, with
 * the reason, when the kernel does not answer in `SUBSHELL_WAIT_MS`.
 */
export async function subshellConnection(
  kernel: Kernel.IKernelConnection
): Promise<Kernel.IKernelConnection | null> {
  const info = await kernel.info;
  if (!kernel.supportsSubshells || !usesSubshells(info.language_info?.name)) {
    return null;
  }
  const creating = replyTo(kernel.requestCreateSubshell({}));
  const created = await within(creating, SUBSHELL_WAIT_MS);
  if (!created) {
    // A subshell that the kernel creates later has no connection.
    void creating.then(
      late =>
        late.content.subshell_id &&
        deleteSubshell(kernel, late.content.subshell_id),
      () => undefined
    );
    throw new Error(
      `The kernel did not create a subshell in ${SUBSHELL_WAIT_MS / 1000} s`
    );
  }
  const subshellId = created.content.subshell_id;
  if (!subshellId) {
    return null;
  }
  const connection = kernel.clone({ handleComms: false });
  // Set before the connection opens, so that its first request carries it.
  connection.subshellId = subshellId;
  // Without its kernel info reply, a connection cannot delete its subshell:
  // it closes without one, and the notebook's connection deletes it.
  const close = () => {
    connection.subshellId = null;
    connection.dispose();
    deleteSubshell(kernel, subshellId);
  };
  try {
    if (!(await opened(connection))) {
      throw new Error('The view could not open a connection to the kernel');
    }
    let waited = 0;
    for (let wait = WAKE_MS; ; wait *= 2) {
      const step = Math.min(wait, SUBSHELL_WAIT_MS - waited);
      if (await within(connection.info, step)) {
        break;
      }
      waited += step;
      if (waited >= SUBSHELL_WAIT_MS) {
        throw new Error(
          `The kernel did not answer a new connection to a subshell in ${SUBSHELL_WAIT_MS / 1000} s`
        );
      }
      wake(kernel);
    }
  } catch (error) {
    close();
    throw error;
  }
  if (!connection.supportsSubshells) {
    close();
    return null;
  }
  return connection;
}

export interface IExecution {
  outputs: nbformat.IOutput[];
  error: string | null;
}

/**
 * The kernel side of the view: variables, cell analysis and small queries.
 *
 * Everything runs on one extra connection bound to a subshell, so it
 * answers while a long cell runs in the main shell. The code it runs is in
 * the kernel's language (./languages.ts); a kernel of a language without
 * that code lists no variables and analyses no cell.
 *
 * An execution counts when the kernel publishes its input, as it does for
 * every request that is not silent, from any client. The bridge's own
 * programs are silent, and so are those of another Whybook view on the same
 * kernel: they count neither here nor there, so two views of one kernel do
 * not refresh each other without end.
 */
export class KernelBridge implements IDisposable {
  constructor(sessionContext: ISessionContext) {
    this._sessionContext = sessionContext;
    sessionContext.kernelChanged.connect(this._onKernelChanged, this);
    sessionContext.statusChanged.connect(this._onStatusChanged, this);
    sessionContext.iopubMessage.connect(this._onIOPub, this);
    void this._readLanguage();
  }

  /**
   * Emits after the variables or the analysis change, and when an
   * execution that published its input, and that the bridge did not start,
   * finishes.
   */
  get changed(): ISignal<this, 'variables' | 'analysis' | 'executed'> {
    return this._changed;
  }

  get snapshot(): IKernelSnapshot | null {
    return this._snapshot;
  }

  /**
   * Whether the bridge saw the current kernel start or restart. Such a
   * kernel held no variables then, so the view needs no listing before an
   * execution; a kernel that was running before the view connected to it
   * may hold anything.
   */
  get watchedStart(): boolean {
    return this._watchedStart;
  }

  /**
   * Whether the kernel is known to have held nothing when it started, and
   * the bridge has not listed it since: the Variables section says that no
   * variable exists yet, where it would otherwise say it reads the kernel.
   */
  get startedEmpty(): boolean {
    return this._watchedStart && this._snapshot === null;
  }

  /**
   * The kernel's `language_info.name`: python, R. Null before the kernel's
   * info reply arrives.
   */
  get languageName(): string | null {
    return this._languageName;
  }

  /** The code the view has for the kernel's language, or null without it. */
  get language(): ILanguage | null {
    return languageOf(this._languageName);
  }

  get usesSubshell(): boolean {
    return this._connection !== null && this._connection.subshellId !== null;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * The analysis of a cell: the kernel's, or the one the notebook kept when
   * the kernel has not analysed this source. A caller that holds the cell
   * gives the kept analysis, which `storedAnalysis` looks up otherwise.
   */
  analysis(
    cellId: string,
    source: string,
    stored: ICellAnalysis | null = this.storedAnalysis?.(cellId, source) ?? null
  ): ICellAnalysis | null {
    const fresh = this.freshAnalysis(cellId, source);
    if (fresh && stored) {
      // Before the cell runs, the kernel analyses it against the names it
      // holds: after a restart the cell seems to use nothing and to make no
      // decisions. The kept analysis of the same source, from a kernel where
      // the cell ran, is complete, so it stands until the cell runs here.
      if (!this.hasRun(source)) {
        return stored;
      }
      return {
        ...fresh,
        uses: [...new Set([...fresh.uses, ...stored.uses])].sort()
      };
    }
    return fresh ?? stored;
  }

  /** The kernel's own analysis of this source, if it made one. */
  freshAnalysis(cellId: string, source: string): ICellAnalysis | null {
    const entry = this._analysis.get(cellId);
    return entry && entry.source === source ? entry.result : null;
  }

  /**
   * Whether the analysis also reads the signatures of the library functions
   * that each cell calls: the setting "Find more defaults with AI". Turned
   * on, the next refresh analyses every cell again.
   */
  signatures = false;

  /**
   * The library functions that this source calls, with the parameters that
   * each call leaves at their defaults, as the kernel read them with the
   * analysis; null when it did not read them. They stay out of the analysis,
   * which the notebook keeps.
   */
  signaturesOf(cellId: string, source: string): ISignature[] | null {
    const entry = this._analysis.get(cellId);
    return entry && entry.source === source ? entry.signatures : null;
  }

  /** Where the analysis the notebook kept comes from. */
  storedAnalysis:
    ((cellId: string, source: string) => ICellAnalysis | null) | null = null;

  /**
   * Whether this code ran in the current kernel, from any client, whatever
   * the result: its count is from this kernel.
   */
  hasRun(code: string): boolean {
    return this._ranCode.has(code);
  }

  /**
   * Whether this code ran in the current kernel and its last run ended
   * without an error. A run that raised may have stopped before it defined
   * what the code makes.
   */
  ranWithoutError(code: string): boolean {
    return this._ranCode.has(code) && !this._raisedCode.has(code);
  }

  /** How many different codes ran in the current kernel. */
  get runCount(): number {
    return this._ranCode.size;
  }

  /**
   * Whether this message id belongs to a request the view sent.
   */
  isOwn(msgId: string): boolean {
    return this._own.has(msgId);
  }

  remember(msgId: string): void {
    this._own.add(msgId);
    setTimeout(() => this._own.delete(msgId), 60000);
  }

  /**
   * Run a kernel snippet in the kernel's language and return what it
   * displays with the result MIME type.
   */
  async run<T>(name: Snippet, args: unknown): Promise<T> {
    const language = await this._readLanguage();
    if (!language) {
      throw new Error(
        `The view has no ${name} for ${this._languageName || 'this kernel'}`
      );
    }
    const execution = await this.execute(
      snippetCall(name, args, language),
      true
    );
    const result = execution.outputs.find(
      output => dataOf(output)?.[RESULT_MIME]
    );
    if (!result) {
      throw new Error(execution.error ?? `${name} returned nothing`);
    }
    const value = dataOf(result)?.[RESULT_MIME];
    // A kernel may send the JSON of a MIME bundle as text.
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  }

  /**
   * Run code on the utility connection and collect its outputs.
   */
  async execute(code: string, silent = false): Promise<IExecution> {
    const connection = await this._connect();
    if (!connection) {
      throw new Error('The notebook has no kernel');
    }
    const future = connection.requestExecute(
      {
        code,
        silent,
        store_history: false,
        allow_stdin: false,
        stop_on_error: true
      },
      true
    );
    this.remember(future.msg.header.msg_id);
    const outputs: nbformat.IOutput[] = [];
    let error: string | null = null;
    future.onIOPub = msg => {
      if (
        KernelMessage.isDisplayDataMsg(msg) ||
        KernelMessage.isExecuteResultMsg(msg)
      ) {
        const { content } = msg;
        const type = msg.header.msg_type;
        if (content.data && content.data[PROGRESS_MIME]) {
          return;
        }
        outputs.push({
          output_type: type,
          data: content.data,
          metadata: content.metadata ?? {},
          ...(type === 'execute_result' ? { execution_count: null } : {})
        } as nbformat.IOutput);
      } else if (KernelMessage.isStreamMsg(msg)) {
        outputs.push({
          output_type: 'stream',
          name: msg.content.name,
          text: msg.content.text
        });
      } else if (KernelMessage.isErrorMsg(msg)) {
        const { content } = msg;
        error = `${content.ename}: ${content.evalue}`;
        outputs.push({
          output_type: 'error',
          ename: content.ename,
          evalue: content.evalue,
          traceback: content.traceback
        });
      }
    };
    await future.done;
    return { outputs, error };
  }

  /**
   * List the variables. Frames that did not change come back as stubs and
   * keep their previous summary.
   */
  async refreshVariables(): Promise<void> {
    await this._readHistory();
    const language = await this._readLanguage();
    if (!supports(language, 'variables')) {
      // A kernel of another language lists nothing, and the view says why.
      this._finishRuns();
      this._changed.emit('variables');
      return;
    }
    const known: Record<string, string> = {};
    for (const variable of this._snapshot?.variables ?? []) {
      if (variable.fingerprint) {
        known[variable.name] = variable.fingerprint;
      }
    }
    const fresh = await this.run<IKernelSnapshot & { error?: string }>(
      'inspect_variables',
      { known }
    );
    if (!fresh.variables) {
      throw new Error(fresh.error ?? 'inspect_variables listed no variables');
    }
    const previous = new Map(
      (this._snapshot?.variables ?? []).map(v => [v.name, v])
    );
    const variables: IVariable[] = [];
    for (const variable of fresh.variables) {
      if (variable.unchanged) {
        const old = previous.get(variable.name);
        if (old) {
          variables.push(old);
        }
        continue;
      }
      variables.push(prepareVariable(variable, language!));
    }
    this._snapshot = { ...fresh, variables };
    this._finishRuns();
    this._changed.emit('variables');
  }

  /**
   * Analyse the cells whose source changed since the last analysis.
   */
  async refreshAnalysis(
    cells: { id: string; source: string }[]
  ): Promise<void> {
    if (!supports(await this._readLanguage(), 'analysis')) {
      return;
    }
    const signatures = this.signatures;
    const stale = cells.filter(cell => {
      const entry = this._analysis.get(cell.id);
      return (
        !entry ||
        entry.source !== cell.source ||
        entry.stale ||
        (signatures && entry.signatures === null)
      );
    });
    if (stale.length === 0) {
      return;
    }
    // Without the setting, the request is the one of before.
    const result = await this.run<{
      cells?: Record<string, ICellAnalysis & { signatures?: ISignature[] }>;
      error?: string;
    }>(
      'analyze_cells',
      signatures ? { cells: stale, signatures: true } : { cells: stale }
    );
    if (!result.cells) {
      // An error of the R program comes back as its result (./languages.ts).
      throw new Error(result.error ?? 'analyze_cells analysed no cell');
    }
    for (const cell of stale) {
      const analysis = result.cells[cell.id];
      if (analysis) {
        const { signatures: read, ...rest } = analysis;
        this._analysis.set(cell.id, {
          source: cell.source,
          result: rest,
          stale: false,
          // A cell that the kernel could not parse lists none.
          signatures: signatures ? (read ?? []) : null
        });
      }
    }
    this._changed.emit('analysis');
  }

  /**
   * The analysis depends on the namespace too: mark every cell for another pass.
   */
  invalidateAnalysis(): void {
    for (const entry of this._analysis.values()) {
      entry.stale = true;
    }
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._dropConnection();
    Signal.clearData(this);
  }

  private async _connect(): Promise<Kernel.IKernelConnection | null> {
    const kernel = this._sessionContext.session?.kernel;
    if (!kernel) {
      return null;
    }
    if (this._connection && !this._connection.isDisposed) {
      return this._connection;
    }
    if (!this._connecting) {
      this._connecting = subshellConnection(kernel)
        .then(connection => {
          this._connection = connection;
          return connection ?? kernel;
        })
        .finally(() => {
          this._connecting = null;
        });
    }
    return this._connecting;
  }

  private _onIOPub(sender: ISessionContext, msg: KernelMessage.IMessage): void {
    if (msg.header.msg_type === 'execute_input') {
      // Silent requests, as the view's own snippets are, send no input. A
      // cell counts as run once it finished: until then it defines nothing.
      const parent = (msg.parent_header as KernelMessage.IHeader).msg_id;
      this._runningCode.set(
        parent,
        (msg.content as KernelMessage.IExecuteInputMsg['content']).code
      );
    }
    if (msg.header.msg_type === 'error' && msg.parent_header) {
      // The run raised, or was interrupted: the kernel publishes the error to
      // every client, and the execute reply goes only to the one that asked.
      const parent = (msg.parent_header as KernelMessage.IHeader).msg_id;
      if (this._runningCode.has(parent)) {
        this._raisedRuns.add(parent);
      }
    }
    if (
      KernelMessage.isStatusMsg(msg) &&
      msg.content.execution_state === 'idle' &&
      msg.parent_header &&
      'msg_id' in msg.parent_header
    ) {
      const parent = msg.parent_header.msg_id;
      const code = this._runningCode.get(parent);
      if (code === undefined) {
        // A silent request, such as a program of this view or of another
        // view on the kernel: it ran no cell.
        return;
      }
      this._runningCode.delete(parent);
      this._finishedCode.set(code, !this._raisedRuns.delete(parent));
      if (!this._own.has(parent)) {
        this.invalidateAnalysis();
        this._changed.emit('executed');
      }
    }
  }

  private _onStatusChanged(
    sender: ISessionContext,
    status: ISessionContext.KernelDisplayStatus
  ): void {
    if (status === 'starting' && !sender.session) {
      // The session context starts a new session, with a new kernel: its
      // connection comes with the next kernel change.
      this._startingSession = true;
    }
    if (
      status === 'restarting' ||
      status === 'autorestarting' ||
      status === 'dead'
    ) {
      this._dropConnection();
      this._snapshot = null;
      this._analysis.clear();
      this._ranCode.clear();
      this._raisedCode.clear();
      this._runningCode.clear();
      this._raisedRuns.clear();
      this._finishedCode.clear();
      // A restarted kernel is a new process: it holds nothing.
      this._watchedStart = status !== 'dead';
      this._changed.emit('variables');
    }
  }

  private _onKernelChanged(
    sender: ISessionContext,
    change: IChangedArgs<
      Kernel.IKernelConnection | null,
      Kernel.IKernelConnection | null,
      'kernel'
    >
  ): void {
    this._dropConnection();
    this._snapshot = null;
    this._analysis.clear();
    this._ranCode.clear();
    this._raisedCode.clear();
    this._runningCode.clear();
    this._raisedRuns.clear();
    this._finishedCode.clear();
    this._languageName = null;
    // A kernel of a session that the context started now, and not one that
    // it connected to, or that another session had.
    this._watchedStart = !!change.newValue && this._startingSession;
    if (change.newValue) {
      this._startingSession = false;
    }
    this._changed.emit('variables');
    void this._readLanguage();
  }

  /**
   * Read the kernel's language from its info reply, and return the code the
   * view has for it.
   */
  private async _readLanguage(): Promise<ILanguage | null> {
    const kernel = this._sessionContext.session?.kernel;
    if (!kernel) {
      return this.language;
    }
    try {
      const info = await kernel.info;
      const name = info.language_info?.name ?? '';
      if (
        kernel === this._sessionContext.session?.kernel &&
        name !== this._languageName
      ) {
        this._languageName = name;
        this._changed.emit('variables');
      }
    } catch {
      // A kernel that died before its info reply keeps the language unknown.
    }
    return this.language;
  }

  /**
   * The codes that ran in a kernel that ran before the bridge connected to
   * it, as after a reload of the page: the kernel's history of its session
   * lists each input that it ran with its count. Without them, every count
   * of the notebook reads as one of an earlier kernel, and a new cell goes
   * right after the cell asked about, above the cells that ran since
   * (design iteration 1.83). Read once per kernel, on the bridge's own
   * connection, which answers while a cell runs; a kernel that does not
   * answer in HISTORY_WAIT_MS, or that keeps no history, adds nothing.
   * IPython keeps an input without its last line breaks, so a code is kept
   * with one too.
   */
  private async _readHistory(): Promise<void> {
    const kernel = this._sessionContext.session?.kernel ?? null;
    if (!kernel || this._watchedStart || this._historyOf === kernel) {
      return;
    }
    this._historyOf = kernel;
    const read = async (): Promise<KernelMessage.IHistoryReplyMsg | null> => {
      const connection = await this._connect();
      return connection
        ? within(
            connection.requestHistory({
              output: false,
              raw: true,
              hist_access_type: 'range',
              session: 0,
              start: 1,
              stop: 1000000
            }),
            HISTORY_WAIT_MS
          )
        : null;
    };
    const reply = await read().catch(() => null);
    if (
      !reply ||
      reply.content.status !== 'ok' ||
      kernel !== this._sessionContext.session?.kernel
    ) {
      return;
    }
    for (const entry of reply.content.history) {
      const input = entry[2] as unknown;
      const code = Array.isArray(input) ? input[0] : input;
      if (typeof code === 'string') {
        this._ranCode.add(code);
        this._ranCode.add(`${code}\n`);
      }
    }
  }

  /** The listing now holds what the cells that finished defined. */
  private _finishRuns(): void {
    for (const [code, ok] of this._finishedCode) {
      this._ranCode.add(code);
      if (ok) {
        this._raisedCode.delete(code);
      } else {
        this._raisedCode.add(code);
      }
    }
    this._finishedCode.clear();
  }

  private _dropConnection(): void {
    // Disposing a connection bound to a subshell also deletes the subshell.
    this._connection?.dispose();
    this._connection = null;
  }

  private _sessionContext: ISessionContext;
  private _connection: Kernel.IKernelConnection | null = null;
  private _connecting: Promise<Kernel.IKernelConnection | null> | null = null;
  private _snapshot: IKernelSnapshot | null = null;
  private _languageName: string | null = null;
  private _analysis = new Map<
    string,
    {
      source: string;
      result: ICellAnalysis;
      stale: boolean;
      signatures: ISignature[] | null;
    }
  >();
  private _own = new Set<string>();
  private _ranCode = new Set<string>();
  // The kernel whose history of its session the bridge read.
  private _historyOf: Kernel.IKernelConnection | null = null;
  // The codes whose last run raised.
  private _raisedCode = new Set<string>();
  // The code of each execution that runs, by its request's id.
  private _runningCode = new Map<string, string>();
  // The requests of the executions that run and raised.
  private _raisedRuns = new Set<string>();
  // The code of each execution that finished since the last listing, and
  // whether it ended without an error.
  private _finishedCode = new Map<string, boolean>();
  // The session context said it starts a new session; its kernel comes next.
  private _startingSession = false;
  private _watchedStart = false;
  private _isDisposed = false;
  private _changed = new Signal<this, 'variables' | 'analysis' | 'executed'>(
    this
  );
}

/**
 * Give each column the expression, in the kernel's language, and the frame
 * it belongs to. A column of a polars frame also names its library, so that
 * the code written about it is polars code.
 */
export function prepareVariable(
  variable: IVariable | IStoredVariable,
  language: ILanguage = PYTHON
): IVariable {
  if (!variable.columns) {
    // Without columns, a kept variable is one as the kernel lists it.
    return variable as IVariable;
  }
  const library = variable.type?.startsWith('polars.') ? 'polars' : null;
  const columns = variable.columns.map(column => ({
    ...column,
    name: language.column(variable.name, column.label),
    parent: variable.name,
    rows: variable.rows,
    ...(library ? { library } : {})
  }));
  return { ...variable, columns };
}
