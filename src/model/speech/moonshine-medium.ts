import { serverEngine } from './server';

/** Moonshine Medium Streaming in the Jupyter server: whybook/server/speech.py. */
export const moonshineMedium = serverEngine({
  id: 'moonshine-medium',
  label: 'Moonshine Medium',
  note: 'English; 6.66% of words wrong on the Open ASR Leaderboard'
});
