/**
 * An agent's run that works in a notebook it made (design iteration 1.69,
 * src/model/epimodel.ts): "Would I get the same results in R?" makes a
 * notebook beside the first with the R kernel, the first kernel writes the
 * frames to files, the cells run in the R notebook, and the comparison comes
 * back to the first notebook as a text cell. One run spans both notebooks:
 * the list of runs holds it for both, Stop stops it in the notebook where
 * its cell runs, and Remove takes the R notebook and the files away, with
 * Undo. The models of both notebooks are fakes over real notebook models,
 * and a fake host stands in for JupyterLab's commands.
 */
import './fakes/quiet';

import { Notification } from '@jupyterlab/apputils';
import type { ICodeCellModel } from '@jupyterlab/cells';
import type * as nbformat from '@jupyterlab/nbformat';

import type { IAgentEvent, IAgentRun } from '../model/agent';
import { cellType } from '../model/agent';
import { AgentRuns } from '../model/runs';
import type { IFakeCell } from './fakes/model-fake';
import { fakeModel, settle, sources, until } from './fakes/model-fake';

const FIRST = 'pain_diary/pain_diary_cohort.ipynb';
const SECOND = 'pain_diary/pain_diary_cohort.R.ipynb';
const QUESTION = 'Would I get the same results in R?';

const IPYKERNEL = [
  'python',
  '-m',
  'ipykernel_launcher',
  '-f',
  '{connection_file}'
];
const XR = ['/opt/xeus-r/bin/xr', '-f', '{connection_file}'];
const SPECS = {
  python3: {
    name: 'python3',
    display_name: 'Python 3 (ipykernel)',
    language: 'python',
    argv: IPYKERNEL
  },
  xr: { name: 'xr', display_name: 'R 4.4.3 (xr)', language: 'R', argv: XR },
  'sas-licence-needed': {
    name: 'sas-licence-needed',
    display_name: 'SAS (licence needed)',
    language: 'sas',
    argv: ['python', '{resource_dir}/sas.py', '-f', '{connection_file}']
  }
};

/** The session of a notebook whose kernel is `name`, and the server's kernelspecs. */
function session(name: string, language: string) {
  return {
    session: {
      kernel: {
        name,
        interrupt: jest.fn(async () => undefined),
        info: Promise.resolve({ language_info: { name: language } })
      }
    },
    specsManager: { specs: { default: 'python3', kernelspecs: SPECS } }
  };
}

/** The server's files: a folder's listing, and each file's content. */
function server(files: Record<string, string>) {
  const listing = (dir: string) =>
    Object.keys(files)
      .filter(path => path.slice(0, path.lastIndexOf('/')) === dir)
      .map(path => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        type: path.endsWith('.ipynb') ? 'notebook' : 'file',
        size: files[path].length
      }));
  const dirs = () =>
    new Set(
      Object.keys(files).map(path => path.slice(0, path.lastIndexOf('/')))
    );
  return {
    files,
    get: jest.fn(async (path: string, options: { content?: boolean } = {}) => {
      if (path in files) {
        return {
          path,
          type: 'file',
          content: options.content ? files[path] : null
        };
      }
      if (dirs().has(path)) {
        return { path, type: 'directory', content: listing(path) };
      }
      throw new Error(`no file ${path}`);
    }),
    save: jest.fn(
      async (path: string, model: { type: string; content?: unknown }) => {
        if (model.type !== 'directory') {
          files[path] =
            typeof model.content === 'string'
              ? model.content
              : JSON.stringify(model.content);
        }
        return { path };
      }
    ),
    delete: jest.fn(async (path: string) => {
      delete files[path];
    })
  };
}

function output(cell: ICodeCellModel, value: nbformat.IOutput): void {
  cell.outputs.add(value);
}

/**
 * The first notebook, in Python, after Run all: [4] prints the weekly
 * means, and [5] the mixed model's estimates.
 */
