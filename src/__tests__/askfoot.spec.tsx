/**
 * The line under the questions of a drop or a pick (critique 5, the app,
 * A6). It read "Runs on pick, no confirmation. Shift+drop always branches ·
 * Alt+drop explores in parallel" in every case: in Click mode, where
 * nothing is dropped, and under the checklist of a parallel exploration,
 * where a pick checks a question and nothing runs until "Start 2 branches".
 */
import './fakes/quiet';

import * as React from 'react';

import type { Ask } from '../model/epimodel';
import type { IOption } from '../tokens';
import { DocumentView } from '../ui/document';
import { QuestionsSection } from '../ui/variables';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

function option(id: string, text: string): IOption {
  return {
    id,
    text,
    type: 'model',
    origin: 'template',
    probability: 0.5,
    reasons: [],
    placement: { kind: 'branch', cell: 'weekly', label: 'branch of [4]' },
    code: 'weekly_if_7 = weekly'
  } as IOption;
}

/** MIN_DAYS onto [4], with its questions: a checklist with Alt or "Explore in parallel". */
function dropAsk(parallel: boolean, anchored = true): Ask {
  const options = [
    option('what-if', 'What changes if MIN_DAYS changes?'),
    option('explicit', 'Make MIN_DAYS an explicit choice in this cell')
  ];
  return {
    kind: 'drop',
    id: 7,
    anchor: anchored ? { x: 400, y: 300 } : null,
    loading: false,
    error: null,
    source: { kind: 'variable', name: 'MIN_DAYS', label: 'MIN_DAYS' },
    target: { cellId: 'weekly' },
    modifiers: { branch: false, parallel },
    result: {
      title: 'MIN_DAYS onto [4]',
      note: null,
      mode: parallel ? 'parallel' : 'auto',
      options,
      placements: [],
      preselected: parallel ? options.map(item => item.id) : []
    },
    checked: parallel ? options.map(item => item.id) : [],
    claudeStage: null
  } as unknown as Ask;
}

describe('the line under the questions', () => {
  // jsdom has no watcher of sizes, which the popover and the cards use.
  beforeAll(() => {
    (globalThis as any).ResizeObserver = class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  });
  afterAll(() => {
    delete (globalThis as any).ResizeObserver;
  });

  it('names the controls of the way of asking, and says that a checklist runs nothing until Start', async () => {
    const { model } = benchModel([
      { id: 'weekly', source: 'weekly = diary', count: 4 }
    ]);
    const mounted = await mount(
      <DocumentView
        model={model}
        editorServices={null}
        openFile={() => undefined}
        isVisible={() => true}
      />
    );
    const line = () =>
      document.querySelector('.jp-Epi-popover .jp-Epi-ask-foot .jp-Epi-caption')
        ?.textContent;
    const start = () =>
      Array.from(document.querySelectorAll('.jp-Epi-popover button'))
        .map(button => button.textContent)
        .find(text => text?.startsWith('Start'));
    const lines: Record<string, string | null | undefined> = {};
    try {
      for (const interaction of ['drag', 'click'] as const) {
        model.settings.interaction = interaction;
        for (const parallel of [false, true]) {
          await step(() => model.showAsk(dropAsk(parallel)));
          await settle();
          lines[`${interaction}${parallel ? ', parallel' : ''}`] = line();
        }
      }
      lines.button = start();
      // "Explore in parallel" ticked in the popover: the checklist loads.
      await step(() =>
        model.showAsk({ ...dropAsk(true), loading: true, result: null } as Ask)
      );
      await settle();
      lines.loading = line();
    } finally {
      await step(() => model.showAsk(null));
      await mounted.unmount();
      model.dispose();
    }
    expect(lines).toEqual({
      drag: 'Runs on pick, no confirmation. Shift+drop always branches · Alt+drop explores in parallel.',
      'drag, parallel':
        'Nothing runs until Start. Shift+drop always branches · Alt+drop explores in parallel.',
      click:
        'Runs on pick, no confirmation. Always branch and Explore in parallel are in the Questions section.',
      'click, parallel':
        'Nothing runs until Start. Always branch and Explore in parallel are in the Questions section.',
      button: 'Start 2 branches',
      loading:
        'Nothing runs until Start. Always branch and Explore in parallel are in the Questions section.'
    });
  });

  it('says in the Questions section too that a checklist runs nothing until Start', async () => {
    const { model } = benchModel([
      { id: 'weekly', source: 'weekly = diary', count: 4 }
    ]);
    model.settings.interaction = 'click';
    const mounted = await mount(<QuestionsSection model={model} />);
    // A pick from the keyboard has no place: its questions show in the section.
    const line = () =>
      mounted.host.querySelector('.jp-Epi-ask-block > .jp-Epi-caption')
        ?.textContent;
    const lines: (string | null | undefined)[] = [];
    try {
      for (const parallel of [false, true]) {
        await step(() => model.showAsk(dropAsk(parallel, false)));
        await settle();
        lines.push(line());
      }
    } finally {
      await step(() => model.showAsk(null));
      await mounted.unmount();
      model.dispose();
    }
    expect(lines).toEqual([
      'Runs on pick, no confirmation.',
      'Nothing runs until Start.'
    ]);
  });
});
