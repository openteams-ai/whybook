import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

import type {
  Api,
  IConnectionState,
  IDeviceSignIn,
  IProviderInfo,
  IProviderModel,
  IServerStatus
} from './api';

/** How long a sign-in with OpenRouter may wait for the browser to come back: its code lasts 10 minutes. */
export const OPENROUTER_WAIT = 10 * 60 * 1000;
/** How often the view asks the server whether OpenRouter sent the browser back. */
export const OPENROUTER_POLL = 2000;

/** The calls of the API that the sign-ins make. */
export type SignInApi = Pick<
  Api,
  | 'connection'
  | 'huggingFaceSignIn'
  | 'huggingFacePoll'
  | 'openRouterSignIn'
  | 'openRouterCode'
>;

/**
 * The sign-ins in progress, for the AI models panel: a Hugging Face device
 * code, and a sign-in with OpenRouter that waits for the browser or for a
 * pasted code. They go on while the panel is closed, since the analyst
 * leaves it to approve on huggingface.co or on openrouter.ai.
 */
export class SignIns {
  constructor(
    private _api: SignInApi,
    /** Called with the provider once its key is on the server. */
    private _done: (provider: string) => void
  ) {}

  /** Fired when a sign-in starts, ends or fails. */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /** The device code that the analyst approves on huggingface.co, while Hugging Face waits for it. */
  huggingFace: IDeviceSignIn | null = null;
  /** A sign-in with OpenRouter in progress: 'code' when the analyst pastes the code that OpenRouter shows. */
  openRouter: { state: string; mode: 'callback' | 'code' } | null = null;
  /** Why the last sign-in failed, in words for the panel. */
  error: string | null = null;
  /** The provider signed in last, whose models the panel offers next. */
  signedIn: string | null = null;

  /** Ask Hugging Face for a device code, then ask the server whether it was approved, at Hugging Face's interval. */
  async startHuggingFace(): Promise<void> {
    this._stopHuggingFace();
    this.error = null;
    try {
      this.huggingFace = await this._api.huggingFaceSignIn();
    } catch (error) {
      this.error = messageOf(error);
      this._changed.emit();
      return;
    }
    this._changed.emit();
    this._pollHuggingFace(this.huggingFace.interval);
  }

  /**
   * Open openrouter.ai in a new tab, and wait for the key. The tab opens
   * before the server answers, while the click still lets it open.
   */
  async startOpenRouter(
    open: () => Window | null = () => window.open('', '_blank')
  ): Promise<void> {
    this._stopOpenRouter();
    this.error = null;
    const tab = open();
    let started: Awaited<ReturnType<SignInApi['openRouterSignIn']>>;
    try {
      started = await this._api.openRouterSignIn();
    } catch (error) {
      tab?.close();
      this.error = messageOf(error);
      this._changed.emit();
      return;
    }
    if (tab) {
      // openrouter.ai gets no handle on this page.
      tab.opener = null;
      tab.location.href = started.url;
    }
    this.openRouter = { state: started.state, mode: started.mode };
    this._changed.emit();
    if (started.mode === 'callback') {
      this._waitForOpenRouter(Date.now() + OPENROUTER_WAIT);
    }
  }

  /** The code that OpenRouter showed, pasted by the analyst. */
  async pasteOpenRouterCode(code: string): Promise<void> {
    if (!this.openRouter) {
      return;
    }
    try {
      await this._api.openRouterCode(this.openRouter.state, code);
    } catch (error) {
      this.error = messageOf(error);
      this._changed.emit();
      return;
    }
    this._finish('openrouter');
  }

  cancel(): void {
    this._stopHuggingFace();
    this._stopOpenRouter();
    this.error = null;
    this._changed.emit();
  }

  dispose(): void {
    this._stopHuggingFace();
    this._stopOpenRouter();
  }

  private _pollHuggingFace(seconds: number): void {
    this._huggingFaceTimer = window.setTimeout(async () => {
      const flow = this.huggingFace;
      if (!flow) {
        return;
      }
      try {
        const polled = await this._api.huggingFacePoll(flow.flow);
        if (polled.status === 'pending') {
          this._pollHuggingFace(polled.interval ?? seconds);
          return;
        }
        if (polled.status === 'done') {
          this.huggingFace = null;
          this._finish('huggingface');
          return;
        }
        this.error =
          polled.status === 'expired'
            ? 'The code expired before it was approved: sign in again.'
            : polled.status === 'denied'
              ? 'The sign-in was refused on huggingface.co.'
              : (polled.message ?? 'Hugging Face refused the sign-in.');
      } catch (error) {
        this.error = messageOf(error);
      }
      this.huggingFace = null;
      this._changed.emit();
    }, seconds * 1000);
  }

