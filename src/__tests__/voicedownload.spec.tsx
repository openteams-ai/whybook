/**
 * The microphone while the browser downloads its recognizer: a download
 * that goes on past INSTALL_TIMEOUT offers a new try, and the microphone
 * turns ready once the browser has the recognizer.
 */
import * as React from 'react';
import { act } from 'react';

import type { EpiModel } from '../model/epimodel';
import type { IAvailability } from '../model/speech/engine';
import { INSTALL_TIMEOUT, browserLocal } from '../model/speech/browser';
import type { IVoice } from '../ui/voice';
import { DOWNLOAD_STALLED, useVoice } from '../ui/voice';
import { benchModel } from './fakes/bench-fake';
import { mount } from './fakes/bench-render';

function Probe(props: {
  model: EpiModel;
  voice: { current: IVoice | null };
}): JSX.Element {
  const voice = useVoice({
    model: props.model,
    enabled: true,
    text: () => '',
    write: () => undefined,
    focus: () => undefined
  });
  props.voice.current = voice;
  return <span data-state={voice.state} title={voice.title} />;
}

/** Move the clock and the timers on, and let the promises due run. */
async function wait(ms: number, now: { value: number }): Promise<void> {
  await act(async () => {
    now.value += ms;
    jest.advanceTimersByTime(ms);
    for (let index = 0; index < 5; index++) {
      await Promise.resolve();
    }
  });
}

describe('the microphone while the browser downloads its recognizer', () => {
  const now = { value: 0 };
  beforeEach(() => {
    jest.useFakeTimers();
    now.value = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now.value);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('offers a new try after a download that did not end in time, and turns ready when the browser has it', async () => {
    let answer: IAvailability = {
      state: 'downloading',
      reason: 'The browser downloads its recognizer.'
    };
    // The answer comes on the next timer, which the test moves on in act.
    jest
      .spyOn(browserLocal, 'availability')
      .mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(answer), 0))
      );
    const install = jest
      .spyOn(browserLocal, 'install')
      .mockImplementation(async () => true);
    const { model } = benchModel([{ id: 'a', source: 'x = 1' }]);
    model.settings.models = {
      ...model.settings.models,
      speech: 'browser-local'
    };
    const voice: { current: IVoice | null } = { current: null };
    const view = await mount(<Probe model={model} voice={voice} />);
    const states: string[] = [];
    const record = () =>
      states.push(view.host.querySelector('span')!.dataset.state!);
    await wait(0, now);
    record();
    // The browser still says it downloads, past the time a download takes.
    await wait(INSTALL_TIMEOUT + 5000, now);
    await wait(5000, now);
    record();
    const title = view.host.querySelector('span')!.title;
    // A click tries again, and the browser then has the recognizer.
    answer = { state: 'ready', reason: 'Ready.' };
    await act(async () => voice.current!.toggle());
    await wait(0, now);
    record();
    await view.unmount();
    model.dispose();
    expect({ states, title, installs: install.mock.calls.length }).toEqual({
      states: ['downloading', 'download', 'ready'],
      title: DOWNLOAD_STALLED,
      installs: 1
    });
  });
});
