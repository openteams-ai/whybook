/**
 * Rules first, and a model when the rules cannot tell (src/model/rulesfirst.ts):
 * the values of a constant whose kind no rule knows, and the questions of a
 * drop that no template fits, both from the model chosen for More questions.
 */
import type { IDecisionAsk, IDropAsk } from '../model/epimodel';
import {
  markModelValues,
  noModelNote,
  noTemplateFits,
  requestKey,
  triesValues,
  valuesCaption,
  valuesWhy
} from '../model/rulesfirst';
import type { IDecision, IItem, IOption, StreamEvent } from '../tokens';
import { fakeModel, settle, until } from './fakes/model-fake';

function option(id: string, extra: Partial<IOption> = {}): IOption {
  return {
    id,
    text: `Question ${id}`,
    type: 'descriptive',
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

/** The status of a server without a model: the reason and the way to set one up. */
const UNCONNECTED = {
  claude_available: false,
  claude: {
    available: false,
    provider: 'none',
    reason: 'no model is connected',
    setup: 'Connect a model in the AI models panel.',
    priced: false
  },
  local_models: []
};

describe('the words of rules first', () => {
  it('says what kind of value the rules read, in a short phrase, and nothing about a rule that no one knows', () => {
    expect(
      valuesCaption({
        by: 'rules',
        kind: 'a count of days',
        rule: 'common lengths of time',
        why: null
      })
    ).toBe('A count of days: common lengths of time.');
    // A rule that gave no kind says nothing.
    expect(
      valuesCaption({ by: 'rules', kind: null, rule: null, why: null })
    ).toBe('');
    // After a model answered, its AI tag on each value says it: no sentence.
    expect(
      valuesCaption({
        by: 'model',
        kind: 'a base temperature in °C',
        rule: null,
        why: null
      })
    ).toBe('');
    // While a model works, one word and the bar of the view.
    expect(
      valuesCaption({
        by: 'asking',
        kind: null,
        rule: 'half and double its value',
        why: null
      })
    ).toBe('Analysing…');
    const why = noModelNote('values', 'no model is connected', false);
    const fallback = (rule: string | null) =>
      valuesCaption({ by: 'fallback', kind: null, rule, why });
    expect(fallback('half and double its value')).toBe(
      'Half and double the value: no AI model answers.'
    );
    expect(fallback('half its value below and above it')).toBe(
      'Half the value below and above it: no AI model answers.'
    );
    expect(fallback(null)).toBe('No AI model answers.');
    // The reason that no model answers is the tooltip of the line.
    expect(valuesWhy({ by: 'fallback', kind: null, rule: null, why })).toBe(
      'A model would suggest values that fit it, and none answers: no model is connected.'
    );
    expect(
      valuesWhy({ by: 'rules', kind: 'a count', rule: 'a rule', why: null })
    ).toBeUndefined();
  });

  it('marks the values of a model with its kind for the tooltip of their AI tag', () => {
    const by = { choice: 'remote', model: 'fake', at: '2026-10-01T09:00:00Z' };
    const marked = markModelValues(
      [
        option('a', { template: 'what_if_value' }),
        option('b', { template: 'what_if_choice' })
      ],
      { kind: 'a base temperature', values: [], by, origin: 'claude' }
    );
    expect(marked.map(item => [item.origin, item.kind])).toEqual([
      ['claude', 'a base temperature'],
      ['template', undefined]
    ]);
    // No kind from the model: no kind on the option.
    expect(
      markModelValues([option('a', { template: 'what_if_value' })], {
        kind: '',
        values: [],
        by,
        origin: 'claude'
      })[0].kind
    ).toBeUndefined();
  });

  it('says why no model suggests questions: none answers, or the cap', () => {
    expect(noModelNote('questions', 'no model is connected', true)).toBe(
      'A model would suggest questions, and none answers: no model is connected.'
    );
    expect(noModelNote('questions', null, true)).toBe(
      "A model would suggest questions, and the notebook's AI answers reached its cap."
    );
    expect(noModelNote('questions', null, false)).toBeNull();
  });

  it('finds that no template fits when no question runs without AI', () => {
    expect(noTemplateFits([])).toBe(true);
    expect(noTemplateFits([option('a'), option('b')])).toBe(true);
    expect(noTemplateFits([option('a'), option('b', { code: 'x = 1' })])).toBe(
      false
    );
    expect(
      noTemplateFits([option('a', { action: { kind: 'assumption' } })])
    ).toBe(false);
  });

  it("marks the options that try a model's values, and only those", () => {
    const by = { choice: 'remote', model: 'fake-model', at: 'now' };
    const marked = markModelValues(
      [
        option('v', { template: 'what_if_value' }),
        option('s', { template: 'what_if_sweep' }),
        option('c', { template: 'what_if_choice' })
      ],
      { kind: 'a temperature', values: [], by, origin: 'claude' }
    );
    expect(marked.map(item => [item.origin, item.by?.model ?? null])).toEqual([
      ['claude', 'fake-model'],
      ['claude', 'fake-model'],
      ['template', null]
    ]);
    expect(marked.map(triesValues)).toEqual([true, true, false]);
  });

  it('keys a request by what was dropped and onto what, a cell with its code', () => {
    const cell = { id: 'c1', source: 'x = 1' };
    expect(requestKey('items', { item: 'names' })).toBe(
      requestKey('items', { item: 'names' })
    );
    expect(requestKey('items', { cell })).not.toBe(
      requestKey('items', { cell: { ...cell, source: 'x = 2' } })
    );
  });
});

const BASE: IDecision = {
  name: 'BASE_TEMP_C',
  value: '15.5',
  provenance: 'defaulted',
  param: 'base',
  function: 'add_degree_days',
  source: { file: 'energy.py', line: 12 }
};

/** The options of the chip: the fallback's half and double, or the model's values. */
function valueOptions(values: string[], template = 'what_if_value'): IOption[] {
  return values.map(value =>
    option(`v${value}`, {
      text: `What if BASE_TEMP_C were ${value}?`,
      type: 'model',
      template,
      code: `daily_if = add_degree_days(daily, base=${value})`
    })
  );
}

/**
 * A view over one cell whose constant no rule knows. The server answers the
 * chip with the fallback's values and ask_model, or with the options of the
 * values sent back; the model suggests 12.0 and 18.0.
 */
function chipModel(status: unknown = CONNECTED) {
  const { model } = fakeModel([
    { id: 'c3', source: 'daily = add_degree_days(daily)\ndaily.head()' }
  ]);
  model.status = status;
  model.settings.showCost = false;
  model._cellNeeds = async () => false;
  model._stopUnsupported = () => false;
  const calls = { options: [] as any[], values: [] as any[] };
  model.api = {
    decisionOptions: async (body: any) => {
      calls.options.push(body);
      if (body.suggested) {
        return {
          title: 'BASE_TEMP_C = 15.5',
          note: 'defaulted in energy.py:12',
          options: valueOptions(body.suggested.map((item: any) => item.value))
        };
      }
      return {
        title: 'BASE_TEMP_C = 15.5',
        note: 'defaulted in energy.py:12',
        options: valueOptions(['7.75', '31.0']),
        kind: null,
        rule: 'half and double its value',
        ask_model: true
      };
    },
    decisionValues: async (
      body: any,
      onEvent: (event: StreamEvent) => void
    ) => {
      calls.values.push(body);
      onEvent({ type: 'progress', stage: 'thinking', elapsed: 0.1 });
      onEvent({
        type: 'result',
        elapsed: 0.4,
        model: 'fake-model',
        cost_usd: 0.0004,
        kind: 'a base temperature in °C',
        values: [
          { value: '12.0', why: 'the UK convention' },
          { value: '18.0', why: 'the US convention' }
        ]
      });
    }
  };
  return { model, calls };
}

describe('the values of a constant that no rule knows', () => {
  it('asks the model of More questions once, and offers its values with the AI tag', async () => {
    const { model, calls } = chipModel();
    await model.askDecision('c3', BASE, null);
    await until(() => (model.ask as IDecisionAsk).values?.by === 'model');
    const ask = model.ask as IDecisionAsk;
    expect(calls.values).toHaveLength(1);
    // The default of More questions: the fast model of the connected provider.
    expect(calls.values[0]).toMatchObject({
      decision: BASE,
      model: 'remote:fast'
    });
    // The server writes the branches of the model's values.
    expect(calls.options[1].suggested).toEqual([
      { value: '12.0', why: 'the UK convention' },
      { value: '18.0', why: 'the US convention' }
    ]);
    expect(ask.options.map(item => item.text)).toEqual([
      'What if BASE_TEMP_C were 12.0?',
      'What if BASE_TEMP_C were 18.0?'
    ]);
    expect(ask.options.every(item => item.origin === 'claude')).toBe(true);
    expect(ask.options[0].by?.model).toBe('fake-model');
    expect(ask.values?.kind).toBe('a base temperature in °C');
    // Another click on the chip shows the same values, and asks no model.
    await model.askDecision('c3', BASE, null);
    await settle();
    expect(calls.values).toHaveLength(1);
    expect((model.ask as IDecisionAsk).values?.by).toBe('model');
  });

  it('waits for the model with its bar, and hides the half and double meanwhile', async () => {
    const { model, calls } = chipModel();
    let answer: (() => void) | null = null;
    model.api.decisionValues = (
      body: unknown,
      onEvent: (event: StreamEvent) => void
    ) => {
      calls.values.push(body);
      onEvent({ type: 'progress', stage: 'thinking', elapsed: 0.1 });
      return new Promise<void>(resolve => {
        answer = () => {
          onEvent({ type: 'error', message: 'The model timed out.' });
          resolve();
        };
      });
    };
    await model.askDecision('c3', BASE, null);
    await settle();
    const ask = model.ask as IDecisionAsk;
    expect(ask.values?.by).toBe('asking');
    expect(ask.values?.stage).toBe('thinking');
    // The fallback's values are there, for the view to hide them while it waits.
    expect(ask.options.every(triesValues)).toBe(true);
    // The model fails: the half and double stay, and the line says why.
    answer!();
    await until(() => ask.values?.by === 'fallback');
    expect(ask.values?.why).toBe(
      'The AI model could not suggest values: The model timed out.'
    );
    expect(ask.options.map(item => item.text)).toEqual([
      'What if BASE_TEMP_C were 7.75?',
      'What if BASE_TEMP_C were 31.0?'
    ]);
  });

  it('keeps the half and double without a model, and says that a model would suggest values', async () => {
    const { model, calls } = chipModel(UNCONNECTED);
    await model.askDecision('c3', BASE, null);
    await settle();
    const ask = model.ask as IDecisionAsk;
    expect(calls.values).toHaveLength(0);
    expect(ask.values).toEqual({
      by: 'fallback',
      kind: null,
      rule: 'half and double its value',
      why: 'A model would suggest values that fit it, and none answers: no model is connected.',
      stage: null
    });
  });

  it("asks no model at the notebook's cap", async () => {
    const { model, calls } = chipModel();
    model.settings.showCost = true;
    model.costCap = () => 0.01;
    model.cost = () => ({ usd: 0.02, priced: 1, unpriced: 0 });
    await model.askDecision('c3', BASE, null);
    await settle();
    expect(calls.values).toHaveLength(0);
    expect((model.ask as IDecisionAsk).values?.why).toBe(
      "A model would suggest values that fit it, and the notebook's AI answers reached its cap."
    );
  });

  it('asks no model when the rules know the kind', async () => {
    const { model, calls } = chipModel();
    model.api.decisionOptions = async () => ({
      title: 'MIN_DAYS = 14',
      note: 'defaulted in prep.py:31',
      options: [],
      kind: 'a count of days',
      rule: 'common lengths of time',
      ask_model: false
    });
    await model.askDecision('c3', { ...BASE, name: 'MIN_DAYS' }, null);
    await settle();
    expect(calls.values).toHaveLength(0);
    expect((model.ask as IDecisionAsk).values).toEqual({
      by: 'rules',
      kind: 'a count of days',
      rule: 'common lengths of time',
      why: null
    });
  });
});

const ITEMS: IItem = { kind: 'variable', name: 'items', label: 'items' };
const NAMES: IItem = { kind: 'variable', name: 'names', label: 'names' };

/**
 * A view whose drops the server answers with `options`, and whose model of
 * More questions writes two questions.
 */
function dropModel(options: IOption[], status: unknown = CONNECTED) {
  const { model } = fakeModel([{ id: 'c1', source: 'items = {"a": 1}' }]);
  model.status = status;
  Object.assign(model.settings, {
    offeredQuestions: 12,
    showCost: false,
    modelQuestions: 'always'
  });
  model._cellNeeds = async () => false;
  model._stopUnsupported = () => false;
  model._orderByModel = async () => undefined;
  model.variable = () => null;
  const calls: any[] = [];
  const answered: string[] = [];
  model.apply = async (picked: IOption) => {
    answered.push(picked.id);
  };
  model.api = {
    // As the server: a drop onto a cell has no places of its own.
    drop: async (body: any) => ({
      title: 'items + names',
      note: null,
      mode: 'auto',
      options: options.map(item => ({ ...item })),
      placements: body.target.cell
        ? []
        : [{ kind: 'new', cell: null, label: 'a new cell at the end' }],
      preselected: []
    }),
    claudeQuestions: async (
      body: unknown,
      onEvent: (event: StreamEvent) => void
    ) => {
      calls.push(body);
      onEvent({ type: 'progress', stage: 'thinking', elapsed: 0.1 });
      onEvent({
        type: 'result',
        elapsed: 0.5,
        model: 'fake-model',
        cost_usd: 0.001,
        questions: [
          option('m1', { text: 'Which keys of items are in names?' }),
          option('m2', { text: 'Does names list every key once?' })
        ].map(item => ({ ...item, origin: 'claude' }))
      });
    }
  };
  return { model, calls, answered };
}

const drop = (model: any, target: { item?: IItem; cellId?: string }) =>
  model.askDrop(ITEMS, target, { branch: false, parallel: false }, null);

describe('the questions of a drop that no template fits', () => {
  it('asks the model at once, adds its questions, and runs none', async () => {
    const { model, calls, answered } = dropModel([]);
    await drop(model, { item: NAMES });
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    const ask = model.ask as IDropAsk;
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('remote:fast');
    expect(ask.result!.options.map(item => item.text)).toEqual([
      'Which keys of items are in names?',
      'Does names list every key once?'
    ]);
    expect(ask.result!.options[0].by?.model).toBe('fake-model');
    expect(ask.claudeStage).toBeNull();
    // Nothing ran by itself.
    expect(answered).toEqual([]);
    expect(model.strips.size).toBe(0);
  });

  it('asks once for a request: the same drop again shows the questions it wrote', async () => {
    const { model, calls } = dropModel([]);
    await drop(model, { item: NAMES });
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    await drop(model, { item: NAMES });
    await settle();
    expect(calls).toHaveLength(1);
    const ask = model.ask as IDropAsk;
    expect(ask.fromModel).toBe('done');
    expect(ask.result!.options).toHaveLength(2);
  });

  it('asks, only when no template fits, when every template question needs AI, and not when one runs', async () => {
    const needsAI = [option('t1'), option('t2')];
    const first = dropModel(needsAI);
    first.model.settings.modelQuestions = 'no-template';
    await drop(first.model, { item: NAMES });
    await until(() => (first.model.ask as IDropAsk).fromModel === 'done');
    expect(first.calls).toHaveLength(1);
    expect(
      (first.model.ask as IDropAsk).result!.options.map(item => item.id)
    ).toEqual(['t1', 't2', 'm1', 'm2']);
    const second = dropModel([option('t1'), option('t2', { code: 'x' })]);
    second.model.settings.modelQuestions = 'no-template';
    await drop(second.model, { item: NAMES });
    await settle();
    expect(second.calls).toHaveLength(0);
    expect((second.model.ask as IDropAsk).fromModel).toBeUndefined();
  });

  it('asks about a drop onto a cell with the cell, and puts the questions after it', async () => {
    const { model, calls } = dropModel([]);
    await drop(model, { cellId: 'c1' });
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    expect(calls[0].cell).toEqual({
      id: 'c1',
      label: model.cell('c1').label,
      source: 'items = {"a": 1}'
    });
    expect(calls[0].selection.target).toBeUndefined();
    expect((model.ask as IDropAsk).result!.options[0].placement).toEqual({
      kind: 'new',
      cell: 'c1',
      label: `new cell after ${model.cell('c1').label}`
    });
  });

  it('says that a model would suggest questions when none answers, and asks none', async () => {
    const { model, calls } = dropModel([], UNCONNECTED);
    await drop(model, { item: NAMES });
    await settle();
    const ask = model.ask as IDropAsk;
    expect(calls).toHaveLength(0);
    expect(ask.fromModel).toBe('off');
    expect(ask.fromModelNote).toBe(
      'A model would suggest questions, and none answers: no model is connected.'
    );
  });

  it("asks none at the notebook's cap, with the setting off, or in a checklist of branches", async () => {
    const capped = dropModel([]);
    capped.model.settings.showCost = true;
    capped.model.costCap = () => 0.01;
    capped.model.cost = () => ({ usd: 0.02, priced: 1, unpriced: 0 });
    await drop(capped.model, { item: NAMES });
    await settle();
    expect(capped.calls).toHaveLength(0);
    expect((capped.model.ask as IDropAsk).fromModelNote).toBe(
      "A model would suggest questions, and the notebook's AI answers reached its cap."
    );
    const off = dropModel([]);
    off.model.settings.modelQuestions = 'never';
    await drop(off.model, { item: NAMES });
    await settle();
    expect(off.calls).toHaveLength(0);
    expect((off.model.ask as IDropAsk).fromModel).toBeUndefined();
    const parallel = dropModel([]);
    parallel.model.api.drop = async () => ({
      title: 'items + names',
      note: null,
      mode: 'parallel',
      options: [],
      placements: [],
      preselected: []
    });
    await drop(parallel.model, { item: NAMES });
    await settle();
    expect(parallel.calls).toHaveLength(0);
  });

  it('keeps the questions of the templates when the model fails, and says why', async () => {
    const { model, calls } = dropModel([option('t1')]);
    model.api.claudeQuestions = async (
      body: unknown,
      onEvent: (event: StreamEvent) => void
    ) => {
      calls.push(body);
      onEvent({ type: 'error', message: 'The model timed out.' });
    };
    await drop(model, { item: NAMES });
    await until(() => (model.ask as IDropAsk).fromModel === 'failed');
    const ask = model.ask as IDropAsk;
    expect(ask.error).toBeNull();
    expect(ask.result!.options.map(item => item.id)).toEqual(['t1']);
    expect(ask.fromModelNote).toBe('The model timed out.');
    // The same request again waits for the button: it does not ask again.
    await drop(model, { item: NAMES });
    await settle();
    expect(calls).toHaveLength(1);
  });
});