  private _waitForOpenRouter(deadline: number): void {
    this._openRouterTimer = window.setTimeout(async () => {
      if (!this.openRouter) {
        return;
      }
      try {
        const state = await this._api.connection();
        if (providerOf(state, 'openrouter')?.signed_in) {
          this._finish('openrouter');
          return;
        }
      } catch {
        // The server may restart; ask again.
      }
      if (Date.now() > deadline) {
        this.openRouter = null;
        this.error = 'OpenRouter did not send the browser back: sign in again.';
        this._changed.emit();
        return;
      }
      this._waitForOpenRouter(deadline);
    }, OPENROUTER_POLL);
  }

  private _finish(provider: string): void {
    this._stopOpenRouter();
    this.signedIn = provider;
    this.error = null;
    this._changed.emit();
    this._done(provider);
  }

  private _stopHuggingFace(): void {
    window.clearTimeout(this._huggingFaceTimer);
    this.huggingFace = null;
  }

  private _stopOpenRouter(): void {
    window.clearTimeout(this._openRouterTimer);
    this.openRouter = null;
  }

  private _changed = new Signal<this, void>(this);
  private _huggingFaceTimer: number | undefined;
  private _openRouterTimer: number | undefined;
}

/** A provider of the state, by id. */
export function providerOf(
  state: IConnectionState | null,
  id: string
): IProviderInfo | undefined {
  return state?.providers.find(provider => provider.id === id);
}

/**
 * Whether an OpenRouter connection exists, so that the AI models panel offers
 * zero data retention: the connected model goes through OpenRouter, as the
 * status or the connection's state says, or the server keeps a key of
 * OpenRouter, whose list of models the setting filters.
 */
export function usesOpenRouter(
  status: IServerStatus | null,
  state: IConnectionState | null
): boolean {
  return (
    status?.claude?.provider === 'openrouter' ||
    state?.connection.provider === 'openrouter' ||
    !!providerOf(state, 'openrouter')?.signed_in
  );
}

/** The error of a request in words for the panel: the server's message, when it sent one. */
export function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    return message.replace(/^\s*Error:\s*/, '');
  }
  return String(error);
}

/**
 * Why a typed key cannot be sent, in words for the panel, or null for a key
 * that can: the rule of whybook/server/providers.py, key_problem, applied in
 * the page, so that such a key never leaves it. An empty key is left to the
 * form's button. A browser can paste the line break of wrapped text as a
 * space.
 */
export function keyProblem(key: string): string | null {
  if (!key) {
    return null;
  }
  if (/[\r\n]/.test(key)) {
    return 'The key holds a line break. Paste it on one line.';
  }
  if (/\s/.test(key)) {
    return 'The key holds a space. Paste it on one line, with no spaces.';
  }
  if (!/^[!-~]+$/.test(key)) {
    return 'The key holds a character that keys do not have. Copy it again.';
  }
  return null;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
];

/** The day of a time that the server kept, as the panel writes it: "27 Sep", with the year when it is not this year. */
export function dayOf(
  time: string | null | undefined,
  now: Date = new Date()
): string | null {
  const date = time ? new Date(time) : null;
  if (!date || isNaN(date.getTime())) {
    return null;
  }
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear()
    ? day
    : `${day} ${date.getFullYear()}`;
}

/**
 * How a check of a key ended, from the server's answer to a request that
 * failed (whybook/server/routes.py, check_failed): its words; 'refused' when
 * the provider refused the key, 'unchecked' when it could not check it, and
 * null for another failure; and when the key that stays in use was saved,
 * null when none is saved.
 */
export interface IKeyCheck {
  message: string;
  check: 'refused' | 'unchecked' | null;
  saved: string | null;
}

