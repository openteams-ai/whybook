import * as fs from 'fs';
import * as path from 'path';

import type { ServerConnection } from '@jupyterlab/services';

import type { IServerSpeechEngine, IServerStatus } from '../model/api';
import { Api } from '../model/api';
import {
  aiSummary,
  choicesFor,
  DEFAULT_MODELS,
  modelName,
  readModels
} from '../model/models';
import { browserLocal } from '../model/speech/browser';
import type {
  ISpeechContext,
  ISpeechListener,
  IKeyTerm
} from '../model/speech/engine';
import { record, recordingReason } from '../model/speech/recorder';
import { ENGINES, speechEngine } from '../model/speech/registry';
import { keyTerms, spoken } from '../model/speech/terms';
import { downsample, encodeWav } from '../model/speech/wav';
import { requestAPI } from '../request';
import type { IItem, IVariable } from '../tokens';

jest.mock('../model/speech/recorder', () => ({
  record: jest.fn(),
  recordingReason: jest.fn(() => null)
}));

jest.mock('../request', () => ({
  requestAPI: jest.fn(),
  streamAPI: jest.fn()
}));

const SCHEMA = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'schema', 'plugin.json'),
    'utf-8'
  )
);

const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

function engine(
  id: string,
  entry: Partial<IServerSpeechEngine> = {}
): IServerSpeechEngine {
  return {
    id,
    label: id === 'moonshine-medium' ? 'Moonshine Medium' : 'Moonshine Small',
    kind: 'speech',
    size_mb: id === 'moonshine-medium' ? 269 : 142,
    note: 'English; a note',
    source: 'download.moonshine.ai',
    available: true,
    reason: null,
    downloadable: false,
    ...entry
  };
}

const STATUS: IServerStatus = {
  ranker: 'heuristic',
  jev_configured: false,
  claude_available: true,
  speech_engines: [
    engine('moonshine-medium'),
    engine('moonshine-small', {
      available: false,
      reason:
        'not downloaded: python -m moonshine_voice.download --stt --language en --model-arch 4',
      downloadable: true
    })
  ]
};

/**
 * A SpeechRecognition that records what the view sets and lets the test
 * say words; like Chrome's, its settings are on the prototype.
 */
class FakeRecognition {
  static answer = 'available';
  static made: FakeRecognition[] = [];
  static available = jest.fn(async () => FakeRecognition.answer);
  static install = jest.fn(async () => true);
  lang!: string;
  continuous!: boolean;
  interimResults!: boolean;
  maxAlternatives!: number;
  processLocally!: boolean;
  phrases!: { phrase: string; boost: number }[];
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;

  constructor() {
    FakeRecognition.made.push(this);
  }

  start() {
    this.started = true;
  }

  stop() {
    this.onend?.();
  }

  abort() {
    this.onerror?.({ error: 'aborted' });
    this.onend?.();
  }

  say(words: string[], final = false) {
    const results = words.map(transcript =>
      Object.assign([{ transcript, confidence: 1 }], { isFinal: final })
    );
    this.onresult?.({ resultIndex: 0, results });
  }
}
Object.assign(FakeRecognition.prototype, {
  lang: '',
  continuous: false,
  interimResults: false,
  maxAlternatives: 1,
  processLocally: false,
  phrases: []
});

class FakePhrase {
  constructor(
    public phrase: string,
    public boost = 1
  ) {}
}

function setAgent(agent: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: agent,
    configurable: true
  });
}

function listener(): ISpeechListener & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    onText: (text, final) =>
      events.push(`${final ? 'final' : 'text'}: ${text}`),
    onStage: stage => events.push(`stage: ${stage}`),
    onError: reason => events.push(`error: ${reason}`),
    onEnd: () => events.push('end')
  };
}

function context(status: IServerStatus | null = STATUS): ISpeechContext {
  return {
    api: new Api({} as ServerConnection.ISettings),
    status,
    refresh: jest.fn()
  };
}

const JSDOM_AGENT = navigator.userAgent;

