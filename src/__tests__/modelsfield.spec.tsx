/**
 * The field "AI models by task" in JupyterLab's settings editor: a select
 * per task, which fills its column.
 */
import './fakes/quiet';

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';

import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Signal } from '@lumino/signaling';

import type { Api } from '../model/api';
import { modelsFieldRenderer } from '../ui/modelsfield';
import { mount, settle, step } from './fakes/bench-render';

describe('The field of the models by task', () => {
  it('fills its column with each select, so that a long model name stops before the arrow', async () => {
    // The view's style sheet: jsdom applies its rules, with no layout.
    const style = document.createElement('style');
    style.textContent = fs.readFileSync(
      path.join(__dirname, '..', '..', 'style', 'base.css'),
      'utf8'
    );
    document.head.appendChild(style);
    const owner = {};
    const settings = {
      composite: { models: {}, keepDataLocal: false, customLocalModels: [] },
      user: { models: {} },
      changed: new Signal(owner),
      set: async () => undefined
    } as unknown as ISettingRegistry.ISettings;
    const api = {
      status: async () => {
        throw new Error('no server in this test');
      }
    } as unknown as Api;
    const Field = modelsFieldRenderer(api);
    try {
      const view = await mount(
        <Field
          schema={{ title: 'AI models by task' }}
          formContext={{ settings }}
        />
      );
      await settle();
      const selects = Array.from(view.host.querySelectorAll('select'));
      expect(selects.length).toBeGreaterThan(0);
      for (const select of selects) {
        // Without a width, a select takes the width of its longest option,
        // such as "Remote AI model: OpenRouter: anthropic/claude-sonnet-5",
        // past its column and under the arrow that JupyterLab draws there.
        expect(getComputedStyle(select).width).toBe('100%');
        expect(getComputedStyle(select.parentElement!).minWidth).toMatch(
          /^0(px)?$/
        );
      }
      await view.unmount();
    } finally {
      style.remove();
    }
  });
});

describe('The note and the help of "Question order"', () => {
  it('reads one short sentence under the select, and the measurement is the last paragraph of the help', async () => {
    const owner = {};
    const settings = {
      composite: { models: {}, keepDataLocal: false, customLocalModels: [] },
      user: { models: {} },
      changed: new Signal(owner),
      set: async () => undefined
    } as unknown as ISettingRegistry.ISettings;
    const api = {
      status: async () => {
        throw new Error('no server in this test');
      }
    } as unknown as Api;
    const Field = modelsFieldRenderer(api);
    const view = await mount(
      <Field
        schema={{ title: 'AI models by task' }}
        formContext={{ settings }}
      />
    );
    await settle();
    const task = view.host
      .querySelector('#jp-Epi-model-ranking')!
      .closest('.jp-Epi-modelsfield-task')!;
    const note = task.querySelector('.jp-Epi-modelsfield-note')?.textContent;
    const help = task.querySelector<HTMLButtonElement>('.jp-Epi-help')!;
    await step(() => help.click());
    const paragraphs = Array.from(
      task.querySelectorAll('.jp-Epi-help-text > p')
    ).map(paragraph => paragraph.textContent);
    await view.unmount();
    expect({
      note,
      paragraphs: paragraphs.length,
      last: paragraphs[1]
    }).toEqual({
      note: 'Rules, then a learned order of the types of question.',
      paragraphs: 2,
      last: "Measured on 4,790 cells of public notebooks, asked again by dragging the variables they use: the first question had the type of the analyst's next question for 52.4% of them, against 33.9% with the rules alone and 26.5% in a random order."
    });
  });
});
