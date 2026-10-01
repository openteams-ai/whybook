import type { IOutputModel } from '@jupyterlab/rendermime';

import type { IAgentRun } from '../model/agent';
import {
  AI_FILE_MARK,
  agentFilePath,
  agentOutputs,
  cellByLabel,
  cellOutputText,
  markedFile,
  RESULT_TEXT,
  runCap,
  runStatus
} from '../model/agent';

function output(type: string, data: Record<string, unknown>): IOutputModel {
  return {
    type,
    data,
    metadata: {},
    trusted: true,
    toJSON: () => ({ output_type: type })
  } as unknown as IOutputModel;
}

const AXES = 'application/vnd.whybook.axes+json';

describe('agentOutputs', () => {
  it('gives a table its size, its columns and its text', () => {
    const [table] = agentOutputs([
      output('execute_result', {
        'text/html':
          '<table><thead><tr><th></th><th>pain</th><th>sleep</th></tr></thead><tbody><tr><th>A</th><td>5.1</td><td>6</td></tr><tr><th>B</th><td>3.2</td><td>7</td></tr></tbody></table>',
        'text/plain': '   pain  sleep\nA   5.1      6\nB   3.2      7'
      })
    ]);
    expect(table).toEqual({
      kind: 'table',
      rows: 2,
      cols: 2,
      columns: ['pain', 'sleep'],
      text: '   pain  sleep\nA   5.1      6\nB   3.2      7'
    });
  });

  it('says what a plot draws, and cuts long printed text', () => {
    const [plot, text] = agentOutputs([
      output('display_data', {
        'image/png': 'iVBOR',
        [AXES]: {
          version: 1,
          library: 'matplotlib',
          image: { width: 640, height: 480, scale: 1 },
          axes: [
            {
              box: [0, 0, 640, 480],
              x: {
                limits: [0, 10],
                scale: 'linear',
                label: 'week',
                column: 'week'
              },
              y: {
                limits: [0, 9],
                scale: 'linear',
                label: 'Pain',
                column: null
              },
              title: 'Pain by week',
              frame: 'visits',
              marks: 20,
              kind: 'scatter'
            }
          ]
        }
      }),
      output('stream', {
        'application/vnd.jupyter.stdout': 'x'.repeat(RESULT_TEXT + 50)
      })
    ]);
    expect(plot).toEqual({
      kind: 'plot',
      plot: { kind: 'scatter', x: 'week', y: 'Pain', title: 'Pain by week' }
    });
    expect(text.kind).toBe('text');
    expect(text.text).toHaveLength(RESULT_TEXT + 1);
    expect(text.text?.endsWith('…')).toBe(true);
  });

  it('leaves out errors, which go with the step, and progress bars', () => {
    expect(
      agentOutputs([
        output('error', {}),
        output('display_data', {
          'application/vnd.whybook.progress+json': { fraction: 0.5 }
        })
      ])
    ).toEqual([]);
  });

  it('gives the columns of a groupby table, not the name of its index', () => {
    // The HTML of pandas 3.0.6 for diary.groupby("arm").mean(), with and
    // without a second level of headers, and of polars 1.44.
    const head = '<table border="1" class="dataframe"><thead>';
    const body =
      '</thead><tbody><tr><th>A</th><td>3.5</td><td>45.0</td></tr><tr><th>B</th><td>5.5</td><td>65.0</td></tr></tbody></table>';
    const grouped =
      head +
      '<tr style="text-align: right;"><th></th><th>pain</th><th>age</th></tr><tr><th>arm</th><th></th><th></th></tr>' +
      body;
    const agg =
      head +
      '<tr><th></th><th colspan="2" halign="left">pain</th><th colspan="2" halign="left">age</th></tr>' +
      '<tr><th></th><th>mean</th><th>std</th><th>mean</th><th>std</th></tr>' +
      '<tr><th>arm</th><th></th><th></th><th></th><th></th></tr>' +
      '</thead><tbody><tr><th>A</th><td>3.5</td><td>0.7</td><td>45.0</td><td>7.1</td></tr></tbody></table>';
    const polars =
      '<small>shape: (2, 2)</small><table border="1" class="dataframe"><thead><tr><th>a</th><th>b</th></tr>' +
      '<tr><td>i64</td><td>str</td></tr></thead><tbody><tr><td>1</td><td>&quot;x&quot;</td></tr>' +
      '<tr><td>2</td><td>&quot;y&quot;</td></tr></tbody></table>';
    const columns = [grouped, agg, polars].map(
      html =>
        agentOutputs([
          output('execute_result', { 'text/html': html, 'text/plain': 'x' })
        ])[0].columns
    );
    expect(columns).toEqual([
      ['pain', 'age'],
      [
        '("pain", "mean")',
        '("pain", "std")',
        '("age", "mean")',
        '("age", "std")'
      ],
      ['a', 'b']
    ]);
  });
});