beforeEach(() => {
  setAgent(JSDOM_AGENT);
  FakeRecognition.answer = 'available';
  FakeRecognition.made = [];
  FakeRecognition.available.mockClear();
  FakeRecognition.install.mockClear();
  delete (window as any).SpeechRecognition;
  delete (window as any).SpeechRecognitionPhrase;
  delete (window as any).webkitSpeechRecognition;
  delete (window as any).isSecureContext;
});

describe('the registry of speech engines', () => {
  it('holds one engine for each value of models.speech in the settings, after off', () => {
    const speech = SCHEMA.properties.models.properties.speech;
    expect(
      speech.oneOf.map((choice: { const: string }) => choice.const)
    ).toEqual(['off', ...ENGINES.map(item => item.id)]);
    expect(speech.default).toBe('off');
    expect(SCHEMA.properties.models.default.speech).toBe('off');
    expect(speechEngine('moonshine-small')?.label).toBe('Moonshine Small');
    expect(speechEngine('off')).toBeUndefined();
  });

  it('reads the setting, with off for an engine that is gone', () => {
    expect(DEFAULT_MODELS.speech).toBe('off');
    expect(readModels(undefined).speech).toBe('off');
    expect(readModels({ speech: 'moonshine-small' }).speech).toBe(
      'moonshine-small'
    );
    expect(readModels({ speech: 'whisper' }).speech).toBe('off');
  });

  it('lists the engines with what each needs, from the page and the server', () => {
    const choices = choicesFor(STATUS, 'speech');
    expect(choices.map(choice => [choice.id, choice.available])).toEqual([
      ['off', true],
      ['browser-local', false],
      ['moonshine-medium', true],
      ['moonshine-small', false]
    ]);
    // jsdom has no speech recognition.
    expect(choices[1].reason).toBe('This browser has no speech recognition.');
    expect(choices[2].label).toBe('Moonshine Medium, local');
    expect(choices[2].note).toMatch(/^269 MB; English; a note;/);
    // A missing model the server can fetch, with where it comes from.
    expect(choices[3].download).toBe(142);
    expect(choices[3].from).toBe('download.moonshine.ai');
    expect(choices[3].reason).toMatch(/^not downloaded: python -m/);
    expect(
      choicesFor(null, 'speech').find(
        choice => choice.id === 'moonshine-medium'
      )?.reason
    ).toBe('the server did not answer');
  });

  it('offers the browser where it can keep the audio on this computer', () => {
    (window as any).SpeechRecognition = FakeRecognition;
    expect(choicesFor(STATUS, 'speech')[1].available).toBe(true);
    // Electron, as JupyterLab Desktop runs, refuses the microphone.
    setAgent(`${CHROME} JupyterLab/4.6.3-1 Electron/42.5.0`);
    expect(choicesFor(STATUS, 'speech')[1].reason).toBe(
      'JupyterLab Desktop does not allow the microphone.'
    );
  });

  it('counts a spoken question engine in the summary and names it', () => {
    expect(
      aiSummary(STATUS, {
        ...DEFAULT_MODELS,
        cells: 'off',
        questions: 'off',
        labels: 'off',
        speech: 'moonshine-medium'
      })
    ).toBe('AI: local');
    expect(
      aiSummary(STATUS, { ...DEFAULT_MODELS, speech: 'moonshine-small' })
    ).toBe('AI: remote and local · 1 cannot run');
    expect(modelName(STATUS, 'moonshine-medium')).toBe(
      'Moonshine Medium, local'
    );
    expect(modelName(STATUS, 'browser-local')).toBe('Browser, on this device');
    expect(modelName(STATUS, undefined)).toBe('off');
  });
});

