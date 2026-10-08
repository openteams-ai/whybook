import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

/**
 * Spoken questions, with fakes in the page: a SpeechRecognition that the
 * test makes speak, and a getUserMedia that gives a 440 Hz tone. No
 * microphone opens, nothing records, and no model runs.
 */

/** A SpeechRecognition like Chrome's, with its settings on the prototype, that the test makes speak. */
function fakeRecognition(options: { answer: string; api: boolean }): void {
  const state: any = { made: [], answer: options.answer, installs: [] };
  class FakeRecognition {
    onresult: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    constructor() {
      state.made.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      setTimeout(() => this.onend?.(), 0);
    }
    abort() {
      setTimeout(() => {
        this.onerror?.({ error: 'aborted' });
        this.onend?.();
      }, 0);
    }
    say(words: string[], final: boolean) {
      const results = words.map(transcript =>
        Object.assign([{ transcript, confidence: 1 }], { isFinal: final })
      );
      this.onresult?.({ resultIndex: 0, results });
    }
    static available(asked: unknown) {
      state.asked = asked;
      return Promise.resolve(state.answer);
    }
    static install(asked: unknown) {
      state.installs.push(asked);
      state.answer = 'available';
      return Promise.resolve(true);
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
  const page = window as any;
  if (options.api) {
    page.SpeechRecognition = FakeRecognition;
    page.webkitSpeechRecognition = FakeRecognition;
    page.SpeechRecognitionPhrase = FakePhrase;
  } else {
    // A browser with the prefixed API only, as before Chrome 139.
    delete page.SpeechRecognition;
    delete page.SpeechRecognitionPhrase;
  }
  page.__speech = state;
}

/**
 * A getUserMedia that gives a 440 Hz tone at half the full scale, in place of
 * a microphone, and the seconds of sound that the view's recorder has taken:
 * its worklet posts the samples out of the audio thread 4,096 at a time.
 */
function fakeMicrophone(_: undefined): void {
  const page = window as any;
  page.__microphone = { asked: [], seconds: 0 };
  navigator.mediaDevices.getUserMedia = async (constraints: any) => {
    page.__microphone.asked.push(constraints);
    const context = new AudioContext();
    const tone = context.createOscillator();
    tone.frequency.value = 440;
    const gain = context.createGain();
    gain.gain.value = 0.5;
    const out = context.createMediaStreamDestination();
    tone.connect(gain).connect(out);
    tone.start();
    return out.stream;
  };
  const Node = window.AudioWorkletNode;
  page.AudioWorkletNode = class extends Node {
    constructor(
      context: BaseAudioContext,
      name: string,
      options?: AudioWorkletNodeOptions
    ) {
      super(context, name, options);
      this.port.addEventListener('message', event => {
        if (event.data instanceof Float32Array) {
          page.__microphone.seconds += event.data.length / context.sampleRate;
        }
      });
    }
  };
}

/**
 * Put a fake in the page: galata opened JupyterLab before the test, so the
 * page loads again with the fake in place before JupyterLab's code.
 */
async function withFake<T>(
  page: IJupyterLabPageFixture,
  fake: (arg: T) => void,
  arg: T
): Promise<void> {
  await page.addInitScript(fake, arg);
  await page.reload();
}

async function openInWhybook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  await page.evaluate(async (file: string) => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: file,
      factory: 'Whybook'
    });
  }, file);
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
}

/** A notebook whose cell makes two variables, run in the view. */
async function openAndRun(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const notebook = {
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        id: 'cell-0',
        metadata: {},
        outputs: [],
        source: 'pain_score = 3\nsite_name = "A"'
      }
    ],
    metadata: {
      kernelspec: {
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
        name: 'python3'
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
  await openInWhybook(page, file);
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator('.jp-Epi-variable', { hasText: 'pain_score' })
  ).toBeVisible({ timeout: 60000 });
}

/** The status says a model can answer questions, with the speech engines given. */
async function answerStatus(
  page: IJupyterLabPageFixture,
  engines: unknown[] = []
): Promise<void> {
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, claude_available: true, speech_engines: engines }
    });
  });
}

/** Choose the engine of spoken questions in the panel of the view's toolbar. */
async function chooseEngine(
  page: IJupyterLabPageFixture,
  engine: string
): Promise<void> {
  await page.locator('.jp-Epi-aibutton').click();
  await page.locator('#jp-Epi-quick-speech').selectOption(engine);
  await page.keyboard.press('Escape');
  await expect(page.locator('.jp-Epi-aipanel')).toHaveCount(0);
}

const box = (page: IJupyterLabPageFixture) =>
  page.locator('#epi-exploration .jp-Epi-ownbox');

