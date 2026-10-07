import { URLExt } from '@jupyterlab/coreutils';
import type { ServerConnection } from '@jupyterlab/services';

import { requestAPI, streamAPI } from '../request';
import type { IDropResult, IOption, IWrittenBy, StreamEvent } from '../tokens';
import type { ICustomLocalModel } from './custommodels';
import { customSpec } from './custommodels';
import type {
  GuardAnswer,
  IGuardEvent,
  IGuardHeld,
  IGuardMemory
} from './guard';

/**
 * Where a local model stands: one of the three best for a laptop with 16 GB,
 * the step down or the step up, or a model added in the settings.
 * whybook/server/local_models.py, TIERS.
 */
export type LocalTier = 'recommended' | 'smaller' | 'larger' | 'custom';

/** A model the server runs on this machine: whybook/server/local_models.py. */
export interface ILocalModel {
  id: string;
  label: string;
  kind: 'local';
  tier?: LocalTier;
  /** Null for a model of the settings whose file is not on the machine yet. */
  size_mb: number | null;
  note: string;
  /** The Hugging Face repository of its file. */
  repo?: string | null;
  /** The file on the server's machine, for a model of the settings. */
  path?: string | null;
  available: boolean;
  /** Why it cannot run: no runtime, or no file. */
  reason: string | null;
  /** The file is missing and the server can fetch it. */
  downloadable?: boolean;
}

/** A speech engine the server runs on this machine: whybook/server/speech.py. */
export interface IServerSpeechEngine {
  id: string;
  label: string;
  kind: 'speech';
  size_mb: number;
  note: string;
  /** Where the model's files come from. */
  source?: string;
  available: boolean;
  /** Why it cannot run: no runtime, or no model. */
  reason: string | null;
  /** The model is missing and the server can fetch it. */
  downloadable?: boolean;
}

/** The words of a spoken question: whybook/server/speech.py, ask_transcribe(). */
export interface ITranscript {
  text: string;
  engine: string;
  elapsed?: number;
}

/** A step of a model download: whybook/server/local_models.py, download(). */
export interface IDownloadEvent {
  type: 'progress' | 'result' | 'error';
  /** The share downloaded, when the server knows the size. */
  progress?: number | null;
  message?: string;
}

export interface IServerStatus {
  ranker: string;
  jev_configured: boolean;
  /** Whether the connected model can answer. The name is older than the connection. */
  claude_available: boolean;
  /**
   * Whether the connected model can answer, read without a call to it, and
   * what is missing and how to set it up: whybook/server/connection.py. For
   * the Claude Code login, the CLI that the SDK runs and the credential that
   * the CLI finds; for another provider, a key and a chosen model.
   */
  claude?: {
    available: boolean;
    cli: string | null;
    credential: string | null;
    reason: string | null;
    setup: string | null;
    /** The provider: 'claude-code', 'openrouter', 'huggingface', 'anthropic', 'ollama' and the others. */
    provider?: string;
    model?: string | null;
    /** The model as the view names it: "OpenRouter: anthropic/claude-sonnet-5". */
    label?: string;
    /** Whether the model runs on this machine, so that it may read the data when it stays here. */
    local?: boolean;
    /**
     * Whether a price of the provider's models is known, so that an answer
     * has a cost and a cost cap holds it: false for Hugging Face and for a
     * model server of the analyst's.
     */
    priced?: boolean;
  };
  /** False when the server's config turns off the table labels by the remote model. */
  describe_tables?: boolean;
  /** c.Whybook.claude_model, or null for the default of the remote model's client. */
  remote_model?: string | null;
  local_models?: ILocalModel[];
  /** The speech engines of the server, with the reason each cannot run. */
  speech_engines?: IServerSpeechEngine[];
  /** Why local models use the standard JSON check although the fast one was chosen, if they do. */
  json_check_warning?: string | null;
  /** Whether Jev from TypeSafe can sort typed questions, and why not. */
  jev?: { available: boolean; reason: string | null };
  /**
   * True when the server keeps the data on the machine for every user
   * (c.Whybook.keep_data_local). In a status from `withDataPolicy`, true
   * also when the user's setting keeps it there.
   */
  keep_data_local?: boolean;
  /**
   * True when the server pins zero data retention on OpenRouter for every
   * user (c.Whybook.openrouter_zdr): the setting zeroDataRetention is fixed.
   */
  openrouter_zdr?: boolean;
  /** The review guard's mode when the server fixes it for every user (c.Whybook.review_guard), else "". */
  review_guard?: string;
  /** The guard models of the server, with the reason each cannot run: whybook/server/guard/models.py. */
  guard_models?: ILocalModel[];
  /**
   * The connected provider's models for the tasks that need speed, by tier,
   * the first being the tier's own: whybook/server/tiers.py. Empty lists for
   * a provider that has none, whose tiers the connected model answers.
   */
  remote_tiers?: Record<'fast' | 'fastest', IProviderModel[]>;
  /** Why models of the settings (customLocalModels) were left out, one line each. */
  custom_model_problems?: string[];
}

