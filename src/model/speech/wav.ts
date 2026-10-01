/** The sample rate that the server's speech engines read: Moonshine takes 16 kHz. */
export const SPEECH_RATE = 16000;

/**
 * Samples at a lower rate: each output sample is the mean of the input over
 * its span, a box filter that keeps speech (under 4 kHz) and damps what
 * would fold back from above the new rate's half. A microphone records at
 * 44.1 or 48 kHz, the rate of the page's AudioContext.
 */
export function downsample(
  input: Float32Array,
  from: number,
  to: number = SPEECH_RATE
): Float32Array {
  if (from <= to) {
    return input.slice();
  }
  const ratio = from / to;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const start = index * ratio;
    const end = start + ratio;
    let sum = 0;
    let weight = 0;
    for (let at = Math.floor(start); at < end && at < input.length; at++) {
      // The part of input sample `at`, the span [at, at + 1), inside [start, end).
      const part = Math.min(at + 1, end) - Math.max(at, start);
      sum += input[at] * part;
      weight += part;
    }
    output[index] = weight > 0 ? sum / weight : 0;
  }
  return output;
}

/** A WAV file of 16-bit mono PCM, which the server reads with Python's wave module. */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + 2 * samples.length);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + 2 * samples.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  // The format chunk: 16 bytes of PCM (1), one channel, the rate, the bytes
  // per second and per frame, and 16 bits per sample.
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, 2 * rate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, 2 * samples.length, true);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(
      44 + 2 * index,
      Math.round(value < 0 ? value * 0x8000 : value * 0x7fff),
      true
    );
  }
  return buffer;
}
