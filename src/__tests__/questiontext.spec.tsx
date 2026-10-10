/**
 * "Question this text" with no model connected (critique 5, the app, A14).
 * Every question about a text needs AI, so with no model the popover held
 * only greyed questions, and the analyst learned it only after the click.
 * With no model, the button says that it needs AI, as the greyed questions
 * do, and a click opens the AI models panel.
 */
import './fakes/quiet';

import * as React from 'react';

import type { IServerStatus } from '../model/api';
import { NoteCard } from '../ui/bench';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

const NO_MODEL = {
  ranker: 'rules',
  jev_configured: false,
  claude_available: false,
  claude: {
    available: false,
    cli: null,
    credential: null,
    provider: 'none',
    reason: 'no model is connected',
    setup: 'Connect one in the AI models panel.'
  },
  local_models: []
} as unknown as IServerStatus;

const CONNECTED = {
  ranker: 'rules',
  jev_configured: false,
  claude_available: true,
  claude: {
    available: true,
    cli: null,
    credential: 'OpenRouter',
    provider: 'openrouter',
    reason: null,
    setup: null,
    priced: true
  },
  local_models: []
} as unknown as IServerStatus;

/**
 * The introduction of the demo, on the bench of a notebook whose server
 * answers with `status`: its button, and what a click on it does.
 */
async function introduction(status: IServerStatus) {
  const { model } = benchModel([
    {
      id: 'intro',
      type: 'markdown',
      source:
        'Does treatment arm B change how pain evolves over the first six months?'
    },
    { id: 'load', source: 'x = 1', count: 1 }
  ]);
  // The first request of the status fails: no server runs in the tests.
  await settle();
  (model.api as any).status = async () => status;
  model.status = status;
  const asked: string[] = [];
  model.askNote = async (cellId: string) => {
    asked.push(cellId);
  };
  let panels = 0;
  model.modelsPanelRequested.connect(() => panels++);
  const view = await mount(
    <NoteCard model={model} cell={model.cell('intro')!} editorServices={null} />
  );
  const button = Array.from(
    view.host.querySelectorAll<HTMLButtonElement>('button')
  ).find(item => item.textContent?.startsWith('Question this text'))!;
  return {
    model,
    button,
    click: async () => {
      await step(() => button.click());
      return { asked: [...asked], panels };
    },
    close: async () => {
      await view.unmount();
      model.dispose();
    }
  };
}

describe('"Question this text"', () => {
  it('says that it needs AI with no model, and opens the AI models panel', async () => {
    const { model, button, click, close } = await introduction(NO_MODEL);
    const found = {
      off: model.aiOff() !== null,
      text: button.textContent,
      tag: button.querySelector('.jp-Epi-needs')?.textContent ?? null,
      clicked: await click()
    };
    await close();
    expect(found).toEqual({
      off: true,
      text: 'Question this text · needs AI',
      tag: ' · needs AI',
      clicked: { asked: [], panels: 1 }
    });
  });

  it('asks about the text with a model, as before', async () => {
    const { model, button, click, close } = await introduction(CONNECTED);
    const found = {
      off: model.aiOff() !== null,
      text: button.textContent,
      clicked: await click()
    };
    await close();
    expect(found).toEqual({
      off: false,
      text: 'Question this text',
      clicked: { asked: ['intro'], panels: 0 }
    });
  });
});
