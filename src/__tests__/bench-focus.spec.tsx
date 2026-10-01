/**
 * The keyboard focus when the control it is on goes away: the control that
 * takes its place takes the focus, or the cell's card does (GuessPrompt,
 * NoteCard and closeStrip in src/ui/bench.tsx). Without that the focus
 * falls to the page body, and the next Tab starts from the top of
 * JupyterLab.
 */
import * as React from 'react';

import type { IStrip } from '../model/epimodel';
import { Bench } from '../ui/bench';
import { LinearView } from '../ui/linear';
import { benchModel } from './fakes/bench-fake';
import { button, focused, mount, settle, step } from './fakes/bench-render';

/** Editors that are text areas in the editor's host, as CodeMirror is. */
function textEditors() {
  return {
    factoryService: {
      newInlineEditor: ({ host }: { host: HTMLElement }) => {
        const area = document.createElement('textarea');
        host.appendChild(area);
        return {
          focus: () => area.focus(),
          hasFocus: () => document.activeElement === area,
          setOptions: () => undefined,
          undo: () => undefined,
          redo: () => undefined,
          dispose: () => area.remove()
        };
      }
    }
  } as any;
}

function strip(status: IStrip['status']): IStrip {
  return {
    cellId: 'a',
    question: {
      id: 'q',
      text: 'Does pain differ by arm?',
      type: 'association'
    } as any,
    guess: null,
    text: 'Does pain differ by arm?',
    action: 'Edit [4] in place',
    placement: { kind: 'edit', cell: 'a', label: 'edit [4] in place' },
    status,
    stage: 'thinking',
    elapsed: null,
    started: Date.now(),
    thinking: null,
    before: status === 'done' ? 'weekly = diary' : null,
    after: status === 'done' ? 'weekly = diary.groupby("arm")' : null,
    insertedId: null,
    error: null,
    showDiff: false
  };
}

function notebook() {
  return benchModel([
    {
      id: 'h',
      type: 'markdown',
      source: '## Notes\n\nPain drops after week 3.'
    },
    { id: 'a', source: 'weekly = diary', count: 4 },
    { id: 'b', source: 'fit = ols(weekly)', count: 5 }
  ]);
}

describe('The keyboard focus on the bench', () => {
  it('goes to the line that takes the place of the guess buttons', async () => {
    const { model } = notebook();
    model.strips.set('a', strip('writing'));
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await settle();
    const higher = button(view.host, 'Higher');
    higher.focus();
    await step(() => higher.click());
    await settle();
    const made = view.host.querySelector('.jp-Epi-guess.jp-mod-made');
    const where = focused();
    const onMade = !!made && document.activeElement === made;
    await view.unmount();
    model.dispose();
    expect(`${where}: ${onMade}`).toBe(
      'div.jp-Epi-guess.jp-mod-made "You guessed first: expected higher": true'
    );
  });

  it('goes to the Edit button after Escape in the editor of a text', async () => {
    const { model } = notebook();
    const view = await mount(
      <Bench
        model={model}
        editorServices={textEditors()}
        openFile={() => undefined}
      />
    );
    await settle();
    const edit = button(view.host, 'Edit');
    edit.focus();
    await step(() => edit.click());
    const area = view.host.querySelector('textarea')!;
    const typing = document.activeElement === area;
    await step(() => {
      area.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true
        })
      );
    });
    await settle();
    const closed = !view.host.querySelector('textarea');
    const active = document.activeElement;
    const where = active?.matches('.jp-Epi-note-edit')
      ? `the ${active.textContent} button of the text`
      : focused();
    await view.unmount();
    model.dispose();
    expect({ typing, closed, where }).toEqual({
      typing: true,
      closed: true,
      where: 'the Edit button of the text'
    });
  });

  it('goes to the card when the × of a finished strip closes it', async () => {
    const { model } = notebook();
    model.strips.set('a', strip('done'));
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await settle();
    const card = view.host.querySelector<HTMLElement>(
      '.jp-Epi-cell[data-cell-id="a"]'
    )!;
    const close = card.querySelector<HTMLElement>(
      '.jp-Epi-strip .jp-Epi-close'
    )!;
    close.focus();
    await step(() => close.click());
    await settle();
    const gone = !view.host.querySelector('.jp-Epi-strip');
    const onCard = document.activeElement === card;
    await view.unmount();
    model.dispose();
    expect({ gone, onCard }).toEqual({ gone: true, onCard: true });
  });

  it('goes to the card when Undo takes back an answer that nobody changed', async () => {
    // The answer added b after a; Undo deletes b at once, and the strip goes
    // with the Undo button that had the focus.
    const { model } = notebook();
    model.strips.set('a', {
      ...strip('done'),
      action: 'Added [5] after [4]',
      placement: { kind: 'new', cell: 'a', label: 'new cell after [4]' },
      before: null,
      after: 'fit = ols(weekly)',
      insertedId: 'b'
    });
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await settle();
    const card = view.host.querySelector<HTMLElement>(
      '.jp-Epi-cell[data-cell-id="a"]'
    )!;
    const undo = Array.from(
      card.querySelectorAll<HTMLElement>('.jp-Epi-strip button')
    ).find(item => item.textContent === 'Undo')!;
    undo.focus();
    await step(() => undo.click());
    await settle();
    const found = {
      gone: !view.host.querySelector('.jp-Epi-strip'),
      added: !!view.host.querySelector('[data-cell-id="b"]'),
      onCard: document.activeElement === card
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({ gone: true, added: false, onCard: true });
  });

  it('goes to the cell of the Code view when the × of its strip closes it', async () => {
    const { model } = notebook();
    model.strips.set('a', strip('done'));
    const view = await mount(
      <LinearView model={model} editorServices={null} />
    );
    await settle();
    const card = view.host.querySelector<HTMLElement>(
      '.jp-Epi-linear-cell[data-cell-id="a"]'
    )!;
    const close = card.querySelector<HTMLElement>(
      '.jp-Epi-strip .jp-Epi-close'
    )!;
    close.focus();
    await step(() => close.click());
    await settle();
    const gone = !view.host.querySelector('.jp-Epi-strip');
    const onCard = document.activeElement === card;
    await view.unmount();
    model.dispose();
    expect({ gone, onCard }).toEqual({ gone: true, onCard: true });
  });
});
