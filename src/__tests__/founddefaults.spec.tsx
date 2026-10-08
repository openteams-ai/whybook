/**
 * "Find more defaults with AI" (design iteration 1.53): the chips of the
 * library defaults that a model picked from the signatures that the kernel
 * read (src/model/founddefaults.ts), their tooltips, the kernel bridge that
 * reads the signatures only while the setting is on, and what the setting
 * says without a model.
 */
import './fakes/quiet';

import { Signal } from '@lumino/signaling';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Api, IKeptDefaults, IServerStatus } from '../model/api';
import { chipText, decisionChips } from '../model/decisions';
import type { IDecisionAsk } from '../model/epimodel';
import type { IFunctionPicks, ISignature } from '../model/founddefaults';
import {
  FoundDefaults,
  foundDecisions,
  functionKey,
  withFound
} from '../model/founddefaults';
import { KernelBridge } from '../model/kernel';
import { DEFAULT_MODELS } from '../model/models';
import { describeBy } from '../model/writtenby';
import type { ICellAnalysis, IDecision, IWrittenBy } from '../tokens';
import { DecisionChip, DecisionChips } from '../ui/common';
import { findDefaultsNote } from '../ui/founddefaults';
import { DecisionHeading, DecisionReason } from '../ui/variables';
import { benchModel } from './fakes/bench-fake';

const BY: IWrittenBy = {
  choice: 'remote',
  model: 'fake-model',
  at: '2026-09-30T09:00:00Z'
};
const DROPNA = 'Rows whose key is missing are left out of the groups.';
const SORT = 'The groups come in the order of their keys.';

/** `totals = df.groupby("g")["v"].sum()`, as the kernel lists it. */
const GROUPBY: ISignature = {
  function: 'pandas.core.frame.DataFrame.groupby',
  name: 'DataFrame.groupby',
  module: 'pandas.core.frame',
  library: 'pandas',
  version: '3.0.6',
  params: [
    { name: 'by', default: 'None' },
    { name: 'level', default: 'None' },
    { name: 'as_index', default: 'True' },
    { name: 'sort', default: 'True' },
    { name: 'group_keys', default: 'True' },
    { name: 'observed', default: 'True' },
    { name: 'dropna', default: 'True' }
  ],
  calls: [
    {
      line: 1,
      col: 12,
      target: 'df',
      defaulted: [
        'level',
        'as_index',
        'sort',
        'group_keys',
        'observed',
        'dropna'
      ]
    }
  ]
};

/** Two merges, of which the second passes validate. */
const MERGE: ISignature = {
  function: 'pandas.core.frame.DataFrame.merge',
  name: 'DataFrame.merge',
  module: 'pandas.core.frame',
  library: 'pandas',
  version: '3.0.6',
  params: [
    { name: 'how', default: "'inner'" },
    { name: 'sort', default: 'False' },
    { name: 'validate', default: 'None' }
  ],
  calls: [
    {
      line: 2,
      col: 5,
      target: 'homes',
      defaulted: ['how', 'sort', 'validate']
    },
    { line: 3, col: 5, target: 'weather', defaulted: ['how', 'sort'] }
  ]
};

const PICKS: Record<string, IFunctionPicks> = {
  [GROUPBY.function]: {
    picks: [
      { param: 'dropna', why: DROPNA },
      { param: 'sort', why: SORT }
    ],
    by: BY
  },
  [MERGE.function]: {
    picks: [
      { param: 'how', why: 'Rows without a match are dropped.' },
      { param: 'validate', why: 'Duplicate keys go unchecked.' }
    ],
    by: BY
  }
};

/** The inner join of both merges, from the kernel's list of 11 defaults. */
const HOW: IDecision = {
  name: 'how',
  value: "'inner'",
  provenance: 'library_default',
  param: 'how',
  function: 'DataFrame.merge',
  note: 'rows without a match in both frames are dropped',
  calls: [
    { line: 2, col: 5, target: 'homes' },
    { line: 3, col: 5, target: 'weather' }
  ]
};

const answer = (signature: ISignature) => PICKS[signature.function];