describe('cellByLabel', () => {
  const cells = [
    { id: 'a', label: '[1]' },
    { id: 'b', label: '[2]' },
    { id: 'c', label: '[2b]' }
  ];

  it('finds a cell by its label, with or without brackets', () => {
    expect(cellByLabel(cells, '[2b]')).toBe('c');
    expect(cellByLabel(cells, '2')).toBe('b');
    expect(cellByLabel(cells, ' [1] ')).toBe('a');
    expect(cellByLabel(cells, '[9]')).toBeNull();
    expect(cellByLabel(cells, undefined)).toBeNull();
  });
});

describe('runStatus', () => {
  const run = (patch: Partial<IAgentRun>): IAgentRun => ({
    id: 'r',
    stripId: 'a',
    question: 'Does pain differ by arm?',
    anchor: 'a',
    state: 'working',
    steps: [],
    notes: [],
    thinking: null,
    answer: null,
    answerCells: [],
    followUp: [],
    by: null,
    costUsd: null,
    error: null,
    started: 0,
    keepLocal: false,
    ...patch
  });
  const step = (cells: string[]) => ({
    call: 'c',
    tool: 'run_cell' as const,
    title: 't',
    why: '',
    cells,
    state: 'done' as const,
    error: null
  });

  it('counts the cells a run added, branches included', () => {
    expect(runStatus(run({ state: 'starting' }))).toBe('Starting');
    expect(runStatus(run({}))).toBe('Working');
    expect(runStatus(run({ steps: [step(['x'])] }))).toBe(
      'Working · 1 cell so far'
    );
    expect(
      runStatus(run({ state: 'done', steps: [step(['x']), step(['y', 'z'])] }))
    ).toBe('Answered with 3 cells');
    expect(runStatus(run({ state: 'stopped', steps: [step(['x'])] }))).toBe(
      'Stopped · 1 cell kept'
    );
  });

  it('says which cost cap stopped a run', () => {
    const stopped = (by: 'notebook' | 'server') =>
      runStatus(
        run({
          state: 'stopped',
          steps: [step(['x', 'y'])],
          capped: { by, usd: 0.58 }
        })
      );
    expect(stopped('notebook')).toBe(
      "Stopped at the notebook's cap · 2 cells kept"
    );
    expect(stopped('server')).toBe(
      'Stopped at the cost cap of a run · 2 cells kept'
    );
  });

  it('counts the files a run wrote beside its cells', () => {
    const file = {
      ...step([]),
      tool: 'write_file' as const,
      file: {
        path: 'study/helpers.py',
        name: 'helpers.py',
        lines: 4,
        content: '',
        previous: null
      }
    };
    expect(runStatus(run({ state: 'done', steps: [file, step(['x'])] }))).toBe(
      'Answered with 1 cell and 1 file'
    );
  });
});

