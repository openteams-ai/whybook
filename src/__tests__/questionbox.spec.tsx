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
import { OwnQuestion, askLabels, hintText, oneLine } from '../ui/common';

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

/** The names of the notebook, and the split of each text, for the tests of branches. */
let names: string[] = [];
const NO_SPLIT = { branches: null, by: null, splitting: false, failed: false };
let split: (text: string) => {
  branches: string[] | null;
  by: string | null;
  splitting: boolean;
  failed: boolean;
} = () => NO_SPLIT;

function fakeModel(
  suggest: IPlacement | null = null,
  reading: string | null = null,
  suggestBy: string | null = null,
  typedBy: string | null = null
): any {
  return {
    changed: new Signal({}),
    aiReady: () => true,
    sortOwn: async () => undefined,
    notebookNames: () => names,
    ownSplit: (text: string) => split(text),
    splitOwn: async () => undefined,
    branchLabels: (_: string, count: number) =>
      ['[3b]', '[3c]', '[3d]'].slice(0, count),
    cell: () => ({ label: '[3]' }),
    ownSorting: (text: string) => text === reading,
    ownType: () => ({ type: 'causal', by: typedBy, probability: null }),
    ownPlace: (_: string, offered: IPlacement[]) => ({
      place: offered[0] ?? null,
      suggestion: suggest ? { place: suggest, by: suggestBy } : null
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
  names = [];
  split = () => NO_SPLIT;
});

/** The box, and the questions that it asked. */
async function mount(
  props: {
    places?: IPlacement[];
    parallel?: boolean;
    suggest?: IPlacement;
    /** The text that the model reads, as its request is on its way. */
    reading?: string;
    /** The model that suggests the place `suggest`, or none for the first words. */
    suggestBy?: string;
    /** The model that gave the type. */
    typedBy?: string;
  } = {}
): Promise<{ asked: [string, IAskHow][] }> {
  const asked: [string, IAskHow][] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <OwnQuestion
        model={fakeModel(
          props.suggest ?? null,
          props.reading ?? null,
          props.suggestBy ?? null,
          props.typedBy ?? null
        )}
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
    const { asked } = await mount({ places: [NEW, PREVIEW] });
    await type('Who is missing?');
    expect(await press({ key: 'Enter', ctrlKey: true })).toBe(false);
    expect(await press({ key: 'Enter', metaKey: true })).toBe(false);
    expect(asked).toEqual([]);
    expect(field().value).toBe('Who is missing?');
  });

  it('suggests another place under the box, which a click takes, while the button keeps its place', async () => {
    const { asked } = await mount({
      places: [NEW, EDIT, PREVIEW],
      suggest: PREVIEW
    });
    await type('Show the first rows of weekly');
    const button = host.querySelector('button[type="submit"]')!;
    expect(button.textContent).toBe('Ask');
    const hint = host.querySelector<HTMLButtonElement>('.jp-Epi-own-hint');
    expect(hint?.textContent).toBe('A quick look? Preview instead');
    await act(async () => hint!.click());
    expect(button.textContent).toBe('Preview');
    // Once the analyst picks a place, the box suggests no other.
    expect(host.querySelector('.jp-Epi-own-hint')).toBeNull();
    expect(await press({ key: 'Enter' })).toBe(false);
    expect(asked).toEqual([
      ['Show the first rows of weekly', { place: PREVIEW }]
    ]);
  });

  it('shows a bar under the Ask button, where a suggestion goes, while the model reads the question', async () => {
    await mount({ places: [NEW, EDIT], reading: 'Is sleep linked to pain?' });
    await type('Is sleep linked to pain?');
    const slot = host.querySelector('.jp-Epi-own-slot')!;
    expect(slot.getAttribute('aria-busy')).toBe('true');
    expect(
      slot.querySelector('[role="progressbar"]')?.getAttribute('aria-label')
    ).toBe('The model reads the question');
    // Another text, which the model does not read, has no bar.
    await type('Is sleep linked to pain at all?');
    expect(slot.getAttribute('aria-busy')).toBeNull();
    expect(slot.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('writes the place as its label, with the AI tag of the type beside the type, and the suggestion in the spot under the button', async () => {
    await mount({ places: [NEW, EDIT, BRANCH, PREVIEW], typedBy: 'Jev 1.13' });
    await type('Is pain worse at night?');
    const meta = host.querySelector('.jp-Epi-own-meta')!;
    const parts = Array.from(meta.children).map(child => child.textContent);
    expect(parts).toEqual(['CausalAI', 'new cell after [3]', '']);
    expect(
      meta
        .querySelector('.jp-Epi-own-tagged .jp-Epi-aitag')
        ?.getAttribute('title')
    ).toBe('Type chosen by Jev 1.13');
    expect(hintText({ place: PREVIEW, by: null })).toBe(
      'A quick look? Preview instead'
    );
    expect(hintText({ place: NEW, by: 'Jev 1.13' })).toBe(
      'New cell after [3] instead?'
    );
  });

  it('offers a branch that a model picks as a box to tick, which sets the button and clears it again', async () => {
    const { asked } = await mount({
      places: [NEW, EDIT, BRANCH],
      suggest: BRANCH,
      suggestBy: 'Jev 1.13'
    });
    await type('Is the effect the same at each site?');
    // No line to read: a box to tick, with the badge of the model.
    expect(host.querySelector('.jp-Epi-own-hint')).toBeNull();
    const option = host.querySelector<HTMLLabelElement>('.jp-Epi-own-option')!;
    expect(option.textContent).toBe('Branch of [3]AI');
    // The box is in the spot under the Ask button, where the bar was.
    expect(option.closest('.jp-Epi-own-slot')).not.toBeNull();
    expect(option.querySelector('.jp-Epi-aitag')?.getAttribute('title')).toBe(
      'Suggested by Jev 1.13'
    );
    const box = option.querySelector('input')!;
    const button = host.querySelector('button[type="submit"]')!;
    const placeText = () =>
      Array.from(host.querySelector('.jp-Epi-own-meta')!.children)
        .map(child => child.textContent)
        .join('|');
    expect(placeText()).toBe('Causal|new cell after [3]|Branch of [3]AI');
    await act(async () => box.click());
    expect(button.textContent).toBe('Branch');
    // The line leaves out the place, which the ticked box states.
    expect(placeText()).toBe('Causal|Branch of [3]AI');
    // Ticked, it stays, so that the analyst can untick it.
    await act(async () => box.click());
    expect(button.textContent).toBe('Ask');
    await act(async () => box.click());
    expect(await press({ key: 'Enter' })).toBe(false);
    expect(asked).toEqual([
      ['Is the effect the same at each site?', { place: BRANCH }]
    ]);
  });

  it('offers an edit or a preview that a model picks as a link, as the first words offer a preview, with the tag of the model', async () => {
    await mount({
      places: [NEW, EDIT, BRANCH, PREVIEW],
      suggest: EDIT,
      suggestBy: 'Jev 1.13'
    });
    await type('Should age be in this model as well?');
    expect(host.querySelector('.jp-Epi-own-option')).toBeNull();
    const link = host.querySelector<HTMLButtonElement>('.jp-Epi-own-hint')!;
    expect(link.textContent).toBe('Edit [3] in place instead?');
    const tags = host.querySelectorAll('.jp-Epi-own-meta .jp-Epi-aitag');
    expect(tags[tags.length - 1].getAttribute('title')).toBe(
      'Suggested by Jev 1.13'
    );
    await act(async () => link.click());
    expect(host.querySelector('button[type="submit"]')?.textContent).toBe(
      'Edit'
    );
    expect(host.querySelector('.jp-Epi-own-hint')).toBeNull();
    // A preview reads the same, whoever suggests it.
    expect(hintText({ place: PREVIEW, by: 'Jev 1.13' })).toBe(
      hintText({ place: PREVIEW, by: null })
    );
  });

  it('offers a branch for each name that the question lists, and asks them side by side', async () => {
    names = ['sleep_hours', 'mood', 'pain'];
    const question = 'What is the impact of sleep_hours, mood on pain?';
    const branches = [
      'What is the impact of sleep_hours on pain?',
      'What is the impact of mood on pain?'
    ];
    split = text =>
      text === question
        ? { branches, by: 'Claude Haiku 5.5', splitting: false, failed: false }
        : NO_SPLIT;
    const { asked } = await mount({ places: [NEW, EDIT, BRANCH, PREVIEW] });
    await type(question);
    const row = host.querySelector('.jp-Epi-own-explore')!;
    expect(row.textContent).toBe(
      'Explore in parallel: a branch of [3] for each of sleep_hours, mood'
    );
    const button = host.querySelector('button[type="submit"]')!;
    expect(button.textContent).toBe('Ask');
    // The question stays as typed; ticked, the branches show under it.
    await act(async () => row.querySelector('input')!.click());
    expect(
      Array.from(row.querySelectorAll('li')).map(item => item.textContent)
    ).toEqual([`[3b] ${branches[0]}`, `[3c] ${branches[1]}AI`]);
    // The model wrote them: AI text, and the tag after the last names it.
    expect(row.querySelectorAll('li .jp-Epi-ai')).toHaveLength(2);
    expect(
      row.querySelector('li:last-child .jp-Epi-aitag')?.getAttribute('title')
    ).toBe('Written by Claude Haiku 5.5');
    expect(button.textContent).toBe('2 branches');
    expect(field().value).toBe(question);
    expect(await press({ key: 'Enter' })).toBe(false);
    expect(asked).toEqual([[question, { branches }]]);
  });

  it('asks as one question at a place picked in the menu, and unticks the box', async () => {
    names = ['sleep_hours', 'mood'];
    const question = 'Adjust for sleep_hours or mood';
    split = () => ({
      branches: ['Adjust for sleep_hours', 'Adjust for mood'],
      by: 'Claude Haiku 5.5',
      splitting: false,
      failed: false
    });
    const { asked } = await mount({ places: [NEW, EDIT, BRANCH] });
    await type(question);
    const tick = host.querySelector<HTMLInputElement>(
      '.jp-Epi-own-explore input'
    )!;
    await act(async () => tick.click());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[aria-label="Where the answer goes"]'
        )!
        .click()
    );
    const edit = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.jp-Epi-placemenu button')
    ).find(item => item.textContent?.includes('Edit [3] in place'))!;
    await act(async () => edit.click());
    expect(tick.checked).toBe(false);
    expect(host.querySelector('.jp-Epi-own-branches')).toBeNull();
    expect(host.querySelector('button[type="submit"]')?.textContent).toBe(
      'Edit'
    );
    expect(await press({ key: 'Enter' })).toBe(false);
    expect(asked).toEqual([[question, { place: EDIT }]]);
  });

  it('waits while the model writes the branches, and asks as one question when it fails', async () => {
    names = ['sleep_hours', 'mood'];
    const question = 'Adjust for sleep_hours or mood';
    split = () => ({
      branches: null,
      by: null,
      splitting: true,
      failed: false
    });
    const { asked } = await mount({ places: [NEW, BRANCH] });
    await type(question);
    await act(async () =>
      host.querySelector<HTMLInputElement>('.jp-Epi-own-explore input')!.click()
    );
    expect(
      host
        .querySelector('.jp-Epi-own-explore [role="progressbar"]')
        ?.getAttribute('aria-label')
    ).toBe('The model writes the branches');
    expect(await press({ key: 'Enter' })).toBe(false);
    expect(asked).toEqual([]);
    split = () => ({
      branches: null,
      by: null,
      splitting: false,
      failed: true
    });
    await type(question + ' ');
    expect(host.querySelector('.jp-Epi-own-explore')?.textContent).toContain(
      'The model could not write the branches'
    );
    expect(await press({ key: 'Enter' })).toBe(false);
    expect(asked).toEqual([[question, { place: NEW }]]);
  });

  it('counts the names of the new text on the button, and shows the last branches grey, while the model writes the branches again', async () => {
    names = ['sleep_hours', 'mood', 'analgesic_use'];
    const first = 'Adjust for sleep_hours, mood';
    const branches = ['Adjust for sleep_hours', 'Adjust for mood'];
    split = text =>
      text === first
        ? { branches, by: 'Claude Haiku 5.5', splitting: false, failed: false }
        : { branches: null, by: null, splitting: true, failed: false };
    await mount({ places: [NEW, BRANCH] });
    await type(first);
    await act(async () =>
      host.querySelector<HTMLInputElement>('.jp-Epi-own-explore input')!.click()
    );
    const button = host.querySelector<HTMLButtonElement>(
      'button[type="submit"]'
    )!;
    const list = () => host.querySelector('.jp-Epi-own-branches')!;
    expect([button.textContent, button.disabled]).toEqual([
      '2 branches',
      false
    ]);
    expect(list().classList.contains('jp-mod-stale')).toBe(false);
    await type(`${first} or analgesic_use`);
    expect([button.textContent, button.disabled]).toEqual(['3 branches', true]);
    expect(list().querySelectorAll('li')).toHaveLength(2);
    expect(list().classList.contains('jp-mod-stale')).toBe(true);
  });

  it('asks as one question when the model finds one question in the text', async () => {
    names = ['sleep_hours', 'mood'];
    const question = 'Adjust for sleep_hours and mood together';
    split = () => ({
      branches: [question],
      by: 'Claude Haiku 5.5',
      splitting: false,
      failed: false
    });
    const { asked } = await mount({ places: [NEW, BRANCH] });
    await type(question);
    await act(async () =>
      host.querySelector<HTMLInputElement>('.jp-Epi-own-explore input')!.click()
    );
    expect(host.querySelector('.jp-Epi-own-explore')?.textContent).toContain(
      'The model found one question in the text, so Ask asks it as one.'
    );
    expect(host.querySelector('.jp-Epi-own-branches')).toBeNull();
    expect(host.querySelector('button[type="submit"]')?.textContent).toBe(
      'Ask'
    );
    expect(await press({ key: 'Enter' })).toBe(false);
    expect(asked).toEqual([[question, { place: NEW }]]);
  });

  it('says when a question lists more names than one question makes branches for', async () => {
    names = Array.from({ length: 21 }, (_, index) => `x${index + 1}`);
    await mount({ places: [NEW, BRANCH] });
    await type(`What is the impact of ${names.join(', ')}?`);
    expect(host.querySelector('.jp-Epi-own-explore')?.textContent).toContain(
      'At most 20 branches for one question: the names after the 20th get none.'
    );
    await type(`What is the impact of ${names.slice(0, 20).join(', ')}?`);
    expect(
      host.querySelector('.jp-Epi-own-explore')?.textContent
    ).not.toContain('At most 20 branches');
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