describe('the defaults that a model found', () => {
  it('come in the model’s order, the first pick of each function first, at most three, and not twice', () => {
    const found = foundDecisions([GROUPBY, MERGE], answer, [HOW]);
    // The inner join has its chip already: the model's first pick for merge adds none.
    expect(
      found.map(decision => [decision.function, chipText(decision)])
    ).toEqual([
      ['DataFrame.groupby', 'dropna True'],
      ['DataFrame.groupby', 'sort True'],
      ['DataFrame.merge', 'validate None']
    ]);
    const [dropna, , validate] = found;
    expect(dropna).toMatchObject({
      provenance: 'library_default',
      param: 'dropna',
      note: DROPNA,
      calls: [{ line: 1, col: 12, target: 'df' }],
      found: { by: BY, library: 'pandas', version: '3.0.6' }
    });
    // Only the merge that leaves validate at its default.
    expect(validate.calls).toEqual([{ line: 2, col: 5, target: 'homes' }]);
    // Without the inner join's chip, the merge's first pick comes second.
    expect(foundDecisions([GROUPBY, MERGE], answer, []).map(chipText)).toEqual([
      'dropna True',
      'inner join',
      'sort True'
    ]);
  });

  it('make one chip of the same default of functions of the same name, as the kernel does for its own decisions', () => {
    // [22] of the NHEFS video: the intervals of a fit and of two of its
    // contrasts, each at alpha 0.05 (design iteration 1.102).
    const fitInterval: ISignature = {
      function:
        'statsmodels.regression.linear_model.RegressionResults.conf_int',
      name: 'RegressionResults.conf_int',
      module: 'statsmodels.regression.linear_model',
      library: 'statsmodels',
      version: '0.15.0',
      params: [{ name: 'alpha', default: '0.05' }],
      calls: [{ line: 9, col: 18, target: null, defaulted: ['alpha'] }]
    };
    const testInterval: ISignature = {
      ...fitInterval,
      function: 'statsmodels.stats.contrast.ContrastResults.conf_int',
      name: 'ContrastResults.conf_int',
      module: 'statsmodels.stats.contrast',
      calls: [
        { line: 12, col: 30, target: null, defaulted: ['alpha'] },
        { line: 11, col: 30, target: null, defaulted: ['alpha'] }
      ]
    };
    const fit: ISignature = {
      ...fitInterval,
      function: 'statsmodels.regression.linear_model.RegressionModel.fit',
      name: 'RegressionModel.fit',
      params: [{ name: 'use_t', default: 'None' }],
      calls: [{ line: 8, col: 40, target: null, defaulted: ['use_t'] }]
    };
    const picks: Record<string, IFunctionPicks> = {
      [fit.function]: {
        picks: [{ param: 'use_t', why: 'A t or a normal distribution.' }],
        by: BY
      },
      [fitInterval.function]: {
        picks: [{ param: 'alpha', why: 'The level of the interval.' }],
        by: BY
      },
      [testInterval.function]: {
        picks: [{ param: 'alpha', why: 'The level of the interval.' }],
        by: BY
      }
    };
    const found = foundDecisions(
      [fit, fitInterval, testInterval],
      signature => picks[signature.function],
      []
    );
    expect(decisionChips(found).map(chip => [chip.text, chip.count])).toEqual([
      ['use_t None', 1],
      ['alpha 0.05', 3]
    ]);
    // The calls of both, in the order of the code.
    expect(found[1].calls?.map(call => call.line)).toEqual([9, 11, 12]);
    // A third pick takes the place that the second alpha would have taken.
    const more: ISignature = {
      ...fitInterval,
      function: 'pandas.core.series.Series.sum',
      name: 'Series.sum',
      params: [{ name: 'skipna', default: 'True' }],
      calls: [{ line: 13, col: 4, target: null, defaulted: ['skipna'] }]
    };
    picks[more.function] = {
      picks: [{ param: 'skipna', why: 'Missing values are left out.' }],
      by: BY
    };
    expect(
      foundDecisions(
        [fit, fitInterval, testInterval, more],
        signature => picks[signature.function],
        []
      ).map(chipText)
    ).toEqual(['use_t None', 'alpha 0.05', 'skipna True']);
  });

  it('are none for a function without an answer, or a pick that the calls pass', () => {
    expect(foundDecisions([GROUPBY], () => undefined, [])).toEqual([]);
    const passes: ISignature = {
      ...GROUPBY,
      calls: [{ ...GROUPBY.calls[0], defaulted: ['level'] }]
    };
    expect(foundDecisions([passes], answer, [])).toEqual([]);
  });

  it('go after the values that nobody chose and before those that somebody chose', () => {
    const minDays: IDecision = {
      name: 'MIN_DAYS',
      value: '14',
      provenance: 'defaulted'
    };
    const boot: IDecision = {
      name: 'n_boot',
      value: '1000',
      provenance: 'you'
    };
    const found = foundDecisions([GROUPBY], answer, []);
    expect(
      withFound([minDays, HOW, boot], found).map(decision => decision.name)
    ).toEqual(['MIN_DAYS', 'how', 'dropna', 'sort', 'n_boot']);
    expect(withFound([boot], found).map(decision => decision.name)).toEqual([
      'dropna',
      'sort',
      'n_boot'
    ]);
    expect(withFound([boot], [])).toEqual([boot]);
  });

  it('show as a chip in the warning colour with no AI tag, and a tooltip of the value and the call alone', () => {
    const [chip] = decisionChips(foundDecisions([GROUPBY], answer, []));
    expect(chip.text).toBe('dropna True');
    // The value as code and the call. The library, the model and its reason
    // are in the popover (design iteration 1.86).
    expect(chip.tooltip.split('\n')).toEqual([
      'dropna = True',
      'parameter dropna of DataFrame.groupby, line 1'
    ]);
    expect(describeBy(BY, 'Picked')).toMatch(
      /^Picked by the remote AI model, fake-model on /
    );
    const markup = renderToStaticMarkup(<DecisionChip chip={chip} />);
    // The colour of a value that nobody chose, no AI tag, and no browser tooltip.
    expect(markup).toContain('class="jp-Epi-chip jp-mod-open jp-mod-found"');
    expect(markup).not.toContain('jp-Epi-aitag');
    expect(markup).not.toContain('title=');
    // A default of the list of 11 keeps its chip as it was: no AI tag.
    const [known] = decisionChips([HOW]);
    expect(renderToStaticMarkup(<DecisionChip chip={known} />)).not.toContain(
      'jp-Epi-aitag'
    );
    // A value that an agent wrote into code keeps its AI tag, which says nothing of its own.
    const [agent] = decisionChips([
      {
        name: 'header',
        value: "'infer'",
        provenance: 'agent',
        param: 'header',
        function: 'read_csv'
      }
    ]);
    const tagged = renderToStaticMarkup(<DecisionChip chip={agent} />);
    expect(tagged).toContain('<span class="jp-Epi-aitag" title="">AI</span>');
  });

  it('puts the library, the model and its reason in the first lines of the popover', () => {
    const [chip] = decisionChips(foundDecisions([GROUPBY], answer, []));
    const ask = (decision: IDecision, note: string) =>
      ({ kind: 'decision', decision, note }) as unknown as IDecisionAsk;
    // header = 'infer' · default in pandas 3.0.6 · flagged as important by AI
    const heading = renderToStaticMarkup(
      <DecisionHeading ask={ask(chip.decision, 'a library default')} />
    );
    expect(heading).toContain('<code>dropna = True</code>');
    expect(heading).toContain(' · default in pandas 3.0.6</span>');
    expect(heading).toContain(' · flagged as important by ');
    expect(heading).toContain(
      `<span class="jp-Epi-aitag" title="${describeBy(BY, 'Flagged as important')}">AI</span>`
    );
    expect(heading.indexOf('default in pandas')).toBeLessThan(
      heading.indexOf('flagged as important')
    );
    // The model's reason comes under it.
    expect(
      renderToStaticMarkup(<DecisionReason ask={ask(chip.decision, '')} />)
    ).toContain(`>${DROPNA}</div>`);
    // A default of the view's own list: the library from the kernel, and no AI part.
    const listed: IDecision = { ...HOW, library: 'pandas', version: '3.0.6' };
    const own = renderToStaticMarkup(
      <DecisionHeading ask={ask(listed, 'a library default')} />
    );
    expect(own).toContain('<code>how = &#x27;inner&#x27;</code>');
    expect(own).toContain(' · default in pandas 3.0.6</span>');
    expect(own).not.toContain('flagged');
    expect(own).not.toContain('jp-Epi-aitag');
    expect(
      renderToStaticMarkup(<DecisionReason ask={ask(listed, '')} />)
    ).toContain('>Rows without a match in both frames are dropped.</div>');
    // A decision kept before the kernel named the library: the server's words.
    expect(
      renderToStaticMarkup(
        <DecisionHeading ask={ask(HOW, 'a library default')} />
      )
    ).toContain(' · a library default</span>');
  });

  it('are on their way while a bar follows the chips, whose tooltip names the functions', () => {
    const chips = (waiting?: string[]) =>
      renderToStaticMarkup(
        <DecisionChips
          decisions={[HOW]}
          onClick={() => undefined}
          waiting={waiting}
        />
      );
    const markup = chips(['DataFrame.groupby', 'read_csv']);
    expect(markup).toContain(
      'title="An AI model reads the signatures of DataFrame.groupby and read_csv, for more defaults."'
    );
    expect(markup).toContain('aria-label="An AI model finds more defaults"');
    expect(chips(['DataFrame.groupby'])).toContain(
      'An AI model reads the signature of DataFrame.groupby, for more defaults.'
    );
    expect(chips([])).not.toContain('jp-Epi-chips-waiting');
    expect(chips()).not.toContain('jp-Epi-chips-waiting');
  });
});