describe('runCap', () => {
  it("reads the cap of a run's stopped result, and nothing else", () => {
    expect(runCap({ by: 'notebook', usd: 0.58 })).toEqual({
      by: 'notebook',
      usd: 0.58
    });
    expect(runCap({ by: 'server', usd: 2 })).toEqual({ by: 'server', usd: 2 });
    expect(runCap(undefined)).toBeNull();
    expect(runCap({ by: 'someone', usd: 1 })).toBeNull();
    expect(runCap({ by: 'notebook', usd: '1' })).toBeNull();
  });
});

describe('agentFilePath', () => {
  it('puts a module in the notebook folder, or in a folder under it', () => {
    expect(agentFilePath('study/pain.ipynb', 'helpers.py')).toEqual({
      path: 'study/helpers.py',
      name: 'helpers.py'
    });
    expect(agentFilePath('pain.ipynb', './lib/fit_models.py')).toEqual({
      path: 'lib/fit_models.py',
      name: 'lib/fit_models.py'
    });
  });

  it('refuses paths outside the folder, and names Python cannot import', () => {
    const refused = (path: string) =>
      'error' in agentFilePath('study/pain.ipynb', path);
    expect(refused('/etc/passwd.py')).toBe(true);
    expect(refused('C:/temp/x.py')).toBe(true);
    expect(refused('../other.py')).toBe(true);
    expect(refused('lib/../../x.py')).toBe(true);
    expect(refused('notes.txt')).toBe(true);
    expect(refused('fit-models.py')).toBe(true);
    expect(refused('2fit.py')).toBe(true);
    expect(refused('.hidden/x.py')).toBe(true);
    expect(refused('')).toBe(true);
  });
});

describe('markedFile', () => {
  it('marks the first line as written by AI, once', () => {
    const at = '2026-09-25T20:00:00.000Z';
    const once = markedFile('TOP = 3\n', 'pain.ipynb', null, at);
    expect(once).toBe(
      `${AI_FILE_MARK} (Whybook's agent) for pain.ipynb on 2026-09-25.\nTOP = 3\n`
    );
    // A file the agent rewrites keeps one mark, with the new date.
    const again = markedFile(
      once,
      'pain.ipynb',
      'claude-opus-5-5',
      '2026-09-26T08:00:00Z'
    );
    expect(again.split(AI_FILE_MARK).length).toBe(2);
    expect(again).toContain(
      "(Whybook's agent, claude-opus-5-5) for pain.ipynb on 2026-09-26."
    );
    expect(again.endsWith('TOP = 3\n')).toBe(true);
  });
});

/**
 * The outputs of any kernel, as the agent reads them (design iteration
 * 1.69): xeus-r 0.11.2 and R 4.4.3 as they ran here, IRkernel's HTML of a
 * data frame, and SAS's ODS HTML of one procedure.
 */
