import type { ServerConnection } from '@jupyterlab/services';

import type { IModelCall } from '../model/api';
import { Api } from '../model/api';
import { requestAPI, streamAPI } from '../request';
import type { StreamEvent } from '../tokens';

jest.mock('../request', () => ({
  requestAPI: jest.fn(),
  streamAPI: jest.fn()
}));

const stream = streamAPI as jest.Mock;
const request = requestAPI as jest.Mock;
const server = {} as ServerConnection.ISettings;
const WARNING =
  'The fast JSON check failed: TypeError: sample() takes 2 positional arguments';

describe('Api, for the requests that a local model may answer', () => {
  beforeEach(() => {
    stream.mockReset();
    stream.mockResolvedValue(undefined);
  });

  it('sends the JSON check of the settings with each request', async () => {
    const api = new Api(server, { jsonCheck: () => 'standard' });
    await api.describeTables({ model: 'gemma-4-e2b', tables: [] }, () => {});
    await api.describeFrames({ model: 'gemma-4-e2b', frames: [] }, () => {});
    await api.claudeQuestions({ model: 'remote' }, () => {});
    expect(stream.mock.calls.map(call => [call[0], call[2]])).toEqual([
      [
        'tables/describe',
        { model: 'gemma-4-e2b', tables: [], json_check: 'standard' }
      ],
      [
        'frames/describe',
        { model: 'gemma-4-e2b', frames: [], json_check: 'standard' }
      ],
      ['questions/claude', { model: 'remote', json_check: 'standard' }]
    ]);
  });

  it('leaves the body as it is without the option', async () => {
    await new Api(server).describeTables({ tables: [] }, () => {});
    expect(stream.mock.calls[0][2]).toEqual({ tables: [] });
  });

  it("passes on every event, and a result's warning to onWarning", async () => {
    const warnings: string[] = [];
    const events: StreamEvent[] = [];
    stream.mockImplementation(async (_endpoint, _server, _body, onEvent) => {
      onEvent({ type: 'progress', stage: 'summarising frame 1 of 1' });
      onEvent({ type: 'result', elapsed: 1, frames: [], warning: WARNING });
    });
    const api = new Api(server, {
      jsonCheck: () => 'fast',
      onWarning: message => warnings.push(message)
    });
    await api.describeFrames({ frames: [] }, event => events.push(event));
    expect(warnings).toEqual([WARNING]);
    expect(events.map(event => event.type)).toEqual(['progress', 'result']);
  });
});

