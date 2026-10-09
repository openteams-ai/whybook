/**
 * The words of the review guard's dialog (src/ui/guard.tsx). Before, a rule
 * of the privacy guard read "Likely wrong:", as if the data held a fault,
 * and printed the rows that it flagged a second time ("Flagged: 0 233 0 0
 * NaN ..."); the caption said "the lines with flagged parts, of 952", with
 * no count of those lines.
 */
import * as React from 'react';

import type { IGuardEvent, IGuardFlag } from '../model/guard';
import { GuardQuestion } from '../ui/guard';
import { mount } from './fakes/bench-render';

const ROWS_RULE =
  'rows of people, each with personal details that could point to one person: age, sex';

/** Three rows of a table of people, as a step's result prints them. */
const ROWS = [
  '0   233     0   42    1  175.0',
  '1   235     0   36    0  123.0',
  '2   244     0   56    1  115.0'
];

/** The text of a step's result: the head of a table, its rows, and lines after them. */
const TEXT = [
  '{"code": "nhefs.head()",',
  ' "outputs": "',
  '   seqn  qsmk death  age  sex    sbp',
  ...ROWS,
  ...Array.from({ length: 24 }, (_, index) => `   note ${index}`),
  '"}'
].join('\n');

function row(text: string): IGuardFlag {
  return {
    kind: 'row of a person',
    text,
    rule: ROWS_RULE,
    level: 'reject',
    by: 'rules'
  };
}

function privacyEvent(flags: IGuardFlag[], text = TEXT): IGuardEvent {
  return {
    type: 'guard',
    id: 'q1',
    guard: 'privacy',
    what: 'the result of [2]',
    decision: 'reject',
    flags,
    reason: ROWS_RULE,
    text,
    masked: null,
    sandboxed: false,
    choices: ['send', 'mask', 'stop'],
    to: 'OpenRouter: x'
  };
}

async function dialog(event: IGuardEvent) {
  const view = await mount(<GuardQuestion event={event} onNote={() => {}} />);
  const host = view.host;
  return {
    findings: Array.from(
      host.querySelectorAll('.jp-Epi-guard-findings li')
    ).map(item => item.textContent),
    caption: host.querySelector('.jp-Epi-guard-caption')!.textContent,
    marks: host.querySelectorAll('mark').length,
    unmount: () => view.unmount()
  };
}

describe('the dialog of the privacy guard', () => {
  it('says that the flagged rows should not leave this machine, counts the parts it marked without printing them, and counts the lines that hold them', async () => {
    const lines = TEXT.split('\n').length;
    const shown = await dialog(privacyEvent(ROWS.map(row)));
    try {
      expect(shown.findings).toEqual([
        `Should not leave this machine: ${ROWS_RULE}. 3 parts are marked below. Found by the rules.`
      ]);
      // The values show once, marked in the text.
      expect(shown.findings[0]).not.toContain('233');
      expect(shown.marks).toBe(3);
      expect(shown.caption).toBe(
        `The text that would leave this machine: 3 of ${lines} lines have flagged parts`
      );
    } finally {
      await shown.unmount();
    }
  });

  it('says that an identifier alone might be fine to send, and counts every place of it', async () => {
    const id: IGuardFlag = {
      kind: 'identifier',
      text: 'P042',
      rule: 'an identifier of a person or a household',
      level: 'ask',
      by: 'rules'
    };
    const text = 'P042 has the most pain.\nP042 slept least.';
    const shown = await dialog({
      ...privacyEvent([id], text),
      decision: 'ask'
    });
    try {
      expect(shown.findings).toEqual([
        'Might be fine to send: an identifier of a person or a household. 2 parts are marked below. Found by the rules.'
      ]);
      // A short text shows whole, with no count of its lines.
      expect(shown.caption).toBe('The text that would leave this machine');
    } finally {
      await shown.unmount();
    }
  });

  it('counts one line in the singular', async () => {
    const shown = await dialog(privacyEvent([row(ROWS[1])]));
    try {
      expect(shown.findings).toEqual([
        `Should not leave this machine: ${ROWS_RULE}. 1 part is marked below. Found by the rules.`
      ]);
      expect(shown.caption).toMatch(/: 1 of \d+ lines has flagged parts$/);
    } finally {
      await shown.unmount();
    }
  });
});

describe('the dialog of the execution guard', () => {
  it('says that flagged code should not run, and names the call that it flagged', async () => {
    const call = 'requests.get("https://data.example.org/norms.csv")';
    const code = [
      'import requests',
      ...Array.from({ length: 18 }, (_, index) => `x${index} = ${index}`),
      `norms = ${call}`
    ].join('\n');
    const shown = await dialog({
      type: 'guard',
      id: 'q2',
      guard: 'execution',
      what: 'a cell',
      decision: 'reject',
      flags: [
        {
          kind: 'network',
          text: call,
          rule: 'reaches the network',
          level: 'reject',
          by: 'rules'
        }
      ],
      reason: 'reaches the network',
      text: code,
      masked: null,
      sandboxed: false,
      choices: ['run', 'stop']
    });
    try {
      expect(shown.findings).toEqual([
        `Should not run: reaches the network. Flagged: ${call}. Found by the rules.`
      ]);
      expect(shown.caption).toBe('The code: 1 of 20 lines has flagged parts');
    } finally {
      await shown.unmount();
    }
  });
});
