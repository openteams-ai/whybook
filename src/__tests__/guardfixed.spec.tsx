/**
 * A review guard that the server fixes (c.Whybook.review_guard) also fixes
 * the notebook's mark of synthetic data and "Allow for this session" (design
 * iteration 1.132). The AI models panel shows the notebook's box "synthetic"
 * off and greyed, with "Fixed on the server", as it shows the guard's two
 * check boxes; neither the panel's list of held items nor an agent's run
 * offers "Allow for this session". A guard that the analyst chooses keeps
 * both.
 */
import * as React from 'react';
import { Signal } from '@lumino/signaling';

import type { IAgentRun } from '../model/agent';
import type { IGuardHeld, IGuardMemory } from '../model/guard';
import { DEFAULT_GUARD } from '../model/guard';
import { AgentRunView } from '../ui/agent';
import { GuardSection } from '../ui/guard';
import type { IMounted } from './fakes/bench-render';
import { button, mount, settle, step } from './fakes/bench-render';

const FLAGS = [
  {
    kind: 'identifier',
    text: 'P042',
    rule: 'an identifier next to age',
    level: 'reject' as const,
    by: 'rules'
  },
  {
    kind: 'age',
    text: 'aged 67',
    rule: 'an identifier next to age',
    level: 'reject' as const,
    by: 'rules'
  }
];

const HELD: IGuardHeld = {
  type: 'guard_held',
  guard: 'privacy',
  what: 'the question and the notebook',
  flags: FLAGS,
  reason: 'an identifier next to age',
  masked: true
};

const HELD_WORDS =
  'The review guard masked parts of the question and the notebook before it went to the model: an identifier next to age.';

/** A view model with what the guard's section and an agent's run read, in a notebook marked synthetic. */
function fakeModel(fixed: boolean): any {
  const memory: IGuardMemory = {
    answers: [],
    held: [
      {
        guard: 'privacy',
        what: HELD.what,
        flags: FLAGS,
        reason: HELD.reason,
        time: 0,
        masked: true
      }
    ]
  };
  return {
    changed: new Signal({}),
    settings: { guard: { ...DEFAULT_GUARD }, setGuard: jest.fn() },
    status: { review_guard: fixed ? 'reject' : '', guard_models: [] },
    guardMode: 'reject',
    guardFixed: fixed,
    guardSynthetic: true,
    setGuardSynthetic: jest.fn(),
    sandboxed: false,
    guardHeld: [],
    guardMemory: jest.fn(async () => memory),
    runs: { entry: () => undefined, host: null },
    context: { path: 'diary.ipynb' }
  };
}

function runWithHeld(): IAgentRun {
  return {
    id: 'r1',
    held: [HELD],
    stripId: 'a',
    question: 'Who has the most pain?',
    anchor: null,
    state: 'done',
    steps: [],
    notes: [],
    thinking: null,
    answer: null,
    answerCells: [],
    followUp: [],
    by: null,
    costUsd: 0,
    error: null,
    started: Date.now(),
    keepLocal: false
  };
}

let mounted: IMounted | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function syntheticBox(host: Element): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('#jp-Epi-guard-synthetic')!;
}

function syntheticDetail(host: Element): string {
  return (
    host.querySelector(
      'label[for="jp-Epi-guard-synthetic"] .jp-Epi-guard-detail'
    )?.textContent ?? ''
  );
}

async function heldList(host: Element): Promise<Element> {
  await step(() => button(host, '1 item held back').click());
  return host.querySelector('.jp-Epi-guard-list')!;
}

function buttonsOf(within: Element): string[] {
  return Array.from(within.querySelectorAll('button')).map(
    item => item.textContent?.trim() ?? ''
  );
}

describe('a guard that the server fixes', () => {
  it('shows the notebook\'s box "synthetic" off and greyed, with "Fixed on the server", and keeps the mark', async () => {
    const model = fakeModel(true);
    mounted = await mount(<GuardSection model={model} />);
    await settle();
    const box = syntheticBox(mounted.host);
    expect([box.checked, box.disabled]).toEqual([false, true]);
    expect(syntheticDetail(mounted.host)).toBe(
      'Fixed on the server: c.Whybook.review_guard treats the data of every notebook as real.'
    );
    // The guard's two check boxes, fixed as before.
    for (const id of ['jp-Epi-guard-privacy', 'jp-Epi-guard-execution']) {
      const fixed = mounted.host.querySelector<HTMLInputElement>(`#${id}`)!;
      expect([fixed.checked, fixed.disabled]).toEqual([true, true]);
    }
    expect(model.setGuardSynthetic).not.toHaveBeenCalled();
  });

  it('lists what the guard held back without "Allow for this session"', async () => {
    const model = fakeModel(true);
    mounted = await mount(<GuardSection model={model} />);
    await settle();
    const list = await heldList(mounted.host);
    expect(list.textContent).toBe(HELD_WORDS);
    expect(buttonsOf(list)).toEqual([]);
  });

  it('offers no "Allow for this session" in an agent\'s run', async () => {
    const model = fakeModel(true);
    mounted = await mount(
      <AgentRunView model={model} run={runWithHeld()} place="strip" />
    );
    const held = mounted.host.querySelector('.jp-Epi-agentrun-held li')!;
    expect(held.textContent).toBe(`Guard${HELD_WORDS}`);
    expect(buttonsOf(held)).toEqual([]);
  });
});

describe('a guard that the analyst chooses', () => {
  it('keeps the box "synthetic", which takes a click', async () => {
    const model = fakeModel(false);
    mounted = await mount(<GuardSection model={model} />);
    await settle();
    const box = syntheticBox(mounted.host);
    expect([box.checked, box.disabled]).toEqual([true, false]);
    expect(syntheticDetail(mounted.host)).toBe(
      'Kept in the notebook. The guard then checks prompts only for keys and passwords.'
    );
    await step(() => box.click());
    expect(model.setGuardSynthetic).toHaveBeenCalledWith(false);
  });

  it('offers "Allow for this session" in the panel and in an agent\'s run', async () => {
    const model = fakeModel(false);
    mounted = await mount(<GuardSection model={model} />);
    await settle();
    const list = await heldList(mounted.host);
    expect(buttonsOf(list)).toEqual(['Allow for this session']);
    await mounted.unmount();
    mounted = await mount(
      <AgentRunView model={model} run={runWithHeld()} place="strip" />
    );
    const held = mounted.host.querySelector('.jp-Epi-agentrun-held li')!;
    expect(buttonsOf(held)).toEqual(['Allow for this session']);
    await step(() => button(held, 'Allow for this session').click());
    await settle();
    expect(model.guardMemory).toHaveBeenCalledWith({
      allow: { guard: 'privacy', flags: FLAGS }
    });
  });
});
