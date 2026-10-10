/**
 * The way to the AI models panel from the note that no model is connected
 * (critique 5, the app, A13). The grey note at the top of the questions
 * ended with "Connect one in the AI models panel." in plain text, and the
 * analyst had to know that the panel opens from AI in the toolbar. The AI
 * button, in the toolbar's "⋯" menu when the toolbar has no room for it,
 * has no box there: the panel opened out of the window, with the focus in it.
 */
import './fakes/quiet';

import * as React from 'react';

import type { IServerStatus } from '../model/api';
import type { EpiModel } from '../model/epimodel';
import { AIButton } from '../ui/aipanel';
import { AIOffNote } from '../ui/common';
import { DocumentView } from '../ui/document';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

/** The status of a server with no model connected, as the server writes it. */
function noModel(reason: string, setup: string | null): IServerStatus {
  return {
    ranker: 'rules',
    jev_configured: false,
    claude_available: false,
    claude: {
      available: false,
      cli: null,
      credential: null,
      provider: 'none',
      reason,
      setup
    },
    local_models: []
  } as unknown as IServerStatus;
}

const CONNECT = noModel(
  'no model is connected',
  'Connect one in the AI models panel.'
);

/** A notebook whose server answers with `status`. */
async function notebook(status: IServerStatus): Promise<EpiModel> {
  const { model } = benchModel([{ id: 'a', source: 'x = 1', count: 1 }]);
  // The first request of the status fails: no server runs in the tests.
  await settle();
  (model.api as any).status = async () => status;
  model.status = status;
  return model;
}

/** How often the model asked its view to open the AI models panel. */
function panelRequests(model: EpiModel): () => number {
  let count = 0;
  model.modelsPanelRequested.connect(() => count++);
  return () => count;
}

describe('The note that no model is connected', () => {
  it('names the AI models panel with a link that opens it, and reads as before', async () => {
    const model = await notebook(CONNECT);
    const requests = panelRequests(model);
    const view = await mount(<AIOffNote model={model} />);
    const note = view.host.querySelector('.jp-Epi-aioff')!;
    const text = note.textContent;
    const links = Array.from(note.querySelectorAll('button.jp-Epi-link')).map(
      link => link.textContent
    );
    const link = note.querySelector<HTMLButtonElement>('button.jp-Epi-link');
    await step(() => link?.click());
    const found = { text, links, requests: requests() };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      text: 'Questions marked needs AI and your own questions are off: no model is connected. Connect one in the AI models panel.',
      links: ['the AI models panel'],
      requests: 1
    });
  });

  it('links the words in the reason too, and in each setup of the server', async () => {
    const texts: [string, string | null][] = [
      [
        'the Hugging Face sign-in has expired. Sign in again in the AI models panel',
        null
      ],
      [
        'not signed in to OpenRouter',
        'Sign in with OpenRouter in the AI models panel.'
      ],
      [
        'no Anthropic API key is saved',
        'Paste an Anthropic API key in the AI models panel.'
      ],
      [
        "the Claude Code login is for development only, under Anthropic's terms",
        'Start the server with --Whybook.claude_code_login=True, or connect another model in the AI models panel.'
      ]
    ];
    const found: (string | null)[][] = [];
    for (const [reason, setup] of texts) {
      const model = await notebook(noModel(reason, setup));
      const view = await mount(<AIOffNote model={model} />);
      found.push(
        Array.from(view.host.querySelectorAll('.jp-Epi-aioff button')).map(
          link => link.textContent
        )
      );
      await view.unmount();
      model.dispose();
    }
    expect(found).toEqual(texts.map(() => ['the AI models panel']));
  });

  it('names the panel by its name when the settings turn AI off for cells, with the link', async () => {
    const model = await notebook(CONNECT);
    model.settings.models = { ...model.settings.models, cells: 'off' };
    const view = await mount(<AIOffNote model={model} />);
    const note = view.host.querySelector('.jp-Epi-aioff')!;
    const found = {
      text: note.textContent,
      link: note.querySelector('button.jp-Epi-link')?.textContent ?? null
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      text: 'Questions marked needs AI and your own questions are off: AI is off for cells and answers in the settings. Choose the remote model for Cells and answers in the AI models panel.',
      link: 'the AI models panel'
    });
  });
});

