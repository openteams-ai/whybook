import * as React from 'react';

import type { EpiModel } from '../model/epimodel';
import { choiceOf } from '../model/models';
import type {
  IAvailability,
  ISpeechContext,
  ISpeechSession
} from '../model/speech/engine';
import { INSTALL_TIMEOUT } from '../model/speech/browser';
import { speechEngine } from '../model/speech/registry';
import { keyTerms } from '../model/speech/terms';
import type { IItem } from '../tokens';

/**
 * What the microphone of a question box shows: 'off' with no engine chosen;
 * 'checking' while the engine says whether it can listen; 'ready', a click
 * listens; 'download', a click fetches what the engine needs; 'downloading';
 * 'unavailable'; 'listening' until a second click or Escape; 'writing' while
 * an engine of the server writes the words.
 */
export type VoiceState =
  | 'off'
  | 'checking'
  | 'ready'
  | 'download'
  | 'downloading'
  | 'unavailable'
  | 'listening'
  | 'writing';

export interface IVoice {
  state: VoiceState;
  /** The microphone's tooltip. */
  title: string;
  /** Why the last question could not be heard or written, for the box to show. */
  error: string | null;
  /** A click on the microphone. */
  toggle: () => void;
}

/** The tooltip of the microphone with no engine chosen. */
export const VOICE_OFF =
  'Ask by voice: off. Choose what writes a spoken question under Spoken questions in the AI models. The words you say then fill this box, and nothing is asked until you press Enter.';

/** How often the microphone asks again while another page downloads the recognizer. */
const RECHECK_MS = 5000;
/** After a download that did not finish in time, ask again less often. */
const STALLED_RECHECK_MS = 30000;
/** The microphone's tooltip once a download has gone on too long. */
export const DOWNLOAD_STALLED =
  'The browser has not finished downloading its recognizer. Click to try again.';

/**
 * The microphone of a question box: the engine of the settings, whether it
 * can listen, and a click that listens, stops, or downloads first. The words
 * go into the box after the text already there; the box then shows their
 * type and place, as for typed text, and nothing is asked until Enter.
 */
