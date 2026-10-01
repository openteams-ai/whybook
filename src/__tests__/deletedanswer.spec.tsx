/**
 * An answer whose cell the analyst deletes while the model writes it (design
 * iteration 1.55; item 12 of research/critique-3.md). The answer found its
 * cell before the model wrote, and used it after: a new cell went to the top
 * of the notebook, an edit ran its code in the kernel with no cell to show
 * it, and a preview that the analyst closed ran its code. Now the answer
 * waits in a strip where the cell was, and nothing runs until the analyst
 * puts it back with its cell or alone.
 */
import './fakes/quiet';

import * as React from 'react';

import { Bench, stripAction } from '../ui/bench';
import { LinearView } from '../ui/linear';
import { benchModel } from './fakes/bench-fake';
import { mount, settle as drawn, step } from './fakes/bench-render';
import { fakeModel, settle, sources } from './fakes/model-fake';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => (resolve = done));
  return { promise, resolve };
}

const FIT = 'fit = smf.ols("pain ~ week", data=visits).fit()';

/** A model whose next answer waits until the test lets the model write it. */
function answerable() {
  const { nb, model } = fakeModel([
    { id: 'imports', count: 1, source: 'import pandas as pd' },
    { id: 'load', count: 2, source: 'visits = pd.read_csv("visits.csv")' },
    { id: 'fit', count: 3, source: FIT }
  ]);
  const ran: string[] = [];
  model.jobs = {
    run: async (cell: any) => {
      ran.push(cell.sharedModel.getSource());
      return { ok: true, error: null };
    }
  };
  model.refresh = () => Promise.resolve();
  model.settings.answers = 'cell';
  model.aiReady = () => true;
  const written = deferred<{ code: string; meta: any }>();
  const signals: AbortSignal[] = [];
  model._write = (...args: any[]) => {
    signals.push(args[5]);
    return written.promise;
  };
  return { nb, model, ran, written, signals };
}

const question = (placement: any) => ({
  id: 'q1',
  text: 'Does week explain pain?',
  type: 'model',
  origin: 'claude',
  probability: 0.5,
  reasons: [],
  placement,
  code: null
});

const AFTER = { kind: 'new', cell: 'fit', label: 'new cell after [3]' };
const EDIT = { kind: 'edit', cell: 'fit', label: 'edit [3] in place' };
const EDITED = 'fit = smf.ols("pain ~ week + il6", data=visits).fit()';

