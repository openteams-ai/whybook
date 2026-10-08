/**
 * The cell of a template's answer comes into sight with its strip (design
 * iteration 1.93). In the demo video, qsmk dropped onto wt82_71 in the
 * Whybook panel asked about [2], the last cell that uses both columns, and
 * the template's new cell [3] went right after it. The strip and [3] were
 * below the fold, under the tall card of [2], and the bench stayed where it
 * was: only an answer that went away from the cell asked about came into
 * sight. The strip goes near the top of the view, with the new cell under
 * it, unless both are in sight already, and the view follows the cell's
 * outputs once it ran. An edit in place leaves the view where it is, and the
 * strip of an agent's run comes into sight alone.
 */
import './fakes/quiet';

import * as React from 'react';

import type { IAgentEvent } from '../model/agent';
import type { IStrip } from '../model/epimodel';
import { AgentRuns } from '../model/runs';
import type { IOption } from '../tokens';
import { DocumentView } from '../ui/document';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

const CELLS = [
  {
    id: 'a',
    source: 'import pandas as pd\nnhefs = pd.read_csv("nhefs.csv")',
    count: 1
  },
  { id: 'b', source: 'whybook.hist(nhefs, "wt82_71")', count: 2 }
];

/** "Does wt82_71 differ between the levels of qsmk?", asked about [2]. */
const DIFFER: IOption = {
  id: 'q:differ',
  text: 'Does wt82_71 differ between the levels of qsmk?',
  type: 'association',
  origin: 'template',
  probability: null,
  reasons: [],
  placement: {
    kind: 'new',
    cell: 'b',
    label: 'a new cell in Notebook, after [2]'
  },
  code: 'whybook.compare_levels(nhefs, "wt82_71", "qsmk", unit="seqn")'
};

/** A template that edits [2] in place. */
const EDIT: IOption = {
  ...DIFFER,
  id: 'q:bins',
  text: 'Use 40 bins',
  type: 'descriptive',
  placement: { kind: 'edit', cell: 'b', label: 'edit [2] in place' },
  code: 'whybook.hist(nhefs, "wt82_71", bins=40)'
};

/** A view model of the two cells, in a view in jsdom, with an agent's stream that the test feeds. */
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
 * 500 px high and scrolled by 1,000 px, a strip is where `strip` says, and
 * a cell other than [1] and [2], the cell that an answer added, is where
 * `added` says. A test moves them through `boxes`. jsdom lays nothing out.
 */
function layout(strip: Box, added: Box) {
  const boxes = { strip, added };
  const scrolled: { element: Element; options: unknown }[] = [];
  const boxOf = Element.prototype.getBoundingClientRect;
  const scrollTo = Element.prototype.scrollTo;
  const scrollIntoView = Element.prototype.scrollIntoView;
  const scrollTop = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollTop'
  )!;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const cell = this.getAttribute('data-cell-id');
    const box = this.classList.contains('jp-Epi-main')
      ? { top: 0, bottom: 500 }
      : this.hasAttribute('data-strip-id')
        ? boxes.strip
        : cell && cell !== 'a' && cell !== 'b'
          ? boxes.added
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
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return (this as Element).classList.contains('jp-Epi-main') ? 1000 : 0;
    },
    set() {
      // jsdom scrolls nothing.
    }
  });
  Element.prototype.scrollTo = function (
    this: Element,
    options?: ScrollToOptions | number
  ) {
    scrolled.push({ element: this, options });
  } as typeof Element.prototype.scrollTo;
  Element.prototype.scrollIntoView = function (
    this: Element,
    options?: unknown
  ) {
    scrolled.push({ element: this, options });
  };
  return {
    boxes,
    scrolled,
    restore: () => {
      Element.prototype.getBoundingClientRect = boxOf;
      Element.prototype.scrollTo = scrollTo;
      Element.prototype.scrollIntoView = scrollIntoView;
      Object.defineProperty(Element.prototype, 'scrollTop', scrollTop);
    }
  };
}

/** The strip of the answer, drawn under [2]. */
function stripOf(host: Element): Element | null {
  return host.querySelector('[data-strip-id="b"]');
}

/** The runs of the model's cells wait until the test ends them. */
function heldRuns(model: any): { end: () => Promise<void> } {
  const waiting: (() => void)[] = [];
  model.jobs.run = () =>
    new Promise(resolve => waiting.push(() => resolve({ ok: true })));
  return {
    end: async () => {
      waiting.splice(0).forEach(release => release());
      await settle();
    }
  };
}