/** Let the promises that are due settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** A server that kept `kept`, and whose model answers `answers`, by function; a missing answer fails. */
function fakeServer(
  kept: IKeptDefaults[],
  answers: Record<string, unknown> = {}
) {
  const lookups: any[] = [];
  const asks: any[] = [];
  const api = {
    libraryDefaults: async (body: any) => {
      lookups.push(body);
      return {
        answers: kept.filter(item =>
          body.functions.some(
            (f: ISignature) => functionKey(f) === functionKey(item)
          )
        )
      };
    },
    askLibraryDefaults: async (body: any, onEvent: (event: any) => void) => {
      asks.push(body);
      const event = answers[body.function.function];
      if (!event) {
        throw new Error('the model failed');
      }
      onEvent({ type: 'progress', stage: 'thinking', elapsed: 0.1 });
      onEvent(event);
    }
  };
  return { api: api as unknown as Api, lookups, asks };
}

function found(
  api: Api,
  options: {
    enabled?: () => boolean;
    ready?: () => boolean;
    model?: () => string;
  } = {}
) {
  const changed = jest.fn();
  const defaults = new FoundDefaults({
    api,
    enabled: options.enabled ?? (() => true),
    ready: options.ready ?? (() => true),
    model: options.model ?? (() => 'remote'),
    changed
  });
  return { defaults, changed };
}