describe('agentOutputs of other kernels', () => {
  const error = (ename: string, evalue: string) =>
    ({
      type: 'error',
      data: {},
      metadata: {},
      trusted: true,
      toJSON: () => ({ output_type: 'error', ename, evalue, traceback: [] })
    }) as unknown as IOutputModel;

  it("reads xeus-r's printed frame, a named vector and printed text, and leaves the error to the step", () => {
    const outputs = [
      output('execute_result', {
        'text/plain':
          '  arm week mean     \n1 A   12   2.6367433\n2 B   24   0.7506944'
      }),
      output('execute_result', {
        'text/plain': '    rows patients \n    5837      291 '
      }),
      output('stream', {
        'application/vnd.jupyter.stdout': 'Mean age: 46.4 \n'
      }),
      output('stream', {
        'application/vnd.jupyter.stderr': 'Warning message:\n“careful”\n'
      }),
      error('ERROR', "there is no package called 'lme4'")
    ];
    expect(agentOutputs(outputs)).toEqual([
      {
        kind: 'text',
        lines: 3,
        text: '  arm week mean     \n1 A   12   2.6367433\n2 B   24   0.7506944'
      },
      {
        kind: 'text',
        lines: 2,
        text: '    rows patients \n    5837      291 '
      },
      { kind: 'text', lines: 1, text: 'Mean age: 46.4 ' },
      { kind: 'text', lines: 2, text: 'Warning message:\n“careful”' }
    ]);
    // The whole text, for the comparison's check, holds the error too.
    expect(cellOutputText(outputs)).toBe(
      "  arm week mean     \n1 A   12   2.6367433\n2 B   24   0.7506944\n    rows patients \n    5837      291 \nMean age: 46.4 \nWarning message:\n“careful”\nERROR: there is no package called 'lme4'"
    );
  });

  it("gives the agent the log of a SAS cell, which sas_kernel sends as HTML with the object's name as its plain text", () => {
    const log = output('execute_result', {
      'text/plain': '<IPython.core.display.HTML object>',
      'text/html':
        '<html><head><style>.s { color: black }</style></head><body><div class="highlight"><pre>' +
        '<span class="s">1048 rows created in WORK.TITANICTRAINCLEAN from TITANIC.</span><br>' +
        '<span class="s">260 rows created in WORK.TITANICTESTCLEAN from TITANIC2.</span><br>' +
        '</pre></div></body></html>'
    });
    expect(agentOutputs([log])).toEqual([
      {
        kind: 'text',
        lines: 2,
        text: '1048 rows created in WORK.TITANICTRAINCLEAN from TITANIC.\n260 rows created in WORK.TITANICTESTCLEAN from TITANIC2.'
      }
    ]);
    expect(cellOutputText([log])).toBe(
      '1048 rows created in WORK.TITANICTRAINCLEAN from TITANIC.\n260 rows created in WORK.TITANICTESTCLEAN from TITANIC2.'
    );
  });

  it("gives IRkernel's frame its names, not the row of types, and the size of its caption", () => {
    const html = [
      '<table class="dataframe">',
      '<caption>A data.frame: 5837 × 3</caption>',
      '<thead>',
      '\t<tr><th scope=col>arm</th><th scope=col>week</th><th scope=col>mean</th></tr>',
      '\t<tr><th scope=col>&lt;chr&gt;</th><th scope=col>&lt;int&gt;</th><th scope=col>&lt;dbl&gt;</th></tr>',
      '</thead>',
      '<tbody>',
      '\t<tr><td>A</td><td>12</td><td>2.6367433</td></tr>',
      '\t<tr><td>B</td><td>24</td><td>0.7506944</td></tr>',
      '</tbody>',
      '</table>'
    ].join('\n');
    const [table] = agentOutputs([
      output('display_data', {
        'text/html': html,
        'text/plain':
          'A data.frame: 5837 × 3\n  arm week mean\n  <chr> <int> <dbl>\n1 A   12   2.6367433'
      })
    ]);
    expect(table).toMatchObject({
      kind: 'table',
      rows: 5837,
      cols: 3,
      columns: ['arm', 'week', 'mean']
    });
    expect(table.text).toContain('A data.frame: 5837 × 3');
  });

  it("names each table of SAS's ODS HTML in the text, which has no plain form", () => {
    const html =
      '<section data-name="Mixed"><table class="table" aria-label="Solution for Fixed Effects"><caption aria-label="Solution for Fixed Effects"></caption>' +
      '<thead><tr><th scope="col">Effect</th><th scope="col">Estimate</th><th scope="col">Standard Error</th></tr></thead>' +
      '<tbody><tr><th>Intercept</th><td>3.1204</td><td>0.2011</td></tr><tr><th>arm B</th><td>-0.8570</td><td>0.1600</td></tr></tbody></table>' +
      '<table class="table" aria-label="Covariance Parameter Estimates"><thead><tr><th>Cov Parm</th><th>Estimate</th></tr></thead>' +
      '<tbody><tr><th>Intercept</th><td>1.2000</td></tr></tbody></table></section>';
    const [table] = agentOutputs([
      output('display_data', { 'text/html': html })
    ]);
    expect(table.text).toBe(
      'Solution for Fixed Effects\nEffect | Estimate | Standard Error\nIntercept | 3.1204 | 0.2011\narm B | -0.8570 | 0.1600\n\nCovariance Parameter Estimates\nCov Parm | Estimate\nIntercept | 1.2000'
    );
    expect(table.columns).toEqual(['Effect', 'Estimate', 'Standard Error']);
  });

  it("reads the numbers of a plot of the view's own, which prints none", () => {
    const ribbon = output('display_data', {
      'application/vnd.whybook.plot+json': {
        version: 1,
        kind: 'ribbon',
        title: 'Weekly pain',
        x: { label: 'week' },
        y: { label: 'pain_score' },
        source: {
          frame: 'weekly',
          x: 'week',
          y: 'pain_score',
          by: 'treatment_arm',
          rows: 5837
        },
        select: 'x',
        series: [
          {
            name: 'B',
            points: [
              { x: 12, y: 0.750694444, lo: 0.5901108, hi: 0.92855489, n: 144 }
            ]
          }
        ]
      },
      'image/png': 'iVBOR'
    });
    expect(cellOutputText([ribbon])).toBe(
      'B week 12: 0.750694444 (0.5901108 to 0.92855489), n 144'
    );
    // A picture of another library holds no numbers the view reads.
    expect(
      cellOutputText([output('display_data', { 'image/png': 'iVBOR' })])
    ).toBe('');
  });

  it('keeps the whole text of a long output for the check, which the agent reads cut', () => {
    const long = `${'x'.repeat(RESULT_TEXT)} 0.7507`;
    const outputs = [
      output('stream', { 'application/vnd.jupyter.stdout': long })
    ];
    expect(agentOutputs(outputs)[0].text).not.toContain('0.7507');
    expect(cellOutputText(outputs)).toContain('0.7507');
  });
});

