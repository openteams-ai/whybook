/**
 * The first drops of a new notebook (design iterations 1.64 and 1.65): a drop
 * or a click asks the model of More questions in the background, next to the
 * templates, and the same call names the outcomes and the units of the
 * analysis, which the notebook keeps as inferred (src/model/inferred.ts).
 */
// The fake first: it quiets the warnings of JupyterLab's modules in jest.
import { fakeModel, settle, until } from './fakes/model-fake';

import type { IDropAsk } from '../model/epimodel';
import type { IItem, IOption, IVariable, StreamEvent } from '../tokens';

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

const READINGS: IItem = {
  kind: 'variable',
  name: 'meter_readings',
  label: 'meter_readings'
};
const HOMES: IItem = { kind: 'variable', name: 'homes', label: 'homes' };

/** Three frames of a new notebook: one row per home, per home and day, and per region and day. */
const FRAMES: IVariable[] = [
  {
    name: 'homes',
    label: 'homes',
    kind: 'dataframe',
    rows: 360,
    columns: [
      {
        name: 'homes["home_id"]',
        label: 'home_id',
        parent: 'homes',
        kind: 'id',
        tag: 'id',
        unique: 360
      },
      {
        name: 'homes["floor_area_m2"]',
        label: 'floor_area_m2',
        parent: 'homes',
        kind: 'numeric',
        tag: 'int',
        unique: 117
      }
    ]
  },
  {
    name: 'meter_readings',
    label: 'meter_readings',
    kind: 'dataframe',
    rows: 129058,
    columns: [
      {
        name: 'r["home_id"]',
        label: 'home_id',
        parent: 'meter_readings',
        kind: 'id',
        tag: 'id',
        unique: 360
      },
      {
        name: 'r["kwh_import"]',
        label: 'kwh_import',
        parent: 'meter_readings',
        kind: 'numeric',
        tag: 'num',
        unique: 38386
      },
      {
        name: 'r["kwh_peak"]',
        label: 'kwh_peak',
        parent: 'meter_readings',
        kind: 'numeric',
        tag: 'num',
        unique: 20000
      }
    ]
  },
  {
    name: 'weather',
    label: 'weather',
    kind: 'dataframe',
    rows: 1460,
    columns: [
      {
        name: 'w["region"]',
        label: 'region',
        parent: 'weather',
        kind: 'categorical',
        tag: 'cat',
        unique: 4
      },
      {
        name: 'w["mean_temp_c"]',
        label: 'mean_temp_c',
        parent: 'weather',
        kind: 'numeric',
        tag: 'num',
        unique: 300
      }
    ]
  }
];

/** What the model of More questions answers: two questions, an outcome and a unit, and the order of the list. */
function answer(order: string[] | null): StreamEvent[] {
  return [
    { type: 'progress', stage: 'thinking', elapsed: 0.1 },
    {
      type: 'result',
      elapsed: 0.5,
      model: 'fake-model',
      cost_usd: 0.001,
      questions: [
        option('m1', {
          text: 'Does kwh_import fall on warmer days?',
          type: 'association',
          origin: 'claude'
        }),
        option('m2', {
          text: 'Are some homes read less often?',
          origin: 'claude'
        })
      ],
      outcomes: [
        {
          column: 'kwh_import',
          frame: 'meter_readings',
          why: 'the energy each home uses'
        },
        { column: 'kwh_peak', frame: 'meter_readings', why: 'use at the peak' }
      ],
      units: [
        {
          column: 'home_id',
          frame: 'meter_readings',
          why: 'each home is read daily'
        }
      ],
      ...(order ? { order } : {})
    }
  ];
}

/**
 * A view whose drops the server answers with `options`, and whose model of
 * More questions answers with `events`, held until `release` when `hold`.
 */