describe('Api, with the data kept on this machine', () => {
  /**
   * Each method whose request the server may pass to a model outside this
   * machine: the connected model, or Jev from TypeSafe for a typed question.
   * With the data kept here, the body carries keep_data_local, and the
   * server cuts the prompt back (whybook/server/privacy.py).
   */
  const REACH_A_MODEL: [string, (api: Api) => Promise<unknown>][] = [
    ['solve', api => api.solve({ question: { text: 'q' } }, () => {})],
    ['agent', api => api.agent({ question: { text: 'q' } }, () => {})],
    ['rankQuestions', api => api.rankQuestions({ model: 'remote' }, () => {})],
    [
      'claudeQuestions',
      api => api.claudeQuestions({ model: 'remote' }, () => {})
    ],
    [
      'reviewQuestions',
      api => api.reviewQuestions({ model: 'remote', cells: [] }, () => {})
    ],
    [
      'decisionValues',
      api => api.decisionValues({ model: 'remote' }, () => {})
    ],
    [
      'askLibraryDefaults',
      api => api.askLibraryDefaults({ model: 'remote', function: {} }, () => {})
    ],
    [
      'claudeDependencies',
      api => api.claudeDependencies({ cells: [] }, () => {})
    ],
    [
      'describeTables',
      api => api.describeTables({ model: 'remote', tables: [] }, () => {})
    ],
    [
      'describeFrames',
      api => api.describeFrames({ model: 'remote', frames: [] }, () => {})
    ],
    [
      'titleCells',
      api => api.titleCells({ model: 'remote', cells: [] }, () => {})
    ],
    ['sortQuestion', api => api.sortQuestion({ text: 'q', model: 'jev' })]
  ];

  /**
   * The other methods. The server answers most of them itself, such as the
   * library defaults that it kept (libraryDefaults). A model
   * reads what agentResult sends, under the policy of the run's own request
   * (whybook/server/agent.py). The speech engines run in the server, and
   * the rest sign in, choose a model, or fetch one.
   */
  const NO_MODEL_OUTSIDE = [
    'status',
    'drop',
    'cellQuestions',
    'decisionOptions',
    'libraryDefaults',
    'next',
    'dependencies',
    'agentResult',
    'agentStop',
    'downloadModel',
    'transcribe',
    'downloadSpeech',
    'connection',
    'saveConnection',
    'connectionModels',
    'localServers',
    'openRouterSignIn',
    'openRouterCode',
    'huggingFaceSignIn',
    'huggingFacePoll',
    'saveKey',
    'signOut'
  ];

  /** The body of each request that the client sent, by its route. */
  function bodies(): Record<string, Record<string, unknown>> {
    const found: Record<string, Record<string, unknown>> = {};
    for (const [route, , body] of stream.mock.calls) {
      found[route] = body;
    }
    for (const [route, , init] of request.mock.calls) {
      found[route] = JSON.parse(init.body);
    }
    return found;
  }

  beforeEach(() => {
    stream.mockReset();
    stream.mockResolvedValue(undefined);
    request.mockReset();
    request.mockResolvedValue({});
  });

  it('says so in the body of every request that can reach a model', async () => {
    const api = new Api(server, { keepDataLocal: () => true });
    for (const [, call] of REACH_A_MODEL) {
      await call(api);
    }
    const flags = Object.fromEntries(
      Object.entries(bodies()).map(([route, body]) => [
        route,
        body.keep_data_local
      ])
    );
    expect(flags).toEqual({
      solve: true,
      agent: true,
      'questions/rank': true,
      'questions/claude': true,
      'questions/review': true,
      'decision/values': true,
      'defaults/ask': true,
      'dependencies/claude': true,
      'tables/describe': true,
      'frames/describe': true,
      'cells/title': true,
      'questions/sort': true
    });
  });

  it('leaves the body as it is when the data may leave', async () => {
    const api = new Api(server, { keepDataLocal: () => false });
    for (const [, call] of REACH_A_MODEL) {
      await call(api);
    }
    const sent = bodies();
    expect(Object.keys(sent)).toHaveLength(REACH_A_MODEL.length);
    expect(
      Object.keys(sent).filter(route => 'keep_data_local' in sent[route])
    ).toEqual([]);
    expect(sent.solve).toEqual({ question: { text: 'q' } });
  });

  it("asks for a server's models with a POST that holds nothing of the notebook", async () => {
    // A POST, which Jupyter checks for its XSRF token: a page of any site can
    // make the browser send a GET, and the server sends a typed key to the
    // server that the request names.
    const api = new Api(server, { keepDataLocal: () => true });
    await api.connectionModels(
      'openai-compatible',
      'http://gpu-server:8000/v1'
    );
    await api.connectionModels('openrouter');
    expect(
      request.mock.calls.map(([route, , init]) => [
        route,
        init.method,
        JSON.parse(init.body)
      ])
    ).toEqual([
      [
        'connection/models',
        'POST',
        { provider: 'openai-compatible', base_url: 'http://gpu-server:8000/v1' }
      ],
      ['connection/models', 'POST', { provider: 'openrouter', base_url: null }]
    ]);
  });

  it('knows of each method of the client whether its request can reach a model', () => {
    // A method added to the client fails here until one of the two lists
    // names it, so that each request that can reach a model is in the test
    // of the flag.
    const methods = Object.getOwnPropertyNames(Api.prototype).filter(
      name => name !== 'constructor' && !name.startsWith('_')
    );
    expect(methods.sort()).toEqual(
      [...REACH_A_MODEL.map(([name]) => name), ...NO_MODEL_OUTSIDE].sort()
    );
  });
});

