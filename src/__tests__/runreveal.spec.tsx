/**
 * The strip of a run that the analyst starts comes into sight (design
 * iteration 1.73). "Reproduce in R" in the menu of the kernel's name puts
 * the run's strip at the end of the notebook, far from where the analyst
 * was: the view scrolls to it and outlines it for a moment. A strip already
 * in sight stays where it is, the scroll is instant when the analyst asks
 * for less motion, and the Code view draws the strip at its end too.
 */
import './fakes/quiet';

import * as React from 'react';

import type { IAgentEvent } from '../model/agent';
import type { ICrossQuestion } from '../model/crosskernel';
import type { IStrip } from '../model/epimodel';
import { AgentRuns } from '../model/runs';
import { DocumentView } from '../ui/document';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

const CELLS = [
  { id: 'a', source: 'import pandas as pd', count: 1 },
  { id: 'b', source: 'diary = pd.read_csv("diary.csv")', count: 2 }
];

const QUESTION: ICrossQuestion = {
  id: 'reproduce:xr',
  text: 'Would I get the same results in R?',
  kind: 'language',
  kernel: {
    name: 'xr',
    displayName: 'R 4.4.3 (xr)',
    language: 'R',
    label: 'R',
    sandboxed: false,
    program: 'xr'
  }
};

/** A model whose agent's stream the test feeds, in a view in jsdom. */
async function view() {
  const runs = new AgentRuns();
  const bench = benchModel(CELLS, { runs });
  const model = bench.model as any;
  const stream: {
    deliver: (event: IAgentEvent | Record<string, unknown>) => void;
  } = { deliver: () => undefined };
  model.aiReady = () => true;
  model._listed = async () => undefined;
  model.refresh = async () => undefined;
  model.api = {
    agent: (
      _body: unknown,
      onEvent: (event: unknown) => void,
      signal: AbortSignal
    ) => {
      stream.deliver = onEvent;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new DOMException('The request was aborted', 'AbortError'))
        );
      });
    },
    agentResult: async () => undefined,
    agentStop: jest.fn(async () => undefined)
  };
  const mounted = await mount(
    <DocumentView
      model={bench.model}
      editorServices={null}
      openFile={() => undefined}
      isVisible={() => true}
    />
  );
  return { model, mounted, stream };
}

type Box = { top: number; bottom: number };

/**
 * The boxes that the browser would give: the scrolled area of the view is
 * 500 px high, and a strip is where `strip` says. jsdom lays nothing out.
 */
function layout(strip: Box) {
  const scrolled: { element: Element; options: unknown }[] = [];
  const boxOf = Element.prototype.getBoundingClientRect;
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const box = this.classList.contains('jp-Epi-main')
      ? { top: 0, bottom: 500 }
      : this.hasAttribute('data-strip-id')
        ? strip
        : { top: 0, bottom: 0 };
    return {
      ...box,
      left: 0,
      right: 600,
      width: 600,
      height: box.bottom - box.top,
      x: 0,
      y: box.top,
      toJSON: () => box
    } as DOMRect;
  };
  Element.prototype.scrollIntoView = function (
    this: Element,
    options?: unknown
  ) {
    scrolled.push({ element: this, options });
  };
  return {
    scrolled,
    restore: () => {
      Element.prototype.getBoundingClientRect = boxOf;
      Element.prototype.scrollIntoView = scrollIntoView;
    }
  };
}

/** The strip of the run asked at the end of the notebook. */
function endStrip(host: Element): Element | null {
  return host.querySelector('[data-strip-id^="end:"]');
}

