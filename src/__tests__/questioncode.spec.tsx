/**
 * The names and values in a question (design iterations 1.145 and 1.146). A
 * question marks each name of code and each value with backticks, "What if
 * `reml` were `False`?", and each name of data with two asterisks, "Does
 * **pain_score** differ by **age**?". The view shows code in the code font,
 * and data by its exact name in bold: in the list of questions, in the title
 * of the cell that a question makes, and in Cell details. A tooltip, a
 * comment of code and the parse of the value chosen read the text without
 * the marks, as a notebook saved before them keeps it.
 */
import './fakes/quiet';

import * as React from 'react';

import { chosenValue } from '../model/decisions';
import {
  inlineCode,
  inlineData,
  plainText,
  splitMarks
} from '../model/inlinecode';
import { pyComment } from '../model/pycode';
import type { IDecision, IOption } from '../tokens';
import { CodeText, LabelledText } from '../ui/common';
import { mount } from './fakes/bench-render';

const HOW: IDecision = {
  name: 'how',
  value: "'left'",
  provenance: 'library_default',
  param: 'how',
  function: 'DataFrame.merge'
};

function option(text: string, value?: string): IOption {
  return {
    id: 'q1',
    text,
    type: 'model',
    origin: 'template',
    template: 'what_if_value',
    probability: 0.6,
    reasons: [],
    placement: { kind: 'branch', cell: 'c8', label: 'branch of [8]' },
    code: null,
    ...(value === undefined ? {} : { value })
  };
}

describe('the marks of names and values', () => {
  it('go around a name of code, a value or a name of data, and come off for plain text', () => {
    expect(inlineCode('how')).toBe('`how`');
    expect(inlineData('treatment_arm')).toBe('**treatment_arm**');
    // A text that a mark would break stays as it is.
    expect([inlineCode('a`b'), inlineData('a*b'), inlineData(' a')]).toEqual([
      'a`b',
      'a*b',
      ' a'
    ]);
    expect(
      plainText('What if `reml` were `False` in the `fit` of **model_data**?')
    ).toBe('What if reml were False in the fit of model_data?');
    // Asterisks with spaces around them, as in a power, are no mark.
    expect(plainText('x ** 2 and y ** 3')).toBe('x ** 2 and y ** 3');
    expect(splitMarks('Is **age** about `how`?')).toEqual([
      { kind: 'text', text: 'Is ' },
      { kind: 'data', text: 'age' },
      { kind: 'text', text: ' about ' },
      { kind: 'code', text: 'how' },
      { kind: 'text', text: '?' }
    ]);
  });

  it('come off in a comment of code', () => {
    expect(
      pyComment('What if the merge with **patients** were an outer join?')
    ).toBe('# What if the merge with patients were an outer join?');
  });

  it('leave the value chosen to the option, whose words do not give it, and read it from an older text', () => {
    const value = { name: 'how', param: 'how', value: '"outer"' };
    expect(
      chosenValue(
        HOW,
        option(
          'What if the merge with **patients** were an outer join?',
          '"outer"'
        )
      )
    ).toEqual(value);
    // A notebook saved before 1.146 keeps the question with the value in it.
    expect(chosenValue(HOW, option('What if `how` were `"outer"`?'))).toEqual(
      value
    );
    expect(chosenValue(HOW, option('What if how were "outer"?'))).toEqual(
      value
    );
    expect(
      chosenValue(
        HOW,
        option('Choose `how` in [8], in the merge with **patients**')
      )
    ).toEqual({ ...value, value: "'left'" });
  });
});

describe('a question in the view', () => {
  it('shows a name of code in the code font and a name of data in bold', async () => {
    const view = await mount(
      <CodeText
        text={'What if `reml` were `False` in the `fit` of **model_data**?'}
      />
    );
    expect(
      Array.from(view.host.querySelectorAll('code.jp-Epi-inlinecode')).map(
        code => code.textContent
      )
    ).toEqual(['reml', 'False', 'fit']);
    expect(
      Array.from(view.host.querySelectorAll('.jp-Epi-inlinedata')).map(
        data => data.textContent
      )
    ).toEqual(['model_data']);
    expect(view.host.textContent).toBe(
      'What if reml were False in the fit of model_data?'
    );
    await view.unmount();
  });

  it('keeps the labels of cells as links, and a label inside a name as part of the name', async () => {
    const cells = [{ id: 'c8', label: '[8]', title: 'Mixed model' }];
    const model = {
      sharedLabels: () => new Set(['[8]', '[0]']),
      cells: () => cells,
      showCell: () => undefined
    } as any;
    const view = await mount(
      <LabelledText
        model={model}
        text={'Is **X[0]** associated with **y** in [8], with `ddof`?'}
      />
    );
    expect(
      Array.from(view.host.querySelectorAll('.jp-Epi-inlinedata')).map(
        data => data.textContent
      )
    ).toEqual(['X[0]', 'y']);
    expect(view.host.querySelector('code')?.textContent).toBe('ddof');
    expect(
      Array.from(view.host.querySelectorAll('.jp-Epi-labelref')).map(
        label => label.textContent
      )
    ).toEqual(['[8]']);
    expect(view.host.textContent).toBe(
      'Is X[0] associated with y in [8], with ddof?'
    );
    await view.unmount();
  });
});