describe('Api, for the local models of the settings', () => {
  const LLAMA = {
    name: 'Llama 3.2 3B',
    repo: 'ggml-org/Llama-3.2-3B-GGUF',
    file: 'llama-3.2-3b-q4_k_m.gguf'
  };

  beforeEach(() => {
    stream.mockReset();
    stream.mockResolvedValue(undefined);
    request.mockReset();
    request.mockResolvedValue({});
  });

  it('sends them with each status request', async () => {
    await new Api(server, { customModels: () => [LLAMA] }).status();
    const [endpoint, , init] = request.mock.calls[0];
    expect(endpoint).toBe('status');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ custom_local_models: [LLAMA] });
  });

  it("adds a model's spec to a request that names it, so that a restarted server can run it", async () => {
    const api = new Api(server, { customModels: () => [LLAMA] });
    await api.describeTables(
      { model: 'custom:llama-3.2-3b', tables: [] },
      () => {}
    );
    await api.downloadModel('custom:llama-3.2-3b', () => {});
    await api.describeTables({ model: 'gemma-4-e2b', tables: [] }, () => {});
    expect(stream.mock.calls.map(call => call[2])).toEqual([
      { model: 'custom:llama-3.2-3b', tables: [], model_spec: LLAMA },
      { model: 'custom:llama-3.2-3b', model_spec: LLAMA },
      { model: 'gemma-4-e2b', tables: [] }
    ]);
  });
});

describe('Api, for what each model call cost', () => {
  beforeEach(() => {
    stream.mockReset();
    request.mockReset();
  });

  it('tells once what a call cost, at its result, whatever the route', async () => {
    const calls: IModelCall[] = [];
    const api = new Api(server, { onCall: call => calls.push(call) });
    stream.mockImplementation(async (_endpoint, _server, _body, onEvent) => {
      onEvent({ type: 'progress', stage: 'writing', elapsed: 0.2 });
      onEvent({
        type: 'result',
        elapsed: 1.4,
        cells: [],
        model: 'openrouter:anthropic/claude-sonnet-5',
        cost_usd: 0.00041
      });
      // A second result of one call is not counted again.
      onEvent({ type: 'result', elapsed: 1.5, cost_usd: 0.00041 });
    });
    const body = { model: 'remote', cells: [{ id: 'c1' }] };
    await api.titleCells(body, () => {});
    await api.describeTables({ tables: [] }, () => {});
    await api.describeFrames({ frames: [] }, () => {});
    await api.solve({}, () => {});
    await api.agent({}, () => {});
    await api.claudeQuestions({}, () => {});
    await api.reviewQuestions({}, () => {});
    await api.rankQuestions({}, () => {});
    await api.claudeDependencies({}, () => {});
    expect(calls.map(call => call.route)).toEqual([
      'cells/title',
      'tables/describe',
      'frames/describe',
      'solve',
      'agent',
      'questions/claude',
      'questions/review',
      'questions/rank',
      'dependencies/claude'
    ]);
    expect(calls[0]).toEqual({
      route: 'cells/title',
      usd: 0.00041,
      seconds: 1.4,
      model: 'openrouter:anthropic/claude-sonnet-5',
      body,
      failed: false
    });
  });

  it('counts a failed call that says what it cost, a result without a price as unknown, and not a failure before any model', async () => {
    const calls: IModelCall[] = [];
    const api = new Api(server, { onCall: call => calls.push(call) });
    const events: StreamEvent[][] = [
      [
        { type: 'error', message: 'the answer broke the schema', cost_usd: 0.3 }
      ],
      [{ type: 'result', elapsed: 2, model: 'huggingface:Qwen/Qwen3.8-27B' }],
      [
        {
          type: 'error',
          message: 'No AI model answered: no model is connected.'
        }
      ]
    ];
    stream.mockImplementation(async (_endpoint, _server, _body, onEvent) => {
      for (const event of events.shift() ?? []) {
        onEvent(event);
      }
    });
    await api.solve({}, () => {});
    await api.solve({}, () => {});
    await api.solve({}, () => {});
    expect(calls.map(call => [call.usd, call.failed])).toEqual([
      [0.3, true],
      [null, false]
    ]);
  });

  it('tells what sorting a typed question cost', async () => {
    const calls: IModelCall[] = [];
    request.mockResolvedValue({
      type: null,
      place: null,
      model: 'jev-1.13.0',
      elapsed: 0.4,
      cost_usd: null
    });
    await new Api(server, { onCall: call => calls.push(call) }).sortQuestion({
      text: 'Add age',
      model: 'jev'
    });
    expect(calls).toEqual([
      {
        route: 'questions/sort',
        usd: null,
        seconds: 0.4,
        model: 'jev-1.13.0',
        body: { text: 'Add age', model: 'jev' },
        failed: false
      }
    ]);
  });
});
