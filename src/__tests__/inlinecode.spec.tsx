/**
 * Names in backticks and words between two asterisks in an agent's answer:
 * the view draws each pair as inline code or in bold, and leaves the rest of
 * the text as the model wrote it.
 */
import './fakes/quiet';

import * as React from 'react';

import type { IAgentRun } from '../model/agent';
import { splitBold, splitCode } from '../model/inlinecode';
import { AgentRunView } from '../ui/agent';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

describe('inline code in a text that a model wrote', () => {
  it('cuts the text around each pair of backticks', () => {
    expect(
      splitCode('With strata by `stratum` and clusters by `psu`, 33.3%.')
    ).toEqual([
      'With strata by ',
      'stratum',
      ' and clusters by ',
      'psu',
      ', 33.3%.'
    ]);
  });

  it('leaves a backtick without its pair, an empty pair and a fenced block as they are', () => {
    expect(splitCode('A lone ` mark')).toEqual(['A lone ` mark']);
    expect(splitCode('An empty `` pair')).toEqual(['An empty `` pair']);
    expect(splitCode('```python\nx = 1\n```')).toEqual([
      '```python\nx = 1\n```'
    ]);
  });

  it('cuts the text around each pair of two asterisks, as Markdown marks bold', () => {
    expect(splitBold('The clearest are **age** and **sex**.')).toEqual([
      'The clearest are ',
      'age',
      ' and ',
      'sex',
      '.'
    ]);
    expect(splitBold('about **1.14 kg** had they kept smoking')).toEqual([
      'about ',
      '1.14 kg',
      ' had they kept smoking'
    ]);
  });

  it('leaves asterisks with a space inside them, or without their pair, as they are', () => {
    expect(splitBold('x ** 2 and y ** 3')).toEqual(['x ** 2 and y ** 3']);
    expect(splitBold('a lone ** mark')).toEqual(['a lone ** mark']);
    expect(splitBold('an empty **** pair')).toEqual(['an empty **** pair']);
  });

  it("draws the names of an agent's answer as code, and keeps its cell links", async () => {
    const { model } = benchModel([
      { id: 'a', source: 'import pandas as pd', count: 1 },
      { id: 'b', source: 'shares = 0.333', count: 8 }
    ]);
    const run = {
      id: 'r1',
      stripId: 'b',
      question: 'What share felt sad or hopeless?',
      anchor: 'b',
      state: 'done',
      steps: [],
      notes: [],
      thinking: null,
      answer:
        'With strata by `stratum` and clusters by `psu`, **33.3%** felt sad or hopeless [8]. `**` in code stays, and so does a lone ` mark.',
      answerCells: ['[8]'],
      followUp: [],
      by: null,
      costUsd: 0.01,
      error: null,
      started: Date.now(),
      keepLocal: false
    } as unknown as IAgentRun;
    const view = await mount(
      <AgentRunView model={model} run={run} place="card" />
    );
    await settle();
    const text = view.host.querySelector('.jp-Epi-agentrun-text')!;
    expect(
      Array.from(text.querySelectorAll('code.jp-Epi-inlinecode')).map(
        code => code.textContent
      )
    ).toEqual(['stratum', 'psu', '**']);
    expect(
      Array.from(text.querySelectorAll('strong')).map(bold => bold.textContent)
    ).toEqual(['33.3%']);
    expect(text.textContent).toBe(
      'With strata by stratum and clusters by psu, 33.3% felt sad or hopeless [8]. ** in code stays, and so does a lone ` mark.'
    );
    expect(text.querySelector('.jp-Epi-agentrun-cell')?.textContent).toBe(
      '[8]'
    );
    await view.unmount();
  });
});