/** A provider of the connected model, as the AI models panel lists it: whybook/server/routes.py, connection_state. */
export interface IProviderInfo {
  id: string;
  label: string;
  /** True when its model runs on this machine; null when the analyst says, for a server of their own. */
  local: boolean | null;
  base_url: string | null;
  /** The sign-in that gives a key: 'openrouter' or 'huggingface'; null where the key is pasted, or none is needed. */
  signin: 'openrouter' | 'huggingface' | null;
  needs_key: boolean;
  /** The Claude Code login: development only, under Anthropic's terms, and listed only with --Whybook.claude_code_login=True. */
  dev_only: boolean;
  /** Whether the server keeps a key for it. The key itself never reaches the browser. */
  signed_in: boolean;
  /** 'typed' for a pasted key, else the sign-in that gave the key; null without a key. */
  key_from: string | null;
  /** When the key was saved, in UTC: "2026-09-27T10:04:00Z". */
  saved: string | null;
  /** False for a key saved without a check of the provider; null without a key. */
  checked?: boolean | null;
  /** When the provider last refused the saved key, which is then wrong; null when it has not since the key last worked. */
  refused?: string | null;
  /** Whether the server has the Python package of its calls. */
  installed: boolean;
}

/** What the panel shows of a saved key: whybook/server/connection.py, key_state. */
export interface IKeyState {
  saved: string | null;
  /** False for a key saved without a check: the first answer checks it. */
  checked: boolean;
  /** When a provider last refused it. */
  refused: string | null;
}

/** The saved choice of the connected model. */
export interface IConnection {
  provider: string;
  model: string | null;
  base_url: string | null;
  local: boolean;
}

export interface IConnectionState {
  connection: IConnection;
  readiness: NonNullable<IServerStatus['claude']>;
  /** The saved key of the connected model, a server's by its URL; null without one. */
  connected_key?: IKeyState | null;
  providers: IProviderInfo[];
  /** Whether the server has the client id of Whybook's Hugging Face OAuth app; without it, the panel takes a token. */
  huggingface_signin: boolean;
  /** Whether pydantic-ai-slim is installed, which every provider but the Claude Code login needs. */
  models_installed: boolean;
}

/** A model that a provider lists: its id, a name, and a note such as its price or size. */
export interface IProviderModel {
  id: string;
  label: string;
  note: string | null;
}

/**
 * The models of a provider. For a key typed with a server's URL, not saved,
 * also whether the server took it or lists its models without a key too,
 * and when the key saved for that URL was saved.
 */
export interface IListedModels {
  models: IProviderModel[];
  key_check?: 'accepted' | 'not needed';
  saved?: string | null;
}

/** A model server found on this machine, with the models it serves. */
export interface ILocalServer {
  provider: string;
  label: string;
  base_url: string;
  models: IProviderModel[];
}