test('asks by voice with the browser on this device: the words fill the box, and nothing is asked before Enter', async ({
  page,
  tmpPath
}) => {
  await withFake(page, fakeRecognition, { answer: 'available', api: true });
  await answerStatus(page);
  const solved: unknown[] = [];
  await page.route(/\/whybook\/solve/, async route => {
    solved.push(route.request().postDataJSON());
    await route.abort();
  });
  await openAndRun(page, `${tmpPath}/spoken.ipynb`);
  const voice = box(page).locator('.jp-Epi-voice');
  const input = box(page).locator('textarea');
  // Off by default: grey, and the tooltip says so.
  await expect(voice).toHaveAttribute('data-state', 'off');
  await expect(voice).toHaveAttribute('aria-disabled', 'true');
  await chooseEngine(page, 'browser-local');
  await expect(voice).toHaveAttribute('data-state', 'ready');
  await expect(voice).not.toHaveAttribute('aria-disabled', 'true');
  await expect(voice).toHaveAttribute(
    'title',
    /recognizes the words on this computer/
  );
  expect(await page.evaluate(() => (window as any).__speech.asked)).toEqual({
    langs: ['en-US'],
    processLocally: true
  });

  // A click listens, on the device, with the variables' names as phrases.
  await voice.click();
  await expect(voice).toHaveAttribute('data-state', 'listening');
  await expect(voice).toHaveAttribute('aria-pressed', 'true');
  const settings = await page.evaluate(() => {
    const recognition = (window as any).__speech.made.at(-1);
    return {
      started: recognition.started,
      processLocally: recognition.processLocally,
      continuous: recognition.continuous,
      interimResults: recognition.interimResults,
      phrases: recognition.phrases.map((item: any) => [item.phrase, item.boost])
    };
  });
  expect(settings).toMatchObject({
    started: true,
    processLocally: true,
    continuous: true,
    interimResults: true
  });
  expect(settings.phrases).toEqual(
    expect.arrayContaining([
      ['pain score', 1],
      ['site name', 1],
      ['covariate', 1]
    ])
  );
  // The words fill the box while the analyst speaks.
  await page.evaluate(() =>
    (window as any).__speech.made.at(-1).say(['is pain score'], false)
  );
  await expect(input).toHaveValue('is pain score');
  await page.evaluate(() =>
    (window as any).__speech.made
      .at(-1)
      .say(['is pain score', ' related to site name'], true)
  );
  // A second click stops; the box has the words, their type, and the focus.
  await voice.click();
  await expect(voice).toHaveAttribute('data-state', 'ready');
  await expect(input).toHaveValue('is pain score related to site name');
  await expect(input).toBeFocused();
  await expect(box(page).locator('.jp-Epi-own-meta')).toContainText(
    'Association'
  );

  // Escape stops too, and the words go after the text already there.
  await voice.click();
  await expect(voice).toHaveAttribute('data-state', 'listening');
  await page.evaluate(() =>
    (window as any).__speech.made.at(-1).say(['adjusting for age'], true)
  );
  await page.keyboard.press('Escape');
  await expect(voice).toHaveAttribute('data-state', 'ready');
  await expect(input).toHaveValue(
    'is pain score related to site name adjusting for age'
  );
  // Nothing was asked: that waits for Enter. Each way of asking empties the
  // box before its request goes, and the box kept the words after the
  // recognizer ended.
  expect(solved).toHaveLength(0);
});

test('downloads the recognizer of the browser after a click, and says when a browser cannot listen', async ({
  page,
  tmpPath
}) => {
  await withFake(page, fakeRecognition, { answer: 'downloadable', api: true });
  await answerStatus(page);
  await openAndRun(page, `${tmpPath}/download.ipynb`);
  const voice = box(page).locator('.jp-Epi-voice');
  await chooseEngine(page, 'browser-local');
  await expect(voice).toHaveAttribute('data-state', 'download');
  await expect(voice).toHaveAttribute('title', /click to download/);
  await voice.click();
  await expect(voice).toHaveAttribute('data-state', 'ready');
  expect(await page.evaluate(() => (window as any).__speech.installs)).toEqual([
    { langs: ['en-US'], processLocally: true }
  ]);

  // A browser that answers "unavailable" leaves the microphone grey, with why.
  await page.evaluate(() => {
    (window as any).__speech.answer = 'unavailable';
  });
  await chooseEngine(page, 'off');
  await chooseEngine(page, 'browser-local');
  await expect(voice).toHaveAttribute('data-state', 'unavailable');
  await expect(voice).toHaveAttribute('aria-disabled', 'true');
  await expect(voice).toHaveAttribute(
    'title',
    /cannot recognize en-US on this computer/
  );
  // A click on the grey microphone does nothing.
  await voice.click({ force: true });
  await expect(voice).toHaveAttribute('data-state', 'unavailable');
  expect(await page.evaluate(() => (window as any).__speech.made)).toEqual([]);
});

