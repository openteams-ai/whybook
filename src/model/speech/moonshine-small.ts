import { serverEngine } from './server';

/** Moonshine Small Streaming in the Jupyter server: whybook/server/speech.py. */
export const moonshineSmall = serverEngine({
  id: 'moonshine-small',
  label: 'Moonshine Small',
  note: 'English; 7.84% of words wrong on the Open ASR Leaderboard'
});