function firstNotebook(runs: AgentRuns, contents: ReturnType<typeof server>) {
  const cells: IFakeCell[] = [
    { id: 'title', type: 'markdown', source: '# Pain diary cohort' },
    {
      id: 'weekly',
      count: 4,
      source:
        'weekly = diary.groupby(["treatment_arm", "week"]).pain_score.mean()\nweekly'
    },
    {
      id: 'lmm',
      count: 5,
      source:
        'lmm_fit = smf.mixedlm("pain_score ~ treatment_arm * month", model_data, groups="patient_id", re_formula="~month").fit()\nlmm_fit.params'
    }
  ];
  const { nb, model } = fakeModel(cells);
  output(nb.cells.get(1) as ICodeCellModel, {
    output_type: 'execute_result',
    execution_count: 4,
    metadata: {},
    data: {
      'text/plain': 'treatment_arm  week\nB              12      0.750694\n'
    }
  });
  output(nb.cells.get(2) as ICodeCellModel, {
    output_type: 'execute_result',
    execution_count: 5,
    metadata: {},
    data: {
      'text/plain':
        'treatment_arm[T.B]         -0.857\ntreatment_arm[T.B]:month   -0.318\n'
    }
  });
  Object.assign(model.context, {
    path: FIRST,
    sessionContext: session('python3', 'python'),
    save: jest.fn(async () => undefined)
  });
  const written: Record<string, unknown>[] = [];
  model.bridge = {
    ...model.bridge,
    languageName: 'python',
    language: { label: 'Python', snippets: { write_frames: 'code' } },
    run: jest.fn(async (name: string, args: Record<string, unknown>) => {
      written.push({ name, args });
      const frames = args.frames as string[];
      contents.files[`pain_diary/from_python/${frames[0]}.csv`] = 'a,b\n1,2\n';
      return {
        folder: 'from_python',
        files: [
          {
            frame: frames[0],
            path: `from_python/${frames[0]}.csv`,
            format: 'csv',
            rows: 56,
            columns: [{ name: 'week', type: 'int64' }],
            existed: false
          }
        ],
        errors: frames
          .slice(1)
          .map(frame => ({ frame, error: `no variable named ${frame}` }))
      };
    })
  };
  model.aiReady = () => true;
  model._listed = async () => undefined;
  model._runs = runs;
  model._contentsManager = contents;
  return { nb, model, written };
}

/** The R notebook that the fake host makes: an empty notebook whose cells R runs. */
function secondNotebook(runs: AgentRuns, path: string) {
  const { nb, model } = fakeModel([]);
  Object.assign(model.context, {
    path,
    sessionContext: session('xr', 'R'),
    save: jest.fn(async () => undefined)
  });
  let count = 0;
  model.bridge = {
    ...model.bridge,
    languageName: 'R',
    language: { label: 'R', snippets: {} },
    run: jest.fn(async () => ({
      language: 'R 4.4.3',
      parquet: false,
      packages: ['base', 'stats']
    }))
  };
  // R runs a cell: the frame's means print, and lme4 is missing.
  model._run = async (cell: ICodeCellModel) => {
    cell.executionCount = ++count;
    if (cell.sharedModel.getSource().includes('lme4')) {
      output(cell, {
        output_type: 'error',
        ename: 'ERROR',
        evalue: "there is no package called 'lme4'",
        traceback: []
      });
      return { ok: false, error: "ERROR: there is no package called 'lme4'" };
    }
    output(cell, {
      output_type: 'execute_result',
      execution_count: count,
      metadata: {},
      data: { 'text/plain': '  arm week mean     \n1 B   12   0.750694444' }
    });
    return { ok: true, error: null };
  };
  model.refresh = async () => undefined;
  model._runs = runs;
  model._listedRuns = new WeakSet();
  return { nb, model };
}

