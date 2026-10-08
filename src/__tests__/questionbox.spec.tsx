/**
 * The box of a question of one's own (`OwnQuestion` in src/ui/common.tsx)
 * wraps the question and grows with it (design iteration 1.90). The field
 * is a textarea next to a copy of its text that nobody sees, which gives the
 * box its height; the question stays one paragraph. Enter asks, Shift+Enter
 * branches, Alt+Enter explores in parallel, and no key adds a line. The Ask
 * button keeps the width of its widest word, so that the box keeps its lines
 * when the place changes the word.
 */
import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { Signal } from '@lumino/signaling';

import { DEFAULT_MODELS } from '../model/models';
import type { IPlacement } from '../tokens';
import type { IAskHow } from '../ui/common';
import { OwnQuestion, askLabels, oneLine } from '../ui/common';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NEW: IPlacement = { kind: 'new', cell: 'a', label: 'new cell after [3]' };
const EDIT: IPlacement = {
  kind: 'edit',
  cell: 'a',
  label: 'edit [3] in place'
};
const BRANCH: IPlacement = {
  kind: 'branch',
  cell: 'a',
  label: 'branch of [3]'
};
const PREVIEW: IPlacement = {
  kind: 'preview',
  cell: null,
  label: 'a preview in the sidebar'
};

const QUESTION =
  'Effect of qsmk on wt82_71 in kg, adjusted for sex, race, age, education, smokeintensity, smokeyrs, exercise, active and wt71';

function fakeModel(): any {
  return {
    changed: new Signal({}),
    aiReady: () => true,
    sortOwn: async () => undefined,
    ownType: () => ({ type: 'causal', by: null, probability: null }),
    ownPlace: (_: string, offered: IPlacement[]) => ({
      place: offered[0] ?? null,
      by: null
    }),
    settings: { models: { ...DEFAULT_MODELS } },
    status: null,
    api: {},
    refreshStatus: () => undefined,
    variables: () => [],
    ask: null
  };
}

let root: Root | null = null;
let host: HTMLElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

/** The box, and the questions that it asked. */
async function mount(
  props: { places?: IPlacement[]; parallel?: boolean } = {}
): Promise<{ asked: [string, IAskHow][] }> {
  const asked: [string, IAskHow][] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <OwnQuestion
        model={fakeModel()}
        onAsk={(text, how) => asked.push([text, how])}
        places={props.places}
        parallel={props.parallel}
      />
    );
  });
  return { asked };
}

function field(): HTMLTextAreaElement {
  const found = host.querySelector('.jp-Epi-own-field textarea');
  if (!(found instanceof HTMLTextAreaElement)) {
    throw new Error('the box has no textarea');
  }
  return found;
}

/** Text typed or pasted into the box, as the browser sends it. */
async function type(text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )!.set!;
    setter.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A key on the box: whether the page kept its default action, such as a new line. */
async function press(init: KeyboardEventInit): Promise<boolean> {
  let kept = true;
  await act(async () => {
    kept = field().dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    );
  });
  return kept;
}

describe("the box of a question of one's own", () => {
  it('is a field that wraps, beside a copy of its text that gives it its height', async () => {
    await mount();
    expect(field().rows).toBe(1);
    expect(field().getAttribute('aria-label')).toBe('Your own question');
    await type(QUESTION);
    expect(field().value).toBe(QUESTION);
    const copy = host.querySelector('.jp-Epi-own-grow');
    expect(copy?.getAttribute('data-text')).toBe(QUESTION);
    // The copy is no text of the page, which holds the question once, in
    // the field: the copy is drawn from the attribute.
    expect(Array.from(copy!.childNodes)).toEqual([field()]);
  });

  it('keeps the question one paragraph: a line break pasted into it becomes a space', async () => {
    await mount();
    await type('Does wt82_71 differ\r\n\r\n   between the levels\nof qsmk? ');
    expect(field().value).toBe(
      'Does wt82_71 differ between the levels of qsmk? '
    );
  });
});

describe('the keys of the box', () => {
  it('asks on Enter, at the place that the box says, and adds no line', async () => {
    const { asked } = await mount({ places: [NEW, EDIT, BRANCH, PREVIEW] });
    await type('Is the effect the same for men and women?');
    expect(await press({ key: 'Enter' })).toBe(false);
    expect(asked).toEqual([
      ['Is the effect the same for men and women?', { place: NEW }]
    ]);
    expect(field().value).toBe('');
  });

  it('branches on Shift+Enter, and asks at the place where no branch is offered', async () => {
    const branching = await mount({ places: [NEW, BRANCH] });
    await type('What if age were a spline?');
    expect(await press({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(branching.asked).toEqual([
      ['What if age were a spline?', { place: BRANCH }]
    ]);
    await act(async () => root?.unmount());
    const notebook = await mount();
    await type('What else could explain both?');
    expect(await press({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(notebook.asked).toEqual([['What else could explain both?', {}]]);
  });

  it('explores in parallel on Alt+Enter where the request offers it, and asks nothing elsewhere', async () => {
    const parallel = await mount({ places: [NEW, BRANCH], parallel: true });
    await type('Estimate it with inverse probability weighting');
    expect(await press({ key: 'Enter', altKey: true })).toBe(false);
    expect(parallel.asked).toEqual([
      ['Estimate it with inverse probability weighting', { parallel: true }]
    ]);
    await act(async () => root?.unmount());
    const single = await mount({ places: [NEW, BRANCH] });
    await type('Estimate it by standardisation');
    expect(await press({ key: 'Enter', altKey: true })).toBe(false);
    expect(single.asked).toEqual([]);
    expect(field().value).toBe('Estimate it by standardisation');
  });

  it('asks nothing on Ctrl+Enter or Meta+Enter, and adds no line', async () => {
    const { asked } = await mount({ places: [NEW] });
    await type('Who is missing?');
    expect(await press({ key: 'Enter', ctrlKey: true })).toBe(false);
    expect(await press({ key: 'Enter', metaKey: true })).toBe(false);
    expect(asked).toEqual([]);
    expect(field().value).toBe('Who is missing?');
  });

  it('leaves the Enter that ends a composition of an input method to it', async () => {
    const { asked } = await mount({ places: [NEW] });
    await type('体重');
    expect(await press({ key: 'Enter', isComposing: true })).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe('the Ask button', () => {
  it('carries every word that its places can give it, so that it keeps the width of the widest', async () => {
    await mount({ places: [NEW, EDIT, BRANCH, PREVIEW] });
    const label = host.querySelector('button[type="submit"] .jp-Epi-asklabel');
    expect(label?.getAttribute('data-labels')).toBe(
      'Ask\nEdit\nBranch\nPreview'
    );
    // The words are no text of the button: it reads as its one word.
    expect(host.querySelector('button[type="submit"]')!.textContent).toBe(
      'Ask'
    );
  });

  it('has Ask alone where the box offers no place', () => {
    expect(askLabels([])).toEqual(['Ask']);
    expect(askLabels([NEW, BRANCH, BRANCH])).toEqual(['Ask', 'Branch']);
  });
});

describe('oneLine', () => {
  it('turns each line break, with the spaces around it, into one space', () => {
    expect(oneLine('a\nb')).toBe('a b');
    expect(oneLine('a  \r\n\r\n  b')).toBe('a b');
    expect(oneLine('a  b')).toBe('a  b');
    expect(oneLine('a\tb\n')).toBe('a\tb ');
  });
});