/** A Hugging Face device code: the code to approve at the address, and how often to ask whether it was approved. */
export interface IDeviceSignIn {
  flow: string;
  user_code: string;
  verification_uri: string;
  /** The address with the code filled in, when the provider gives one. */
  verification_uri_complete: string | null;
  expires_in: number;
  interval: number;
}

/**
 * How a local model's answer is held to its JSON rules: 'fast' asks the
 * rules about the picked token first, 'standard' checks the whole
 * vocabulary before each pick. whybook/server/local_models.py, JSON_CHECKS.
 */
export type JsonCheck = 'fast' | 'standard';

/** A model's type and place for a typed question: the pick and the probability of each option. */
export interface ISortedQuestion {
  type: { choice: string; probabilities: Record<string, number> } | null;
  place: { choice: string; probabilities: Record<string, number> } | null;
  model: string;
  elapsed?: number;
  /** What the call cost: $0 for a local model, null for Jev, whose price is not known. */
  cost_usd?: number | null;
}

/** A value to try for a constant, as Python code, and what it means. */
export interface ISuggestedValue {
  value: string;
  why: string;
}

/**
 * What a model picked from the signature of a library function, as the
 * server keeps it for the library's version: whybook/server/library_defaults.py.
 */
export interface IKeptDefaults {
  function: string;
  library: string;
  version: string | null;
  picks: { param: string; why: string }[];
  by?: IWrittenBy | null;
}

/** The what-if branches of a decision: whybook/server/questions/cells.py, decision_options. */
export interface IDecisionOptions {
  title: string;
  note: string;
  options: IOption[];
  /** The kind of the constant, as the rules read it, such as "a count of days"; null when no rule knows it. */
  kind?: string | null;
  /** How the rules chose the values, such as "common lengths of time". */
  rule?: string | null;
  /** No rule knows the kind: the values are half below and above, until a model suggests others. */
  ask_model?: boolean;
}

/**
 * A call of the view that reached a model, with what it cost, as its result
 * or an error that says what it cost reports it: the view keeps the sums
 * (src/model/cost.ts).
 */
export interface IModelCall {
  /** The server's route, such as 'cells/title': it says the kind of call. */
  route: string;
  /** US dollars; null when no price of the model is known. */
  usd: number | null;
  /** The call's seconds on the server. */
  seconds: number | null;
  /** The model that answered, as the server names it. */
  model: string | null;
  /** The request, which names the cells the call worked on. */
  body: unknown;
  /** The call failed after it reached the model. */
  failed: boolean;
}

/**
 * The server extension's endpoints, for one notebook view.
 */
export class Api {
  constructor(
    private _settings: ServerConnection.ISettings,
    private _options: Api.IOptions = {}
  ) {}

  /**
   * What the server can run, with the local models of the settings, which it
   * lists after its own: those given, or else those of the options.
   */
  status(
    custom: ICustomLocalModel[] = this._options.customModels?.() ?? []
  ): Promise<IServerStatus> {
    return requestAPI<IServerStatus>('status', this._settings, {
      method: 'POST',
      body: JSON.stringify({ custom_local_models: custom })
    });
  }

  drop(body: unknown): Promise<IDropResult> {
    return this._post<IDropResult>('drop', body);
  }

  cellQuestions(body: unknown): Promise<{ questions: IOption[] }> {
    return this._post('cell-questions', body);
  }

  /**
   * What-if branches for one decision of a cell, for one value typed, or for
   * the values a model suggested (`suggested`). Without either, the values
   * follow the kind of the constant: `kind` names it, `rule` says how the
   * values were chosen, and `ask_model` is true when no rule knows the kind.
   */
  decisionOptions(body: unknown): Promise<IDecisionOptions> {
    return this._post('decision', body);
  }