export function useVoice(options: {
  model: EpiModel;
  /** Whether the box takes a question: a model can answer it. */
  enabled: boolean;
  /** The box's text now. */
  text: () => string;
  /** Put this text in the box. */
  write: (text: string) => void;
  /** Move the keyboard focus to the box, once the words are in. */
  focus: () => void;
}): IVoice {
  const { model, enabled } = options;
  const latest = React.useRef(options);
  latest.current = options;
  const id = choiceOf(model.settings.models, 'speech');
  const engine = speechEngine(id);
  // An engine of the server can listen once the server says so.
  const entry = JSON.stringify(
    model.status?.speech_engines?.find(item => item.id === id) ?? null
  );
  const known = model.status !== null;
  const [check, setCheck] = React.useState<IAvailability | null>(null);
  const [phase, setPhase] = React.useState<
    'idle' | 'downloading' | 'listening' | 'writing'
  >('idle');
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);
  const session = React.useRef<ISpeechSession | null>(null);
  const downloadingSince = React.useRef<number | null>(null);
  // A download went on longer than INSTALL_TIMEOUT: a click tries again.
  const stalled = React.useRef(false);

  const context = (): ISpeechContext => ({
    api: model.api,
    status: model.status,
    refresh: () => model.refreshStatus()
  });

  React.useEffect(() => {
    setCheck(null);
    if (!engine) {
      return;
    }
    let live = true;
    engine.availability(context()).then(
      result => {
        if (!live) {
          return;
        }
        if (result.state !== 'downloading') {
          downloadingSince.current = null;
          stalled.current = false;
        } else if (downloadingSince.current === null) {
          downloadingSince.current = Date.now();
        } else if (Date.now() - downloadingSince.current > INSTALL_TIMEOUT) {
          // A slow download, or Brave 1.89, which says it downloads and
          // never ends: the analyst can try again.
          stalled.current = true;
        }
        if (result.state === 'downloading' && stalled.current) {
          result = { state: 'download', reason: DOWNLOAD_STALLED };
        }
        setCheck(result);
      },
      reason =>
        live && setCheck({ state: 'unavailable', reason: String(reason) })
    );
    return () => {
      live = false;
    };
  }, [id, entry, known, round]);

  // While the recognizer downloads, ask again now and then, so that the
  // microphone turns ready when it ends, also after a download that stalled.
  React.useEffect(() => {
    const waiting =
      check?.state === 'downloading' ||
      (check?.state === 'download' && stalled.current);
    if (!waiting || phase !== 'idle') {
      return;
    }
    const timer = window.setTimeout(
      () => setRound(value => value + 1),
      stalled.current ? STALLED_RECHECK_MS : RECHECK_MS
    );
    return () => window.clearTimeout(timer);
  }, [check, phase]);

  // A box that goes away stops listening, and drops what was heard.
  React.useEffect(() => () => session.current?.abort(), []);

  // Escape stops listening, before a popover or a panel closes on it.
  React.useEffect(() => {
    if (phase !== 'listening') {
      return;
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        session.current?.stop();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [phase]);

  const download = () => {
    if (!engine) {
      return;
    }
    setError(null);
    setProgress(null);
    setPhase('downloading');
    // A new try gets its own INSTALL_TIMEOUT.
    downloadingSince.current = null;
    let installing: Promise<boolean>;
    try {
      // In the click's task: a browser downloads only after a click.
      installing = engine.install(context(), setProgress);
    } catch (reason) {
      installing = Promise.reject(reason);
    }
    installing
      .then(
        done => {
          if (!done) {
            stalled.current = true;
            setError(
              'The download has not finished yet. Click the microphone to try again.'
            );
          } else {
            stalled.current = false;
          }
        },
        reason => setError((reason as Error)?.message ?? String(reason))
      )
      .finally(() => {
        setPhase('idle');
        setRound(value => value + 1);
      });
  };

  const listen = () => {
    if (!engine) {
      return;
    }
    setError(null);
    const before = latest.current.text().trim();
    const ask = model.ask;
    const dropped: IItem[] =
      ask?.kind === 'drop'
        ? [ask.source, ask.target.item].filter(
            (item): item is IItem => item !== undefined
          )
        : [];
    const terms = keyTerms({ dropped, variables: model.variables() });
    setPhase('listening');
    try {
      session.current = engine.start(context(), terms, {
        onText: words =>
          latest.current.write([before, words].filter(Boolean).join(' ')),
        onStage: stage =>
          setPhase(stage === 'writing' ? 'writing' : 'listening'),
        onError: reason => setError(reason),
        onEnd: () => {
          session.current = null;
          setPhase('idle');
          latest.current.focus();
        }
      });
    } catch (reason) {
      session.current = null;
      setPhase('idle');
      setError((reason as Error)?.message ?? String(reason));
    }
  };

  const toggle = () => {
    if (phase === 'listening') {
      session.current?.stop();
      return;
    }
    if (!engine || !enabled || phase !== 'idle') {
      return;
    }
    if (check?.state === 'download') {
      download();
    } else if (check?.state === 'ready') {
      listen();
    }
  };

  let state: VoiceState;
  let title: string;
  if (!engine) {
    state = 'off';
    title = VOICE_OFF;
  } else if (phase === 'listening') {
    state = 'listening';
    title = 'Listening: click again or press Escape to stop.';
  } else if (phase === 'writing') {
    state = 'writing';
    title = `${engine.label} is writing the words.`;
  } else if (phase === 'downloading') {
    state = 'downloading';
    title = `Downloading what ${engine.label} needs${progress !== null ? `, ${Math.round(100 * progress)}% done` : ''}.`;
  } else if (!enabled) {
    state = 'unavailable';
    title =
      'Ask by voice: this box takes a question once an AI model can answer it.';
  } else if (!check) {
    state = 'checking';
    title = `Ask by voice: checking whether ${engine.label} can listen.`;
  } else {
    state = check.state;
    title = check.reason;
  }
  return { state, title, error, toggle };
}