describe('keyTerms', () => {
  const variables: IVariable[] = [
    {
      name: 'patients',
      label: 'patients',
      kind: 'dataframe',
      columns: ['age', 'site', 'treatment_arm', 'id'].map(name => ({
        name,
        label: name,
        parent: 'patients',
        kind: 'series',
        tag: 'numeric'
      })) as any
    },
    { name: 'df', label: 'df', kind: 'dataframe' },
    { name: 'IL8', label: 'IL8', kind: 'series' }
  ] as IVariable[];

  it('says names as the analyst does', () => {
    expect(spoken('pain_score')).toBe('pain score');
    expect(spoken('IL8')).toBe('IL8');
    expect(spoken('weekly.mean,sd')).toBe('weekly mean sd');
  });

  it('favours the dropped names, then the frame and the variables, each once', () => {
    const dropped: IItem[] = [
      {
        kind: 'column',
        name: 'pain_score',
        label: 'pain_score',
        parent: 'diary'
      },
      { kind: 'variable', name: 'patients', label: 'patients' }
    ];
    const terms = keyTerms({ dropped, variables });
    expect(terms.slice(0, 2)).toEqual([
      { phrase: 'pain score', boost: 3 },
      { phrase: 'patients', boost: 3 }
    ]);
    expect(terms.map(term => term.phrase)).toEqual([
      'pain score',
      'patients',
      'diary',
      'age',
      'site',
      'treatment arm',
      'IL8',
      'covariate',
      'confounder',
      'residuals'
    ]);
    // Names under three letters (id, df) are left out.
    expect(terms.every(term => term.phrase.length >= 3)).toBe(true);
  });

  it('keeps 40 columns of a dropped frame and 100 names in all', () => {
    const wide = {
      name: 'olink',
      label: 'olink',
      kind: 'dataframe',
      columns: Array.from({ length: 4812 }, (_, index) => ({
        name: `INF${String(index).padStart(4, '0')}`,
        label: '',
        parent: 'olink',
        kind: 'numeric',
        tag: 'num'
      }))
    };
    const many = Array.from({ length: 300 }, (_, index) => ({
      name: `variable_${index}`,
      label: '',
      kind: 'constant'
    }));
    const terms = keyTerms({
      dropped: [{ kind: 'variable', name: 'olink', label: 'olink' }],
      variables: [wide, ...many] as unknown as IVariable[]
    });
    expect(terms).toHaveLength(100);
    expect(terms[0]).toEqual({ phrase: 'olink', boost: 3 });
    expect(terms[40]).toEqual({ phrase: 'INF0039', boost: 1 });
    expect(terms[41]).toEqual({ phrase: 'variable 0', boost: 1 });
  });
});