function dropModel(
  options: IOption[],
  events: StreamEvent[] = answer(['m1', 't1', 't2', 'm2']),
  meta: Record<string, unknown> = {}
) {
  const { model, nb } = fakeModel(
    [
      {
        id: 'c1',
        source: 'import pandas as pd\n\nhomes = pd.read_csv("homes.csv")'
      },
      {
        id: 'c2',
        source: 'meter_readings = pd.read_parquet("meter_readings.parquet")'
      }
    ],
    meta
  );
  model.status = CONNECTED;
  Object.assign(model.settings, {
    offeredQuestions: 12,
    showCost: false,
    modelQuestions: 'always'
  });
  model._cellNeeds = async () => false;
  model._stopUnsupported = () => false;
  model._orderByModel = async () => undefined;
  model.variables = () => FRAMES;
  model.variable = (name: string) =>
    FRAMES.find(variable => variable.name === name) ?? null;
  const calls: any[] = [];
  const drops: any[] = [];
  const answered: string[] = [];
  const waiting: (() => void)[] = [];
  let hold = false;
  model.apply = async (picked: IOption) => {
    answered.push(picked.id);
  };
  model.api = {
    drop: async (body: any) => {
      drops.push(body);
      return {
        title: 'meter_readings + homes',
        note: null,
        mode: 'auto',
        options: options.map(item => ({ ...item })),
        placements: [
          { kind: 'new', cell: 'c2', label: 'a new cell after [2]' }
        ],
        preselected: []
      };
    },
    claudeQuestions: async (
      body: unknown,
      onEvent: (event: StreamEvent) => void
    ) => {
      calls.push(body);
      if (hold) {
        await new Promise<void>(resolve => waiting.push(resolve));
      }
      events.forEach(onEvent);
    }
  };
  return {
    model,
    nb,
    calls,
    drops,
    answered,
    holdAnswers: () => {
      hold = true;
    },
    release: () => waiting.shift()?.()
  };
}

const drop = (model: any, source: IItem = READINGS, target: IItem = HOMES) =>
  model.askDrop(
    source,
    { item: target },
    { branch: false, parallel: false },
    null
  );

const TEMPLATES = [
  option('t1', {
    text: 'How do meter_readings and homes line up?',
    code: 'x',
    type: 'quality',
    probability: 0.87
  }),
  option('t2', {
    text: 'Do meter_readings and homes describe the same units?',
    type: 'quality',
    probability: 0.69
  })
];