describe('FoundDefaults', () => {
  it('reads the answers that the server kept first, with no model', async () => {
    const server = fakeServer([
      {
        function: GROUPBY.function,
        library: 'pandas',
        version: '3.0.6',
        picks: PICKS[GROUPBY.function].picks,
        by: BY
      }
    ]);
    const { defaults, changed } = found(server.api);
    defaults.update([GROUPBY]);
    await flush();
    expect(defaults.answer(GROUPBY)).toEqual(PICKS[GROUPBY.function]);
    expect(server.asks).toEqual([]);
    expect(changed).toHaveBeenCalled();
    expect(defaults.version).toBe(1);
    // The server reads the signature, not the calls of the notebook.
    expect(server.lookups[0].functions[0]).not.toHaveProperty('calls');
    expect(server.lookups[0].functions[0].params).toEqual(GROUPBY.params);
    // A function looked up once is not looked up again.
    defaults.update([GROUPBY]);
    await flush();
    expect(server.lookups).toHaveLength(1);
  });

  it('asks the model about each function that has no answer, one at a time, while the model can run', async () => {
    const server = fakeServer([], {
      [GROUPBY.function]: {
        type: 'result',
        picks: PICKS[GROUPBY.function].picks,
        by: BY,
        cost_usd: 0.0003
      },
      [MERGE.function]: {
        type: 'result',
        kept: true,
        picks: PICKS[MERGE.function].picks,
        by: BY
      }
    });
    let ready = false;
    const { defaults, changed } = found(server.api, { ready: () => ready });
    defaults.update([GROUPBY, MERGE]);
    // The server looks for kept answers: the cells show a bar.
    expect(defaults.waiting([GROUPBY, MERGE])).toEqual([
      'DataFrame.groupby',
      'DataFrame.merge'
    ]);
    await flush();
    // No model can run: nothing is asked, nothing fails, and the bar goes.
    expect(server.asks).toEqual([]);
    expect(defaults.waiting([GROUPBY, MERGE])).toEqual([]);
    expect(changed).toHaveBeenCalled();
    ready = true;
    defaults.update([GROUPBY, MERGE]);
    // The model reads groupby now and merge next.
    expect(server.asks.map(body => body.function.name)).toEqual([
      'DataFrame.groupby'
    ]);
    expect(defaults.waiting([GROUPBY, MERGE])).toEqual([
      'DataFrame.groupby',
      'DataFrame.merge'
    ]);
    await flush();
    expect(server.asks.map(body => body.function.name)).toEqual([
      'DataFrame.groupby',
      'DataFrame.merge'
    ]);
    expect(server.asks[0].model).toBe('remote');
    expect(server.asks[0].function).not.toHaveProperty('calls');
    // A kept answer, which another view asked for, counts as an answer too.
    expect(defaults.answer(GROUPBY)?.picks).toEqual(
      PICKS[GROUPBY.function].picks
    );
    expect(defaults.answer(MERGE)?.picks).toEqual(PICKS[MERGE.function].picks);
    expect(defaults.waiting([GROUPBY, MERGE])).toEqual([]);
    defaults.update([GROUPBY, MERGE]);
    await flush();
    expect(server.asks).toHaveLength(2);
  });

  it('does not ask again about a function whose call failed, unless another model is chosen', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const server = fakeServer([]);
    let model = 'remote';
    const { defaults } = found(server.api, { model: () => model });
    defaults.update([GROUPBY]);
    await flush();
    expect(server.asks).toHaveLength(1);
    expect(defaults.answer(GROUPBY)).toBeUndefined();
    defaults.update([GROUPBY]);
    await flush();
    expect(server.asks).toHaveLength(1);
    model = 'gemma-4-e2b';
    defaults.update([GROUPBY]);
    await flush();
    expect(server.asks.map(body => body.model)).toEqual([
      'remote',
      'gemma-4-e2b'
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Could not read the defaults of DataFrame.groupby',
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it('asks nothing while the setting is off', async () => {
    const server = fakeServer([]);
    const { defaults } = found(server.api, { enabled: () => false });
    defaults.update([GROUPBY]);
    await flush();
    expect(server.lookups).toEqual([]);
    expect(server.asks).toEqual([]);
  });
});

/** The session context that the bridge listens to, with a Python kernel. */
function pythonSession() {
  const context: any = {
    session: {
      kernel: {
        status: 'idle',
        connectionStatus: 'connected',
        info: Promise.resolve({ language_info: { name: 'python' } })
      }
    }
  };
  context.kernelChanged = new Signal<any, any>(context);
  context.statusChanged = new Signal<any, any>(context);
  context.iopubMessage = new Signal<any, any>(context);
  return context;
}

const ANALYSIS: ICellAnalysis = {
  defs: ['totals'],
  uses: ['df'],
  formulas: [],
  columns: {},
  decisions: [],
  attachments: []
};

describe('the kernel bridge', () => {
  it('reads the signatures only with the setting, and keeps them out of the analysis that the notebook keeps', async () => {
    const bridge = new KernelBridge(pythonSession());
    const requests: any[] = [];
    jest.spyOn(bridge, 'run').mockImplementation(async (name, args: any) => {
      requests.push(args);
      return {
        cells: Object.fromEntries(
          args.cells.map((cell: { id: string }) => [
            cell.id,
            cell.id === 'broken'
              ? { error: 'SyntaxError: invalid syntax' }
              : {
                  ...ANALYSIS,
                  ...(args.signatures ? { signatures: [GROUPBY] } : {})
                }
          ])
        )
      } as any;
    });
    const cells = [
      { id: 'g', source: 'totals = df.groupby("g")["v"].sum()' },
      { id: 'broken', source: 'totals = (' }
    ];
    await bridge.refreshAnalysis(cells);
    // Without the setting, the request is the one of before.
    expect(requests[0]).toEqual({ cells });
    expect(bridge.signaturesOf('g', cells[0].source)).toBeNull();

    bridge.signatures = true;
    await bridge.refreshAnalysis(cells);
    // Turned on, the cells analysed without signatures are analysed again.
    expect(requests[1]).toEqual({ cells, signatures: true });
    expect(bridge.signaturesOf('g', cells[0].source)).toEqual([GROUPBY]);
    expect(bridge.freshAnalysis('g', cells[0].source)).toEqual(ANALYSIS);
    // A cell that the kernel could not parse lists none, and is not asked about again.
    expect(bridge.signaturesOf('broken', cells[1].source)).toEqual([]);
    await bridge.refreshAnalysis(cells);
    expect(requests).toHaveLength(2);
    // Another source has none until the kernel reads it.
    expect(bridge.signaturesOf('g', 'totals = 1')).toBeNull();
  });

  it('reads a cell that the kernel could not parse as one that uses nothing, and merges it with the kept analysis', async () => {
    // A branch that a model wrote as `import pandas as pd as pd_ipw6b` came
    // back as its error alone, and the merge below threw "fresh.uses is not
    // iterable": the bench went blank in the middle of the demo's take.
    const bridge = new KernelBridge(pythonSession());
    jest.spyOn(bridge, 'run').mockImplementation(
      async () =>
        ({
          cells: { broken: { error: 'SyntaxError: invalid syntax' } }
        }) as any
    );
    const source = 'import pandas as pd as pd_ipw6b';
    await bridge.refreshAnalysis([{ id: 'broken', source }]);
    expect(bridge.freshAnalysis('broken', source)).toEqual({
      defs: [],
      uses: [],
      formulas: [],
      columns: {},
      decisions: [],
      attachments: [],
      error: 'SyntaxError: invalid syntax'
    });
    // Once the code ran in this kernel, the fresh analysis is merged with the kept one.
    (bridge as any)._ranCode.add(source);
    expect(bridge.analysis('broken', source, ANALYSIS)?.uses).toEqual(['df']);
  });
});

describe('the view with "Find more defaults with AI"', () => {
  it('shows the defaults that a model found with the cell’s chips, and none with the setting off', async () => {
    const source = 'totals = df.groupby("g")["v"].sum()';
    const { model } = benchModel([{ id: 'g', source }]);
    jest.spyOn(model.bridge, 'freshAnalysis').mockReturnValue(ANALYSIS);
    jest.spyOn(model.bridge, 'signaturesOf').mockReturnValue([GROUPBY]);
    jest.spyOn(model.api, 'libraryDefaults').mockResolvedValue({
      answers: [
        {
          function: GROUPBY.function,
          library: 'pandas',
          version: '3.0.6',
          picks: PICKS[GROUPBY.function].picks,
          by: BY
        }
      ]
    });
    const chips = () =>
      model
        .cells()
        .find(cell => cell.id === 'g')!
        .decisions.map(decision => chipText(decision));
    expect(chips()).toEqual([]);
    // On by default: the kernel reads the signatures with the analysis.
    expect(model.settings.findDefaults).toBe(true);
    expect(model.bridge.signatures).toBe(true);
    // The kernel's analysis came: the view finds the answers.
    (model.bridge.changed as Signal<KernelBridge, string>).emit('analysis');
    await flush();
    expect(chips()).toEqual(['dropna True', 'sort True']);
    model.settings.update({ findDefaults: false });
    expect(model.bridge.signatures).toBe(false);
    expect(chips()).toEqual([]);
    model.dispose();
  });
});

describe('the setting without a model', () => {
  const status = (claude: Partial<NonNullable<IServerStatus['claude']>>) =>
    ({
      claude_available: !!claude.available,
      claude: {
        available: false,
        cli: null,
        credential: null,
        reason: null,
        setup: null,
        ...claude
      }
    }) as IServerStatus;

  it('says that it waits for a connected model, or why the model cannot run, as other options that need AI do', () => {
    expect(
      findDefaultsNote(
        status({ provider: 'none', reason: 'no model is connected' }),
        DEFAULT_MODELS
      )
    ).toBe('Waits for a connected model: connect one in the AI models panel.');
    expect(
      findDefaultsNote(
        status({
          provider: 'openrouter',
          reason: 'OpenRouter: sign in first.'
        }),
        DEFAULT_MODELS
      )
    ).toBe('Needs an AI model: OpenRouter: sign in first.');
    expect(
      findDefaultsNote(status({ provider: 'openrouter', available: true }), {
        ...DEFAULT_MODELS,
        questions: 'off'
      })
    ).toBe(
      'Needs an AI model: AI is off for More questions in the AI models panel.'
    );
    expect(findDefaultsNote(null, DEFAULT_MODELS)).toBe(
      'Needs an AI model: the server did not answer.'
    );
    expect(
      findDefaultsNote(
        status({ provider: 'openrouter', available: true }),
        DEFAULT_MODELS
      )
    ).toBeNull();
  });
});
