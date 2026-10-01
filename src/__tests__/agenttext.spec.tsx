/**
 * A text that an agent wrote, such as the comparison that a run in another
 * notebook brings back (design iteration 1.69): the bench and the Code
 * view mark it as the summary of an agent's code is marked, with the AI tag
 * and the colour of what a model wrote. The analyst's own text has no mark.
 * A run asked in another notebook shows in a line of its own, with Stop.
 */
import * as React from 'react';

import type { IAgentRun } from '../model/agent';
import { AgentRuns } from '../model/runs';
import { NoteCard, ResultStrip } from '../ui/bench';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

const MARK = {
  written_by: 'agent',
  asked_by: 'user',
  agent: { run: 'r1', step: 4 },
  generated_by: {
    agent: 'anthropic',
    model: 'claude-opus-5-5',
    at: '2026-09-30T15:00:00Z'
  }
};

async function drawn(
  meta: Record<string, unknown> | undefined,
  variant: 'bench' | 'linear'
) {
  const { model } = benchModel([
    {
      id: 't',
      type: 'markdown',
      source: '## Would I get the same results in R?\n\nThe means agree.',
      meta
    },
    { id: 'a', source: 'x = 1', count: 1 }
  ]);
  const view = await mount(
    <NoteCard
      model={model}
      cell={model.cell('t')!}
      editorServices={null}
      variant={variant}
    />
  );
  await settle();
  return view;
}

describe("an agent's text on the bench and in the Code view", () => {
  for (const variant of ['bench', 'linear'] as const) {
    it(`carries the AI tag and the model's colour in the ${variant === 'bench' ? 'bench' : 'Code view'}`, async () => {
      const view = await drawn(MARK, variant);
      const note = view.host.querySelector('.jp-Epi-note')!;
      expect(note.classList.contains('jp-mod-ai')).toBe(true);
      const by = note.querySelector('.jp-Epi-note-by')!;
      expect(by.textContent).toBe('Written by the agentAI');
      expect(
        by.querySelector('.jp-Epi-aitag')?.getAttribute('title')
      ).toContain('claude-opus-5-5');
      await view.unmount();
    });
  }

  it("leaves the analyst's own text unmarked", async () => {
    const view = await drawn(undefined, 'bench');
    const note = view.host.querySelector('.jp-Epi-note')!;
    expect(note.classList.contains('jp-mod-ai')).toBe(false);
    expect(note.querySelector('.jp-Epi-note-by')).toBeNull();
    await view.unmount();
  });
});

describe('a run asked in another notebook', () => {
  it('shows in a line with the question, where it was asked, and Stop', async () => {
    const runs = new AgentRuns();
    const { model } = benchModel(
      [{ id: 'intro', type: 'markdown', source: '# In R' }],
      {
        path: 'study/pain.R.ipynb',
        runs
      }
    );
    const run: IAgentRun = {
      id: 'r1',
      stripId: 'end:1',
      question: 'Would I get the same results in R?',
      anchor: null,
      state: 'working',
      steps: [
        {
          call: 'c1',
          tool: 'run_cell',
          title: 'Weekly means',
          why: '',
          cells: ['x'],
          notebook: 'study/pain.R.ipynb',
          state: 'done',
          error: null
        }
      ],
      notes: [],
      thinking: null,
      answer: null,
      answerCells: [],
      followUp: [],
      by: null,
      costUsd: null,
      error: null,
      started: Date.now(),
      keepLocal: false,
      notebooks: [
        {
          path: 'study/pain.R.ipynb',
          kernel: 'xr',
          displayName: 'R 4.4.3 (xr)',
          label: 'R',
          sandboxed: false,
          intro: 'intro'
        }
      ]
    };
    const stop = jest.fn();
    model.stopAgent = stop;
    const view = await mount(
      <ResultStrip
        model={model}
        strip={{
          cellId: 'intro',
          text: run.question,
          action: 'the run',
          placement: { kind: 'new', cell: 'intro', label: 'the run' },
          status: 'writing',
          stage: null,
          elapsed: null,
          started: Date.now(),
          thinking: null,
          before: null,
          after: null,
          insertedId: null,
          error: null,
          showDiff: false,
          agent: run,
          elsewhere: 'study/pain.ipynb'
        }}
      />
    );
    await settle();
    const line = view.host.querySelector('.jp-Epi-agentelsewhere')!;
    expect(line.querySelector('.jp-Epi-strip-text')?.textContent).toBe(
      'Would I get the same results in R?'
    );
    expect(line.querySelector('.jp-Epi-strip-stage')?.textContent).toBe(
      'Working · 1 cell here · asked in pain.ipynb'
    );
    const buttons = Array.from(line.querySelectorAll('button')).map(
      button => button.textContent
    );
    expect(buttons).toEqual(['Show the run', 'Stop']);
    (line.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(stop).toHaveBeenCalledWith(run);
    await view.unmount();
  });
});