/** The first notebook with a host that makes the R notebook, and the run's stream fed by the test. */
async function asked() {
  const runs = new AgentRuns();
  const contents = server({
    [FIRST]: '{}',
    'pain_diary/prep.py': 'MIN_DAYS = 14\n',
    'pain_diary/diary.csv': 'patient_id,day,pain_score\n'
  });
  const files = contents.files;
  const first = firstNotebook(runs, contents);
  let second: ReturnType<typeof secondNotebook> | null = null;
  let removed = false;
  const host = {
    create: jest.fn(async (options: { path: string }) => {
      second = secondNotebook(runs, options.path);
      files[options.path] = '{}';
      return second.model;
    }),
    show: jest.fn(async () => undefined),
    modelOf: jest.fn((path: string) =>
      second && !removed && second.model.context.path === path
        ? second.model
        : null
    ),
    remove: jest.fn(async (path: string) => {
      removed = true;
      delete files[path];
    })
  };
  runs.host = host;
  const posted: Record<string, any>[] = [];
  const stream: {
    body: Record<string, any> | null;
    signal: AbortSignal | null;
    deliver: (event: IAgentEvent | Record<string, unknown>) => void;
    finish: () => void;
  } = {
    body: null,
    signal: null,
    deliver: () => undefined,
    finish: () => undefined
  };
  first.model.api = {
    agent: (
      body: Record<string, any>,
      onEvent: (event: unknown) => void,
      signal: AbortSignal
    ) => {
      stream.body = body;
      stream.signal = signal;
      stream.deliver = onEvent;
      return new Promise<void>((resolve, reject) => {
        stream.finish = resolve;
        signal.addEventListener('abort', () =>
          reject(new DOMException('The request was aborted', 'AbortError'))
        );
      });
    },
    agentResult: async (body: Record<string, any>) => {
      posted.push(body);
    },
    agentStop: jest.fn(async () => undefined)
  };
  const [question] = first.model.kernelQuestions();
  const ending = first.model.askInKernel(question);
  await until(() => stream.body !== null);
  stream.deliver({ type: 'started', run: 'r1', keep_local: false });
  await settle();
  const run = first.model.agentRuns[0] as IAgentRun;
  const tool = async (
    call: string,
    name: string,
    input: Record<string, unknown>
  ) => {
    const before = posted.length;
    stream.deliver({ type: 'tool', run: 'r1', call, name, input });
    await until(() => posted.length > before);
    return posted[posted.length - 1].result;
  };
  return {
    runs,
    files,
    first,
    second: () => second!,
    host,
    stream,
    posted,
    run,
    tool,
    ending,
    question,
    written: first.written
  };
}