describe('an answer whose cell is deleted while the model writes it', () => {
  it('does not put an answer at the top of the notebook', async () => {
    const { nb, model, ran, written } = answerable();
    const answering = model.apply(question(AFTER), AFTER);
    // The analyst deletes [3] while the model writes.
    model.deleteCell('fit');
    written.resolve({ code: 'fit.summary()', meta: {} });
    await answering;
    expect(sources(nb)).toEqual([
      'import pandas as pd',
      'visits = pd.read_csv("visits.csv")'
    ]);
    expect(ran).toEqual([]);
    // The answer waits where [3] was.
    const strip = model.strips.get('fit');
    expect(strip.status).toBe('waiting');
    expect(strip.gone.label).toBe('[3]');
    expect(strip.gone.before).toBe('load');
    expect(strip.waiting.code).toBe('fit.summary()');
  });

  it('does not run an edit whose cell was deleted', async () => {
    const { model, ran, written } = answerable();
    const answering = model.apply(question(EDIT), EDIT);
    model.deleteCell('fit');
    written.resolve({ code: EDITED, meta: {} });
    await answering;
    expect(ran).toEqual([]);
    expect(model.strips.get('fit').status).toBe('waiting');
  });

  it('waits too when the cell goes in another view of the notebook', async () => {
    const { nb, model, ran, written } = answerable();
    const answering = model.apply(question(AFTER), AFTER);
    // JupyterLab's notebook view deletes [3]: the view's model does not.
    nb.sharedModel.deleteCell(2);
    written.resolve({ code: 'fit.summary()', meta: {} });
    await answering;
    expect(sources(nb)).toHaveLength(2);
    expect(ran).toEqual([]);
    const strip = model.strips.get('fit');
    expect(strip.status).toBe('waiting');
    expect(strip.gone.cell.source).toBe(FIT);
    expect(strip.gone.before).toBe('load');
  });

  it('"Restore [3] and run" puts the cell back, and the new cell after it', async () => {
    const { nb, model, ran, written } = answerable();
    const answering = model.apply(question(AFTER), AFTER);
    model.deleteCell('fit');
    written.resolve({ code: 'fit.summary()', meta: {} });
    await answering;
    await model.runWaiting('fit', 'restore');
    expect(sources(nb)).toEqual([
      'import pandas as pd',
      'visits = pd.read_csv("visits.csv")',
      FIT,
      'fit.summary()'
    ]);
    expect(nb.cells.get(2).id).toBe('fit');
    expect(ran).toEqual(['fit.summary()']);
    const strip = model.strips.get('fit');
    expect(strip.status).toBe('done');
    expect(strip.insertedId).toBe(nb.cells.get(3).id);
    expect(strip.gone).toBeNull();
  });

  it('"Restore [3] and run" of an edit edits the cell it puts back', async () => {
    const { nb, model, ran, written } = answerable();
    const answering = model.apply(question(EDIT), EDIT);
    model.deleteCell('fit');
    written.resolve({ code: EDITED, meta: {} });
    await answering;
    await model.runWaiting('fit', 'restore');
    expect(sources(nb)).toEqual([
      'import pandas as pd',
      'visits = pd.read_csv("visits.csv")',
      EDITED
    ]);
    expect(nb.cells.get(2).id).toBe('fit');
    expect(ran).toEqual([EDITED]);
    // Undo puts back the code that the cell had.
    expect(model.strips.get('fit').before).toBe(FIT);
  });

  it('"Run it" puts the answer alone where the cell was', async () => {
    const { nb, model, ran, written } = answerable();
    const answering = model.apply(question(AFTER), AFTER);
    model.deleteCell('fit');
    written.resolve({ code: 'fit.summary()', meta: {} });
    await answering;
    await model.runWaiting('fit', 'alone');
    expect(sources(nb)).toEqual([
      'import pandas as pd',
      'visits = pd.read_csv("visits.csv")',
      'fit.summary()'
    ]);
    expect(ran).toEqual(['fit.summary()']);
    // The strip goes with the new cell, and says where it went.
    const added = nb.cells.get(2).id;
    const strip = model.strips.get(added);
    expect(model.strips.has('fit')).toBe(false);
    expect(strip.status).toBe('done');
    expect(stripAction(model, strip)).toBe('Added a cell where [3] was');
  });

  it('drops the answer when the analyst closes its strip', async () => {
    const { nb, model, ran, written } = answerable();
    const answering = model.apply(question(AFTER), AFTER);
    model.deleteCell('fit');
    written.resolve({ code: 'fit.summary()', meta: {} });
    await answering;
    model.dismissStrip('fit');
    expect(model.strips.has('fit')).toBe(false);
    await model.runWaiting('fit', 'restore');
    expect(sources(nb)).toHaveLength(2);
    expect(ran).toEqual([]);
  });

  it('goes where it was meant to when the cell came back before it', async () => {
    const { nb, model, ran, written } = answerable();
    const answering = model.apply(question(AFTER), AFTER);
    const saved = model.deleteCell('fit');
    // The notice's Undo.
    model.restoreCell(saved);
    written.resolve({ code: 'fit.summary()', meta: {} });
    await answering;
    expect(sources(nb)).toEqual([
      'import pandas as pd',
      'visits = pd.read_csv("visits.csv")',
      FIT,
      'fit.summary()'
    ]);
    expect(ran).toEqual(['fit.summary()']);
  });
});

describe('Stop on the strip of an answer that the model writes', () => {
  it('ends the request, adds nothing, and closes the strip', async () => {
    const { nb, model, ran, written, signals } = answerable();
    const answering = model.apply(question(AFTER), AFTER);
    await settle();
    expect(model.strips.get('fit').status).toBe('writing');
    model.stopAnswer('fit');
    expect(signals[0].aborted).toBe(true);
    expect(model.strips.has('fit')).toBe(false);
    // An answer that comes all the same is not added.
    written.resolve({ code: 'fit.summary()', meta: {} });
    await answering;
    expect(sources(nb)).toHaveLength(3);
    expect(ran).toEqual([]);
    expect(model.strips.has('fit')).toBe(false);
  });
});

describe('an answer in the sidebar that the analyst closes', () => {
  function previewing() {
    const { model } = fakeModel([
      { id: 'a', source: 'diary = load()', count: 1 }
    ]);
    const written = deferred<{ code: string; meta: object }>();
    const signals: AbortSignal[] = [];
    model._write = (...args: any[]) => {
      signals.push(args[5]);
      return written.promise;
    };
    const ran: string[] = [];
    model.bridge = {
      ...model.bridge,
      execute: async (code: string) => {
        ran.push(code);
        return { outputs: [], error: null };
      }
    };
    const option = {
      id: 'own:1',
      text: 'Show pain for patients over 60',
      type: 'descriptive',
      origin: 'user',
      probability: null,
      reasons: [],
      placement: null,
      code: null
    };
    return { model, written, signals, ran, option };
  }

  it('does not run its code when the answer comes', async () => {
    const { model, written, ran, option } = previewing();
    const done = model._preview(option, null);
    expect(model.preview?.status).toBe('writing');
    model.closePreview();
    expect(model.preview).toBeNull();
    written.resolve({
      code: 'diary = diary[diary.age > 60]\ndiary.pain.describe()',
      meta: {}
    });
    await done;
    expect(ran).toEqual([]);
  });

  it('ends the request of its answer', async () => {
    const { model, signals, option } = previewing();
    void model._preview(option, null);
    model.closePreview();
    expect(signals[0].aborted).toBe(true);
  });
});

