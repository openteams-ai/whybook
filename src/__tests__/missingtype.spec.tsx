/**
 * A list that likely misses the type of question that the analyst wants
 * (design iteration 1.130, research/order-none.md). The server's type
 * predictor gives that chance and the type; at 0.7 or more the view marks the
 * list: the model of More questions is asked for a question of that type, the
 * first row of the list is held for it and asks whether the analyst looks for
 * one, and while the model writes, the template questions show lighter and
 * still run. The model's question takes the held row, so nothing moves.
 */
// The fake first: it quiets the warnings of JupyterLab's modules in jest.
import { fakeModel, settle, until } from './fakes/model-fake';

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { IDropAsk } from '../model/epimodel';
import { MISSING_CUT, missingType } from '../model/rulesfirst';
import type { IItem, IMissingType, IOption, StreamEvent } from '../tokens';
import { OptionRow } from '../ui/common';
import { lighter, MissingSlot, ModelLine } from '../ui/variables';

function option(id: string, extra: Partial<IOption> = {}): IOption {
  return {
    id,
    text: `Question ${id}`,
    type: 'association',
    origin: 'template',
    probability: 0.5,
    reasons: [],
    placement: null,
    ...extra
  };
}

/** The status of a server whose connected model answers, at a known price. */
const CONNECTED = {
  claude_available: true,
  claude: {
    available: true,
    provider: 'openrouter',
    reason: null,
    setup: null,
    priced: true
  },
  local_models: []
};

const AGE: IItem = { kind: 'variable', name: 'age', label: 'age' };
const PAIN: IItem = { kind: 'variable', name: 'pain', label: 'pain' };

/** The model's answer of the fakes: one descriptive question, first. */
const DESCRIPTIVE = {
  questions: [
    {
      ...option('m1', { text: 'How are age and pain spread?' }),
      type: 'descriptive' as const,
      origin: 'claude' as const
    }
  ],
  order: ['m1', 't1']
};

/**
 * A view whose drops the server answers with `options` and `missing`, and
 * whose model of More questions answers with `answer`. With `hold`, the
 * model answers when `release` is called.
 */
function dropModel(
  options: IOption[],
  missing: IMissingType | null,
  modelQuestions: 'always' | 'no-template' = 'always',
  answer: { questions: IOption[]; order: string[] } = DESCRIPTIVE,
  hold = false
) {
  const { model } = fakeModel([{ id: 'c1', source: 'age = [1, 2]' }]);
  model.status = CONNECTED;
  Object.assign(model.settings, {
    offeredQuestions: 12,
    showCost: false,
    modelQuestions
  });
  model._cellNeeds = async () => false;
  model._stopUnsupported = () => false;
  model._orderByModel = async () => undefined;
  model.variable = () => null;
  const calls: any[] = [];
  let release = () => {};
  const held = hold
    ? new Promise<void>(resolve => {
        release = resolve;
      })
    : Promise.resolve();
  model.api = {
    drop: async () => ({
      title: 'age + pain',
      note: null,
      mode: 'auto',
      options: options.map(item => ({ ...item })),
      placements: [{ kind: 'new', cell: null, label: 'a new cell at the end' }],
      preselected: [],
      missing
    }),
    claudeQuestions: async (
      body: unknown,
      onEvent: (event: StreamEvent) => void
    ) => {
      calls.push(body);
      await held;
      onEvent({
        type: 'result',
        elapsed: 0.5,
        model: 'fake-model',
        cost_usd: 0.001,
        questions: answer.questions.map(item => ({ ...item })),
        order: answer.order
      });
    }
  };
  return { model, calls, release: () => release() };
}

const drop = (model: any) =>
  model.askDrop(AGE, { item: PAIN }, { branch: false, parallel: false }, null);

