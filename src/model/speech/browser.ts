import type { IServerStatus } from '../api';
import type { IModelChoice } from '../models';
import type { IAvailability, ISpeechEngine, ISpeechSession } from './engine';
import { pageReason, tidy } from './engine';

/**
 * The browser's own recognizer, the Web Speech API, with `processLocally`:
 * the audio stays on this computer, and a browser that cannot keep it there
 * refuses rather than sending it to a server. Chrome 139 and later does this
 * on Windows, macOS and Linux, and takes the names as phrases from 142;
 * research/voice-questions.md, "The browser's own recognizer", has the
 * support of each browser that the tooltips below follow.
 */

/** A browser that the tooltips name. */
type Browser = 'Brave' | 'Edge' | 'Opera' | 'Firefox' | 'Chrome' | 'Safari';

/** What the recognizer's `available` and `install` take. */
interface IRecognitionOptions {
  langs: string[];
  processLocally: boolean;
}

/**
 * The recognizer of the Web Speech API, as far as the view uses it:
 * TypeScript's types of the DOM leave it out.
 */
interface IRecognition {
  lang: string;
  processLocally: boolean;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  phrases: unknown[];
  onresult: ((event: { results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** The recognizer's class, with the static methods of Chrome 139. */
interface IRecognitionClass {
  new (): IRecognition;
  prototype: object;
  available?: (options: IRecognitionOptions) => Promise<string>;
  install?: (options: IRecognitionOptions) => Promise<boolean>;
}

/** What the browser may add to `window` for speech, beside the DOM's types. */
interface ISpeechWindow {
  SpeechRecognition?: IRecognitionClass;
  /** A phrase to favour, with its boost (Chrome 142). */
  SpeechRecognitionPhrase?: new (phrase: string, boost: number) => unknown;
}

function speechWindow(): Window & ISpeechWindow {
  return window as Window & ISpeechWindow;
}

/** How long a download may take before the microphone gives up: Brave 1.89 never ends one. */
export const INSTALL_TIMEOUT = 5 * 60 * 1000;

function browserName(): Browser | null {
  const agent = navigator.userAgent;
  if ((navigator as Navigator & { brave?: unknown }).brave) {
    return 'Brave';
  }
  if (/\bEdg\//.test(agent)) {
    return 'Edge';
  }
  if (/\bOPR\//.test(agent)) {
    return 'Opera';
  }
  if (/\bFirefox\//.test(agent)) {
    return 'Firefox';
  }
  if (/Chrom(e|ium)\//.test(agent)) {
    return 'Chrome';
  }
  if (/\bSafari\//.test(agent)) {
    return 'Safari';
  }
  return null;
}

/** The recognizer's class, when the browser has the unprefixed API. */
function recognition(): IRecognitionClass | undefined {
  return speechWindow().SpeechRecognition;
}

/** The language to recognize: the browser's. */
export function speechLanguage(): string {
  return navigator.language || 'en-US';
}

/** Whether the browser takes the names as phrases (Chrome 142 and later). */
function takesPhrases(): boolean {
  return 'SpeechRecognitionPhrase' in window && !phrasesRefused;
}

/** Set when the browser refused phrases once: it then gets none. */
let phrasesRefused = false;

/**
 * Why this browser cannot recognize speech on this computer, before asking
 * it anything, or null when it may: Electron, plain HTTP and a frame of
 * another site first, then a browser without the API or without
 * `processLocally`.
 */
export function browserReason(): string | null {
  const page = pageReason();
  if (page) {
    return page;
  }
  const name = browserName();
  const Recognition = recognition();
  if (!Recognition) {
    if (name === 'Firefox') {
      return 'Firefox recognizes speech only in its Nightly builds.';
    }
    if ('webkitSpeechRecognition' in window) {
      return name === 'Safari'
        ? "Safari may send the audio to Apple's servers: it cannot promise to recognize speech on this computer."
        : `${name ?? 'This browser'} may send the audio to a server: Chrome 139 and later recognizes speech on this computer.`;
    }
    return `${name ?? 'This browser'} has no speech recognition.`;
  }
  if (
    !('processLocally' in Recognition.prototype) ||
    typeof Recognition.available !== 'function'
  ) {
    return `${name ?? 'This browser'} may send the audio to a server: it cannot promise to recognize speech on this computer.`;
  }
  return null;
}

/** Why the browser answered "unavailable", in the words of the tooltip. */
function unavailableReason(name: Browser | null, language: string): string {
  if (name === 'Edge') {
    return 'Edge recognizes speech on this computer only in Canary or Dev, with the flag "Speech Recognition with on-device model". The settings offer a model in the Jupyter server.';
  }
  if (name === 'Chrome') {
    return `Chrome cannot recognize ${language} on this computer. The settings offer a model in the Jupyter server.`;
  }
  return `${name ?? 'This browser'} cannot recognize speech on this computer. The settings offer a model in the Jupyter server.`;
}

/** An error event's code, in the words the box shows. */
export function errorReason(code: string, language: string): string {
  switch (code) {
    case 'not-allowed':
      return "The microphone is blocked for this page: allow it in the browser's site settings.";
    case 'audio-capture':
      return 'No microphone was found.';
    case 'no-speech':
      return 'Nothing was heard.';
    case 'language-not-supported':
      return `The browser cannot recognize ${language} on this computer.`;
    case 'service-not-allowed':
      return 'The browser refused to recognize speech on this computer.';
    case 'phrases-not-supported':
      return "The browser cannot use the notebook's names: say the question again.";
    case 'network':
      return 'The browser could not reach its recognizer.';
    default:
      return `The browser stopped listening: ${code}.`;
  }
}

const ID = 'browser-local';
const LABEL = 'Browser, on this device';
const NOTE =
  'the audio stays on this computer; in Chrome 139 and later, which downloads its recognizer, about 60 MB a language, at the first click on the microphone';

export const browserLocal: ISpeechEngine = {
  id: ID,
  label: LABEL,
  note: NOTE,

  choice(status: IServerStatus | null): IModelChoice {
    const reason = browserReason();
    return {
      id: ID,
      label: LABEL,
      note: NOTE,
      available: reason === null,
      reason,
      download: null,
      source: null
    };
  },

  async availability(): Promise<IAvailability> {
    const reason = browserReason();
    if (reason) {
      return { state: 'unavailable', reason };
    }
    const name = browserName();
    const language = speechLanguage();
    let answer: string;
    try {
      // browserReason found the class and its `available`.
      answer = await recognition()!.available!({
        langs: [language],
        processLocally: true
      });
    } catch (error) {
      return {
        state: 'unavailable',
        reason: `${name ?? 'The browser'} could not say whether it recognizes ${language}: ${String(error)}`
      };
    }
    const who = name ?? 'The browser';
    switch (answer) {
      case 'available':
        return {
          state: 'ready',
          reason: `Ask by voice: click, speak, then click again or press Escape. ${who} recognizes the words on this computer; they fill this box, and nothing is asked until you press Enter.${takesPhrases() ? '' : ' This version cannot favour the names of the notebook.'}`
        };
      case 'downloadable':
        return {
          state: 'download',
          reason: `Ask by voice: click to download ${who === 'Chrome' ? "Chrome's recognizer for" : 'the recognizer for'} ${language} first${who === 'Chrome' ? ', about 60 MB' : ''}. The audio then stays on this computer.`
        };
      case 'downloading':
        return {
          state: 'downloading',
          reason: `${who} is downloading its recognizer for ${language}.`
        };
      default:
        return {
          state: 'unavailable',
          reason: unavailableReason(name, language)
        };
    }
  },

  install(context, onProgress): Promise<boolean> {
    onProgress(null);
    // Called in the click's task: Chrome needs the click to download.
    const done: Promise<boolean> = recognition()!.install!({
      langs: [speechLanguage()],
      processLocally: true
    }).then(Boolean);
    let timer = 0;
    const late = new Promise<boolean>(resolve => {
      timer = window.setTimeout(() => resolve(false), INSTALL_TIMEOUT);
    });
    return Promise.race([done, late]).finally(() => window.clearTimeout(timer));
  },

  start(context, terms, listener): ISpeechSession {
    const language = speechLanguage();
    const listening = new (recognition()!)();
    listening.lang = language;
    // Set before the phrases: Chrome takes phrases only on the device.
    listening.processLocally = true;
    // Push to talk: the analyst ends the question, not a pause.
    listening.continuous = true;
    listening.interimResults = true;
    listening.maxAlternatives = 1;
    if (terms.length && takesPhrases()) {
      const Phrase = speechWindow().SpeechRecognitionPhrase!;
      listening.phrases = terms.map(
        term => new Phrase(term.phrase, Math.max(0, Math.min(10, term.boost)))
      );
    }
    let text = '';
    let dropped = false;
    listening.onresult = event => {
      let words = '';
      for (let index = 0; index < event.results.length; index++) {
        words += event.results[index][0]?.transcript ?? '';
      }
      text = tidy(words);
      listener.onText(text, false);
    };
    listening.onerror = event => {
      if (dropped && event.error === 'aborted') {
        return;
      }
      if (event.error === 'phrases-not-supported') {
        phrasesRefused = true;
      }
      listener.onError(errorReason(event.error, language));
    };
    listening.onend = () => {
      if (!dropped && text) {
        listener.onText(text, true);
      }
      listener.onEnd();
    };
    listener.onStage('listening');
    listening.start();
    return {
      stop: () => listening.stop(),
      abort: () => {
        dropped = true;
        listening.abort();
      }
    };
  }
};