  /**
   * Other values of a constant from the model chosen for More questions, when
   * no rule knows the kind of the constant: a result event with `kind`, the
   * model's words for it, and `values`, each a value and why.
   */
  decisionValues(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'decision/values',
      this._settings,
      this._guarded(this._local(body)),
      this._cost('decision/values', body, this._watch(onEvent)),
      signal
    );
  }

  /**
   * The picks that the server kept for these library functions, each for
   * its library's version, read without a model: "Find more defaults with AI".
   */
  libraryDefaults(body: unknown): Promise<{ answers: IKeptDefaults[] }> {
    return this._post('defaults', body);
  }

  /**
   * The model chosen for More questions picks, from one function's
   * signature, the defaults that can change a result: a result event with
   * `picks` and `by`. For a function that the server has an answer for, the
   * result says `kept: true`: no model was asked, and no call is counted.
   */
  askLibraryDefaults(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const counted = this._cost('defaults/ask', body, this._watch(onEvent));
    return streamAPI(
      'defaults/ask',
      this._settings,
      this._guarded(this._local(body), true),
      event =>
        event.type === 'result' && event.kept === true
          ? onEvent(event)
          : counted(event),
      signal
    );
  }

  next(body: unknown): Promise<{ questions: IOption[] }> {
    return this._post('next', body);
  }

  solve(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'solve',
      this._settings,
      this._guarded(this._policy(body)),
      this._cost('solve', body, onEvent),
      signal
    );
  }

  /** The type, and with Jev the place, of a question the analyst types. */
  async sortQuestion(body: unknown): Promise<ISortedQuestion> {
    const sorted = await this._post<ISortedQuestion>('questions/sort', body);
    this._options.onCall?.({
      route: 'questions/sort',
      usd: typeof sorted.cost_usd === 'number' ? sorted.cost_usd : null,
      seconds: typeof sorted.elapsed === 'number' ? sorted.elapsed : null,
      model: sorted.model ?? null,
      body,
      failed: false
    });
    return sorted;
  }

  claudeQuestions(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'questions/claude',
      this._settings,
      this._guarded(this._local(body), true),
      this._cost('questions/claude', body, this._watch(onEvent)),
      signal
    );
  }

  /**
   * What a reviewer would ask about the whole notebook, from the model chosen
   * for More questions: a result event with `questions`, each with the label
   * of its cell. The check-up asks it (src/model/checkup.ts).
   */
  reviewQuestions(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'questions/review',
      this._settings,
      this._guarded(this._local(body)),
      this._cost('questions/review', body, this._watch(onEvent)),
      signal
    );
  }

  /**
   * The probability that each offered question is worth asking next, from
   * the model chosen for "Question order": a result event with `scores`,
   * from question id to probability.
   */
  rankQuestions(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'questions/rank',
      this._settings,
      this._guarded(this._policy(body), true),
      this._cost('questions/rank', body, onEvent),
      signal
    );
  }

  /**
   * An answer by an agent that adds and runs cells: the run's events, with
   * a `tool` event for each step that the view runs and posts back with
   * `agentResult`.
   */
  agent(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'agent',
      this._settings,
      this._guarded(this._policy(body)),
      this._cost('agent', body, onEvent),
      signal
    );
  }

  /** What a step of an agent's run did in the notebook. */
  agentResult(body: {
    run: string;
    call: string;
    result: unknown;
  }): Promise<{ ok: boolean }> {
    return this._post('agent/result', body);
  }

  /** The analyst's answer to a question of the review guard: the request that waits goes on. */
  guardAnswer(
    id: string,
    answer: GuardAnswer,
    note: string
  ): Promise<{ ok: boolean }> {
    return requestAPI('guard/answer', this._settings, {
      method: 'POST',
      body: JSON.stringify({ id, answer, note })
    });
  }

  /** What the server keeps of a session of the review guard, after a change: forget an answer, or allow what a held item flagged. */
  guardSession(body: {
    session: string;
    forget?: number | 'all';
    allow?: unknown;
  }): Promise<IGuardMemory> {
    return requestAPI('guard/session', this._settings, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  /** Stop an agent's run; the cells it added stay. */
  agentStop(run: string): Promise<{ ok: boolean }> {
    return this._post('agent/stop', { run });
  }

  /**
   * The cells to run so that some names exist, read from the source; with
   * `before`, also the names that cell uses and the kernel lacks (`inputs`).
   */
  dependencies(body: unknown): Promise<{
    cells: string[];
    unresolved: string[];
    unparsed: string[];
    inputs?: string[];
  }> {
    return this._post('dependencies', body);
  }

  claudeDependencies(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'dependencies/claude',
      this._settings,
      this._guarded(this._policy(body)),
      this._cost('dependencies/claude', body, onEvent),
      signal
    );
  }

  describeTables(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'tables/describe',
      this._settings,
      this._guarded(this._local(body), true),
      this._cost('tables/describe', body, this._watch(onEvent)),
      signal
    );
  }

  describeFrames(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'frames/describe',
      this._settings,
      this._guarded(this._local(body), true),
      this._cost('frames/describe', body, this._watch(onEvent)),
      signal
    );
  }

  /** Titles for code cells that the analyst edited: whybook/server/cell_titles.py. */
  titleCells(
    body: unknown,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'cells/title',
      this._settings,
      this._guarded(this._local(body), true),
      this._cost('cells/title', body, this._watch(onEvent)),
      signal
    );
  }

  /** Fetch a local model's file into the server's Hugging Face cache. */
  downloadModel(
    model: string,
    onEvent: (event: IDownloadEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'models/download',
      this._settings,
      this._withSpec({ model }),
      event => onEvent(event as unknown as IDownloadEvent),
      signal
    );
  }

  /**
   * The words of a spoken question: a WAV file of 16-bit mono PCM, written
   * as text by a speech engine of the server, which favours the names given.
   */
  transcribe(
    engine: string,
    wav: ArrayBuffer,
    terms: string[] = []
  ): Promise<ITranscript> {
    const query = new URLSearchParams([
      ['engine', engine],
      ...terms.map(term => ['term', term])
    ]);
    return requestAPI<ITranscript>(
      `speech/transcribe?${query.toString()}`,
      this._settings,
      { method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav' } }
    );
  }

  /** Fetch a speech engine's model into the server, as its library does. */
  downloadSpeech(
    engine: string,
    onEvent: (event: IDownloadEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamAPI(
      'speech/download',
      this._settings,
      { engine },
      event => onEvent(event as unknown as IDownloadEvent),
      signal
    );
  }

  /** The connected model and each provider. */
  connection(): Promise<IConnectionState> {
    return requestAPI<IConnectionState>('connection', this._settings);
  }

  /**
   * Save a new connection, after the server checks at no cost that the
   * provider lists the model. A key typed with a server's URL is saved with
   * it once the server takes the key; `check: false` saves both without the
   * check, the key marked as not checked.
   */
  saveConnection(body: {
    provider: string;
    model: string | null;
    base_url?: string | null;
    local?: boolean;
    key?: string;
    check?: false;
  }): Promise<IConnectionState> {
    return requestAPI<IConnectionState>('connection', this._settings, {
      method: 'POST',
      // The check of an OpenRouter model reads the list with the choice of zero data retention.
      body: JSON.stringify(this._retention(body))
    });
  }

  /**
   * The models of a provider, as its endpoint lists them. A POST, which
   * Jupyter checks for its XSRF token, where a page of any site can make the
   * browser send a GET: the server sends a key typed for a server only to
   * the URL it was typed for. A key typed with the URL goes with the request
   * and is saved by nothing: the server checks it.
   */
  connectionModels(
    provider: string,
    baseUrl?: string | null,
    key?: string
  ): Promise<IListedModels> {
    return requestAPI('connection/models', this._settings, {
      method: 'POST',
      // With zero data retention, OpenRouter lists the models that have a provider that keeps no data.
      body: JSON.stringify(
        this._retention({ provider, base_url: baseUrl || null, key })
      )
    });
  }

  /** The model servers that answer on this machine. */
  localServers(): Promise<{ servers: ILocalServer[] }> {
    return requestAPI('connection/local', this._settings);
  }

  /**
   * Start a sign-in with OpenRouter. OpenRouter sends the browser back to the
   * server's callback when it takes the server's address; otherwise it shows
   * a code, and `mode` is 'code'.
   */
  openRouterSignIn(): Promise<{
    state: string;
    url: string;
    mode: 'callback' | 'code';
  }> {
    return requestAPI('auth/openrouter', this._settings, {
      method: 'POST',
      body: JSON.stringify({
        callback_base: URLExt.join(
          this._settings.baseUrl,
          'whybook',
          'auth',
          'openrouter',
          'callback'
        )
      })
    });
  }

  /** The code that OpenRouter showed, pasted into the panel. */
  openRouterCode(state: string, code: string): Promise<IConnectionState> {
    return requestAPI<IConnectionState>(
      'auth/openrouter/code',
      this._settings,
      {
        method: 'POST',
        body: JSON.stringify({ state, code })
      }
    );
  }

  /** Start a sign-in with Hugging Face: a device code to approve on huggingface.co. */
  huggingFaceSignIn(): Promise<IDeviceSignIn> {
    return requestAPI<IDeviceSignIn>('auth/huggingface', this._settings, {
      method: 'POST',
      body: '{}'
    });
  }

  /** Ask once whether the device code was approved. */
  huggingFacePoll(flow: string): Promise<{
    status: 'pending' | 'done' | 'expired' | 'denied' | 'error';
    interval?: number;
    message?: string;
  }> {
    return requestAPI('auth/huggingface/poll', this._settings, {
      method: 'POST',
      body: JSON.stringify({ flow })
    });
  }

  /**
   * Keep a key pasted into the panel, after the server checks it at no cost.
   * With `check` false the server keeps it without the check, marked as not
   * checked: Save anyway, or Save without a check.
   */
  saveKey(
    provider: string,
    key: string,
    check = true
  ): Promise<IConnectionState> {
    return requestAPI<IConnectionState>('auth/key', this._settings, {
      method: 'POST',
      body: JSON.stringify(check ? { provider, key } : { provider, key, check })
    });
  }

  /** Forget the key of a provider on the server. */
  signOut(provider: string): Promise<IConnectionState> {
    return requestAPI<IConnectionState>('auth/signout', this._settings, {
      method: 'POST',
      body: JSON.stringify({ provider })
    });
  }

  private _post<T>(endpoint: string, body: unknown): Promise<T> {
    return requestAPI<T>(endpoint, this._settings, {
      method: 'POST',
      body: JSON.stringify(this._policy(body))
    });
  }

  /** The body of a request that a local model may answer, with the JSON check of the settings. */
  private _local(body: unknown): unknown {
    const check = this._options.jsonCheck?.();
    return this._policy(
      check && body && typeof body === 'object'
        ? { ...body, json_check: check }
        : body
    );
  }

  /**
   * The body with `keep_data_local` when the data stays on this machine, so
   * that the server keeps values, tables and pictures from remote models,
   * and with `zero_data_retention: false` when the analyst turned it off.
   */
  private _policy(body: unknown): unknown {
    const withSpec = this._retention(this._withSpec(body));
    return this._options.keepDataLocal?.() &&
      withSpec &&
      typeof withSpec === 'object' &&
      !Array.isArray(withSpec)
      ? { ...withSpec, keep_data_local: true }
      : withSpec;
  }

  /**
   * The body of a request that can reach a model, with the review guard's
   * object: what the view chose, and what the notebook tells of its data
   * and its kernel. Other requests go without it. A request that nobody
   * waits on, such as a table's labels, is `background`: the guard holds it
   * back without a question.
   */
  private _guarded(body: unknown, background = false): unknown {
    const guard = this._options.guard?.();
    return guard && body && typeof body === 'object' && !Array.isArray(body)
      ? { ...body, guard: background ? { ...guard, background } : guard }
      : body;
  }

  /**
   * The body with `zero_data_retention: false` when the analyst turned zero
   * data retention off, and the server does not pin it: requests through
   * OpenRouter may then go to any provider. A body without it keeps the
   * providers that keep no data.
   */
  private _retention(body: unknown): unknown {
    return this._options.zeroDataRetention?.() === false &&
      body &&
      typeof body === 'object' &&
      !Array.isArray(body)
      ? { ...body, zero_data_retention: false }
      : body;
  }

  /**
   * The body with `model_spec` when it names a model of the settings, so
   * that the server runs it even after a restart, before the next status.
   */
  private _withSpec(body: unknown): unknown {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return body;
    }
    const model = (body as { model?: unknown }).model;
    const spec =
      typeof model === 'string'
        ? customSpec(this._options.customModels?.() ?? [], model)
        : undefined;
    return spec ? { ...body, model_spec: spec } : body;
  }

  /**
   * Passes the events of a route that calls a model on, and tells onCall
   * once what the call cost: at its result, or at an error that says what
   * the call cost before it failed. A stream that ends without either, such
   * as one the view closes, tells nothing.
   */
  private _cost(
    route: string,
    body: unknown,
    onEvent: (event: StreamEvent) => void
  ): (event: StreamEvent) => void {
    let told = false;
    return event => {
      const kind = (event as { type: string }).type;
      if (kind === 'guard') {
        // A question of the review guard: the request waits for the answer.
        const question = event as unknown as IGuardEvent;
        const ask = this._options.onGuard;
        void (
          ask
            ? ask(question)
            : Promise.resolve({ answer: 'stop' as GuardAnswer, note: '' })
        )
          .catch(() => ({ answer: 'stop' as GuardAnswer, note: '' }))
          .then(({ answer, note }) =>
            this.guardAnswer(question.id, answer, note)
          )
          .catch(() => undefined);
        return;
      }
      if (kind === 'guard_held') {
        this._options.onGuardHeld?.(event as unknown as IGuardHeld);
        // An agent's run shows it among its steps.
        if (route !== 'agent') {
          return;
        }
      }
      // The server pings while a question waits; only an agent's run reads pings.
      if (kind === 'ping' && route !== 'agent') {
        return;
      }
      const cost = (event as { cost_usd?: unknown }).cost_usd;
      if (
        !told &&
        (event.type === 'result' ||
          (event.type === 'error' && typeof cost === 'number'))
      ) {
        told = true;
        const elapsed = (event as { elapsed?: unknown }).elapsed;
        const model = (event as { model?: unknown }).model;
        this._options.onCall?.({
          route,
          usd: typeof cost === 'number' ? cost : null,
          seconds: typeof elapsed === 'number' ? elapsed : null,
          model: typeof model === 'string' ? model : null,
          body,
          failed: event.type === 'error'
        });
      }
      onEvent(event);
    };
  }

  /** Passes the events on, and the warning of a local model's result to onWarning. */
  private _watch(
    onEvent: (event: StreamEvent) => void
  ): (event: StreamEvent) => void {
    return event => {
      if (event.type === 'result' && typeof event.warning === 'string') {
        this._options.onWarning?.(event.warning);
      }
      onEvent(event);
    };
  }
}

export namespace Api {
  export interface IOptions {
    /** The JSON check of local models that the settings chose. */
    jsonCheck?: () => JsonCheck;
    /** Called with the warning of a local model's run, such as a fast JSON check that failed. */
    onWarning?: (message: string) => void;
    /** Whether the data stays on this machine: the requests then say so. */
    keepDataLocal?: () => boolean;
    /**
     * Whether requests through OpenRouter go only to providers that keep no
     * data: when it is false, the requests say so.
     */
    zeroDataRetention?: () => boolean;
    /** The local models that the settings add: customLocalModels. */
    customModels?: () => ICustomLocalModel[];
    /** Called once for each call that reached a model, with what it cost. */
    onCall?: (call: IModelCall) => void;
    /** The review guard's object of each request: src/model/guard.ts, guardBody. */
    guard?: () => Record<string, unknown>;
    /** Asks the analyst a question of the review guard. */
    onGuard?: (
      event: IGuardEvent
    ) => Promise<{ answer: GuardAnswer; note: string }>;
    /** Told what the guard held back in reject mode. */
    onGuardHeld?: (event: IGuardHeld) => void;
  }
}
