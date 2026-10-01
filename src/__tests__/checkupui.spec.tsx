/**
 * The Check-up section at the end of the Exploration panel (design
 * iterations 1.68, D, and 1.70): one folded line with no note before the
 * first check-up, the icon of the Check-up beside the name, the groups once
 * it opens, the outline when a notebook's tab opens it, the reviewer's
 * question with Ask, and the place kept for the question in another
 * language. The Exploration panel draws the blocks that a plugin registers,
 * and none without one.
 */
import './fakes/quiet';

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';

import { checkupIcon } from '../icons';
import { checkupMeta, checkupOf } from '../model/checkup';
import { storedAnalysis } from '../model/restore';
import { CheckupSection } from '../ui/checkup';
import { ExplorationPanel } from '../ui/exploration';
import { viewExtensions } from '../ui/extensions';
import { benchModel } from './fakes/bench-fake';
import { button, mount, settle, step } from './fakes/bench-render';

/** A notebook whose first cell makes a frame that no later cell uses. */
function notebook(): any {
  const source = 'olink = load_olink()';
  return {
    cells: [
      {
        cell_type: 'code',
        id: 'load',
        source,
        metadata: {
          whybook: {
            title: 'Load the panel',
            analysis: storedAnalysis(
              {
                defs: ['olink'],
                uses: [],
                formulas: [],
                columns: {},
                decisions: [],
                attachments: []
              },
              source
            )
          }
        },
        execution_count: 2,
        outputs: []
      }
    ],
    metadata: {
      whybook: {
        variables: [
          { name: 'olink', label: 'olink', kind: 'dataframe', cell: 'load' }
        ]
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

describe('The Check-up section', () => {
  it('is one folded line with no note before the first check-up, and opens on a click', async () => {
    const { model, nb } = benchModel(notebook());
    const shown: string[] = [];
    model.cellShown.connect((_, id) => shown.push(id));
    const view = await mount(<CheckupSection model={model} />);
    const head = view.host.querySelector('.jp-Epi-checkup-head')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toBe('Check-up');
    expect(view.host.querySelector('.jp-Epi-checkup-body')).toBeNull();
    await step(() => (head as HTMLButtonElement).click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const groups = Array.from(
      view.host.querySelectorAll('.jp-Epi-checkup-name')
    ).map(node => node.textContent);
    expect(groups).toEqual(['Reproduce', 'Speed', 'Review', 'Gaps']);
    expect(view.host.textContent).toContain(
      'olink is made in [2], and no later cell uses it.'
    );
    expect(view.host.textContent).toContain(
      'No run times yet. The view times a cell only while "Questions about the notebook" is on and the notebook is open in it. Run the cells again to time them.'
    );
    // The day of the check-up, kept in the notebook, is the note now.
    expect(checkupMeta(nb).last).toBeTruthy();
    expect(
      view.host.querySelector('.jp-Epi-checkup-head .jp-Epi-section-count')
        ?.textContent
    ).toMatch(/^last on \d+ [A-Z][a-z]{2}$/);
    // A line about a cell shows the cell.
    const line = Array.from(
      view.host.querySelectorAll('button.jp-Epi-checkup-line')
    ).find(node => node.textContent?.startsWith('olink'))!;
    await step(() => (line as HTMLButtonElement).click());
    expect(shown).toEqual(['load']);
    await view.unmount();
    checkupOf(model).dispose();
  });

  it('keeps the name at the start of the folded line before the first check-up, when no note follows it', async () => {
    // The view's own style sheets: jsdom applies their rules, with no layout.
    const style = document.createElement('style');
    style.textContent = ['base.css', 'checkup.css']
      .map(file =>
        fs.readFileSync(path.join(__dirname, '..', '..', 'style', file), 'utf8')
      )
      .join('\n');
    document.head.appendChild(style);
    try {
      const { model } = benchModel(notebook());
      const view = await mount(<CheckupSection model={model} />);
      const head = view.host.querySelector('.jp-Epi-checkup-head')!;
      expect(head.querySelector('.jp-Epi-section-count')).toBeNull();
      const name = Array.from(head.querySelectorAll('span')).find(
        node => node.textContent === 'Check-up' && !node.children.length
      )!;
      // The rule of block heads that moves a count to the end of the line,
      // in lower case, took the name while it was the head's last child.
      expect(getComputedStyle(name).marginLeft).not.toBe('auto');
      expect(getComputedStyle(name).textTransform).not.toBe('none');
      await view.unmount();
      checkupOf(model).dispose();
    } finally {
      style.remove();
    }
  });

  it('shows the icon of the Check-up between the caret and the name, the icon that a notebook tab turns into', async () => {
    const { model } = benchModel(notebook());
    const view = await mount(<CheckupSection model={model} />);
    const title = view.host.querySelector('.jp-Epi-checkup-title')!;
    const parts = Array.from(title.children);
    expect(parts.map(part => part.className)).toEqual([
      'jp-Epi-checkup-caret',
      'jp-Epi-checkup-icon',
      ''
    ]);
    expect(
      parts[1].querySelector(`[data-icon="${checkupIcon.name}"]`)
    ).not.toBeNull();
    expect(parts[2].textContent).toBe('Check-up');
    await view.unmount();
    checkupOf(model).dispose();
  });

  it('comes into sight and is outlined for a moment when it is opened from elsewhere, and not when the analyst opens it from its head', async () => {
    // jsdom has no scrolling: the calls are recorded instead.
    const scrolled: ScrollIntoViewOptions[] = [];
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (
      options?: boolean | ScrollIntoViewOptions
    ) {
      scrolled.push(options as ScrollIntoViewOptions);
    };
    try {
      const { model } = benchModel(notebook());
      const checkup = checkupOf(model);
      const view = await mount(<CheckupSection model={model} />);
      const section = view.host.querySelector('.jp-Epi-checkup')!;
      const head = view.host.querySelector(
        '.jp-Epi-checkup-head'
      ) as HTMLButtonElement;
      // The analyst's own click: the eye is on the section already.
      await step(() => head.click());
      expect(head.getAttribute('aria-expanded')).toBe('true');
      expect(section.classList.contains('jp-mod-flash')).toBe(false);
      expect(scrolled).toEqual([]);
      await step(() => head.click());
      // The icon on a notebook's tab opens it this way.
      await step(() => checkup.open(true));
      expect(head.getAttribute('aria-expanded')).toBe('true');
      expect(scrolled).toEqual([{ block: 'start', behavior: 'smooth' }]);
      expect(section.classList.contains('jp-mod-flash')).toBe(true);
      // The outline ends with its animation, and a second request outlines
      // the open section again.
      section.dispatchEvent(
        Object.assign(new Event('animationend'), {
          animationName: 'jp-epi-flash'
        })
      );
      expect(section.classList.contains('jp-mod-flash')).toBe(false);
      await step(() => checkup.open(true));
      expect(scrolled).toHaveLength(2);
      expect(section.classList.contains('jp-mod-flash')).toBe(true);
      // A draw for another reason does not outline it again.
      section.classList.remove('jp-mod-flash');
      await step(() => checkup.exported());
      expect(section.classList.contains('jp-mod-flash')).toBe(false);
      expect(scrolled).toHaveLength(2);
      await view.unmount();
      checkup.dispose();
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
    }
  });

  it('keeps the note about a kernel that the view cannot read out of Reproduce, whose questions work in any language', async () => {
    const { model } = benchModel(notebook());
    const note =
      'The columns each cell uses are read in a Python kernel. This kernel runs SAS.';
    model.unsupported = (feature: string) =>
      feature === 'analysis' ? note : null;
    const view = await mount(<CheckupSection model={model} />);
    const head = view.host.querySelector('.jp-Epi-checkup-head')!;
    await step(() => (head as HTMLButtonElement).click());
    const groups = Array.from(
      view.host.querySelectorAll('.jp-Epi-checkup-group')
    );
    const text = (label: string) =>
      groups.find(
        group =>
          group.querySelector('.jp-Epi-checkup-name')?.textContent === label
      )?.textContent ?? '';
    expect(text('Reproduce')).not.toContain(note);
    expect(text('Review')).toContain(note);
    await view.unmount();
    checkupOf(model).dispose();
  });

  it("offers the reviewer's question with Ask, greyed with the reason while no model answers, and the question in another language as not built yet", async () => {
    const { model } = benchModel(notebook());
    checkupOf(model).open();
    const view = await mount(<CheckupSection model={model} />);
    const cards = Array.from(
      view.host.querySelectorAll('.jp-Epi-checkup-question')
    );
    expect(
      cards.map(card => card.querySelector('.jp-Epi-next-text')?.textContent)
    ).toEqual([
      'Would I get the same results in another language?',
      'What would a reviewer ask?'
    ]);
    const other = cards[0].querySelector('button')!;
    expect(other.disabled).toBe(true);
    expect(cards[0].textContent).toContain('Not built yet.');
    const ask = button(cards[1], 'Ask');
    expect(ask.disabled).toBe(true);
    expect(cards[1].textContent).toContain(
      'A model would ask as a reviewer, and none answers: the server did not answer.'
    );
    expect(cards[1].textContent).toContain('needs AI · one call');
    await view.unmount();
    checkupOf(model).dispose();
  });

  it("shows the reviewer's questions under its card, each with the cell it is about and Ask, which asks it as the view's questions are asked", async () => {
    const { model } = benchModel(notebook());
    // The status request of the fake server fails first: the status that
    // the test gives takes its place.
    await settle();
    (model as any).status = {
      claude_available: true,
      claude: { available: true, reason: null, setup: null, priced: true },
      local_models: []
    };
    const checkup = checkupOf(model);
    (model.api as any).reviewQuestions = async (
      _body: unknown,
      onEvent: (event: any) => void
    ) =>
      onEvent({
        type: 'result',
        elapsed: 1,
        model: 'fake-model',
        questions: [
          {
            id: 'review:1',
            text: 'Is the protein panel needed?',
            type: 'descriptive',
            cell: '[2]',
            why: 'No cell reads it.'
          }
        ]
      });
    const asked: string[] = [];
    model.apply = async option => {
      asked.push(`${option.text} → ${option.placement?.label}`);
    };
    checkup.open();
    const view = await mount(<CheckupSection model={model} />);
    const card = Array.from(
      view.host.querySelectorAll('.jp-Epi-checkup-question')
    ).find(node => node.textContent?.includes('What would a reviewer ask?'))!;
    await step(() => button(card, 'Ask').click());
    await settle();
    const row = card.querySelector('.jp-Epi-checkup-asked')!;
    expect(row.querySelector('.jp-Epi-checkup-asked-text')?.textContent).toBe(
      'Is the protein panel needed? AI'
    );
    expect(row.querySelector('.jp-Epi-next-why')?.textContent).toBe(
      'About [2]. No cell reads it.'
    );
    expect(button(card, 'Ask again').disabled).toBe(false);
    await step(() => button(row, 'Ask').click());
    expect(asked).toEqual([
      'Is the protein panel needed? → new cell after [2]'
    ]);
    await view.unmount();
    checkup.dispose();
  });
});

describe('The places of the Exploration panel that a plugin adds to', () => {
  it('draws the blocks that a plugin registered, after its own, and none without one', async () => {
    const { model } = benchModel(notebook());
    const view = await mount(<ExplorationPanel model={model} />);
    expect(view.host.querySelector('.jp-Epi-test-block')).toBeNull();
    viewExtensions.exploration.set('test', () => (
      <div className="jp-Epi-test-block">added</div>
    ));
    try {
      await view.render(<ExplorationPanel model={model} />);
      const panel = view.host.querySelector('.jp-Epi-exploration')!;
      expect(panel.lastElementChild?.className).toBe('jp-Epi-test-block');
    } finally {
      viewExtensions.exploration.delete('test');
    }
    await view.unmount();
  });
});
