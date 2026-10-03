/**
 * Questions by the language of the kernel. In R a drop asks the server for
 * questions, with the kernel's language; in a kernel whose variables the
 * view cannot list, such as Julia, it asks the server nothing, and the
 * popover says why.
 */
import './fakes/quiet';

import type * as nbformat from '@jupyterlab/nbformat';
import * as React from 'react';

import type { IDropAsk } from '../model/epimodel';
import type { IItem } from '../tokens';
import { AskContent } from '../ui/variables';
import { benchModel, notebookOf } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

function notebookIn(language: string): nbformat.INotebookContent {
  return {
    ...notebookOf([{ id: 'load', source: 'visits <- read.csv("visits.csv")' }]),
    metadata: {
      kernelspec: { display_name: language, language, name: language }
    }
  };
}

const VISITS: IItem = {
  name: 'visits',
  label: 'visits',
  kind: 'dataframe',
  parent: null
} as unknown as IItem;

async function dropped(language: string) {
  const { model } = benchModel(notebookIn(language));
  const drops: unknown[] = [];
  model.api.drop = async (body: unknown) => {
    drops.push(body);
    // The server sends the templates' questions without code in R.
    return {
      title: 'visits onto [1]',
      note: null,
      mode: 'auto',
      options: [
        {
          id: 't:rows',
          text: 'How many rows does visits have?',
          type: 'descriptive',
          origin: 'template',
          template: 'rows',
          variables: ['visits'],
          probability: 0.6,
          reasons: [],
          effect: '',
          placement: null,
          code: null,
          action: null
        }
      ],
      placements: [],
      preselected: []
    } as any;
  };
  await model.askDrop(
    VISITS,
    { cellId: 'load' },
    { branch: false, parallel: false },
    null
  );
  const view = await mount(<AskContent model={model} />);
  await settle();
  return { model, view, drops };
}

describe('questions by the language of the kernel', () => {
  it('offers questions in R, and tells the server the language', async () => {
    const { model, view, drops } = await dropped('R');
    expect(drops).toHaveLength(1);
    expect((drops[0] as any).context.language).toBe('r');
    expect((model.ask as IDropAsk).result?.options).toHaveLength(1);
    expect(view.host.querySelector('.jp-Epi-unsupported')).toBeNull();
    await view.unmount();
    model.dispose();
  });

  it('asks nothing in a kernel whose variables the view cannot list, and says why', async () => {
    const { model, view, drops } = await dropped('julia');
    expect(drops).toEqual([]);
    expect(view.host.querySelector('.jp-Epi-unsupported')?.textContent).toBe(
      "Questions ask about the kernel's variables, which the view lists in a Python or R kernel. This kernel runs julia."
    );
    expect(view.host.querySelector('.jp-Epi-option')).toBeNull();
    await view.unmount();
    model.dispose();
  });
});