test('keeps the microphone grey in a browser that may send the audio to a server', async ({
  page,
  tmpPath
}) => {
  await withFake(page, fakeRecognition, { answer: 'available', api: false });
  await answerStatus(page);
  await openAndRun(page, `${tmpPath}/prefixed.ipynb`);
  await page.locator('.jp-Epi-aibutton').click();
  const option = page.locator(
    '#jp-Epi-quick-speech option[value="browser-local"]'
  );
  await expect(option).toHaveText('Browser, on this device (cannot run)');
  await expect(option).toBeDisabled();
});

test('asks by voice with Moonshine in the Jupyter server: the recording goes as 16 kHz WAV with the names', async ({
  page,
  tmpPath
}) => {
  await withFake(page, fakeMicrophone, undefined);
  const engine = (id: string, label: string, available: boolean) => ({
    id,
    label,
    kind: 'speech',
    size_mb: id === 'moonshine-medium' ? 269 : 142,
    note: 'English',
    source: 'download.moonshine.ai',
    available,
    reason: available
      ? null
      : 'not downloaded: python -m moonshine_voice.download --stt --language en --model-arch 4',
    downloadable: !available
  });
  await answerStatus(page, [
    engine('moonshine-medium', 'Moonshine Medium', true),
    engine('moonshine-small', 'Moonshine Small', false)
  ]);
  const posted: { url: string; body: Buffer; type: string | null }[] = [];
  await page.route(/\/whybook\/speech\/transcribe/, async route => {
    const request = route.request();
    posted.push({
      url: request.url(),
      body: request.postDataBuffer()!,
      type: await request.headerValue('content-type')
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        text: 'does pain differ by site',
        engine: 'Moonshine Medium'
      })
    });
  });
  await openAndRun(page, `${tmpPath}/moonshine.ipynb`);

  // The AI panel lists the engines; a missing model says where to get it.
  await page.locator('.jp-Epi-aibutton').click();
  await expect(page.locator('#jp-Epi-quick-speech option')).toHaveText([
    'Off',
    'Browser, on this device',
    'Moonshine Medium, local',
    'Moonshine Small, local (cannot run)'
  ]);
  const panel = page.locator('.jp-Epi-aipanel');
  await page.locator('#jp-Epi-quick-speech').selectOption('moonshine-small');
  await expect(panel).toContainText('Not downloaded: see all AI settings');
  // The settings editor offers its download, from Moonshine's site.
  const downloads: unknown[] = [];
  await page.route(/\/whybook\/speech\/download/, async route => {
    downloads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({
          type: 'result',
          model: 'moonshine-small',
          elapsed: 0.1
        }) + '\n'
    });
  });
  await panel.locator('button', { hasText: 'All AI settings' }).click();
  const field = page.locator('.jp-Epi-modelsfield');
  await expect(field).toBeVisible();
  await expect(field).toContainText('from download.moonshine.ai');
  await field.locator('button', { hasText: 'Download 142 MB' }).click();
  await expect.poll(() => downloads).toEqual([{ engine: 'moonshine-small' }]);
  await field.locator('#jp-Epi-model-speech').selectOption('moonshine-medium');
  await page.locator('.lm-TabBar-tab', { hasText: 'moonshine.ipynb' }).click();

  const voice = box(page).locator('.jp-Epi-voice');
  const input = box(page).locator('textarea');
  await expect(voice).toHaveAttribute('data-state', 'ready');
  await expect(voice).toHaveAttribute(
    'title',
    /Moonshine Medium writes the words in the Jupyter server/
  );
  await voice.click();
  await expect(voice).toHaveAttribute('data-state', 'listening');
  // A second of the tone reaches the recorder before the second click.
  await page.waitForFunction(() => (window as any).__microphone.seconds >= 1);
  await voice.click();
  await expect(input).toHaveValue('does pain differ by site');
  await expect(voice).toHaveAttribute('data-state', 'ready');

  // The browser asked for a microphone once, and posted one WAV file.
  expect(
    await page.evaluate(() => (window as any).__microphone.asked.length)
  ).toBe(1);
  expect(posted).toHaveLength(1);
  const url = new URL(posted[0].url);
  expect(url.searchParams.get('engine')).toBe('moonshine-medium');
  expect(url.searchParams.getAll('term')).toEqual(
    expect.arrayContaining(['pain score', 'site name'])
  );
  expect(posted[0].type).toBe('audio/wav');
  const wav = posted[0].body;
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(16000);
  expect(wav.readUInt16LE(34)).toBe(16);
  const bytes = wav.readUInt32LE(40);
  expect(bytes).toBe(wav.length - 44);
  // About a second of the tone: its samples are not silence.
  expect(bytes / 2 / 16000).toBeGreaterThan(0.5);
  let squares = 0;
  for (let at = 44; at < wav.length; at += 2) {
    squares += (wav.readInt16LE(at) / 32768) ** 2;
  }
  expect(Math.sqrt(squares / (bytes / 2))).toBeGreaterThan(0.1);
});