describe('the recording as the server reads it', () => {
  const sine = (rate: number, seconds: number, frequency = 440) =>
    Float32Array.from(
      { length: Math.round(rate * seconds) },
      (_, index) => 0.5 * Math.sin((2 * Math.PI * frequency * index) / rate)
    );
  const crossings = (samples: Float32Array) =>
    samples.reduce(
      (count, value, index) =>
        index > 0 &&
        Math.sign(value) !== Math.sign(samples[index - 1]) &&
        value !== 0
          ? count + 1
          : count,
      0
    );

  it('downsamples to 16 kHz and keeps a voice-range tone', () => {
    const tone = downsample(sine(48000, 0.5), 48000);
    expect(tone).toHaveLength(8000);
    // 440 Hz for half a second crosses zero about 440 times.
    expect(Math.abs(crossings(tone) - 440)).toBeLessThanOrEqual(2);
    expect(Math.max(...tone)).toBeCloseTo(0.5, 2);
    expect(downsample(sine(44100, 0.5), 44100)).toHaveLength(8000);
    // A rate at or under 16 kHz is kept.
    expect(downsample(sine(16000, 0.1), 16000)).toHaveLength(1600);
  });

  it('writes a WAV file of 16-bit mono PCM', () => {
    const wav = encodeWav(Float32Array.from([0, 0.5, -1, 2]), 16000);
    const view = new DataView(wav);
    const text = (at: number) =>
      String.fromCharCode(...new Uint8Array(wav, at, 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual([
      'RIFF',
      'WAVE',
      'fmt ',
      'data'
    ]);
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    // Values over 1 are cut to full scale.
    expect(
      [0, 1, 2, 3].map(index => view.getInt16(44 + 2 * index, true))
    ).toEqual([0, 16384, -32768, 32767]);
  });

  it('goes to the server with the engine and the names in the query', async () => {
    const request = requestAPI as jest.Mock;
    request.mockResolvedValue({
      text: 'is it associated',
      engine: 'Moonshine Medium'
    });
    const api = new Api({} as ServerConnection.ISettings);
    const wav = encodeWav(new Float32Array(160), 16000);
    await api.transcribe('moonshine-medium', wav, ['pain score', 'IL8']);
    const [endpoint, , init] = request.mock.calls[0];
    expect(endpoint).toBe(
      'speech/transcribe?engine=moonshine-medium&term=pain+score&term=IL8'
    );
    expect(init).toMatchObject({
      method: 'POST',
      body: wav,
      headers: { 'Content-Type': 'audio/wav' }
    });
  });
});

describe('the browser engine', () => {
  const terms: IKeyTerm[] = [
    { phrase: 'pain score', boost: 3 },
    { phrase: 'site', boost: 1 }
  ];

  it('says why a page or a browser cannot listen, before asking the browser', async () => {
    expect((await browserLocal.availability(context())).reason).toBe(
      'This browser has no speech recognition.'
    );
    (window as any).webkitSpeechRecognition = FakeRecognition;
    setAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15'
    );
    expect((await browserLocal.availability(context())).reason).toMatch(
      /^Safari may send the audio to Apple's servers/
    );
    setAgent(
      'Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0'
    );
    delete (window as any).webkitSpeechRecognition;
    expect((await browserLocal.availability(context())).reason).toBe(
      'Firefox recognizes speech only in its Nightly builds.'
    );
    (window as any).SpeechRecognition = FakeRecognition;
    (window as any).isSecureContext = false;
    expect((await browserLocal.availability(context())).reason).toMatch(
      /^Voice needs HTTPS or localhost/
    );
    expect(FakeRecognition.available).not.toHaveBeenCalled();
  });

  it('asks the browser whether it recognizes the language on this computer', async () => {
    (window as any).SpeechRecognition = FakeRecognition;
    (window as any).SpeechRecognitionPhrase = FakePhrase;
    setAgent(CHROME);
    const ready = await browserLocal.availability(context());
    expect(ready.state).toBe('ready');
    expect(ready.reason).toMatch(
      /Chrome recognizes the words on this computer/
    );
    expect(FakeRecognition.available).toHaveBeenCalledWith({
      langs: ['en-US'],
      processLocally: true
    });
    FakeRecognition.answer = 'downloadable';
    const download = await browserLocal.availability(context());
    expect(download.state).toBe('download');
    expect(download.reason).toMatch(
      /Chrome's recognizer for en-US first, about 60 MB/
    );
    FakeRecognition.answer = 'unavailable';
    setAgent(`${CHROME} Edg/154.0.0.0`);
    expect((await browserLocal.availability(context())).reason).toMatch(
      /^Edge recognizes speech on this computer only in Canary or Dev/
    );
    // A download needs the click; the install call keeps the audio on the device.
    expect(await browserLocal.install(context(), jest.fn())).toBe(true);
    expect(FakeRecognition.install).toHaveBeenCalledWith({
      langs: ['en-US'],
      processLocally: true
    });
  });

  it('listens on this computer with the names as phrases, and gives the words', () => {
    (window as any).SpeechRecognition = FakeRecognition;
    (window as any).SpeechRecognitionPhrase = FakePhrase;
    const events = listener();
    const session = browserLocal.start(context(), terms, events);
    const [recognition] = FakeRecognition.made;
    expect(recognition.started).toBe(true);
    expect([
      recognition.lang,
      recognition.processLocally,
      recognition.continuous,
      recognition.interimResults
    ]).toEqual(['en-US', true, true, true]);
    expect(recognition.phrases).toEqual([
      new FakePhrase('pain score', 3),
      new FakePhrase('site', 1)
    ]);
    recognition.say(['is pain'], false);
    recognition.say(['is pain score', ' related to site'], true);
    session.stop();
    expect(events.events).toEqual([
      'stage: listening',
      'text: is pain',
      'text: is pain score related to site',
      'final: is pain score related to site',
      'end'
    ]);
  });

  it('drops what it heard on abort, and says why it stopped on an error', () => {
    (window as any).SpeechRecognition = FakeRecognition;
    const dropped = listener();
    const session = browserLocal.start(context(), terms, dropped);
    FakeRecognition.made[0].say(['half a question']);
    session.abort();
    expect(dropped.events).toEqual([
      'stage: listening',
      'text: half a question',
      'end'
    ]);
    // Without SpeechRecognitionPhrase, as before Chrome 142, no phrases are set.
    expect(FakeRecognition.made[0].phrases).toEqual([]);
    const refused = listener();
    browserLocal.start(context(), terms, refused);
    FakeRecognition.made[1].onerror?.({ error: 'not-allowed' });
    FakeRecognition.made[1].onend?.();
    expect(refused.events).toEqual([
      'stage: listening',
      "error: The microphone is blocked for this page: allow it in the browser's site settings.",
      'end'
    ]);
  });
});

describe('an engine of the Jupyter server', () => {
  const medium = speechEngine('moonshine-medium')!;
  const small = speechEngine('moonshine-small')!;

  it('listens once the server can run it, and offers the download of a missing model', async () => {
    expect((await medium.availability(context())).state).toBe('ready');
    const download = await small.availability(context());
    expect(download.state).toBe('download');
    expect(download.reason).toBe(
      'Ask by voice: click to download Moonshine Small (142 MB) into the Jupyter server first.'
    );
    const missing = {
      ...STATUS,
      speech_engines: [
        engine('moonshine-medium', {
          available: false,
          reason: "moonshine-voice is not installed: pip install -e '.[speech]'"
        })
      ]
    };
    expect((await medium.availability(context(missing))).reason).toBe(
      "Moonshine Medium cannot run in the Jupyter server: moonshine-voice is not installed: pip install -e '.[speech]'"
    );
    expect((await medium.availability(context(null))).state).toBe(
      'unavailable'
    );
    (recordingReason as jest.Mock).mockReturnValueOnce(
      'This browser cannot record from the microphone on this page.'
    );
    expect((await medium.availability(context())).reason).toBe(
      'This browser cannot record from the microphone on this page.'
    );
  });

  it('sends the recording as 16 kHz WAV with the names, and gives the words', async () => {
    const samples = Float32Array.from(
      { length: 24000 },
      (_, index) => 0.5 * Math.sin((2 * Math.PI * 440 * index) / 48000)
    );
    const stop = jest.fn(async () => samples);
    (record as jest.Mock).mockResolvedValue({
      rate: 48000,
      stop,
      cancel: jest.fn()
    });
    const api = new Api({} as ServerConnection.ISettings);
    const transcribe = jest.spyOn(api, 'transcribe').mockResolvedValue({
      text: ' does pain differ by site ',
      engine: 'Moonshine Medium'
    });
    const events = listener();
    const session = medium.start(
      { api, status: STATUS, refresh: jest.fn() },
      [
        { phrase: 'pain score', boost: 3 },
        { phrase: 'site', boost: 1 }
      ],
      events
    );
    session.stop();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.events).toEqual([
      'stage: listening',
      'stage: writing',
      'final: does pain differ by site',
      'end'
    ]);
    const [id, wav, names] = transcribe.mock.calls[0];
    expect([id, names]).toEqual(['moonshine-medium', ['pain score', 'site']]);
    const view = new DataView(wav);
    expect(view.getUint32(24, true)).toBe(16000);
    // Half a second at 48 kHz is 8,000 samples of 2 bytes at 16 kHz.
    expect(view.getUint32(40, true)).toBe(16000);
  });

  it('says why the microphone was refused', async () => {
    (record as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    );
    const events = listener();
    medium.start(context(), [], events);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.events).toEqual([
      'stage: listening',
      "error: The microphone is blocked for this page: allow it in the browser's site settings.",
      'end'
    ]);
  });
});
