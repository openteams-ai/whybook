import { Button, HTMLSelect } from '@jupyterlab/ui-components';
import type { ISignal } from '@lumino/signaling';
import * as React from 'react';

import type {
  IConnectionState,
  IListedModels,
  ILocalServer,
  IProviderInfo,
  IProviderModel
} from '../model/api';
import type { IKeyCheck } from '../model/connection';
import {
  capital,
  connectedKeyLine,
  filterExample,
  filterModels,
  keyCheckOf,
  keyCheckText,
  keyProblem,
  keyWords,
  messageOf,
  providerOf,
  savedKey,
  SELECT_MODELS
} from '../model/connection';
import type { EpiModel } from '../model/epimodel';
import { isRemote, TASKS } from '../model/models';
import { HelpButton } from './common';

const HELP =
  'The model that answers the tasks set to the remote model, and writes cells and answers. The provider comes first, then one of the models it lists. A model on this machine reads the data as the local models do; a hosted model gets what "Keep data on this machine" allows. Keys stay on the server, in a file only you can read.';

/**
 * The providers whose key is pasted into the panel: what the key is, with
 * its article, where it comes from, what it looks like, and how the server
 * checks it at no cost.
 */
const KEYS: Record<
  string,
  {
    article: string;
    what: string;
    where: string;
    placeholder: string;
    checks: string;
  }
> = {
  huggingface: {
    article: 'A',
    what: 'Hugging Face access token with the permission "Make calls to Inference Providers"',
    where: 'https://huggingface.co/settings/tokens',
    placeholder: 'hf_…',
    checks: 'it says whose token it is'
  },
  anthropic: {
    article: 'An',
    what: 'Anthropic API key',
    where: 'https://platform.claude.com/settings/keys',
    placeholder: 'sk-ant-…',
    checks: 'it lists its models with it'
  },
  openai: {
    article: 'An',
    what: 'OpenAI API key',
    where: 'https://platform.openai.com/api-keys',
    placeholder: 'sk-…',
    checks: 'it lists its models with it'
  },
  google: {
    article: 'A',
    what: 'Gemini API key',
    where: 'https://aistudio.google.com/apikey',
    placeholder: 'AIza…',
    checks: 'it lists its models with it'
  },
  mistral: {
    article: 'A',
    what: 'Mistral AI API key',
    where: 'https://console.mistral.ai/api-keys',
    placeholder: 'API key',
    checks: 'it lists its models with it'
  }
};

/** The tooltips of the buttons that follow a failed check of a key. */
const TRY_AGAIN =
  'Check the key again: some providers take a minute to accept a key they just made.';
const SAVE_ANYWAY =
  'Save the key although the provider refused it. It is marked as not checked until an answer uses it.';
const SAVE_UNCHECKED =
  'Save the key without a check. It is marked as not checked until an answer uses it.';

/** The companies whose models come with an API key, in the order of the panel, and what each serves. */
const COMPANIES: [string, string][] = [
  ['anthropic', 'Claude models'],
  ['openai', 'GPT models'],
  ['google', 'Gemini models'],
  ['mistral', 'Mistral models']
];

/** The provider being set up in the panel: its id, and for a server its URL and whether it runs here. */
interface IPick {
  provider: string;
  baseUrl?: string | null;
  local?: boolean;
  key?: string;
  /** Opened by a sign-in or a saved key, not by a button of the provider's row. */
  afterSignIn?: boolean;
}

/** Re-render when a signal fires. */
function useSignal<T, U>(signal: ISignal<T, U>): void {
  const [, update] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => {
    const changed = () => update();
    signal.connect(changed);
    return () => {
      signal.disconnect(changed);
    };
  }, [signal]);
}

/**
 * Where the keyboard focus goes when the control that has it goes away, as
 * "Connect a model" does once the list opens, or "Forget key" once the key
 * is gone: to the control that takes its place, which `find` looks up after
 * the panel draws. The focus would fall to the page, and the next Tab would
 * leave the panel, which closes. A focus that the analyst moved meanwhile
 * stays where it is.
 */
function useRefocus(): (find: () => HTMLElement | null | undefined) => void {
  const pending = React.useRef<{
    find: () => HTMLElement | null | undefined;
    from: Element | null;
  } | null>(null);
  React.useLayoutEffect(() => {
    const wait = pending.current;
    if (!wait) {
      return;
    }
    const active = document.activeElement;
    // A control that is still there keeps the focus; one that a browser
    // already took the focus from, as from a button it disabled, left it
    // on the page.
    if (wait.from?.isConnected && wait.from !== document.body) {
      if (active !== wait.from) {
        pending.current = null;
      }
      return;
    }
    if (active && active !== document.body) {
      pending.current = null;
      return;
    }
    const target = wait.find();
    if (target) {
      pending.current = null;
      target.focus();
    }
  });
  return React.useCallback(find => {
    pending.current = { find, from: document.activeElement };
  }, []);
}