describe('the strip of a run that the analyst starts', () => {
  afterEach(() => {
    delete (window as any).matchMedia;
  });

  it('comes into sight, outlined, when Reproduce in R puts it at the end of the notebook', async () => {
    const { model, mounted } = await view();
    const page = layout({ top: 900, bottom: 960 });
    try {
      void model.askInKernel(QUESTION);
      await settle();
      const strip = endStrip(mounted.host);
      expect(strip).not.toBeNull();
      expect(strip!.textContent).toContain(QUESTION.text);
      expect(page.scrolled.map(item => item.element)).toEqual([strip]);
      expect(page.scrolled[0].options).toMatchObject({
        block: 'center',
        behavior: 'smooth'
      });
      expect(strip!.classList.contains('jp-mod-flash')).toBe(true);
      // Taken once: the next drawing does not scroll again.
      model._emit();
      await settle();
      expect(page.scrolled).toHaveLength(1);
      expect(model.stripToShow).toBeNull();
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('scrolls at once, with no smooth motion, when the analyst asks for less motion', async () => {
    (window as any).matchMedia = (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)'
    });
    const { model, mounted } = await view();
    const page = layout({ top: 900, bottom: 960 });
    try {
      void model.askInKernel(QUESTION);
      await settle();
      expect(page.scrolled).toHaveLength(1);
      expect(page.scrolled[0].options).toMatchObject({ behavior: 'auto' });
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('stays where it is when it is in sight', async () => {
    const { model, mounted } = await view();
    const page = layout({ top: 300, bottom: 360 });
    try {
      void model.askInKernel(QUESTION);
      await settle();
      const strip = endStrip(mounted.host);
      expect(strip).not.toBeNull();
      expect(page.scrolled).toEqual([]);
      expect(strip!.classList.contains('jp-mod-flash')).toBe(false);
      expect(model.stripToShow).toBeNull();
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('comes into sight for a question about a cell, as for a typed question', async () => {
    const { model, mounted } = await view();
    const page = layout({ top: 700, bottom: 760 });
    try {
      const strip: IStrip = {
        cellId: 'b',
        question: { id: 'q1', text: 'Does pain fall?', type: 'causal' },
        guess: null,
        text: 'Does pain fall?',
        action: 'New cell after [2]',
        placement: { kind: 'new', cell: 'b', label: 'new cell after [2]' },
        status: 'writing',
        stage: null,
        elapsed: null,
        started: Date.now(),
        thinking: null,
        before: null,
        after: null,
        insertedId: null,
        error: null,
        showDiff: false
      };
      model.strips.set('b', strip);
      void model._agent(
        {
          id: 'q1',
          text: 'Does pain fall?',
          type: 'causal',
          origin: 'user',
          probability: null,
          reasons: [],
          placement: null,
          code: null
        },
        strip.placement,
        model.cell('b'),
        strip,
        null,
        async () => undefined
      );
      await settle();
      const shown = mounted.host.querySelector('[data-strip-id="b"]');
      expect(shown).not.toBeNull();
      expect(page.scrolled.map(item => item.element)).toEqual([shown]);
      expect(shown!.classList.contains('jp-mod-flash')).toBe(true);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('comes into sight when Reproduce in R waits at the cap of the notebook', async () => {
    const { model, mounted } = await view();
    const page = layout({ top: 900, bottom: 960 });
    try {
      model.settings.showCost = true;
      model.notebook.setMetadata('whybook', {
        cost_cap_usd: 0.05,
        costs: { answers: { usd: 0.05, n: 1 } }
      });
      void model.askInKernel(QUESTION);
      await settle();
      // The strip that says why the run did not start, under the last cell.
      const held = mounted.host.querySelector('.jp-Epi-heldstrip');
      expect(held?.textContent).toContain('Not started');
      expect(page.scrolled.map(item => item.element)).toEqual([held]);
      expect(held!.classList.contains('jp-mod-flash')).toBe(true);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('shows at the end of the Code view too', async () => {
    const { model, mounted } = await view();
    const page = layout({ top: 900, bottom: 960 });
    try {
      model.setView('linear');
      await settle();
      void model.askInKernel(QUESTION);
      await settle();
      const strip = endStrip(mounted.host);
      expect(strip).not.toBeNull();
      expect(strip!.closest('.jp-Epi-linear')).not.toBeNull();
      expect(page.scrolled.map(item => item.element)).toEqual([strip]);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });
});