describe('a run that answers in a notebook of its own', () => {
  it('asks with the kernels, the folder, the notebook with its outputs and the kernel it names', async () => {
    const { stream, question } = await asked();
    expect(question.text).toBe(QUESTION);
    expect(question.kernel.name).toBe('xr');
    const body = stream.body!;
    expect(body.compare).toEqual({
      kernel: 'xr',
      display_name: 'R 4.4.3 (xr)',
      language: 'R'
    });
    expect(body.kernels).toEqual([
      {
        name: 'python3',
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
        sandboxed: false,
        current: true
      },
      {
        name: 'xr',
        display_name: 'R 4.4.3 (xr)',
        language: 'R',
        sandboxed: false
      },
      {
        name: 'sas-licence-needed',
        display_name: 'SAS (licence needed)',
        language: 'sas',
        sandboxed: false
      }
    ]);
    expect(body.files.map((file: { name: string }) => file.name)).toEqual([
      'pain_diary_cohort.ipynb',
      'prep.py',
      'diary.csv'
    ]);
    expect(body.notebook.name).toBe('pain_diary_cohort.ipynb');
    expect(
      body.notebook.cells.map((cell: { label: string }) => cell.label)
    ).toEqual(['[4]', '[5]']);
    expect(body.notebook.cells[1].outputs[0]).toContain('-0.318');
  });

  it('makes the notebook beside the first with the kernel, and writes its first cell', async () => {
    const { tool, host, second, run, runs } = await asked();
    const made = await tool('c1', 'new_notebook', {
      kernel: 'xr',
      name: 'pain_diary_cohort.R.ipynb',
      why: 'the same analysis in R'
    });
    expect(host.create).toHaveBeenCalledWith({
      path: SECOND,
      kernel: 'xr',
      beside: FIRST
    });
    expect(made).toEqual({
      status: 'ok',
      notebook: 'pain_diary_cohort.R.ipynb',
      kernel: 'R 4.4.3 (xr)',
      language: 'R',
      version: 'R 4.4.3',
      sandboxed: false,
      parquet: false,
      packages: ['base', 'stats']
    });
    const { nb } = second();
    expect(nb.getMetadata('kernelspec')).toEqual({
      name: 'xr',
      display_name: 'R 4.4.3 (xr)',
      language: 'R'
    });
    expect(nb.cells.length).toBe(1);
    const intro = nb.cells.get(0);
    expect(intro.type).toBe('markdown');
    expect(intro.sharedModel.getSource()).toContain(
      `Whybook's agent made this notebook for the question "${QUESTION}", asked in pain_diary_cohort.ipynb.`
    );
    expect((intro.getMetadata('whybook') as any).written_by).toBe('agent');
    expect(run.notebooks?.[0]).toMatchObject({
      path: SECOND,
      kernel: 'xr',
      intro: intro.id,
      parquet: false
    });
    // The list of runs holds the run for both notebooks.
    expect(runs.of(nb)).toHaveLength(1);
    // The R notebook's view shows the run in a line under its first cell.
    second().model._onRuns();
    const strip = second().model.strips.get(intro.id);
    expect(strip.agent).toBe(run);
    expect(strip.elsewhere).toBe(FIRST);
  });

  it('refuses a kernel that is not there, and a name that is taken', async () => {
    const { tool, host } = await asked();
    expect(
      await tool('c1', 'new_notebook', { kernel: 'julia', name: 'x.ipynb' })
    ).toEqual({
      status: 'refused',
      reason: 'no kernel named julia: choose one of "kernels"'
    });
    expect(
      await tool('c3', 'new_notebook', { kernel: 'xr', name: 'prep.py.ipynb' })
    ).toMatchObject({ status: 'ok' });
    expect(host.create).toHaveBeenCalledTimes(1);
  });

  it("runs the agent's cells in the notebook it names, and writes the frames there from the first kernel", async () => {
    const { tool, first, second, run, written } = await asked();
    await tool('c1', 'new_notebook', {
      kernel: 'xr',
      name: 'pain_diary_cohort.R.ipynb'
    });
    const shared = await tool('c2', 'share_frames', {
      frames: ['weekly', 'nope'],
      notebook: 'pain_diary_cohort.R.ipynb'
    });
    expect(written).toEqual([
      {
        name: 'write_frames',
        args: {
          frames: ['weekly', 'nope'],
          folder: 'from_python',
          format: 'csv'
        }
      }
    ]);
    expect(shared).toEqual({
      status: 'ok',
      folder: 'from_python',
      files: [
        {
          frame: 'weekly',
          path: 'from_python/weekly.csv',
          format: 'csv',
          rows: 56,
          columns: [{ name: 'week', type: 'int64' }]
        }
      ],
      errors: [{ frame: 'nope', error: 'no variable named nope' }]
    });
    expect(run.frames).toEqual([
      { path: 'pain_diary/from_python/weekly.csv', existed: false }
    ]);
    const before = sources(first.nb);
    const ran = await tool('c3', 'run_cell', {
      notebook: 'pain_diary_cohort.R.ipynb',
      title: 'Weekly means',
      code: 'weekly <- read.csv("from_python/weekly.csv")\nweekly'
    });
    expect(ran).toMatchObject({ status: 'ok', cell: '[1]' });
    expect(ran.outputs[0].text).toContain('0.750694444');
    // The first notebook has no new cell; the R notebook has the cell.
    expect(sources(first.nb)).toEqual(before);
    expect(sources(second().nb)[1]).toBe(
      'weekly <- read.csv("from_python/weekly.csv")\nweekly'
    );
    const failed = await tool('c4', 'run_cell', {
      notebook: 'pain_diary_cohort.R.ipynb',
      title: 'The mixed model',
      code: 'library(lme4)'
    });
    expect(failed).toMatchObject({
      status: 'error',
      error: "ERROR: there is no package called 'lme4'"
    });
    expect(run.steps.map(step => [step.tool, step.notebook ?? null])).toEqual([
      ['new_notebook', SECOND],
      ['share_frames', null],
      ['run_cell', SECOND],
      ['run_cell', SECOND]
    ]);
    // A notebook that the run did not make is no place for a cell.
    expect(
      await tool('c5', 'run_cell', { notebook: 'other.ipynb', code: 'x' })
    ).toEqual({
      status: 'error',
      error: 'no notebook other.ipynb in this run: make it with new_notebook'
    });
  });

  it('refuses to write frames from a kernel whose language has no program to write them, as SAS', async () => {
    const { tool, first } = await asked();
    await tool('c1', 'new_notebook', {
      kernel: 'xr',
      name: 'pain_diary_cohort.R.ipynb'
    });
    first.model.bridge = {
      ...first.model.bridge,
      languageName: 'sas',
      language: { label: 'SAS', snippets: {} }
    };
    expect(
      await tool('c2', 'share_frames', {
        frames: ['weekly'],
        notebook: 'pain_diary_cohort.R.ipynb'
      })
    ).toEqual({
      status: 'refused',
      reason:
        'the kernel of pain_diary_cohort.ipynb cannot write files: it runs SAS. Port the reading of the data from its code.'
    });
  });

  it('brings the comparison back as a text cell of the first notebook, checked and marked', async () => {
    const { tool, first, second, run, stream, ending } = await asked();
    await tool('c1', 'new_notebook', {
      kernel: 'xr',
      name: 'pain_diary_cohort.R.ipynb'
    });
    await tool('c2', 'run_cell', {
      notebook: 'pain_diary_cohort.R.ipynb',
      title: 'Weekly means',
      code: 'weekly'
    });
    await tool('c3', 'run_cell', {
      notebook: 'pain_diary_cohort.R.ipynb',
      title: 'The mixed model',
      code: 'library(lme4)\nlmer(pain_score ~ treatment_arm * month + (month | patient_id), model_data)'
    });
    stream.deliver({
      type: 'result',
      answer: 'The weekly means agree; R [2] did not run: no lme4.',
      cells: [],
      follow_up: [],
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      cost_usd: 0.12,
      elapsed: 40,
      comparison: {
        rows: [
          {
            estimate: 'mean pain, week 12, arm B',
            first: { cell: '[4]', value: '0.7507' },
            second: { cell: '[1]', value: '0.7507' }
          },
          {
            estimate: 'arm B × month',
            first: { cell: '[5]', value: '-0.318' },
            second: { cell: '[2]', value: '' },
            note: 'lme4 is not installed'
          }
        ],
        missing: ['lme4']
      }
    });
    stream.finish();
    await ending;
    const last = first.nb.cells.get(first.nb.cells.length - 1);
    expect(last.type).toBe('markdown');
    const text = last.sharedModel.getSource();
    expect(text.split('\n')[0]).toBe(`## ${QUESTION}`);
    expect(text).toContain(
      '| mean pain, week 12, arm B | 0.7507 ([4]) | 0.7507 (R [1]) | 0 |'
    );
    expect(text).toContain(
      '| arm B × month | −0.318 ([5]) | no result: lme4 is not installed |  |'
    );
    // The cells fit a mixed model with a formula, and draw nothing at random.
    expect(text).toContain('- **The degrees of freedom of a mixed model.**');
    expect(text).not.toContain('- **Random draws.**');
    expect(text).toContain('**Missing in R 4.4.3 (xr):** lme4.');
    const meta = last.getMetadata('whybook') as any;
    expect(meta.written_by).toBe('agent');
    expect(meta.agent.run).toBe('r1');
    expect(meta.generated_by.model).toBe('claude-opus-5-5');
    expect(run.comparison?.rows[0].second.found).toBe(true);
    // The strip of the question goes with the text.
    expect(first.model.strips.get(last.id)?.agent).toBe(run);
    // Each notebook keeps the run: the first with its text cell, the R
    // notebook with the cells it wrote there, its first text included.
    const firstRecord = (first.nb.getMetadata('whybook') as any).agent_runs.r1;
    expect(firstRecord).toMatchObject({
      cells: [last.id],
      cost_usd: 0.12,
      state: 'done'
    });
    const secondRecord = (second().nb.getMetadata('whybook') as any).agent_runs
      .r1;
    expect(secondRecord.cells).toHaveLength(3);
    expect(second().model.context.save).toHaveBeenCalled();
    expect(run.state).toBe('done');
  });

  it("gives each cell in the R notebook the type of its own step, and the question's type to the cell that holds the answer", async () => {
    const { tool, second, stream, ending } = await asked();
    await tool('c1', 'new_notebook', {
      kernel: 'xr',
      name: 'pain_diary_cohort.R.ipynb'
    });
    const steps = [
      [
        'Read the weekly means',
        'weekly <- read.csv("from_python/weekly.csv")\nweekly'
      ],
      [
        'Count missing weeks per arm',
        'table(weekly$treatment_arm, is.na(weekly$pain_score))'
      ],
      ['Mean pain, arm B, week 12', 'weekly[weekly$week == 12, ]']
    ];
    for (const [index, [title, code]] of steps.entries()) {
      await tool(`c${index + 2}`, 'run_cell', {
        notebook: 'pain_diary_cohort.R.ipynb',
        title,
        code
      });
    }
    const types = () =>
      second()
        .model.codeCells()
        .map((cell: any) => [cell.label, cellType(cell.meta)]);
    expect(types()).toEqual([
      ['[1]', 'descriptive'],
      ['[2]', 'quality'],
      ['[3]', 'descriptive']
    ]);
    stream.deliver({
      type: 'result',
      answer: 'The weekly means agree: 0.7507 in [4] and in R [3].',
      // [1] alone is a cell of the first notebook, where the run has no
      // cell [1]: R [1] keeps its own type.
      cells: ['R [3]', '[1]'],
      follow_up: [],
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      cost_usd: 0.1,
      elapsed: 30
    });
    stream.finish();
    await ending;
    expect(types()).toEqual([
      ['[1]', 'descriptive'],
      ['[2]', 'quality'],
      ['[3]', 'model']
    ]);
    // The R notebook counts the question once, as a model check.
    const { asked: counted } = second().model.askedCounts();
    expect(
      counted.map((question: any) => [question.text, question.type])
    ).toEqual([[QUESTION, 'model']]);
  });

  it('stops the run where its cell runs: a Python kernel is interrupted, an R kernel is not', async () => {
    const { first, second, tool, run } = await asked();
    await tool('c1', 'new_notebook', {
      kernel: 'xr',
      name: 'pain_diary_cohort.R.ipynb'
    });
    run.steps = [
      ...run.steps,
      {
        call: 'c2',
        tool: 'run_cell',
        title: 'A long fit',
        why: '',
        cells: [],
        notebook: SECOND,
        state: 'running',
        error: null
      }
    ];
    first.model.stopAgent(run);
    expect(
      second().model.sessionContext.session.kernel.interrupt
    ).not.toHaveBeenCalled();
    expect(
      first.model.sessionContext.session.kernel.interrupt
    ).not.toHaveBeenCalled();
    expect(run.state).toBe('stopped');
    expect(first.model.api.agentStop).toHaveBeenCalledWith('r1');
    // A cell of the run in the Python notebook is interrupted, as before.
    run.state = 'working';
    run.steps[run.steps.length - 1].notebook = undefined;
    first.model.stopAgent(run);
    expect(
      first.model.sessionContext.session.kernel.interrupt
    ).toHaveBeenCalled();
  });

  it('removes the R notebook, the frames and the text cell, and Undo puts them back', async () => {
    const { tool, first, second, run, stream, ending, host, files } =
      await asked();
    await tool('c1', 'new_notebook', {
      kernel: 'xr',
      name: 'pain_diary_cohort.R.ipynb'
    });
    await tool('c2', 'share_frames', {
      frames: ['weekly'],
      notebook: 'pain_diary_cohort.R.ipynb'
    });
    await tool('c3', 'run_cell', {
      notebook: 'pain_diary_cohort.R.ipynb',
      title: 'Weekly means',
      code: 'weekly'
    });
    stream.deliver({
      type: 'result',
      answer: 'They agree.',
      cells: [],
      follow_up: [],
      model: 'claude-opus-5-5',
      cost_usd: 0.1,
      elapsed: 20,
      comparison: { rows: [] }
    });
    stream.finish();
    await ending;
    const rNotebook = second().nb.toJSON();
    const cellsBefore = sources(first.nb);
    const emit = jest.spyOn(Notification, 'emit');
    await first.model.discardAgent(run);
    expect(host.remove).toHaveBeenCalledWith(SECOND);
    await until(() => !('pain_diary/from_python/weekly.csv' in files));
    expect(files).not.toHaveProperty(['pain_diary/from_python/weekly.csv']);
    expect(sources(first.nb)).toEqual(cellsBefore.slice(0, -1));
    const [message, , options] = emit.mock.calls[
      emit.mock.calls.length - 1
    ] as [
      string,
      unknown,
      { actions: { label: string; callback: () => void }[] }
    ];
    expect(message).toBe(
      `Removed the cell, pain_diary_cohort.R.ipynb and 1 file that the agent added for "${QUESTION}".`
    );
    options.actions[0].callback();
    await until(() => host.show.mock.calls.length > 0);
    expect(sources(first.nb)).toEqual(cellsBefore);
    expect(JSON.parse(files[SECOND])).toEqual(rNotebook);
    expect(files['pain_diary/from_python/weekly.csv']).toBe('a,b\n1,2\n');
    expect(host.show).toHaveBeenCalledWith(SECOND, null, false);
    emit.mockRestore();
  });

  it("removes from the R notebook's view through the view that runs the run", async () => {
    const { tool, second, run, stream, ending, runs } = await asked();
    await tool('c1', 'new_notebook', {
      kernel: 'xr',
      name: 'pain_diary_cohort.R.ipynb'
    });
    stream.deliver({
      type: 'result',
      answer: 'a',
      cells: [],
      model: 'm',
      cost_usd: 0
    });
    stream.finish();
    await ending;
    const discard = jest.fn(async () => undefined);
    runs.entry(run)!.discard = discard;
    await second().model.discardAgent(run, true);
    expect(discard).toHaveBeenCalledWith(true);
  });
});