describe('the outputs of the cell of a template', () => {
  it('come into sight under its strip once the cell ran, when they reach below the fold', async () => {
    const { model, mounted } = await view();
    const runs = heldRuns(model);
    // The strip and the new cell, without outputs yet, at the bottom of the view.
    const page = layout({ top: 380, bottom: 440 }, { top: 440, bottom: 490 });
    try {
      void model.apply(DIFFER);
      await settle();
      expect(page.scrolled).toEqual([]);
      // The run brings a table: the cell now ends 300 px below the fold.
      page.boxes.added = { top: 440, bottom: 800 };
      await runs.end();
      const main = mounted.host.querySelector('.jp-Epi-main');
      expect(page.scrolled).toEqual([
        { element: main, options: { top: 1356, behavior: 'smooth' } }
      ]);
      expect(model.stripToShow).toBeNull();
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('stay where they are when the analyst scrolled the view while the cell ran', async () => {
    const { model, mounted } = await view();
    const runs = heldRuns(model);
    const page = layout({ top: 380, bottom: 440 }, { top: 440, bottom: 490 });
    try {
      void model.apply(DIFFER);
      await settle();
      const main = mounted.host.querySelector('.jp-Epi-main')!;
      main.dispatchEvent(new Event('wheel'));
      page.boxes.added = { top: 440, bottom: 800 };
      await runs.end();
      expect(page.scrolled).toEqual([]);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('stay where they are when another scroll moved the view, or a drag started, while the cell ran', async () => {
    for (const event of ['scroll', 'dragstart']) {
      const { model, mounted } = await view();
      const runs = heldRuns(model);
      const page = layout({ top: 380, bottom: 440 }, { top: 440, bottom: 490 });
      try {
        void model.apply(DIFFER);
        await settle();
        // As "Show on the bench" scrolls the view to another cell, or a
        // column is dragged from the Whybook panel.
        const main = mounted.host.querySelector('.jp-Epi-main')!;
        (event === 'scroll' ? main : document).dispatchEvent(
          new Event(event, { bubbles: event === 'dragstart' })
        );
        page.boxes.added = { top: 440, bottom: 800 };
        await runs.end();
        expect(page.scrolled).toEqual([]);
      } finally {
        page.restore();
        await mounted.unmount();
        model.dispose();
      }
    }
  });

  it('need no scroll when they show whole', async () => {
    const { model, mounted } = await view();
    const runs = heldRuns(model);
    const page = layout({ top: 100, bottom: 160 }, { top: 160, bottom: 220 });
    try {
      void model.apply(DIFFER);
      await settle();
      page.boxes.added = { top: 160, bottom: 460 };
      await runs.end();
      expect(page.scrolled).toEqual([]);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });
});

describe("the cell of a template's answer", () => {
  it('asks the view to show its strip and its new cell, when the cell goes right after the cell asked about', async () => {
    const { model, mounted } = await view();
    try {
      void model.apply(DIFFER);
      // The template's code is known: the strip and the cell are there at once.
      const strip: IStrip = model.strips.get('b');
      expect(strip.insertedId).not.toBeNull();
      expect(model.stripToShow).toBe('b');
      expect(model.stripCellToShow).toBe(strip.insertedId);
      expect(model.stripIfHidden).toBe(true);
      await settle();
      expect(model.stripToShow).toBeNull();
      expect(model.stripCellToShow).toBeNull();
    } finally {
      await mounted.unmount();
      model.dispose();
    }
  });

  it('comes into sight below the fold: the view scrolls its strip near the top, with the cell under it', async () => {
    const { model, mounted } = await view();
    const page = layout({ top: 900, bottom: 960 }, { top: 960, bottom: 1160 });
    try {
      void model.apply(DIFFER);
      await settle();
      const strip = stripOf(mounted.host);
      expect(strip).not.toBeNull();
      const main = mounted.host.querySelector('.jp-Epi-main');
      // 1,000 px scrolled, and the strip 900 px down the view: 24 px above it show.
      expect(page.scrolled).toEqual([
        { element: main, options: { top: 1876, behavior: 'smooth' } }
      ]);
      expect(strip!.classList.contains('jp-mod-flash')).toBe(true);
      // Taken once: the next drawing does not scroll again.
      model._emit();
      await settle();
      expect(page.scrolled).toHaveLength(1);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('comes into sight when its strip shows at the bottom of the view and the cell under it does not', async () => {
    const { model, mounted } = await view();
    const page = layout({ top: 420, bottom: 480 }, { top: 480, bottom: 680 });
    try {
      void model.apply(DIFFER);
      await settle();
      const main = mounted.host.querySelector('.jp-Epi-main');
      expect(page.scrolled).toEqual([
        { element: main, options: { top: 1396, behavior: 'smooth' } }
      ]);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('stays where it is when its strip and its cell are in sight', async () => {
    const { model, mounted } = await view();
    const page = layout({ top: 100, bottom: 160 }, { top: 160, bottom: 360 });
    try {
      void model.apply(DIFFER);
      await settle();
      expect(stripOf(mounted.host)).not.toBeNull();
      expect(page.scrolled).toEqual([]);
      expect(stripOf(mounted.host)!.classList.contains('jp-mod-flash')).toBe(
        false
      );
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });
});

/** A model that writes one cell when the test lets it. */
function heldWrites(model: any): { write: () => Promise<void> } {
  const waiting: (() => void)[] = [];
  model.settings.answers = 'cell';
  model.api.solve = (
    _body: unknown,
    onEvent: (event: Record<string, unknown>) => void
  ) =>
    new Promise<void>(resolve =>
      waiting.push(() => {
        onEvent({
          type: 'result',
          elapsed: 1,
          cell: {
            code: 'nhefs.groupby("qsmk").wt82_71.mean()',
            summary: 'The mean weight change by quitting.',
            assumptions: [],
            follow_up: []
          },
          model: 'a model'
        });
        resolve();
      })
    );
  return {
    write: async () => {
      waiting.splice(0).forEach(release => release());
      await settle();
    }
  };
}

/** A question that no template answers, about [2]. */
const TYPED: IOption = {
  ...DIFFER,
  id: 'q:typed',
  text: 'How much more weight did the quitters gain?',
  origin: 'user',
  code: null
};

describe('the cell of an answer that a model writes', () => {
  it('comes into sight when the code comes, when the analyst left the view alone', async () => {
    const { model, mounted } = await view();
    heldRuns(model);
    const writes = heldWrites(model);
    const page = layout({ top: 900, bottom: 960 }, { top: 960, bottom: 1160 });
    try {
      void model.apply(TYPED);
      await settle();
      // The strip waits under [2] while the model writes.
      expect(page.scrolled).toEqual([]);
      await writes.write();
      const main = mounted.host.querySelector('.jp-Epi-main');
      expect(model.strips.get('b').insertedId).not.toBeNull();
      expect(page.scrolled).toEqual([
        { element: main, options: { top: 1876, behavior: 'smooth' } }
      ]);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it('leaves the view where the analyst scrolled it while the model wrote', async () => {
    const { model, mounted } = await view();
    heldRuns(model);
    const writes = heldWrites(model);
    const page = layout({ top: 900, bottom: 960 }, { top: 960, bottom: 1160 });
    try {
      void model.apply(TYPED);
      await settle();
      // The wheel moves the view a moment after the question.
      await new Promise(resolve => setTimeout(resolve, 5));
      mounted.host
        .querySelector('.jp-Epi-main')!
        .dispatchEvent(new Event('wheel'));
      await writes.write();
      expect(model.strips.get('b').insertedId).not.toBeNull();
      expect(page.scrolled).toEqual([]);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });
});

describe('an edit in place, and the strip of an agent', () => {
  it('an edit in place leaves the view where it is', async () => {
    const { model, mounted } = await view();
    const page = layout({ top: 900, bottom: 960 }, { top: 960, bottom: 1160 });
    try {
      void model.apply(EDIT);
      await settle();
      expect(stripOf(mounted.host)).not.toBeNull();
      expect(model.strips.get('b').placement.kind).toBe('edit');
      expect(page.scrolled).toEqual([]);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });

  it("an agent's run brings its strip alone into sight, and not its first cell", async () => {
    const { model, mounted, stream } = await view();
    // The strip shows under [2]; the run's first cell, below it, is out of sight.
    const page = layout({ top: 200, bottom: 260 }, { top: 700, bottom: 900 });
    try {
      void model.apply({
        ...DIFFER,
        id: 'q:agent',
        text: 'What else could explain both qsmk and wt82_71?',
        origin: 'claude',
        code: null
      });
      await settle();
      stream.deliver({ type: 'started', run: 'r1', keep_local: false });
      stream.deliver({
        type: 'tool',
        run: 'r1',
        call: 'r1-0',
        name: 'run_cell',
        input: { code: 'nhefs.corr()', title: 'Correlations', why: '' }
      });
      await settle();
      const strip = model.strips.get('b');
      expect(strip?.agent).toBeTruthy();
      expect(strip.insertedId).not.toBeNull();
      expect(model.stripCellToShow).toBeNull();
      expect(page.scrolled).toEqual([]);
    } finally {
      page.restore();
      await mounted.unmount();
      model.dispose();
    }
  });
});