/**
 * The connected model, at the top of the AI models panel: which provider
 * and model answer the tasks set to the remote model, and a way to change
 * them. research/model-access.md, "A smooth first run".
 */
/**
 * What waits while no model is connected: the tasks set to the remote model,
 * and which of them a local model can do instead.
 */
function waitingLine(model: EpiModel): string {
  const waiting = TASKS.filter(task =>
    isRemote(model.settings.models[task.id])
  );
  if (!waiting.length) {
    return 'No task uses a remote model.';
  }
  // Quoted, since two of the names hold an "and" of their own.
  const names = (tasks: typeof TASKS) =>
    joinWords(tasks.map(task => `"${task.label}"`));
  const local = waiting.filter(task => task.local);
  const line = `${names(waiting)} ${waiting.length === 1 ? 'waits' : 'wait'} for a model.`;
  return local.length
    ? `${line} A local model can do ${names(local)}: choose it below.`
    : line;
}

/** "a", "a and b", "a, b and c". */
function joinWords(words: string[]): string {
  return words.length < 2
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function ConnectionSection(props: {
  model: EpiModel;
  /** Called with each state of the connection that the section reads or gets. */
  onState?: (state: IConnectionState) => void;
}): JSX.Element {
  const { model } = props;
  const { api, signIns } = model;
  useSignal(signIns.changed);
  const node = React.useRef<HTMLDivElement>(null);
  const refocus = useRefocus();
  // The button that opens and closes the list of providers.
  const toggle = () =>
    node.current?.querySelector<HTMLElement>(
      '.jp-Epi-connection-head > button:not(.jp-Epi-help)'
    );
  // The first button of a provider's row, such as Paste key after Forget key.
  const rowButton = (provider: string) =>
    node.current?.querySelector<HTMLElement>(
      `.jp-Epi-provider[data-provider="${CSS.escape(provider)}"] .jp-Epi-provider-actions button:not(:disabled)`
    );
  const [state, setState] = React.useState<IConnectionState | null>(null);
  // The panel reads the state too: zero data retention shows with OpenRouter.
  const onState = React.useRef(props.onState);
  onState.current = props.onState;
  React.useEffect(() => {
    if (state) {
      onState.current?.(state);
    }
  }, [state]);
  const [open, setOpen] = React.useState(false);
  const [help, setHelp] = React.useState(false);
  const [servers, setServers] = React.useState<ILocalServer[] | null>(null);
  const [pick, setPick] = React.useState<IPick | null>(null);
  // The provider whose key form is open.
  const [keying, setKeying] = React.useState<string | null>(null);
  // A key typed with a server's URL is being checked: its form is locked.
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api
      .connection()
      .then(setState)
      .catch(reason => setError(messageOf(reason)));
  }, [api]);
  React.useEffect(load, [load]);

  const lookForServers = React.useCallback(() => {
    setServers(null);
    api
      .localServers()
      .then(found => setServers(found.servers))
      .catch(() => setServers([]));
  }, [api]);
  React.useEffect(() => {
    if (open && servers === null) {
      lookForServers();
    }
  }, [open]);

  // A sign-in that ended while the panel was open, or closed: its models come
  // next, once, under its row.
  React.useEffect(() => {
    if (signIns.signedIn) {
      setPick({ provider: signIns.signedIn, afterSignIn: true });
      setOpen(true);
      signIns.signedIn = null;
      load();
    }
  });

  const saved = (next: IConnectionState) => {
    // The list closes: the focus goes to the button that opens it again.
    refocus(toggle);
    setState(next);
    setPick(null);
    setOpen(false);
    setError(null);
    model.refreshStatus();
  };
  // A key that the server checked and kept: the provider's models come next,
  // and take the focus from the form. A key kept without a check, which the
  // list of models would check at once, leaves the list to the analyst:
  // the focus goes to the row's Models.
  const keySaved =
    (provider: string) => (next: IConnectionState, checked: boolean) => {
      if (checked) {
        refocus(() =>
          node.current?.querySelector<HTMLElement>(
            `.jp-Epi-modelpicker[data-provider="${CSS.escape(provider)}"]`
          )
        );
        setPick({ provider, afterSignIn: true });
      } else {
        refocus(() => rowButton(provider));
        if (pick?.provider === provider) {
          setPick(null);
        }
      }
      setState(next);
      setKeying(null);
    };
  // Without its key, a provider lists no models: its list closes, and the
  // focus goes to what its row offers instead, such as Paste key.
  const signOut = (provider: string) => {
    refocus(() => rowButton(provider));
    if (pick?.provider === provider) {
      setPick(null);
    }
    void api.signOut(provider).then(setState);
  };
  const keyForm = (provider: IProviderInfo | undefined) =>
    provider &&
    keying === provider.id && (
      <KeyForm
        model={model}
        provider={provider}
        onSaved={keySaved(provider.id)}
      />
    );

  if (!state) {
    return (
      <div className="jp-Epi-connection">
        <div className="jp-Epi-connection-head">
          <span className="jp-Epi-tasklabel">Connected model</span>
        </div>
        <div
          className={error ? 'jp-Epi-aipanel-note' : 'jp-Epi-connection-note'}
        >
          {error ? `The server did not answer: ${error}` : 'Asking the server…'}
        </div>
      </div>
    );
  }
  const { readiness } = state;
  // No model is connected yet: nothing is wrong, and the tasks set to the
  // remote model wait for one.
  const unconnected = readiness.provider === 'none';
  const openRouter = providerOf(state, 'openrouter');
  const huggingFace = providerOf(state, 'huggingface');
  // Listed only when the server starts with --Whybook.claude_code_login=True.
  const claudeCode = providerOf(state, 'claude-code');
  // A list with the saved key checks that key: a refusal, or a key that
  // had a mark, changes what the rows say, so the state is read again.
  const marked = (
    key?: { checked?: boolean | null; refused?: string | null } | null
  ) => key?.checked === false || !!key?.refused;
  const listedWith = (provider: string) => (took: boolean) => {
    if (
      !took ||
      marked(providerOf(state, provider)) ||
      marked(state.connected_key)
    ) {
      load();
    }
  };
  // A provider's models open under its own row, right after it.
  const pickerFor = (provider: string) =>
    pick?.provider === provider && (
      <ModelPicker
        key={`${pick.provider} ${pick.baseUrl ?? ''}`}
        model={model}
        pick={pick}
        label={providerOf(state, provider)?.label ?? provider}
        onSaved={saved}
        onChecked={listedWith(provider)}
        onChecking={setChecking}
      />
    );
  const keyLine = connectedKeyLine(state);
  return (
    <div className="jp-Epi-connection" aria-label="Connected model" ref={node}>
      <div className="jp-Epi-connection-head">
        <span className="jp-Epi-tasklabel">
          Connected model
          <HelpButton
            label="Connected model"
            text={HELP}
            open={help}
            onToggle={() => setHelp(!help)}
          />
        </span>
        {unconnected && !open ? (
          <Button
            small
            className="jp-mod-styled jp-mod-accept jp-Epi-connect"
            aria-expanded={open}
            onClick={() => {
              // The link that closes the list takes the button's place.
              refocus(toggle);
              setOpen(true);
              setPick(null);
            }}
          >
            Connect a model
          </Button>
        ) : (
          <button
            className="jp-Epi-link"
            aria-expanded={open}
            onClick={() => {
              refocus(toggle);
              setOpen(!open);
              setPick(null);
            }}
          >
            {open
              ? 'Close'
              : readiness.available
                ? 'Change'
                : 'Connect a model'}
          </button>
        )}
      </div>
      {help && <div className="jp-Epi-help-text">{HELP}</div>}
      <div
        // No green dot for a model whose provider refused the saved key.
        className={`jp-Epi-connection-now${readiness.available && !keyLine?.wrong ? ' jp-mod-ready' : ''}`}
      >
        {readiness.label}
      </div>
      {keyLine && (
        <div
          className={
            keyLine.wrong ? 'jp-Epi-aipanel-note' : 'jp-Epi-connection-note'
          }
        >
          {keyLine.text}
        </div>
      )}
      {unconnected ? (
        <div className="jp-Epi-connection-note">{waitingLine(model)}</div>
      ) : (
        !readiness.available && (
          <div className="jp-Epi-aipanel-note">
            Cannot run: {readiness.reason}. {readiness.setup ?? ''}
          </div>
        )
      )}
      {readiness.available && readiness.local && (
        <div className="jp-Epi-connection-note">
          Runs on this machine: it reads the data as the local models do.
        </div>
      )}
      {open && (
        <div className="jp-Epi-connection-choose">
          {!state.models_installed && (
            <div className="jp-Epi-aipanel-note jp-mod-warning">
              Every choice but the Claude Code login needs pydantic-ai-slim on
              the server: pip install -e ".[models]", then restart it.
            </div>
          )}
          <div className="jp-Epi-connection-group">On this machine</div>
          {servers === null && (
            <div className="jp-Epi-connection-note">
              Looking for model servers…
            </div>
          )}
          {servers?.length === 0 && (
            <div className="jp-Epi-connection-note">
              No model server answers on this machine. Start Ollama, LM Studio,
              llama.cpp or vLLM, then{' '}
              <button className="jp-Epi-link" onClick={lookForServers}>
                look again
              </button>
              .
            </div>
          )}
          {servers?.map(server => (
            <React.Fragment key={server.provider}>
              <ProviderRow
                provider={server.provider}
                label={server.label}
                note={`${server.models.length} ${server.models.length === 1 ? 'model' : 'models'} at ${server.base_url}`}
              >
                <Button
                  small
                  minimal
                  onClick={() =>
                    setPick({
                      provider: server.provider,
                      baseUrl: server.base_url
                    })
                  }
                >
                  Choose
                </Button>
              </ProviderRow>
              {pickerFor(server.provider)}
            </React.Fragment>
          ))}
          <div className="jp-Epi-connection-group">Sign in</div>
          <ProviderRow
            provider="openrouter"
            label="OpenRouter"
            note={
              openRouter?.signed_in
                ? openRouter.refused
                  ? `${capital(keyWords(openRouter))}: sign in again`
                  : 'Signed in: your own key, kept on the server'
                : 'Claude, GPT, Gemini and open models, with a key of your own'
            }
            wrong={!!openRouter?.signed_in && !!openRouter.refused}
          >
            {openRouter?.signed_in ? (
              <>
                <Button
                  small
                  minimal
                  onClick={() => setPick({ provider: 'openrouter' })}
                >
                  Models
                </Button>
                <Button small minimal onClick={() => signOut('openrouter')}>
                  Sign out
                </Button>
              </>
            ) : (
              <Button
                small
                minimal
                onClick={() => void signIns.startOpenRouter()}
              >
                Sign in
              </Button>
            )}
          </ProviderRow>
          {pickerFor('openrouter')}
          {signIns.openRouter?.mode === 'callback' && (
            <div className="jp-Epi-connection-note">
              Approve Whybook on openrouter.ai, in the new tab: this panel
              notices when you are back.
            </div>
          )}
          {signIns.openRouter?.mode === 'code' && <PasteCode model={model} />}
          <ProviderRow
            provider="huggingface"
            label="Hugging Face"
            note={
              huggingFace?.signed_in
                ? huggingFace.key_from === 'typed' || huggingFace.refused
                  ? `${capital(keyWords(huggingFace, 'token'))}: open models of many companies`
                  : 'Signed in: open models of many companies'
                : 'Open models, each served by a company you pick at its price'
            }
            wrong={!!huggingFace?.signed_in && !!huggingFace.refused}
          >
            {huggingFace?.signed_in ? (
              <>
                <Button
                  small
                  minimal
                  onClick={() => setPick({ provider: 'huggingface' })}
                >
                  Models
                </Button>
                {huggingFace.key_from === 'typed' && (
                  <Button
                    small
                    minimal
                    aria-expanded={keying === 'huggingface'}
                    onClick={() =>
                      setKeying(keying === 'huggingface' ? null : 'huggingface')
                    }
                  >
                    Replace token
                  </Button>
                )}
                <Button small minimal onClick={() => signOut('huggingface')}>
                  {huggingFace.key_from === 'typed'
                    ? 'Forget token'
                    : 'Sign out'}
                </Button>
              </>
            ) : (
              <>
                {state.huggingface_signin && (
                  <Button
                    small
                    minimal
                    onClick={() => void signIns.startHuggingFace()}
                  >
                    Sign in
                  </Button>
                )}
                <Button
                  small
                  minimal
                  aria-expanded={keying === 'huggingface'}
                  onClick={() =>
                    setKeying(keying === 'huggingface' ? null : 'huggingface')
                  }
                >
                  Paste a token
                </Button>
              </>
            )}
          </ProviderRow>
          {pickerFor('huggingface')}
          {signIns.huggingFace && (
            <div className="jp-Epi-devicecode" role="status">
              Approve the code <code>{signIns.huggingFace.user_code}</code> at{' '}
              <a
                href={
                  signIns.huggingFace.verification_uri_complete ??
                  signIns.huggingFace.verification_uri
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                {signIns.huggingFace.verification_uri.replace(
                  /^https:\/\//,
                  ''
                )}
              </a>
              . This panel notices when it is done.
            </div>
          )}
          {keyForm(huggingFace)}
          {signIns.error && (
            <div className="jp-Epi-aipanel-note jp-mod-warning">
              {signIns.error}
            </div>
          )}
          <div className="jp-Epi-connection-group">With an API key</div>
          {COMPANIES.map(([id, serves]) => {
            const company = providerOf(state, id);
            if (!company) {
              return null;
            }
            return (
              <React.Fragment key={id}>
                <ProviderRow
                  provider={id}
                  label={company.label}
                  note={
                    !company.installed
                      ? 'Needs its Python package on the server: pip install -e ".[models]"'
                      : company.signed_in
                        ? `${serves}: ${keyWords(company)}`
                        : serves
                  }
                  wrong={company.signed_in && !!company.refused}
                >
                  {company.signed_in ? (
                    <>
                      <Button
                        small
                        minimal
                        disabled={!company.installed}
                        onClick={() => setPick({ provider: id })}
                      >
                        Models
                      </Button>
                      {/* A new key is checked before it takes the saved key's place. */}
                      <Button
                        small
                        minimal
                        disabled={!company.installed}
                        aria-expanded={keying === id}
                        onClick={() => setKeying(keying === id ? null : id)}
                      >
                        Replace key
                      </Button>
                      <Button small minimal onClick={() => signOut(id)}>
                        Forget key
                      </Button>
                    </>
                  ) : (
                    <Button
                      small
                      minimal
                      disabled={!company.installed}
                      aria-expanded={keying === id}
                      onClick={() => setKeying(keying === id ? null : id)}
                    >
                      Paste key
                    </Button>
                  )}
                </ProviderRow>
                {pickerFor(id)}
                {keyForm(company)}
              </React.Fragment>
            );
          })}
          <div className="jp-Epi-connection-group">Other</div>
          {claudeCode && (
            <ProviderRow
              provider="claude-code"
              label="Claude, with the Claude Code login"
              note="Development only, under Anthropic's terms"
            >
              <Button
                small
                minimal
                onClick={() =>
                  api
                    .saveConnection({ provider: 'claude-code', model: null })
                    .then(saved)
                    .catch(reason => setError(messageOf(reason)))
                }
              >
                Use
              </Button>
            </ProviderRow>
          )}
          <OwnServer onPick={setPick} locked={checking} />
          {pickerFor('openai-compatible')}
          {error && (
            <div className="jp-Epi-aipanel-note jp-mod-warning">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ProviderRow(props: {
  /** The provider's id, by which the focus finds its row. */
  provider: string;
  label: string;
  note: string;
  /** The note says that the saved key is wrong: the provider refused it. */
  wrong?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="jp-Epi-provider" data-provider={props.provider}>
      <div className="jp-Epi-provider-text">
        <span className="jp-Epi-provider-label">{props.label}</span>
        <span
          className={`jp-Epi-provider-note${props.wrong ? ' jp-mod-wrong' : ''}`}
        >
          {props.note}
        </span>
      </div>
      <div className="jp-Epi-provider-actions">{props.children}</div>
    </div>
  );
}

/** The code that OpenRouter shows when it cannot send the browser back to the server. */
function PasteCode(props: { model: EpiModel }): JSX.Element {
  const [code, setCode] = React.useState('');
  return (
    <form
      className="jp-Epi-pastecode"
      onSubmit={event => {
        event.preventDefault();
        void props.model.signIns.pasteOpenRouterCode(code.trim());
      }}
    >
      <label htmlFor="jp-Epi-openrouter-code">
        OpenRouter cannot send the browser back to this server: paste the code
        it shows
      </label>
      <input
        id="jp-Epi-openrouter-code"
        className="jp-mod-styled"
        value={code}
        autoComplete="off"
        onChange={event => setCode(event.currentTarget.value)}
      />
      <Button small type="submit" disabled={!code.trim()}>
        Sign in
      </Button>
    </form>
  );
}

/**
 * A key pasted for a provider, or a new key in place of the saved one. The
 * page refuses a key that no request can carry; the server checks the rest
 * at no cost, and keeps a key only once the provider takes it, so that a
 * refused key never replaces the saved one. The field is locked while the
 * check runs. A refused key gets Try again, since a provider can take a
 * minute to accept a key it just made, and Save anyway; a check that gets
 * no answer gets Try again and Save without a check. Both of the latter keep
 * the key marked as not checked.
 */
function KeyForm(props: {
  model: EpiModel;
  provider: IProviderInfo;
  /** Called with the state once the key is saved, and whether the provider checked it. */
  onSaved: (state: IConnectionState, checked: boolean) => void;
}): JSX.Element {
  const { provider } = props;
  const about = KEYS[provider.id];
  const noun = provider.id === 'huggingface' ? 'token' : 'key';
  // The saved key, which stays in use until a new one passes its check.
  const saved = provider.signed_in
    ? savedKey(provider.saved ?? '', noun)
    : null;
  const [key, setKey] = React.useState('');
  const [phase, setPhase] = React.useState<'typing' | 'checking' | 'saving'>(
    'typing'
  );
  const [failed, setFailed] = React.useState<IKeyCheck | null>(null);
  const form = React.useRef<HTMLFormElement>(null);
  const id = `jp-Epi-key-${provider.id}`;
  const typed = key.trim();
  const save = (check: boolean) => {
    const problem = keyProblem(typed);
    if (problem) {
      setFailed({ message: problem, check: null, saved: null });
      return;
    }
    setPhase(check ? 'checking' : 'saving');
    if (check) {
      // A new check: the words of the last one go. Save anyway keeps them,
      // and its button, until the key is saved.
      setFailed(null);
    }
    props.model.api
      .saveKey(provider.id, typed, check)
      .then(state => props.onSaved(state, check))
      .catch(reason => {
        setPhase('typing');
        setFailed(keyCheckOf(reason));
      });
  };
  // After a failed check, Try again takes the focus that the locked form
  // lost, so that the next Tab stays in the panel.
  React.useEffect(() => {
    const again = form.current?.querySelector<HTMLElement>(
      'button[type="submit"]'
    );
    const active = document.activeElement;
    if (
      failed?.check &&
      again &&
      (!active || active === document.body || active === again)
    ) {
      again.focus();
    }
  }, [failed]);
  return (
    <form
      ref={form}
      className="jp-Epi-keyform"
      aria-label={`Key of ${provider.label}`}
      onSubmit={event => {
        event.preventDefault();
        save(true);
      }}
    >
      <label htmlFor={id}>
        {provider.signed_in
          ? `A new ${about?.what ?? `key of ${provider.label}`}, from`
          : `${about?.article ?? 'A'} ${about?.what ?? `key of ${provider.label}`}, from`}{' '}
        <a href={about?.where} target="_blank" rel="noopener noreferrer">
          {about?.where.replace(/^https:\/\//, '')}
        </a>
        . It stays on the server, in a file only you can read.
      </label>
      <input
        id={id}
        className="jp-mod-styled"
        type="password"
        autoComplete="off"
        placeholder={about?.placeholder}
        value={key}
        readOnly={phase !== 'typing'}
        aria-describedby={`${id}-check`}
        onChange={event => {
          setKey(event.currentTarget.value);
          // Another key: the words of the last check are of the old one.
          setFailed(null);
        }}
      />
      {phase === 'checking' && (
        <div
          id={`${id}-check`}
          className="jp-Epi-connection-note"
          role="status"
        >
          Checking the {noun} with {provider.label}:{' '}
          {about?.checks ?? 'it lists its models with it'}, at no cost. Nothing
          is saved until the check passes
          {saved ? `, and ${saved} stays in use` : ''}.
        </div>
      )}
      {failed && (
        <div
          id={`${id}-check`}
          className="jp-Epi-aipanel-note jp-mod-warning"
          role="alert"
        >
          {keyCheckText(
            {
              ...failed,
              saved:
                failed.saved ??
                (provider.signed_in ? (provider.saved ?? '') : null)
            },
            noun
          )}
        </div>
      )}
      <div className="jp-Epi-keyform-buttons">
        <Button
          small
          type="submit"
          disabled={phase !== 'typing' || !typed}
          title={failed?.check ? TRY_AGAIN : undefined}
        >
          {phase === 'checking'
            ? 'Checking…'
            : failed?.check
              ? 'Try again'
              : 'Save key'}
        </Button>
        {failed?.check && (
          <Button
            small
            type="button"
            title={failed.check === 'refused' ? SAVE_ANYWAY : SAVE_UNCHECKED}
            disabled={phase !== 'typing'}
            onClick={() => save(false)}
          >
            {phase === 'saving'
              ? 'Saving…'
              : failed.check === 'refused'
                ? 'Save anyway'
                : 'Save without a check'}
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * A server of the analyst's own, with an OpenAI-compatible API: its URL, a
 * key if it asks for one, and whether it runs here. A typed key goes with
 * the request that lists the server's models, which checks it and saves
 * nothing; the form is locked meanwhile (`locked`).
 */
function OwnServer(props: {
  onPick: (pick: IPick) => void;
  locked: boolean;
}): JSX.Element {
  const [url, setUrl] = React.useState('');
  const [key, setKey] = React.useState('');
  const [local, setLocal] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const valid = /^https?:\/\/\S+$/.test(url.trim());
  return (
    <form
      className="jp-Epi-ownserver"
      onSubmit={event => {
        event.preventDefault();
        // A key that no request can carry stays in the page.
        const found = keyProblem(key.trim());
        setProblem(found);
        if (found) {
          return;
        }
        props.onPick({
          provider: 'openai-compatible',
          baseUrl: url.trim(),
          local,
          key: key.trim() || undefined
        });
      }}
    >
      <label htmlFor="jp-Epi-ownserver-url">
        Another server with an OpenAI-compatible API
      </label>
      <input
        id="jp-Epi-ownserver-url"
        className="jp-mod-styled"
        placeholder="http://gpu-server:8000/v1"
        value={url}
        readOnly={props.locked}
        onChange={event => setUrl(event.currentTarget.value)}
      />
      <input
        className="jp-mod-styled"
        type="password"
        aria-label="Its API key, if it asks for one"
        placeholder="API key, if it asks for one"
        autoComplete="off"
        value={key}
        readOnly={props.locked}
        onChange={event => {
          setKey(event.currentTarget.value);
          setProblem(null);
        }}
      />
      {problem && (
        <div className="jp-Epi-aipanel-note jp-mod-warning" role="alert">
          {problem}
        </div>
      )}
      <label className="jp-Epi-ownserver-local">
        <input
          type="checkbox"
          checked={local}
          disabled={props.locked}
          onChange={event => setLocal(event.currentTarget.checked)}
        />
        It runs on this machine or in this network, so it may read the data
      </label>
      <Button small type="submit" disabled={!valid || props.locked}>
        List its models
      </Button>
    </form>
  );
}

/**
 * The models of the chosen provider, as its endpoint lists them, and the
 * button that connects one. A key typed with a server's URL goes with the
 * request that lists them, which checks it and saves nothing; Use this model
 * then saves the key with that URL, and the connection, together. A server
 * that lists its models without a key too gets no key. When the server
 * refuses the typed key, or cannot be asked, the model's name can be typed:
 * Try again asks once more, and Save anyway or Save without a check saves
 * the key and the connection, the key marked as not checked.
 */
function ModelPicker(props: {
  model: EpiModel;
  pick: IPick;
  label: string;
  onSaved: (state: IConnectionState) => void;
  /** Called after a list with the saved key, which checks that key: whether the provider took it. */
  onChecked?: (took: boolean) => void;
  /** Called with true while a key typed with a server's URL is checked, and with false after. */
  onChecking?: (checking: boolean) => void;
}): JSX.Element {
  const { model, pick, label } = props;
  const node = React.useRef<HTMLDivElement>(null);
  const [models, setModels] = React.useState<IProviderModel[] | null>(null);
  const [problem, setProblem] = React.useState<IKeyCheck | null>(null);
  // What the list said of a typed key, and when the key saved for its URL was saved.
  const [keyCheck, setKeyCheck] = React.useState<
    IListedModels['key_check'] | null
  >(null);
  const [savedFor, setSavedFor] = React.useState<string | null>(null);
  // The request that failed, which Try again sends again: the list, or the save.
  const [failedAt, setFailedAt] = React.useState<'list' | 'save'>('list');
  const [attempt, setAttempt] = React.useState(0);
  const [chosen, setChosen] = React.useState('');
  const [typed, setTyped] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  // The callbacks of the section, which each of its renders makes anew.
  const section = React.useRef(props);
  section.current = props;
  // OpenRouter lists other models with zero data retention on or off.
  const retention =
    pick.provider === 'openrouter' ? model.zeroDataRetention : null;
  React.useEffect(() => {
    let live = true;
    const key = pick.key;
    setModels(null);
    setProblem(null);
    setKeyCheck(null);
    if (key) {
      section.current.onChecking?.(true);
    }
    model.api
      .connectionModels(pick.provider, pick.baseUrl, key)
      .then(listed => {
        if (!live) {
          return;
        }
        setModels(listed.models);
        setKeyCheck(listed.key_check ?? null);
        setSavedFor(listed.saved ?? null);
        if (listed.models.length === 1) {
          setChosen(listed.models[0].id);
        }
        if (!key) {
          section.current.onChecked?.(true);
        }
      })
      .catch(reason => {
        if (!live) {
          return;
        }
        const failed = keyCheckOf(reason);
        setModels([]);
        setProblem(failed);
        setFailedAt('list');
        if (!key && failed.check === 'refused') {
          section.current.onChecked?.(false);
        }
      })
      .finally(() => {
        if (live && key) {
          section.current.onChecking?.(false);
        }
      });
    return () => {
      live = false;
      if (key) {
        section.current.onChecking?.(false);
      }
    };
  }, [model, pick, attempt, retention]);
  // After a sign-in, the field of the list takes the focus once the models
  // are listed, so that the analyst can type a filter at once. The focus
  // moves only from the page, the panel or the provider's row, just before
  // the list, where a sign-in leaves it. A field or a button elsewhere keeps
  // the focus.
  const afterSignIn = !!pick.afterSignIn;
  const listed = models !== null;
  React.useEffect(() => {
    const picker = node.current;
    if (!afterSignIn || !listed || !picker) {
      return;
    }
    const active = document.activeElement;
    const free =
      !active ||
      active === document.body ||
      active.contains(picker) ||
      !!picker.previousElementSibling?.contains(active);
    if (!free) {
      return;
    }
    picker.scrollIntoView({ block: 'nearest' });
    picker
      .querySelector<HTMLElement>('input, select')
      ?.focus({ preventScroll: true });
  }, [afterSignIn, listed]);
  // The check of a typed key ended: the focus that its locked form lost goes
  // to the first control of the list, such as the field of the model's name
  // after a refusal, so that the next Tab stays in the panel.
  const typedKeyListed = !!pick.key && listed;
  React.useEffect(() => {
    const active = document.activeElement;
    if (!typedKeyListed || (active && active !== document.body)) {
      return;
    }
    node.current
      ?.querySelector<HTMLElement>('select, input, button:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [typedKeyListed]);
  const save = (check = true) => {
    const id = (chosen || typed).trim();
    if (!id) {
      return;
    }
    setSaving(true);
    if (check) {
      setProblem(null);
    }
    model.api
      .saveConnection({
        provider: pick.provider,
        model: id,
        base_url: pick.baseUrl ?? null,
        local: pick.local,
        // A server that lists its models without a key needs none: the key is not sent.
        key: keyCheck === 'not needed' ? undefined : pick.key,
        ...(check ? {} : { check: false as const })
      })
      .then(props.onSaved)
      .catch(reason => {
        const failed = keyCheckOf(reason);
        setProblem(failed);
        setFailedAt('save');
        // The server marked the saved key as refused: the rows say so.
        if (!pick.key && failed.check === 'refused') {
          section.current.onChecked?.(false);
        }
      })
      .finally(() => setSaving(false));
  };
  const many = (models?.length ?? 0) > SELECT_MODELS;
  const offered = many ? filterModels(models ?? [], typed) : (models ?? []);
  const named = !!(chosen || (!many && typed.trim()));
  const ready = !saving && named;
  // A typed key that the server refused, or could not check.
  const typedKey = !!pick.key;
  const stuck = typedKey && !!problem?.check;
  // Who lists the models, in a sentence: a server of the analyst's own by its URL.
  const who =
    pick.provider === 'openai-compatible'
      ? `the server at ${pick.baseUrl ?? ''}`
      : label;
  const count = models?.length ?? 0;
  return (
    <div
      ref={node}
      className="jp-Epi-modelpicker"
      data-provider={pick.provider}
      aria-label={`Models of ${label}`}
      // The focus waits here after Save key, until the field is drawn.
      tabIndex={-1}
    >
      <div className="jp-Epi-connection-group">Models of {label}</div>
      {models === null && (
        <div className="jp-Epi-connection-note" role="status">
          {typedKey
            ? `Checking the key with ${who}: it lists its models with it. Nothing is saved yet.`
            : `Asking ${label} for its models…`}
        </div>
      )}
      {models !== null && keyCheck && (
        <div className="jp-Epi-connection-note" role="status">
          {keyCheck === 'accepted'
            ? `${capital(who)} took the key and lists ${count} ${count === 1 ? 'model' : 'models'}. Nothing is saved yet: the key goes with this URL once you use one of them${savedFor ? `, in place of ${savedKey(savedFor)}` : ''}.`
            : `${capital(who)} lists its models without a key too: it needs none, so the key is not saved.`}
        </div>
      )}
      {models !== null && models.length > 0 && !many && (
        <HTMLSelect
          aria-label={`Model of ${label}`}
          value={chosen}
          onChange={event => setChosen(event.currentTarget.value)}
        >
          <option value="">Choose a model</option>
          {models.map(entry => (
            <option key={entry.id} value={entry.id}>
              {entry.note ? `${entry.label} (${entry.note})` : entry.label}
            </option>
          ))}
        </HTMLSelect>
      )}
      {models !== null && (many || models.length === 0) && (
        <>
          <input
            className="jp-mod-styled"
            aria-label={`Model of ${label}`}
            placeholder={
              many
                ? `Filter ${models.length} models, such as ${filterExample(pick.provider)}`
                : 'The model name the server uses'
            }
            value={typed}
            onChange={event => {
              setTyped(event.currentTarget.value);
              setChosen('');
            }}
          />
          {many && typed && (
            <ul
              className="jp-Epi-modellist"
              role="listbox"
              aria-label="Matching models"
            >
              {offered.map(entry => (
                <li key={entry.id}>
                  <button
                    role="option"
                    aria-selected={chosen === entry.id}
                    className={chosen === entry.id ? 'jp-mod-selected' : ''}
                    onClick={() => setChosen(entry.id)}
                  >
                    <span>{entry.label}</span>
                    {entry.note && <small>{entry.note}</small>}
                  </button>
                </li>
              ))}
              {offered.length === 0 && (
                <li className="jp-Epi-connection-note">No model matches.</li>
              )}
            </ul>
          )}
        </>
      )}
      {problem && (
        <div className="jp-Epi-aipanel-note jp-mod-warning" role="alert">
          {typedKey ? keyCheckText(problem) : problem.message}
        </div>
      )}
      {typedKey ? (
        // One row of buttons in every state, so that the first keeps the
        // focus from Try again to Checking… and back.
        <div className="jp-Epi-keyform-buttons">
          <Button
            small
            className={
              !stuck && ready ? 'jp-mod-styled jp-mod-accept' : undefined
            }
            title={stuck ? TRY_AGAIN : undefined}
            disabled={saving || models === null || (!stuck && !ready)}
            onClick={() => {
              if (!stuck) {
                save();
              } else if (failedAt === 'save') {
                save();
              } else {
                setAttempt(attempt + 1);
              }
            }}
          >
            {saving || models === null
              ? 'Checking…'
              : stuck
                ? 'Try again'
                : 'Use this model'}
          </Button>
          {stuck && (
            <Button
              small
              title={
                problem?.check === 'refused' ? SAVE_ANYWAY : SAVE_UNCHECKED
              }
              disabled={saving || !named}
              onClick={() => save(false)}
            >
              {problem?.check === 'refused'
                ? 'Save anyway'
                : 'Save without a check'}
            </Button>
          )}
        </div>
      ) : (
        // Blue, as the view's primary actions are, once it can be pressed.
        <Button
          small
          className={ready ? 'jp-mod-styled jp-mod-accept' : undefined}
          disabled={!ready}
          onClick={() => save()}
        >
          {saving ? 'Checking…' : 'Use this model'}
        </Button>
      )}
    </div>
  );
}
