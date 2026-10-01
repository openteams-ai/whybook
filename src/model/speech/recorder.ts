/**
 * A recording from the microphone, for the speech engines of the Jupyter
 * server: an AudioWorklet copies the samples out of the audio thread, mixed
 * to mono, at the rate of the page's AudioContext. The server engine
 * downsamples them to 16 kHz and sends them as a WAV file.
 */

/** The audio thread's part: it gathers blocks of 128 samples and posts them 4,096 at a time. */
const WORKLET = [
  'class WhybookCapture extends AudioWorkletProcessor {',
  '  constructor() {',
  '    super();',
  '    this.blocks = [];',
  '    this.size = 0;',
  '    this.port.onmessage = () => {',
  '      this.flush();',
  "      this.port.postMessage('flushed');",
  '    };',
  '  }',
  '  flush() {',
  '    if (!this.size) {',
  '      return;',
  '    }',
  '    const samples = new Float32Array(this.size);',
  '    let at = 0;',
  '    for (const block of this.blocks) {',
  '      samples.set(block, at);',
  '      at += block.length;',
  '    }',
  '    this.blocks = [];',
  '    this.size = 0;',
  '    this.port.postMessage(samples, [samples.buffer]);',
  '  }',
  '  process(inputs) {',
  '    const channels = inputs[0];',
  '    if (channels && channels.length) {',
  '      const mono = new Float32Array(channels[0].length);',
  '      for (const channel of channels) {',
  '        for (let i = 0; i < mono.length; i++) {',
  '          mono[i] += channel[i] / channels.length;',
  '        }',
  '      }',
  '      this.blocks.push(mono);',
  '      this.size += mono.length;',
  '      if (this.size >= 4096) {',
  '        this.flush();',
  '      }',
  '    }',
  '    return true;',
  '  }',
  '}',
  "registerProcessor('whybook-capture', WhybookCapture);"
].join('\n');

/** A recording under way. */
export interface IRecording {
  /** The samples' rate: the AudioContext's, 44.1 or 48 kHz as a rule. */
  readonly rate: number;
  /** Stop, free the microphone, and give the samples. */
  stop(): Promise<Float32Array>;
  /** Stop and free the microphone. */
  cancel(): void;
}

/** Why the page cannot record, or null. */
export function recordingReason(): string | null {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser cannot record from the microphone on this page.';
  }
  if (typeof AudioWorkletNode === 'undefined') {
    return 'This browser cannot process audio in the page: it has no AudioWorklet.';
  }
  // Chromium's feature policy, which TypeScript's types of the DOM leave out.
  const policy = (
    document as Document & {
      featurePolicy?: { allowsFeature?: (feature: string) => boolean };
    }
  ).featurePolicy;
  if (policy?.allowsFeature && !policy.allowsFeature('microphone')) {
    return 'The page that holds JupyterLab does not allow the microphone: open JupyterLab in its own tab.';
  }
  return null;
}

/** Start recording, after the browser asks the analyst for the microphone. */
export async function record(): Promise<IRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  let context: AudioContext | null = null;
  const release = () => {
    // The browser's recording indicator goes out with the last track.
    for (const track of stream.getTracks()) {
      track.stop();
    }
    void context?.close();
  };
  try {
    context = new AudioContext();
    const url = URL.createObjectURL(
      new Blob([WORKLET], { type: 'text/javascript' })
    );
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'whybook-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    const blocks: Float32Array[] = [];
    let flushed: (() => void) | null = null;
    node.port.onmessage = event => {
      if (event.data === 'flushed') {
        flushed?.();
      } else {
        blocks.push(event.data as Float32Array);
      }
    };
    source.connect(node);
    // The processor writes nothing to its output: connected, it runs, and is silent.
    node.connect(context.destination);
    if (context.state === 'suspended') {
      await context.resume();
    }
    const rate = context.sampleRate;
    let done = false;
    const close = () => {
      if (!done) {
        done = true;
        source.disconnect();
        node.disconnect();
        release();
      }
    };
    return {
      rate,
      stop: async () => {
        if (!done) {
          // The samples still in the audio thread, or what came before them after half a second.
          await new Promise<void>(resolve => {
            flushed = resolve;
            node.port.postMessage('flush');
            window.setTimeout(resolve, 500);
          });
        }
        close();
        const samples = new Float32Array(
          blocks.reduce((size, block) => size + block.length, 0)
        );
        let at = 0;
        for (const block of blocks) {
          samples.set(block, at);
          at += block.length;
        }
        return samples;
      },
      cancel: close
    };
  } catch (error) {
    release();
    throw error;
  }
}