describe('a run that works in a notebook it made', () => {
  const run = (patch: Partial<IAgentRun>): IAgentRun => ({
    id: 'r',
    stripId: 'a',
    question: 'Would I get the same results in R?',
    anchor: null,
    state: 'done',
    steps: [],
    notes: [],
    thinking: null,
    answer: null,
    answerCells: [],
    followUp: [],
    by: null,
    costUsd: null,
    error: null,
    started: 0,
    keepLocal: false,
    ...patch
  });
  const R_NOTEBOOK = 'pain_diary/pain_diary_cohort.R.ipynb';
  const step = (cells: string[], notebook?: string) => ({
    call: 'c',
    tool: 'run_cell' as const,
    title: 't',
    why: '',
    cells,
    ...(notebook ? { notebook } : {}),
    state: 'done' as const,
    error: null
  });
  const made = {
    path: R_NOTEBOOK,
    kernel: 'xr',
    displayName: 'R 4.4.3 (xr)',
    label: 'R',
    sandboxed: false,
    intro: 'intro'
  };

  it('counts the cells of each notebook, and names the kernel of the one it made', () => {
    const steps = [
      step(['r1', 'r2'], R_NOTEBOOK),
      step(['r3'], R_NOTEBOOK),
      { ...step(['cmp']), tool: 'compare' as const }
    ];
    expect(runStatus(run({ steps, notebooks: [made] }))).toBe(
      'Answered with 1 cell here and 3 cells in pain_diary_cohort.R.ipynb · R 4.4.3 (xr)'
    );
    expect(
      runStatus(
        run({ state: 'working', steps: steps.slice(0, 1), notebooks: [made] })
      )
    ).toBe('Working · 2 cells in pain_diary_cohort.R.ipynb so far');
  });

  it('writes an R module for a notebook whose kernel runs R', () => {
    expect(agentFilePath('study/pain.R.ipynb', 'models.R', 'R')).toEqual({
      path: 'study/models.R',
      name: 'models.R'
    });
    expect(agentFilePath('study/pain.R.ipynb', 'models.py', 'R')).toEqual({
      error: 'only an R module, a name ending in .R'
    });
    expect('error' in agentFilePath('study/pain.ipynb', 'models.R')).toBe(true);
  });
});
