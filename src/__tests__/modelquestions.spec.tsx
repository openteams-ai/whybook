/**
 * The model's questions and the values of a template (design iteration
 * 1.76):
 *
 * - the request for the model's questions carries what agents found in the
 *   notebook, so that the model does not ask again what a run settled;
 * - a question that the model wrote and the analyst asked since does not
 *   come back when the same drop shows the model's questions again;
 * - a value that a template wrote is chosen by the template, and not by AI.
 */
// The fake first: it quiets the warnings of JupyterLab's modules in jest.
import { fakeModel, settle, until } from './fakes/model-fake';

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { attributed, decisionChips, readsFile } from '../model/decisions';
import type { IDropAsk } from '../model/epimodel';
import { agentFindings, notAsked } from '../model/modelquestions';
import type {
  IAgentRunRecord,
  IDecision,
  IItem,
  IOption,
  IVariable,
  StreamEvent
} from '../tokens';
import { DecisionChip } from '../ui/common';

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

/** A run as the notebook keeps it, with its answer. */
function run(
  question: string,
  answer: string | null,
  at: string
): IAgentRunRecord {
  return {
    question,
    provider: 'openrouter',
    model: 'fake-model',
    cost_usd: 0.01,
    cells: [],
    files: [],
    state: 'done',
    at,
    answer
  };
}

const NO_ARM =
  'The tables visits and sites hold no treatment arm and no pain score, so the question cannot be answered from this data.';

describe('what agents found, for the model that writes questions', () => {
  it('lists the answers of the runs, the newest first, at most three, each cut', () => {
    const runs = {
      a: run('Does arm B change pain?', NO_ARM, '2026-10-01T07:24:00Z'),
      b: run(
        'How does the dose evolve?',
        'x'.repeat(900),
        '2026-10-01T07:29:00Z'
      ),
      c: run('A run that stopped', null, '2026-10-01T07:30:00Z'),
      d: run(
        'Fit a mixed model',
        'No trend in the dose.',
        '2026-10-01T07:31:00Z'
      ),
      e: run('The first run', 'An old answer.', '2026-10-01T07:20:00Z')
    };
    const found = agentFindings(runs);
    expect(found.map(item => item.question)).toEqual([
      'Fit a mixed model',
      'How does the dose evolve?',
      'Does arm B change pain?'
    ]);
    expect(found[1].answer).toHaveLength(600);
    expect(agentFindings(undefined)).toEqual([]);
  });

  it('leaves out of a list the questions asked, by their id or their words', () => {
    const options = [
      option('claude:a', { text: 'Does treatment arm moderate crp_mg_l?' }),
      option('claude:b', { text: 'Does crp_mg_l rise by week?' }),
      option('claude:c', { text: 'Is crp_mg_l missing at some visits?' })
    ];
    const asked = [
      { id: 'claude:a', text: 'Does treatment arm moderate crp_mg_l?' },
      { id: 'own:1', text: ' is crp_mg_l missing at some visits? ' }
    ];
    expect(notAsked(options, asked).map(item => item.id)).toEqual(['claude:b']);
  });
});

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

const VISITS: IVariable = {
  name: 'visits',
  label: 'visits',
  kind: 'dataframe',
  rows: 1428,
  columns: [
    {
      name: 'visits["week"]',
      label: 'week',
      parent: 'visits',
      kind: 'numeric',
      tag: 'int',
      unique: 26
    },
    {
      name: 'visits["crp_mg_l"]',
      label: 'crp_mg_l',
      parent: 'visits',
      kind: 'numeric',
      tag: 'num',
      unique: 180
    }
  ]
};
const WEEK: IItem = {
  kind: 'column',
  name: 'visits["week"]',
  label: 'week',
  parent: 'visits'
};
const CRP: IItem = {
  kind: 'column',
  name: 'visits["crp_mg_l"]',
  label: 'crp_mg_l',
  parent: 'visits'
};

const ARM = option('claude:arm', {
  text: 'Does treatment arm moderate how crp_mg_l changes over week?',
  origin: 'claude'
});
const MEDIATE = option('claude:mediate', {
  text: 'Does analgesic_dose_mg mediate the effect of week on crp_mg_l?',
  origin: 'claude'
});