/** The words of a rendered element, without its tags. */
const words = (element: JSX.Element) =>
  renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('a list that likely misses the type that the analyst wants', () => {
  it('is marked from a probability of 0.7', () => {
    expect(MISSING_CUT).toBe(0.7);
    const marked = (probability: number) =>
      missingType({ missing: { type: 'descriptive', probability } });
    expect(marked(0.69)).toBeNull();
    expect(marked(0.7)).toBe('descriptive');
    expect(missingType({ missing: null })).toBeNull();
    expect(missingType(null)).toBeNull();
  });

  it('asks the model for a question of the missing type, which goes first, also when the setting asks only where no template fits', async () => {
    const { model, calls } = dropModel(
      [option('t1', { code: 'print(age)' })],
      { type: 'descriptive', probability: 0.8 },
      'no-template'
    );
    await drop(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    const ask = model.ask as IDropAsk;
    expect(ask.missingType).toBe('descriptive');
    expect(calls).toHaveLength(1);
    expect(calls[0].missing_type).toBe('descriptive');
    expect(ask.result!.options.map(item => item.id)).toEqual(['m1', 't1']);
  });

  it('names no type below the cut, and then asks no model where a template fits and the setting asks only where none fits', async () => {
    const below = { type: 'descriptive' as const, probability: 0.6 };
    const { model, calls } = dropModel(
      [option('t1', { code: 'print(age)' })],
      below,
      'no-template'
    );
    await drop(model);
    await settle();
    expect((model.ask as IDropAsk).missingType).toBeNull();
    expect(calls).toHaveLength(0);
    // Asked always, the model gets the request with no type named.
    const always = dropModel([option('t1', { code: 'print(age)' })], below);
    await drop(always.model);
    await until(() => (always.model.ask as IDropAsk).fromModel === 'done');
    expect(always.calls[0].missing_type).toBeUndefined();
  });

  it('asks about the missing type while the model writes, when no model answers, and when the setting asks none, and goes once the model answered', () => {
    const ask: IDropAsk = {
      kind: 'drop',
      source: AGE,
      target: { item: PAIN },
      modifiers: { branch: false, parallel: false },
      result: {
        title: 'age + pain',
        note: null,
        mode: 'auto',
        options: [option('t1', { code: 'print(age)' })],
        placements: [],
        preselected: [],
        missing: { type: 'descriptive', probability: 0.8 }
      },
      checked: [],
      claudeStage: null,
      missingType: 'descriptive'
    } as unknown as IDropAsk;
    const line = (
      fromModel: IDropAsk['fromModel'],
      fromModelNote: string | null = null,
      ready = true
    ) =>
      words(
        <ModelLine ask={{ ...ask, fromModel, fromModelNote }} ready={ready} />
      );
    expect(line('asking')).toMatch(
      /^Looking for a Descriptive question\? An AI model is writing one\./
    );
    // Once the model answered, the line goes, as on any list.
    expect(line('done')).toBe('');
    expect(line('off', 'Connect a model in the AI models panel.')).toBe(
      'Looking for a Descriptive question? Connect a model in the AI models panel.'
    );
    expect(line('failed', 'the provider timed out.')).toBe(
      'Looking for a Descriptive question? The AI model could not suggest one: the provider timed out.'
    );
    // At never, the button More questions from AI asks for one.
    expect(line(null)).toBe(
      'Looking for a Descriptive question? More questions from AI can write one.'
    );
    expect(line(null, null, false)).toBe('Looking for a Descriptive question?');
    expect(
      words(
        <ModelLine
          ask={{ ...ask, missingType: 'association', fromModel: 'asking' }}
        />
      )
    ).toMatch(/^Looking for an Association question\?/);
    // A list that no template fits keeps its own words.
    expect(
      words(
        <ModelLine ask={{ ...ask, noTemplate: true, fromModel: 'asking' }} />
      )
    ).toMatch(
      /^Every template question here needs AI: an AI model writes more/
    );
  });

  it('shows the template questions of a marked list lighter while the model writes, and only then', () => {
    const template = { origin: 'template' as const };
    const marked = { missingType: 'descriptive' as const };
    expect(lighter({ ...marked, fromModel: 'asking' }, template)).toBe(true);
    expect(
      lighter({ ...marked, fromModel: 'asking' }, { origin: 'claude' })
    ).toBe(false);
    for (const fromModel of ['done', 'off', 'failed', null] as const) {
      expect(lighter({ ...marked, fromModel }, template)).toBe(false);
    }
    expect(lighter({ missingType: null, fromModel: 'asking' }, template)).toBe(
      false
    );
  });

  it('shows a template question with unlikely lighter, and still runs it', () => {
    let ran = 0;
    const html = renderToStaticMarkup(
      <OptionRow
        option={option('t1', { code: 'print(age)' })}
        placement={null}
        onApply={() => ran++}
        unlikely
      />
    );
    expect(html).toContain('jp-mod-unlikely');
    expect(html).not.toContain('jp-mod-disabled');
    expect(html).not.toContain('aria-disabled');
    expect(
      renderToStaticMarkup(
        <OptionRow
          option={option('t1')}
          placement={null}
          onApply={() => ran++}
        />
      )
    ).not.toContain('jp-mod-unlikely');
  });

  it("holds the first row for the model's question, which takes it at once", async () => {
    const { model, release } = dropModel(
      [option('t1', { code: 'print(age)' }), option('t2', { code: 'x' })],
      { type: 'descriptive', probability: 0.8 },
      'always',
      DESCRIPTIVE,
      true
    );
    await drop(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'asking');
    const ask = model.ask as IDropAsk;
    expect(ask.slot).toBe('waiting');
    // The row carries the words and the bar, and the line above is empty.
    expect(words(<MissingSlot ask={ask} />)).toMatch(
      /^Looking for a Descriptive question\? An AI model is writing one\./
    );
    expect(words(<ModelLine ask={ask} ready />)).toBe('');
    // The pointer is on the list: the model's question still takes the row.
    model.pointAtList(ask, true);
    release();
    await until(() => ask.fromModel === 'done');
    expect(ask.slot).toBeNull();
    expect(ask.result!.options.map(item => item.id)).toEqual([
      'm1',
      't1',
      't2'
    ]);
  });

  it('says that the model wrote none until the pointer leaves the list, then lets the row go', async () => {
    const association = {
      questions: [
        {
          ...option('m2', { text: 'Is age associated with pain here?' }),
          origin: 'claude' as const
        }
      ],
      order: ['m2', 't1']
    };
    const { model, release } = dropModel(
      [option('t1', { code: 'print(age)' })],
      { type: 'descriptive', probability: 0.8 },
      'always',
      association,
      true
    );
    await drop(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'asking');
    const ask = model.ask as IDropAsk;
    model.pointAtList(ask, true);
    release();
    await until(() => ask.fromModel === 'done');
    expect(ask.slot).toBe('empty');
    expect(words(<MissingSlot ask={ask} />)).toBe(
      'The AI model wrote no Descriptive question.'
    );
    // The model's question waits at the end while the pointer is on the list.
    expect(ask.result!.options.map(item => item.id)).toEqual(['t1', 'm2']);
    model.pointAtList(ask, false);
    expect(ask.slot).toBeNull();
    expect(ask.result!.options.map(item => item.id)).toEqual(['m2', 't1']);
    expect(words(<MissingSlot ask={ask} />)).toBe('');
  });

  it('holds no row on a list that is not marked', async () => {
    const { model } = dropModel([option('t1', { code: 'print(age)' })], {
      type: 'descriptive',
      probability: 0.6
    });
    await drop(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    expect((model.ask as IDropAsk).slot ?? null).toBeNull();
    await settle();
  });
});