export function keyCheckOf(error: unknown): IKeyCheck {
  const body =
    error && typeof error === 'object' && 'body' in error
      ? (error as { body: unknown }).body
      : null;
  const fields: { check?: unknown; saved?: unknown } =
    body && typeof body === 'object' ? body : {};
  return {
    message: messageOf(error),
    check:
      fields.check === 'refused' || fields.check === 'unchecked'
        ? fields.check
        : null,
    saved: typeof fields.saved === 'string' ? fields.saved : null
  };
}

/** Words of the server as a sentence: a full stop after them, unless they end with one or with a question mark. */
function sentence(words: string): string {
  return /[.?!]$/.test(words) ? words : `${words}.`;
}

/** The saved key, by the day it was saved when the server kept it: "the key saved on 27 Sep". */
export function savedKey(saved: string, noun = 'key', now?: Date): string {
  const day = dayOf(saved, now);
  return day ? `the ${noun} saved on ${day}` : `the saved ${noun}`;
}

/**
 * What the panel says when the check of a key failed: the server's words,
 * then what became of the key, and of the key saved before it.
 * "Mistral AI refused this key (HTTP 401). Nothing changed: the key saved
 * on 27 Sep stays in use."
 */
export function keyCheckText(
  failed: IKeyCheck,
  noun = 'key',
  now?: Date
): string {
  const saved =
    failed.saved !== null ? savedKey(failed.saved, noun, now) : null;
  if (failed.check === 'refused') {
    return `${sentence(failed.message)} ${saved ? `Nothing changed: ${saved} stays in use.` : 'Nothing is saved.'}`;
  }
  if (failed.check === 'unchecked') {
    return `${sentence(failed.message)} The ${noun} is not checked, and not saved.${saved ? ` ${capital(saved)} stays in use.` : ''}`;
  }
  return failed.message;
}

/** Words with a capital first letter, for the start of a sentence or a line. */
export function capital(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a provider's row says of its saved key: when it was saved, that it
 * is not checked, or that the provider refused it, so it is wrong.
 * "key saved on 27 Sep", "key saved, not checked".
 */
export function keyWords(
  provider: IProviderInfo,
  noun = 'key',
  now?: Date
): string {
  if (provider.refused) {
    const refused = dayOf(provider.refused, now);
    return `the ${noun} is wrong, ${provider.label} refused it${refused ? ` on ${refused}` : ''}`;
  }
  if (provider.checked === false) {
    return `${noun} saved, not checked`;
  }
  const saved = dayOf(provider.saved, now);
  return `${noun} saved ${saved ? `on ${saved}` : 'on the server'}`;
}

/**
 * A line under the connected model when its saved key is not checked, or
 * was refused, with whether it says that something is wrong. Null for a
 * key that a provider took, or no key.
 */
export function connectedKeyLine(
  state: IConnectionState,
  now?: Date
): { text: string; wrong: boolean } | null {
  const key = state.connected_key;
  if (!key) {
    return null;
  }
  if (key.refused) {
    const who =
      state.connection.provider === 'openai-compatible'
        ? 'The server'
        : (providerOf(state, state.connection.provider)?.label ??
          'The provider');
    const day = dayOf(key.refused, now);
    return {
      text: `${who} refused the saved key${day ? ` on ${day}` : ''}. The key is wrong: replace it.`,
      wrong: true
    };
  }
  if (!key.checked) {
    return {
      text: 'The saved key is not checked yet: the first answer checks it.',
      wrong: false
    };
  }
  return null;
}

/** Past this many models, the panel offers a field that filters them rather than a select. */
export const SELECT_MODELS = 30;

/** Words to type in the filter of a provider's long list of models, written as the provider names its models. */
const FILTER_EXAMPLES: Record<string, string> = {
  huggingface: 'Qwen Scaleway'
};

/** The example in the placeholder of the filter: the filter ignores case, so the example finds models as it is written. */
export function filterExample(provider: string): string {
  return FILTER_EXAMPLES[provider] ?? 'Claude Sonnet';
}

/**
 * The models to offer for a typed filter: those whose id or name holds
 * every word typed, the first `limit` of them.
 */
export function filterModels(
  models: IProviderModel[],
  typed: string,
  limit = 50
): IProviderModel[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  return models
    .filter(model => {
      const text = `${model.id} ${model.label}`.toLowerCase();
      return words.every(word => text.includes(word));
    })
    .slice(0, limit);
}
