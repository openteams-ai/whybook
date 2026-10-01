import type { Api, IServerStatus } from '../api';
import type { IModelChoice } from '../models';

/**
 * A speech engine writes a question that the analyst says as text, for the
 * microphone of a "Your own question" box. Each engine is one module of this
 * folder, and registry.ts lists them; the value of `models.speech` in the
 * settings is an engine's id.
 */
export interface ISpeechEngine {
  /** The value of `models.speech`, and of its choice in schema/plugin.json. */
  readonly id: string;
  /** Its name in the settings. */
  readonly label: string;
  /** What the choice means for speed, quality or data. */
  readonly note: string;
  /**
   * The engine as the settings list it, with the reason it cannot run: from
   * the page and the server's status, without asking the browser anything.
   */
  choice(status: IServerStatus | null): IModelChoice;
  /** Whether the microphone can listen, and what its tooltip says. */
  availability(context: ISpeechContext): Promise<IAvailability>;
  /**
   * Fetch what the engine needs, after a click on the microphone: resolves
   * to true once it can listen. A browser needs the click to call it.
   */
  install(
    context: ISpeechContext,
    onProgress: (share: number | null) => void
  ): Promise<boolean>;
  /** Listen until the session stops, favouring the names in play. */
  start(
    context: ISpeechContext,
    terms: IKeyTerm[],
    listener: ISpeechListener
  ): ISpeechSession;
}

/** What an engine needs from the view. */
export interface ISpeechContext {
  api: Api;
  /** The server's status, with its speech engines. */
  status: IServerStatus | null;
  /** Ask the server again what it can run, after a download. */
  refresh: () => void;
}

/**
 * Whether the microphone can listen: 'ready', a click listens; 'download',
 * a click fetches what the engine needs; 'downloading'; 'unavailable'.
 */
export interface IAvailability {
  state: 'ready' | 'download' | 'downloading' | 'unavailable';
  /** The microphone's tooltip: what a click does, or why it cannot listen. */
  reason: string;
}

/** A name to favour, as the analyst says it, with how much to favour it. */
export interface IKeyTerm {
  phrase: string;
  /**
   * About the natural log of how many times more likely the name is than the
   * recognizer thinks, from 0 to 10, as the Web Speech API's phrases take it.
   */
  boost: number;
}

/** What an engine tells the microphone while it listens. */
export interface ISpeechListener {
  /** The words so far; `final` once the engine will not change them. */
  onText(text: string, final: boolean): void;
  /** What the engine does after listening, such as writing the words. */
  onStage(stage: 'listening' | 'writing'): void;
  /** Why the engine could not listen or write, for the box to show. */
  onError(reason: string): void;
  /** Listening is over, after the last words or an error. */
  onEnd(): void;
}

/** One question being said. */
export interface ISpeechSession {
  /** Stop listening, and write what was heard. */
  stop(): void;
  /** Stop listening, and drop what was heard. */
  abort(): void;
}

/** Collapse the spaces of what an engine heard. */
export function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Whether the page runs in Electron, as JupyterLab Desktop does. */
export function inElectron(): boolean {
  return /\bElectron\//.test(navigator.userAgent);
}

/** Why no engine can use the microphone on this page, or null. */
export function pageReason(): string | null {
  if (inElectron()) {
    // JupyterLab Desktop 4.6.3-1 refuses the microphone to every page, and an
    // Electron before 42.10.0 kills the page when it asks for recognition on
    // the device: research/voice-questions.md.
    return 'JupyterLab Desktop does not allow the microphone.';
  }
  if (window.isSecureContext === false) {
    return 'Voice needs HTTPS or localhost: this page is served over plain HTTP from another machine.';
  }
  if (inOtherSite()) {
    return 'Open JupyterLab in its own tab to ask by voice: a page of another site holds this one.';
  }
  return null;
}

/** Whether a page of another origin holds this one in a frame. */
function inOtherSite(): boolean {
  if (window.top === window.self) {
    return false;
  }
  try {
    return window.top?.location.origin !== window.location.origin;
  } catch {
    // Reading the location of another origin throws.
    return true;
  }
}