describe('questions from a model next to the templates', () => {
  it('asks the model in the background when a template question runs, with the questions offered, and runs none', async () => {
    const { model, calls, answered, holdAnswers, release } =
      dropModel(TEMPLATES);
    holdAnswers();
    await drop(model);
    const ask = model.ask as IDropAsk;
    // The templates' questions show at once, while the model works.
    await until(() => ask.fromModel === 'asking');
    expect(ask.loading).toBe(false);
    expect(ask.result!.options.map(o => o.id)).toEqual(['t1', 't2']);
    release();
    await until(() => ask.fromModel === 'done');
    expect(calls).toHaveLength(1);
    expect(calls[0].offered).toEqual([
      {
        id: 't1',
        text: 'How do meter_readings and homes line up?',
        type: 'quality',
        origin: 'template',
        probability: 0.87,
        runs: true,
        placement: null
      },
      {
        id: 't2',
        text: 'Do meter_readings and homes describe the same units?',
        type: 'quality',
        origin: 'template',
        probability: 0.69,
        runs: false,
        placement: null
      }
    ]);
    expect(calls[0].cells_above).toBe(2);
    // The model's questions take the places that the server gave.
    expect(ask.result!.options.map(o => o.id)).toEqual([
      'm1',
      't1',
      't2',
      'm2'
    ]);
    expect(ask.result!.options[0].by?.model).toBe('fake-model');
    expect(ask.result!.options[0].placement).toEqual({
      kind: 'new',
      cell: 'c2',
      label: 'a new cell after [2]'
    });
    expect(ask.noTemplate).toBe(false);
    expect(answered).toEqual([]);
    expect(model.strips.size).toBe(0);
  });

  it('keeps the questions where they are while the pointer is on the list, and orders them when it leaves', async () => {
    const { model, holdAnswers, release } = dropModel(TEMPLATES);
    holdAnswers();
    await drop(model);
    const ask = model.ask as IDropAsk;
    await until(() => ask.fromModel === 'asking');
    model.pointAtList(ask, true);
    release();
    await until(() => ask.fromModel === 'done');
    expect(ask.result!.options.map(o => o.id)).toEqual([
      't1',
      't2',
      'm1',
      'm2'
    ]);
    model.pointAtList(ask, false);
    expect(ask.result!.options.map(o => o.id)).toEqual([
      'm1',
      't1',
      't2',
      'm2'
    ]);
  });

  it('shows the same questions in the same order for the same request, and asks once', async () => {
    const { model, calls } = dropModel(TEMPLATES);
    await drop(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    await drop(model);
    await settle();
    expect(calls).toHaveLength(1);
    expect((model.ask as IDropAsk).result!.options.map(o => o.id)).toEqual([
      'm1',
      't1',
      't2',
      'm2'
    ]);
  });

  it('asks only when no template fits with that choice, and never with never', async () => {
    const some = dropModel(TEMPLATES);
    some.model.settings.modelQuestions = 'no-template';
    await drop(some.model);
    await settle();
    expect(some.calls).toHaveLength(0);
    const never = dropModel([]);
    never.model.settings.modelQuestions = 'never';
    await drop(never.model);
    await settle();
    expect(never.calls).toHaveLength(0);
    expect((never.model.ask as IDropAsk).fromModel).toBeUndefined();
  });

  it('asks no model about a file that a template loads: the model would read its name alone', async () => {
    const { model, calls } = dropModel([
      option('load', { text: 'Load homes.csv as homes', code: 'homes = 1' })
    ]);
    const file: IItem = {
      kind: 'file',
      name: 'homes.csv',
      label: 'homes.csv',
      path: 'homes.csv'
    };
    await model.askDrop(file, {}, { branch: false, parallel: false }, null);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('says nothing about a model where templates fit and no model answers', async () => {
    const { model, calls } = dropModel(TEMPLATES);
    model.status = {
      ...CONNECTED,
      claude_available: false,
      claude: {
        ...CONNECTED.claude,
        available: false,
        reason: 'no model is connected'
      }
    };
    await drop(model);
    await settle();
    expect(calls).toHaveLength(0);
    expect((model.ask as IDropAsk).fromModel).toBeUndefined();
  });

  it('says why the model added no questions when its call failed', async () => {
    const { model } = dropModel(TEMPLATES, [
      { type: 'error', message: 'The model timed out.' }
    ]);
    await drop(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'failed');
    const ask = model.ask as IDropAsk;
    expect(ask.fromModelNote).toBe('The model timed out.');
    expect(ask.result!.options.map(o => o.id)).toEqual(['t1', 't2']);
  });
});

describe('the outcomes and the units, inferred', () => {
  it('keeps what the model named as inferred, and the next requests carry it', async () => {
    const { model, nb } = dropModel(TEMPLATES);
    expect(model.serverContext()).toMatchObject({
      outcomes: [],
      units: ['home_id']
    });
    await drop(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    const kept = (nb.getMetadata('whybook') as any).inferred;
    expect(kept.outcomes.map((item: any) => [item.column, item.by])).toEqual([
      ['kwh_import', 'model'],
      ['kwh_peak', 'model']
    ]);
    expect(kept.outcomes[0].model.model).toBe('fake-model');
    expect(kept.outcomes[0].why).toBe('the energy each home uses');
    expect(model.serverContext()).toMatchObject({
      outcome: 'kwh_import',
      outcomes: ['kwh_import', 'kwh_peak'],
      unit: 'home_id',
      units: ['home_id']
    });
  });

  it('leaves the outcome and the unit that the notebook sets by hand alone', async () => {
    const { model } = dropModel(TEMPLATES, undefined, {
      outcome: 'pain_score',
      unit: 'patient_id'
    });
    await drop(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    expect(model.serverContext()).toMatchObject({
      outcome: 'pain_score',
      outcomes: ['pain_score'],
      unit: 'patient_id',
      units: ['patient_id']
    });
  });

  it("puts the analyst's pick first, and asks the questions of the request again", async () => {
    const { model, nb, drops } = dropModel(TEMPLATES);
    await drop(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    model.pickInferred('outcome', {
      column: 'kwh_peak',
      frame: 'meter_readings'
    });
    await until(() => drops.length === 2);
    const kept = (nb.getMetadata('whybook') as any).inferred;
    expect(kept.outcomes[0]).toEqual({
      column: 'kwh_peak',
      frame: 'meter_readings',
      by: 'analyst'
    });
    expect(drops[1].context.outcome).toBe('kwh_peak');
    expect(drops[1].context.outcomes).toEqual(['kwh_peak', 'kwh_import']);
  });
});
