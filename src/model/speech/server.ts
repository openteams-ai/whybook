import type { IServerSpeechEngine, IServerStatus } from '../api';
import type { IModelChoice } from '../models';
import type { IAvailability, ISpeechEngine } from './engine';
import { pageReason, tidy } from './engine';
import { record, recordingReason } from './recorder';
import { downsample, encodeWav, SPEECH_RATE } from './wav';

/** A spoken question is a few seconds; a recording stops by itself after this. */
export const MAX_SECONDS = 30;

/** A download size as the settings write it. */
function size(megabytes: number): string {
  return megabytes >= 1000
    ? `${(megabytes / 1000).toFixed(1)} GB`
    : `${megabytes} MB`;
}

/** Why the microphone was refused, in the words the box shows. */
export function microphoneReason(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return "The microphone is blocked for this page: allow it in the browser's site settings.";
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found.';
  }
  if (name === 'NotReadableError') {
    return 'The microphone is in use by another program.';
  }
  return `The microphone could not record: ${String(error)}`;
}

/**
 * An engine that runs in the Jupyter server, as whybook/server/speech.py
 * lists it under the same id. The browser records the question, and the
 * server writes it as text, with the names in play as key terms.
 */
export function serverEngine(spec: {
  id: string;
  label: string;
  note: string;
}): ISpeechEngine {
  const entryOf = (
    status: IServerStatus | null
  ): IServerSpeechEngine | undefined =>
    status?.speech_engines?.find(entry => entry.id === spec.id);
  const unavailable = (reason: string): IAvailability => ({
    state: 'unavailable',
    reason
  });
  return {
    ...spec,

    choice(status: IServerStatus | null): IModelChoice {
      const entry = entryOf(status);
      const page = pageReason() ?? recordingReason();
      return {
        id: spec.id,
        label: `${spec.label}, local`,
        note: `${entry ? `${size(entry.size_mb)}; ${entry.note}` : spec.note}; the audio goes only to the Jupyter server`,
        available: !!entry?.available && page === null,
        reason:
          page ??
          (status
            ? entry
              ? entry.reason
              : 'this Jupyter server has no such engine'
            : 'the server did not answer'),
        download: entry?.downloadable ? entry.size_mb : null,
        // The model comes from Moonshine's site, not a Hugging Face repository.
        source: null,
        from: entry?.downloadable ? entry.source : undefined
      };
    },

    async availability(context): Promise<IAvailability> {
      const page = pageReason() ?? recordingReason();
      if (page) {
        return unavailable(page);
      }
      if (!context.status) {
        return unavailable('Ask by voice: the Jupyter server did not answer.');
      }
      const entry = entryOf(context.status);
      if (!entry) {
        return unavailable(
          `This Jupyter server has no ${spec.label}: its Whybook may be older than the one in the browser.`
        );
      }
      if (entry.available) {
        return {
          state: 'ready',
          reason: `Ask by voice: click, speak, then click again or press Escape. ${spec.label} writes the words in the Jupyter server; they fill this box, and nothing is asked until you press Enter.`
        };
      }
      if (entry.downloadable) {
        return {
          state: 'download',
          reason: `Ask by voice: click to download ${spec.label} (${size(entry.size_mb)}) into the Jupyter server first.`
        };
      }
      return unavailable(
        `${spec.label} cannot run in the Jupyter server: ${entry.reason}`
      );
    },

    async install(context, onProgress): Promise<boolean> {
      let failed: string | null = null;
      await context.api.downloadSpeech(spec.id, event => {
        if (event.type === 'progress') {
          onProgress(event.progress ?? null);
        } else if (event.type === 'error') {
          failed = event.message ?? 'the download failed';
        }
      });
      context.refresh();
      if (failed) {
        throw new Error(failed);
      }
      return true;
    },

    start(context, terms, listener) {
      let ended = false;
      let stopping = false;
      let limit = 0;
      const end = () => {
        if (!ended) {
          ended = true;
          window.clearTimeout(limit);
          listener.onEnd();
        }
      };
      const recording = record();
      recording.catch(error => {
        listener.onError(microphoneReason(error));
        end();
      });
      const finish = async () => {
        let samples: Float32Array;
        let rate: number;
        try {
          const running = await recording;
          rate = running.rate;
          samples = await running.stop();
        } catch {
          // The microphone was refused: the error is out already.
          return;
        }
        if (ended) {
          return;
        }
        if (samples.length < rate / 10) {
          listener.onError('Nothing was recorded.');
          end();
          return;
        }
        listener.onStage('writing');
        try {
          const wav = encodeWav(downsample(samples, rate), SPEECH_RATE);
          const transcript = await context.api.transcribe(
            spec.id,
            wav,
            terms.map(term => term.phrase)
          );
          if (!ended) {
            listener.onText(tidy(transcript.text), true);
          }
        } catch (error) {
          listener.onError(
            `${spec.label} could not write the words: ${(error as Error).message ?? error}`
          );
        }
        end();
      };
      const stop = () => {
        if (!stopping && !ended) {
          stopping = true;
          void finish();
        }
      };
      // A question left recording stops by itself.
      limit = window.setTimeout(stop, MAX_SECONDS * 1000);
      listener.onStage('listening');
      return {
        stop,
        abort: () => {
          if (!ended) {
            void recording.then(running => running.cancel()).catch(() => null);
            end();
          }
        }
      };
    }
  };
}