/** A view whose drops get one template question, and whose model of More questions adds two. */
function dropModel(meta: Record<string, unknown> = {}) {
  const { model, nb } = fakeModel(
    [{ id: 'c1', source: 'visits = pd.read_sql("SELECT * FROM visits", con)' }],
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
  model.variables = () => [VISITS];
  model.variable = (name: string) => (name === 'visits' ? VISITS : null);
  const calls: any[] = [];
  model.api = {
    drop: async () => ({
      title: 'week + crp_mg_l',
      note: null,
      mode: 'auto',
      options: [
        option('t:within', {
          text: 'Are week and crp_mg_l associated, within or between patients?',
          code: 'x',
          type: 'association'
        })
      ],
      placements: [{ kind: 'new', cell: 'c1', label: 'a new cell after [1]' }],
      preselected: []
    }),
    claudeQuestions: async (
      body: unknown,
      onEvent: (event: StreamEvent) => void
    ) => {
      calls.push(body);
      onEvent({
        type: 'result',
        elapsed: 0.5,
        model: 'fake-model',
        cost_usd: 0.001,
        questions: [ARM, MEDIATE],
        outcomes: [],
        units: [],
        order: ['claude:arm', 't:within', 'claude:mediate']
      });
    }
  };
  return { model, nb, calls };
}

const dropWeekOnCrp = (model: any) =>
  model.askDrop(WEEK, { item: CRP }, { branch: false, parallel: false }, null);

describe('the model of More questions in a notebook with agents', () => {
  it('reads what agents found in the notebook', async () => {
    const { model, calls } = dropModel({
      agent_runs: {
        r1: run(
          'Does treatment arm B change how pain evolves over the first six months?',
          NO_ARM,
          '2026-10-01T07:24:00Z'
        )
      }
    });
    await dropWeekOnCrp(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    expect(calls).toHaveLength(1);
    expect(calls[0].found).toEqual([
      {
        question:
          'Does treatment arm B change how pain evolves over the first six months?',
        answer: NO_ARM
      }
    ]);
  });

  it('does not show again a question of the model that the analyst asked since', async () => {
    const { model, calls } = dropModel();
    await dropWeekOnCrp(model);
    await until(() => (model.ask as IDropAsk).fromModel === 'done');
    expect((model.ask as IDropAsk).result!.options.map(o => o.id)).toEqual([
      'claude:arm',
      't:within',
      'claude:mediate'
    ]);
    // The analyst picks the question about the arm, as pain step 15 did.
    model._recordAsked((model.ask as IDropAsk).result!.options[0]);
    model.ask = null;
    // Pain step 35: the same drop again shows the model's questions it kept.
    await dropWeekOnCrp(model);
    await settle();
    expect(calls).toHaveLength(1);
    expect((model.ask as IDropAsk).result!.options.map(o => o.id)).toEqual([
      't:within',
      'claude:mediate'
    ]);
  });
});

describe('a value that a template wrote', () => {
  const how: IDecision = {
    name: 'how',
    value: "'left'",
    provenance: 'literal',
    param: 'how',
    function: 'DataFrame.merge',
    calls: [{ line: 2, col: 25, target: 'homes' }]
  };
  const read: IDecision = {
    name: 'filepath_or_buffer',
    value: "'homes.csv'",
    provenance: 'literal',
    param: 'filepath_or_buffer',
    function: 'read_csv',
    calls: [{ line: 1, col: 8, target: 'homes' }]
  };

  it('is chosen by the template that the analyst picked, and a model keeps the AI mark', () => {
    // Energy step 6: "Join homes.csv to readings on home_id", a template; the analyst picked the file.
    const template = {
      written_by: 'agent' as const,
      template: true,
      user_values: [{ name: 'homes.csv', value: 'homes.csv', file: true }]
    };
    expect(
      attributed([how, read], template).map(item => item.provenance)
    ).toEqual(['template', 'you']);
    const byModel = {
      written_by: 'agent' as const,
      generated_by: { agent: 'openrouter', model: 'fake-model' }
    };
    expect(attributed([how], byModel)[0].provenance).toBe('agent');
    // A cell of the view from before 28 September 2026 does not say which wrote it.
    expect(attributed([how], { written_by: 'agent' })[0].provenance).toBe(
      'agent'
    );
  });

  it('says so in the tooltip of its chip, which has no AI tag', () => {
    const [left] = decisionChips(
      attributed([how], { written_by: 'agent', template: true })
    );
    expect(left.text).toBe('left join');
    expect(left.tooltip.split('\n').pop()).toBe(
      'Chosen by the template you picked.'
    );
    const html = renderToStaticMarkup(<DecisionChip chip={left} />);
    expect(html).not.toContain('jp-Epi-aitag');
    expect(html).not.toContain('jp-Epi-ai"');
    // A file that a template reads is still shown by its name.
    expect(readsFile({ ...read, provenance: 'template' })).toBe(true);
  });
});
