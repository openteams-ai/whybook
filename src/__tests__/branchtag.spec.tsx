/**
 * The tag in the head of a branch's card (critique 5, the app, A4). It
 * names the branch's parallel run while the run goes on, and reads "branch"
 * from the moment the run ends. A job that ended stays listed for a minute
 * with its slot (src/model/jobs.ts), and for that minute the card read
 * "parallel run 1" while the status bar read "Parallel 0/8".
 */
import './fakes/quiet';

import * as React from 'react';

import type { IJob } from '../model/jobs';
import { Bench } from '../ui/bench';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

const CELLS = [
  { id: 'weekly', count: 4, source: 'weekly = diary.groupby("week").mean()' },
  {
    id: 'weekly-b',
    count: 5,
    source: 'weekly_if_7 = diary.groupby("week").mean()',
    meta: { branch: { of: 'weekly', letter: 'b' } }
  }
];

/** The job of the branch, as the job manager lists it. */
function branchJob(status: IJob['status'], slot: number | null): IJob {
  return {
    id: 'weekly-b:1',
    cellId: 'weekly-b',
    label: '[4b]',
    text: 'What if MIN_DAYS were 7?',
    slot,
    status,
    progress: null,
    stage: null,
    outputBar: false,
    error: null,
    started: status === 'queued' ? null : 1,
    finished: null
  };
}

describe('the tag of a branch’s card', () => {
  it('names the parallel run while the branch runs, and reads "branch" once the run ends', async () => {
    const { model } = benchModel(CELLS);
    const jobs = model.jobs as any;
    const listed = (job: IJob) => {
      jobs._jobs.set(job.id, job);
      jobs._changed.emit();
    };
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    const tag = () =>
      view.host.querySelector('[data-cell-id="weekly-b"] .jp-Epi-subshell')
        ?.textContent;
    const shown: Record<string, string | null | undefined> = {};
    try {
      await settle();
      shown.before = tag();
      // A job waits for a slot with none of its own.
      const job = branchJob('queued', null);
      await step(() => listed(job));
      await settle();
      shown.queued = tag();
      await step(() => {
        job.status = 'running';
        job.slot = 0;
        jobs._changed.emit();
      });
      await settle();
      shown.running = tag();
      // The run ends: the job stays listed, with its slot, for a minute.
      await step(() => {
        job.status = 'done';
        job.finished = 2;
        jobs._changed.emit();
      });
      await settle();
      shown.done = tag();
      shown.slot = String(model.jobs.jobFor('weekly-b')?.slot);
      await step(() => {
        job.status = 'error';
        jobs._changed.emit();
      });
      await settle();
      shown.failed = tag();
    } finally {
      await view.unmount();
      model.dispose();
    }
    expect(shown).toEqual({
      before: 'branch',
      queued: 'branch',
      running: 'parallel run 1',
      done: 'branch',
      slot: '0',
      failed: 'branch'
    });
  });
});