describe('the strips of an answer whose cell is gone, as the views draw them', () => {
  const CELLS = [
    { id: 'head', type: 'markdown' as const, source: '## Model' },
    { id: 'lmm', source: 'fit = mixedlm(diary)', count: 5 },
    { id: 'ordinal', source: 'ordinal = OrderedModel(diary)', count: 6 }
  ];

  /** A strip for a new cell after [5], as the view makes it. */
  function writing(model: any): any {
    const strip = {
      cellId: 'lmm',
      question: { id: 'q1', text: 'Does the effect differ by site?' },
      guess: null,
      text: 'Does the effect differ by site?',
      action: 'New cell after [5]',
      placement: { kind: 'new', cell: 'lmm', label: 'new cell after [5]' },
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
    model.strips.set('lmm', strip);
    return strip;
  }

  function cardsAndStrips(host: Element): string[] {
    return Array.from(
      host.querySelectorAll('.jp-Epi-sectionblock > *, .jp-Epi-linear > *')
    )
      .map(node =>
        node.matches('.jp-Epi-gonestrip')
          ? 'strip'
          : (node.getAttribute('data-cell-id') ??
            node
              .querySelector('[data-cell-id]')
              ?.getAttribute('data-cell-id') ??
            '')
      )
      .filter(Boolean);
  }

  it('draws Stop while the model writes, and the strip where the cell was once deleted', async () => {
    const { model } = benchModel(CELLS);
    const strip = writing(model);
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await drawn();
    const stop = () =>
      Array.from(view.host.querySelectorAll('button')).find(
        button => button.textContent === 'Stop'
      );
    const underCard = !!view.host.querySelector(
      '.jp-Epi-cell[data-cell-id="lmm"] .jp-Epi-strip'
    );
    const hadStop = !!stop();
    await step(() => void model.deleteCell('lmm'));
    await drawn();
    const order = cardsAndStrips(view.host);
    const note = view.host.querySelector('.jp-Epi-strip-note')?.textContent;
    await step(() => stop()?.click());
    await drawn();
    const found = {
      underCard,
      hadStop,
      order,
      note,
      stopped: !model.strips.has('lmm'),
      gone: !view.host.querySelector('.jp-Epi-gonestrip')
    };
    await view.unmount();
    model.dispose();
    expect(strip.gone.label).toBe('[5]');
    expect(found).toEqual({
      underCard: true,
      hadStop: true,
      order: ['strip', 'ordinal'],
      note: '[5] was deleted. When the answer comes, it waits here, and nothing runs.',
      stopped: true,
      gone: true
    });
  });

  it('keeps the strip where the cell was when another view deletes it', async () => {
    const { nb, model } = benchModel(CELLS);
    const strip = writing(model);
    // As _answer does before the model writes.
    (model as any)._watchTarget('lmm');
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await drawn();
    // JupyterLab's notebook view deletes [5].
    await step(() => nb.sharedModel.deleteCell(1));
    await drawn();
    const order = cardsAndStrips(view.host);
    // Undo in the notebook view puts it back: the strip is under it again.
    await step(() => nb.sharedModel.insertCell(1, strip.gone.cell as any));
    await drawn();
    const back = !!view.host.querySelector(
      '.jp-Epi-cell[data-cell-id="lmm"] .jp-Epi-strip'
    );
    await view.unmount();
    model.dispose();
    expect(order).toEqual(['strip', 'ordinal']);
    expect(back).toBe(true);
    expect(strip.gone).toBeNull();
  });

  it('draws the answer that waits with its code and its two actions, in the bench and the Code view', async () => {
    const { model } = benchModel(CELLS);
    const strip = writing(model);
    model.deleteCell('lmm');
    (model as any)._keepWaiting(strip, {
      option: { id: 'q1', text: strip.text },
      code: 'by_site = model_data.groupby("site").pain.mean()\nby_site',
      meta: {}
    });
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await drawn();
    const held = view.host.querySelector('.jp-Epi-waitstrip');
    const found = {
      order: cardsAndStrips(view.host),
      action: held?.querySelector('.jp-Epi-strip-action')?.textContent,
      note: held?.querySelector('.jp-Epi-capnote-text')?.textContent,
      buttons: Array.from(held?.querySelectorAll('button') ?? []).map(
        button => button.textContent
      ),
      code: Array.from(held?.querySelectorAll('.jp-Epi-diff > div') ?? []).map(
        line => line.textContent
      )
    };
    await view.render(<LinearView model={model} editorServices={null} />);
    await drawn();
    const linear = cardsAndStrips(view.host);
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      order: ['strip', 'ordinal'],
      action: 'Not added',
      note: '[5] was deleted while the model wrote this answer, so the answer waits here: nothing was added to the notebook, and nothing ran.',
      buttons: ['', 'Hide code', 'Run it', 'Restore [5] and run'],
      code: ['+ by_site = model_data.groupby("site").pain.mean()', '+ by_site']
    });
    expect(linear).toContain('strip');
    expect(linear.indexOf('strip')).toBe(linear.indexOf('head') + 1);
  });
});
