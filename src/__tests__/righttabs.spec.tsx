/**
 * The tabs of the right panel stay in sight while what they show scrolls
 * (critique 5, the app, A7). The tabs, Exploration and Cell details, were
 * in the box that scrolls, and went up with its content: reaching Cell
 * details from Worth asking next took a scroll back to the top. Now the
 * content under the tabs scrolls in a box of its own, in the side panel
 * and in the column inside the notebook alike, as both show RightPanel.
 * ui-tests/tests/view-panels.spec.ts checks the scrolling in the browser.
 */
import './fakes/quiet';

import * as React from 'react';

import { RightPanel } from '../ui/exploration';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

describe('the tabs of the right panel', () => {
  // jsdom has no watcher of sizes, which the panels use.
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

  it('are outside the box that scrolls, which holds what each tab shows', async () => {
    const { model } = benchModel([
      { id: 'weekly', source: 'weekly = diary', count: 4 }
    ]);
    const view = await mount(<RightPanel model={model} width={270} />);
    const main = () => view.host.querySelector('.jp-Epi-right-main')!;
    const parts = () =>
      Array.from(main().children).map(child => child.className);
    const holder = (selector: string) =>
      view.host.querySelector(selector)?.parentElement?.className;
    const found: Record<string, unknown> = {};
    try {
      await settle();
      found.exploration = [parts(), holder('.jp-Epi-exploration')];
      const details = Array.from(
        view.host.querySelectorAll<HTMLButtonElement>('.jp-Epi-tabs button')
      ).find(tab => tab.textContent === 'Cell details')!;
      await step(() => details.click());
      await settle();
      found.details = [parts(), holder('.jp-Epi-details')];
    } finally {
      await view.unmount();
      model.dispose();
    }
    expect(found).toEqual({
      exploration: [
        ['jp-Epi-tabs', 'jp-Epi-right-scroll'],
        'jp-Epi-right-scroll'
      ],
      details: [['jp-Epi-tabs', 'jp-Epi-right-scroll'], 'jp-Epi-right-scroll']
    });
  });

  it('show another tab from its top, though the box was scrolled down', async () => {
    const { model } = benchModel([
      { id: 'weekly', source: 'weekly = diary', count: 4 }
    ]);
    const view = await mount(<RightPanel model={model} width={270} />);
    const tab = (name: string) =>
      Array.from(
        view.host.querySelectorAll<HTMLButtonElement>('.jp-Epi-tabs button')
      ).find(item => item.textContent === name)!;
    const tops: number[] = [];
    try {
      await settle();
      // jsdom lays nothing out: the box keeps the scroll that it is given.
      const box = view.host.querySelector<HTMLElement>('.jp-Epi-right-scroll')!;
      let top = 0;
      Object.defineProperty(box, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
        }
      });
      // Scrolled down to Worth asking next, the analyst opens Cell details.
      box.scrollTop = 300;
      await step(() => tab('Cell details').click());
      await settle();
      tops.push(top);
      box.scrollTop = 120;
      await step(() => tab('Exploration').click());
      await settle();
      tops.push(top);
    } finally {
      await view.unmount();
      model.dispose();
    }
    expect(tops).toEqual([0, 0]);
  });
});
