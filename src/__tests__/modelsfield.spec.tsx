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
import { mount, settle } from './fakes/bench-render';

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