describe('The AI models panel, opened by a link', () => {
  const width = window.innerWidth;
  beforeAll(() => {
    // jsdom has no watcher of sizes, which the cards use.
    (globalThis as any).ResizeObserver = class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
    Object.defineProperty(window, 'innerWidth', {
      value: 1600,
      configurable: true
    });
  });
  afterAll(() => {
    delete (globalThis as any).ResizeObserver;
    Object.defineProperty(window, 'innerWidth', {
      value: width,
      configurable: true
    });
  });

  /** A box on the page, as a browser measures it. */
  function box(left: number, top: number, right: number, bottom: number) {
    return () =>
      ({
        left,
        top,
        right,
        bottom,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        toJSON: () => ({})
      }) as DOMRect;
  }

  /**
   * The notebook's view under its toolbar, from x 300 to 1500 and from y 80,
   * the AI button, where the test puts it, and the note with its link.
   */
  async function page(button: (() => DOMRect) | null) {
    const model = await notebook(CONNECT);
    const view = await mount(
      <DocumentView
        model={model}
        editorServices={null}
        openFile={() => undefined}
        isVisible={() => true}
      />
    );
    view.host.querySelector<HTMLElement>(
      '.jp-Epi-document'
    )!.getBoundingClientRect = box(300, 80, 1500, 900);
    const toolbar = await mount(
      <AIButton model={model} openSettings={() => undefined} />
    );
    if (button) {
      toolbar.host.querySelector<HTMLElement>(
        '.jp-Epi-aibutton'
      )!.getBoundingClientRect = button;
    }
    const note = await mount(<AIOffNote model={model} />);
    const link = note.host.querySelector<HTMLButtonElement>(
      '.jp-Epi-aioff button.jp-Epi-link'
    )!;
    return {
      model,
      link,
      panel: () => document.body.querySelector<HTMLElement>('.jp-Epi-aipanel'),
      close: async () => {
        await note.unmount();
        await toolbar.unmount();
        await view.unmount();
        model.dispose();
      }
    };
  }

  /** Where the panel is: its right edge from the window's, and its top. */
  function place(panel: HTMLElement | null) {
    return panel ? { right: panel.style.right, top: panel.style.top } : null;
  }

  // The link and the AI item of the status bar ask the model for the panel.
  it('opens under the AI button, as a click on the button opens it', async () => {
    const { model, panel, close } = await page(box(1400, 10, 1460, 38));
    await step(() => model.requestModelsPanel());
    await settle();
    const found = place(panel());
    await close();
    expect(found).toEqual({ right: '140px', top: '40px' });
  });

  it('opens under the toolbar at the right edge of the notebook, where "⋯" is, when the AI button is in the menu of "⋯"', async () => {
    // A closed menu of "⋯" shows nothing: the button in it has no box.
    const { model, panel, close } = await page(null);
    await step(() => model.requestModelsPanel());
    await settle();
    const found = place(panel());
    await close();
    expect(found).toEqual({ right: '100px', top: '82px' });
  });

  it('gives the focus back to the link on Escape', async () => {
    const { link, panel, close } = await page(box(1400, 10, 1460, 38));
    link.focus();
    // Enter on the link clicks it.
    await step(() =>
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    );
    await settle();
    const opened = !!panel() && panel()!.contains(document.activeElement);
    await step(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    await settle();
    const found = {
      opened,
      closed: panel() === null,
      onLink: document.activeElement === link
    };
    await close();
    expect(found).toEqual({ opened: true, closed: true, onLink: true });
  });
});
