/**
 * The head of an agent's run: its tooltip has the whole question, which
 * wraps to two lines at most and is cut after the second, in the strip and
 * in the card. The run's state stays on one line beside it. In the sidebar
 * the whole question shows.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';

import type { IAgentRun } from '../model/agent';
import { AgentElsewhere, AgentPointer, AgentRunView } from '../ui/agent';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

const QUESTION =
  'Before anyone quit, how did quitters and continuers differ? Compare their age, sex, years of smoking and weight at baseline, and say which differences matter for the effect of quitting on weight gain.';

function runOf(): IAgentRun {
  return {
    id: 'r1',
    stripId: 'a',
    question: QUESTION,
    anchor: 'a',
    state: 'done',
    steps: [
      {
        call: 'c1',
        tool: 'run_cell',
        title: 'Baseline means of quitters and continuers',
        why: '',
        cells: ['b'],
        state: 'done',
        error: null
      }
    ],
    notes: [],
    thinking: null,
    answer: 'Quitters were older at baseline ([3]).',
    answerCells: ['[3]'],
    followUp: [],
    by: null,
    costUsd: 0.02,
    error: null,
    started: Date.now(),
    keepLocal: false
  };
}

/**
 * The value that the style sheets give a property of an element, the last
 * rule that matches winning: jsdom's computed style leaves out
 * -webkit-line-clamp and -webkit-box-orient.
 */
function declared(element: Element, property: string): string {
  let value = '';
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const selector = (rule as CSSStyleRule).selectorText;
      let matches = false;
      try {
        matches = !!selector && element.matches(selector);
      } catch {
        // A selector that jsdom does not read, such as a pseudo-element.
      }
      if (matches) {
        value =
          (rule as CSSStyleRule).style.getPropertyValue(property) || value;
      }
    }
  }
  return value;
}

function modelOf() {
  return benchModel([
    { id: 'a', source: 'nhefs = pd.read_csv("nhefs.csv")', count: 2 },
    {
      id: 'b',
      source: 'nhefs.groupby("qsmk")[["age", "smokeyrs"]].mean().round(1)',
      count: 3
    }
  ]).model;
}

describe('the question in the head of an agent’s run', () => {
  it('has the whole question in its tooltip, in the strip, the card, the sidebar and the one-line pointers', async () => {
    const model = modelOf();
    const run = runOf();
    for (const place of ['strip', 'card', 'sidebar'] as const) {
      const view = await mount(
        <AgentRunView model={model} run={run} place={place} />
      );
      const question = view.host.querySelector('.jp-Epi-agentrun-question')!;
      expect([place, question.textContent]).toEqual([place, QUESTION]);
      expect([place, question.getAttribute('title')]).toEqual([
        place,
        QUESTION
      ]);
      await view.unmount();
    }
    const pointers = await mount(
      <>
        <AgentPointer model={model} run={run} />
        <AgentElsewhere model={model} run={run} askedIn="Untitled.ipynb" />
      </>
    );
    const texts = Array.from(
      pointers.host.querySelectorAll('.jp-Epi-strip-text')
    ).map(text => text.getAttribute('title'));
    await pointers.unmount();
    expect(texts).toEqual([QUESTION, QUESTION]);
    model.dispose();
  });

  it('wraps to two lines and cuts after the second in the strip and the card, and shows it whole in the sidebar', async () => {
    // The view's style sheet: jsdom applies its rules, with no layout.
    const style = document.createElement('style');
    style.textContent = fs.readFileSync(
      path.join(__dirname, '..', '..', 'style', 'base.css'),
      'utf8'
    );
    document.head.appendChild(style);
    const model = modelOf();
    try {
      const drawn: Record<string, Record<string, string>> = {};
      for (const place of ['strip', 'card', 'sidebar'] as const) {
        const view = await mount(
          <AgentRunView model={model} run={runOf()} place={place} />
        );
        await settle();
        const element = view.host.querySelector('.jp-Epi-agentrun-question')!;
        const question = getComputedStyle(element);
        const status = getComputedStyle(
          view.host.querySelector('.jp-Epi-agentrun-status')!
        );
        drawn[place] = {
          display: question.display,
          lines: declared(element, '-webkit-line-clamp'),
          orient: declared(element, '-webkit-box-orient'),
          overflow: question.overflow,
          oneLine: String(question.whiteSpace === 'nowrap'),
          status: status.whiteSpace
        };
        await view.unmount();
      }
      const cut = {
        display: '-webkit-box',
        lines: '2',
        orient: 'vertical',
        overflow: 'hidden',
        oneLine: 'false',
        status: 'nowrap'
      };
      expect(drawn.strip).toEqual(cut);
      expect(drawn.card).toEqual(cut);
      expect(drawn.sidebar).toMatchObject({
        display: 'block',
        oneLine: 'false'
      });
    } finally {
      style.remove();
      model.dispose();
    }
  });
});
