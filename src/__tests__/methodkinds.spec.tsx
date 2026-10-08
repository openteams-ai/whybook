/**
 * The type of a question that asks for a causal method (design iteration
 * 1.100). In the takes of the demo video of 7 October 2026, the branches
 * "Estimate it with inverse probability weighting" and "Estimate it by
 * standardisation (g-formula)" showed Descriptive beside the Causal model
 * they branched from, and so did the follow-ups of the agent that carried
 * no type, such as "Would you like an adjusted estimate controlling for
 * these candidates?". The keywords of src/model/own.ts name the methods now,
 * and a follow-up without one of the five types gets the type of its words.
 */
import './fakes/quiet';

import * as React from 'react';

import { followUpOf, keywordType } from '../model/own';
import { pastRun } from '../model/runs';
import { AgentRunView } from '../ui/agent';
import { benchModel } from './fakes/bench-fake';
import { mount, step } from './fakes/bench-render';

describe('the keywords of a typed question', () => {
  it('type a question that names a causal method or an adjusted effect as causal', () => {
    const texts = [
      // The two branches of the video.
      'Estimate it with inverse probability weighting',
      'Estimate it by standardisation (g-formula)',
      'Use g-computation instead',
      'Is there a doubly robust estimate?',
      'Would propensity-score weighting give the same estimate?',
      'Estimate it by matching on age and sex',
      'Estimate it with nearest-neighbour matching',
      // The follow-up of the agent in the video.
      'Would you like an adjusted estimate controlling for these candidates?',
      'Is the estimate adjusted for baseline weight?',
      'Use price as an instrumental variable',
      'Try a difference in differences between 1971 and 1982',
      'Does the treatment effect hold in women?'
    ];
    expect(texts.map(text => [text, keywordType(text)])).toEqual(
      texts.map(text => [text, 'causal'])
    );
  });

  it('leave ids that match, p-values adjusted for multiple tests and a median to the other rules', () => {
    expect(keywordType('Are there rows with matching ids in both files?')).toBe(
      null
    );
    expect(keywordType('Are the p-values adjusted for multiple testing?')).toBe(
      null
    );
    expect(keywordType('What is the median age of the quitters?')).toBe(null);
  });

  it('type a question about outcomes that were not measured as data quality, as they type a missing value', () => {
    const texts = [
      // The question of the video's take dry3.
      'Does leaving out the 63 people with no 1982 weight bias the effect?',
      'How would multiple imputation change the estimate?',
      'Is missingness related to the pain score the week before?',
      'Does a complete-case analysis agree?',
      'How many patients were lost to follow-up?'
    ];
    expect(texts.map(text => [text, keywordType(text)])).toEqual(
      texts.map(text => [text, 'quality'])
    );
    // Leaving out a term of a model is no missing value.
    expect(keywordType('What if we leave out the interaction?')).toBe('model');
  });

  it('read the causal words first in a question with both', () => {
    expect(
      keywordType(
        'How robust is the adjusted estimate to missing-data handling and alternative confounder sets?'
      )
    ).toBe('causal');
  });
});

describe('a follow-up question that a model wrote', () => {
  it('keeps a type of the five that the model gave, also where its words give another', () => {
    expect(followUpOf('association: Does sleep relate to pain?')).toEqual({
      type: 'association',
      text: 'Does sleep relate to pain?'
    });
    expect(
      followUpOf('quality: Are estimated propensities near zero or one?')
    ).toEqual({
      type: 'quality',
      text: 'Are estimated propensities near zero or one?'
    });
  });

  it('gets the type of its words when the model gave none, or a label of its own', () => {
    expect(
      followUpOf(
        'Would you like an adjusted estimate controlling for these candidates?'
      )
    ).toEqual({
      type: 'causal',
      text: 'Would you like an adjusted estimate controlling for these candidates?'
    });
    expect(
      followUpOf(
        'missing-data: How would multiple imputation change the estimate and uncertainty?'
      )
    ).toEqual({
      type: 'quality',
      text: 'missing-data: How would multiple imputation change the estimate and uncertainty?'
    });
    expect(
      followUpOf(
        'interpretation: What do sex codes 0 and 1 represent in the NHEFS codebook?'
      ).type
    ).toBe('descriptive');
  });
});

describe("the follow-ups of an agent's run", () => {
  const FOLLOW_UP = [
    'Would you like an adjusted estimate controlling for these candidates?',
    'missing-data: How would multiple imputation change the estimate and uncertainty?',
    'causal: Would conclusions hold under stronger assumptions about outcome missingness?'
  ];

  function run() {
    return pastRun('r1', {
      question: 'What else could explain both qsmk and wt82_71?',
      provider: null,
      model: null,
      cost_usd: null,
      cells: [],
      files: [],
      state: 'done',
      at: '2026-10-07T17:27:00Z',
      answer: 'Age, years of smoking and the weight in 1971 [6].',
      follow_up: FOLLOW_UP
    });
  }

  it('show the type of their words when the model gave none, and ask with the type that they show', async () => {
    const { model } = benchModel([
      { id: 'a', source: 'import pandas as pd', count: 1 }
    ]);
    const asked = jest.spyOn(model, 'askOwn').mockResolvedValue(undefined);
    const view = await mount(
      <AgentRunView model={model} run={run()} place="strip" />
    );
    const buttons = Array.from(
      view.host.querySelectorAll<HTMLButtonElement>('.jp-Epi-agentrun-followup')
    );
    const shown = buttons.map(item => [
      item.querySelector('.jp-Epi-type')?.textContent,
      item.querySelector('.jp-Epi-type + span')?.textContent
    ]);
    await step(() => buttons[2].click());
    await view.unmount();
    model.dispose();
    expect(shown).toEqual([
      ['Causal', FOLLOW_UP[0]],
      ['Data quality', FOLLOW_UP[1]],
      [
        'Causal',
        'Would conclusions hold under stronger assumptions about outcome missingness?'
      ]
    ]);
    // The words alone would make the question Data quality: "missingness".
    expect(asked).toHaveBeenCalledWith(
      'Would conclusions hold under stronger assumptions about outcome missingness?',
      'notebook',
      { type: 'causal' }
    );
  });

  it('keeps the type of the follow-up in the question that it asks, and the words decide without one', async () => {
    const { model } = benchModel([
      { id: 'a', source: 'import pandas as pd', count: 1 }
    ]);
    const apply = jest.spyOn(model, 'apply').mockResolvedValue(undefined);
    const text =
      'Would conclusions hold under stronger assumptions about outcome missingness?';
    await model.askOwn(text, 'notebook', { type: 'causal' });
    await model.askOwn(text, 'notebook');
    model.dispose();
    expect(apply.mock.calls.map(call => [call[0].text, call[0].type])).toEqual([
      [text, 'causal'],
      [text, 'quality']
    ]);
  });
});
