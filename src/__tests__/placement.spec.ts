/**
 * Where a new cell goes (design iteration 1.74, src/model/placement.ts), in
 * notebooks shaped like two that went wrong in testing: the pain diary, where the second and third agents' runs went above the first run's
 * cells that they read, and the home energy data, where a template's cell
 * went between the cells of an agent's run.
 */
import type { IPlacedCell } from '../model/placement';
import { ownNames, placeAfter } from '../model/placement';
import type { IFakeCell } from './fakes/model-fake';
import { fakeModel, ids, settle, until } from './fakes/model-fake';

/** The names that a cell assigns and imports, as the kernel's analysis lists them. */
function analysisOf(source: string) {
  const defs = new Set<string>();
  for (const line of source.split('\n')) {
    const assigned = /^(\w+)\s*=(?!=)/.exec(line);
    if (assigned) {
      defs.add(assigned[1]);
    }
    const imported = /^import\s+(\w+)(?:\s+as\s+(\w+))?/.exec(line);
    if (imported) {
      defs.add(imported[2] ?? imported[1]);
    }
  }
  return {
    defs: [...defs],
    uses: [],
    formulas: [],
    columns: {},
    decisions: [],
    attachments: []
  };
}

describe('placeAfter', () => {
  const cell = (id: string, patch: Partial<IPlacedCell> = {}): IPlacedCell => ({
    id,
    branchOf: null,
    run: null,
    ran: true,
    defs: [],
    ...patch
  });

  it('puts a new cell after the last cell that ran, below the cell asked about', () => {
    const cells = [
      cell('load', { defs: ['visits'] }),
      cell('within'),
      cell('r1a', { run: 'r1', defs: ['conn', 'tables'] }),
      cell('r1b', { run: 'r1' })
    ];
    expect(placeAfter(cells, { below: 'within', code: 'visits.head()' })).toBe(
      'r1b'
    );
    expect(placeAfter(cells, { below: 'r1b' })).toBe('r1b');
  });

  it('puts a new cell after the first cell that defines a name it reads, when none above does', () => {
    const cells = [
      cell('load', { ran: false, defs: ['visits'] }),
      cell('plot', { ran: false }),
      cell('tables', { ran: false, defs: ['conn', 'tables'] }),
      cell('again', { ran: false, defs: ['visits'] })
    ];
    expect(
      placeAfter(cells, { below: 'load', code: 'print(tables, conn)' })
    ).toBe('tables');
    // visits is defined above already: the cell that defines it again
    // below has not run, and the new cell read the value from above.
    expect(placeAfter(cells, { below: 'plot', code: 'visits.head()' })).toBe(
      'plot'
    );
    // A name in a comment, a name it imports, and an attribute are no reads.
    expect(
      placeAfter(cells, {
        below: 'load',
        code: '# from tables\nimport conn\nx.tables'
      })
    ).toBe('load');
  });

  it('never puts a new cell between the cells of one run', () => {
    const cells = [
      cell('e1'),
      cell('e5', { run: 'r2', ran: false }),
      cell('e9', { ran: false }),
      cell('e6', { run: 'r2', ran: false }),
      cell('e7', { run: 'r2', ran: false }),
      cell('e8', { run: 'r2', ran: false })
    ];
    expect(placeAfter(cells, { below: 'e5' })).toBe('e8');
    // A notebook where a cell split the run already: past its end too.
    expect(placeAfter(cells, { below: 'e9' })).toBe('e8');
    expect(placeAfter(cells, { below: 'e1' })).toBe('e1');
  });

  it("puts a run's next cell right after the run's last cell", () => {
    const cells = [
      cell('a1', { run: 'A' }),
      cell('b1', { run: 'B' }),
      cell('t', { ran: true })
    ];
    // B and a template ran after A's first cell: A's cells stay together.
    expect(
      placeAfter(cells, {
        below: 'a1',
        code: 'x = 1',
        run: { id: 'A', later: true }
      })
    ).toBe('a1');
    // Its first cell goes after the last cell that ran.
    expect(
      placeAfter(cells, { below: 'a1', run: { id: 'C', later: false } })
    ).toBe('t');
  });

  it("goes after a cell's branches, and counts a branch that ran as its cell", () => {
    const cells = [
      cell('fit'),
      cell('fit_b', { branchOf: 'fit' }),
      cell('plot', { ran: false }),
      cell('plot_b', { branchOf: 'plot', ran: true, defs: ['late'] })
    ];
    expect(placeAfter(cells, { below: 'fit' })).toBe('plot');
    expect(placeAfter(cells, { below: 'fit_b' })).toBe('plot');
  });

  it('leaves the place to the end of the notebook when nothing places it', () => {
    expect(placeAfter([cell('a', { ran: false })], { below: null })).toBe(null);
    expect(placeAfter([], { below: 'gone' })).toBe(null);
  });

  it('reads the imports and definitions of the code as its own', () => {
    expect([
      ...ownNames(
        'import pandas as pd, numpy\nfrom scipy import stats as st, linalg\nimport a.b\ndef fit(x):\n    pass\nclass Model:\n    pass'
      )
    ]).toEqual(['pd', 'numpy', 'st', 'linalg', 'a', 'fit', 'Model']);
  });
});

/**
 * A view model over a notebook whose cells ran in this kernel, in their
 * order: each new run gets the next count.
 */
function session(cells: IFakeCell[], options: { ran?: boolean } = {}) {
  const { nb, model } = fakeModel(cells);
  let count = Math.max(0, ...cells.map(each => each.count ?? 0));
  const ran: string[] = [];
  model.jobs = {
    run: async (cell: any) => {
      cell.executionCount = ++count;
      ran.push(cell.sharedModel.getSource());
      return { ok: true };
    }
  };
  // Every code ran in this kernel, or none did, as after a restart.
  model.bridge.hasRun = () => options.ran !== false;
  model.bridge.analysis = (_id: string, source: string) => analysisOf(source);
  model._refresher = { invoke: () => Promise.resolve() };
  model.aiReady = () => true;
  model.runCell = jest.fn(async () => undefined);
  return { nb, model, ran };
}

/** The agent's route: each run of `runs` gives its cells, one tool call each. */
function agentRoute(model: any, runs: string[][]) {
  const posted: Record<string, unknown>[] = [];
  let next = 0;
  model.api = {
    agent: async (
      _body: unknown,
      onEvent: (event: unknown) => void
    ): Promise<void> => {
      const run = `r${next + 2}`;
      const codes = runs[next++] ?? [];
      onEvent({ type: 'started', run, keep_local: false });
      codes.forEach((code, index) =>
        onEvent({
          type: 'tool',
          run,
          call: `${run}-${index}`,
          name: 'run_cell',
          input: { code, title: `Step ${index + 1}`, why: '' }
        })
      );
      onEvent({ type: 'result', answer: 'Done.', cells: [], follow_up: [] });
    },
    agentResult: async (body: Record<string, unknown>) => {
      posted.push(body);
    }
  };
  return posted;
}

/** A question that needs AI, about a cell, as a drop or a follow-up asks it. */
function question(text: string, cellId: string, label: string) {
  return {
    id: `q:${text}`,
    text,
    type: 'descriptive',
    origin: 'claude',
    probability: null,
    reasons: [],
    placement: {
      kind: 'new',
      cell: cellId,
      label: `a new cell in Notebook, after ${label}`
    },
    code: null
  };
}

/** A template's question about a cell, with its code. */
function template(text: string, cellId: string, label: string, code: string) {
  return {
    ...question(text, cellId, label),
    origin: 'template',
    code
  };
}

/**
 * Whether the notebook runs from the top: each name that a cell reads is
 * defined by a cell above it, or by the cell itself.
 */
function readsBeforeDefined(nb: any): string[] {
  const sources = Array.from(nb.cells as Iterable<any>).map(cell =>
    cell.sharedModel.getSource()
  );
  const defined = sources.map(source => analysisOf(source).defs);
  const late: string[] = [];
  sources.forEach((source, index) => {
    defined.forEach((names, at) => {
      for (const name of names) {
        const above = defined.slice(0, index + 1).some(d => d.includes(name));
        if (
          at > index &&
          !above &&
          new RegExp(`(^|[^\\w.])${name}(?!\\w)`).test(source)
        ) {
          late.push(`${index + 1} reads ${name}`);
        }
      }
    });
  });
  return late;
}

// The pain diary notebook of the first pass, after the first agent's run.
const LOAD =
  'import sqlite3\nimport pandas as pd\nvisits = pd.read_sql(\'SELECT * FROM "visits"\', sqlite3.connect("clinic.sqlite"))';
const WITHIN =
  'import whybook\nwhybook.within_between(visits, "week", "analgesic_dose_mg", by="patient_id")';
const TABLES =
  'conn = sqlite3.connect("clinic.sqlite")\ntables = conn.execute("SELECT name FROM sqlite_master").fetchall()\ntables';
const PRAGMA = 'pd.read_sql("PRAGMA table_info(visits)", conn)';
const pain = (): IFakeCell[] => [
  { id: 'load', source: LOAD, count: 1, meta: { template: true } },
  { id: 'within', source: WITHIN, count: 2, meta: { template: true } },
  { id: 'r1a', source: TABLES, count: 3, meta: { agent: { run: 'r1' } } },
  { id: 'r1b', source: PRAGMA, count: 4, meta: { agent: { run: 'r1' } } }
];
// Run 2 reads conn and tables, which only run 1 makes; run 3 reads visits.
const RUN2 = [
  'for (name,) in tables:\n    print(name, pd.read_sql(f\'SELECT * FROM "{name}" LIMIT 1\', conn).columns.tolist())',
  'df = pd.read_sql(\'SELECT * FROM "sites"\', conn)\ndf'
];
const RUN3 = [
  'slopes = visits.groupby("patient_id").apply(lambda g: g.analgesic_dose_mg.diff().mean())\nslopes.describe()'
];

describe('the cells of an agent run about a cell that earlier runs follow', () => {
  it('go after the cells of the earlier run that they read, and the next run after them', async () => {
    const { nb, model } = session(pain());
    agentRoute(model, [RUN2, RUN3]);
    await model.apply(
      question('Does treatment arm moderate how crp changes?', 'within', '[2]')
    );
    await until(() => nb.cells.length === 6);
    await settle();
    const run2 = ids(nb).slice(4);
    expect(ids(nb).slice(0, 4)).toEqual(['load', 'within', 'r1a', 'r1b']);
    await model.apply(
      question(
        'How does analgesic_dose_mg evolve over the weeks, per patient?',
        'within',
        '[2]'
      )
    );
    await until(() => nb.cells.length === 7);
    await settle();
    // Read from the top, the runs come in the order they ran.
    expect(ids(nb).slice(0, 6)).toEqual([
      'load',
      'within',
      'r1a',
      'r1b',
      ...run2
    ]);
    expect(readsBeforeDefined(nb)).toEqual([]);
  });

  it('show their strip above their first cell, and bring it into sight', async () => {
    const { nb, model } = session(pain());
    agentRoute(model, [RUN2]);
    await model.apply(
      question('Does treatment arm moderate how crp changes?', 'within', '[2]')
    );
    await until(() => nb.cells.length === 6);
    await settle();
    // No strip under the cell asked about: it shows under [4], the cell
    // that the run's first cell went after, from the start of the run.
    expect(model.strips.has('within')).toBe(false);
    const strip = model.strips.get('r1b');
    expect(strip.agent.question).toBe(
      'Does treatment arm moderate how crp changes?'
    );
    expect(strip.agent.anchor).toBe('within');
    expect(strip.agent.stripId).toBe('r1b');
    expect(model.stripToShow).toBe('r1b');
    // The run's cells say where they went.
    const placed = nb.cells.get(4).getMetadata('whybook').placement;
    expect(placed).toMatchObject({ kind: 'new', cell: 'r1b' });
  });

  it('show their strip where it showed when the history draws it again', async () => {
    const { nb, model } = session(pain());
    agentRoute(model, [RUN2]);
    await model.apply(
      question('Does treatment arm moderate how crp changes?', 'within', '[2]')
    );
    await until(() => nb.cells.length === 6);
    await settle();
    const run = model.agentRuns.find((each: any) => each.id === 'r2');
    model.dismissAgent(run);
    expect(model.strips.has('r1b')).toBe(false);
    await model.openRun('r2');
    expect(model.strips.get('r1b').agent).toMatchObject({
      id: 'r2',
      anchor: 'within'
    });
    expect(model.strips.has('within')).toBe(false);
  });

  it('show their strip with their first cell while another strip holds the cell they go after', async () => {
    const { nb, model } = session(pain());
    agentRoute(model, [RUN2]);
    // A finished answer's strip under [4].
    model.strips.set('r1b', { cellId: 'r1b', status: 'done' });
    await model.apply(
      question('Does treatment arm moderate how crp changes?', 'within', '[2]')
    );
    await until(() => nb.cells.length === 6);
    await settle();
    const first = ids(nb)[4];
    expect(model.strips.get('r1b')).toEqual({
      cellId: 'r1b',
      status: 'done'
    });
    expect(model.strips.get(first).agent.stripId).toBe(first);
    expect(model.stripToShow).toBe(first);
  });

  it('go right after the cell asked about when it is the last cell that ran, as before', async () => {
    const { nb, model } = session(pain());
    agentRoute(model, [RUN3]);
    await model.apply(question('Does dose drift by week?', 'r1b', '[4]'));
    await until(() => nb.cells.length === 5);
    await settle();
    expect(ids(nb).slice(0, 4)).toEqual(['load', 'within', 'r1a', 'r1b']);
    expect(model.strips.get('r1b').agent.question).toBe(
      'Does dose drift by week?'
    );
  });
});

// The home energy notebook of the first pass: the agent's second run is
// [5] to [8], and the template is asked about [5].
const energy = (): IFakeCell[] => [
  {
    id: 'e1',
    source:
      'import pandas as pd\nreadings = pd.read_parquet("readings.parquet")',
    count: 1,
    meta: { template: true }
  },
  {
    id: 'e2',
    source:
      'homes = pd.read_csv("homes.csv")\nreadings_homes = readings.merge(homes, on="home_id", how="left")',
    count: 2,
    meta: { template: true }
  },
  {
    id: 'e3',
    source: 'readings.kwh_import.describe()',
    count: 3,
    meta: { agent: { run: 'r1' } }
  },
  {
    id: 'e4',
    source: 'readings_homes.groupby("tariff").kwh_peak.mean()',
    count: 4,
    meta: { template: true }
  },
  {
    id: 'e5',
    source:
      'df = readings_homes[readings_homes.kwh_import < 999].copy()\ndf["peak_share"] = df.kwh_peak / df.kwh_import',
    count: 5,
    meta: { agent: { run: 'r2' } }
  },
  {
    id: 'e6',
    source: 'tou_dates = df.tou_start.dropna().unique()',
    count: 6,
    meta: { agent: { run: 'r2' } }
  },
  {
    id: 'e7',
    source: 'cutoff = pd.Timestamp("2025-06-01")',
    count: 7,
    meta: { agent: { run: 'r2' } }
  },
  {
    id: 'e8',
    source: 'did = df.groupby(["tariff", df.date >= cutoff]).peak_share.mean()',
    count: 8,
    meta: { agent: { run: 'r2' } }
  }
];
const CROSSTAB =
  'pd.crosstab(readings_homes.tariff, readings_homes.has_ev, normalize="index")';

describe("a template's cell asked about a cell inside an agent's run", () => {
  it("goes after the run's last cell, and its strip goes with it", async () => {
    const { nb, model } = session(energy());
    await model.apply(
      template('Are tariff and has_ev independent?', 'e5', '[5]', CROSSTAB)
    );
    expect(ids(nb).slice(0, 8)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
      'e6',
      'e7',
      'e8'
    ]);
    const added = ids(nb)[8];
    // The strip shows right above the new cell, under [8], and comes into sight.
    expect(model.strips.has('e5')).toBe(false);
    const strip = model.strips.get('e8');
    expect(strip.status).toBe('done');
    expect(strip.insertedId).toBe(added);
    expect(strip.placement).toMatchObject({
      kind: 'new',
      cell: 'e8',
      label: 'new cell after [8]'
    });
    expect(model.stripToShow).toBe('e8');
  });

  it('goes after the run in a notebook opened again, before any cell ran', async () => {
    const { nb, model } = session(energy(), { ran: false });
    // Before any cell ran, a cell that no run holds keeps its answer right
    // after it, with the strip under it.
    const plot = 'readings_homes.plot.scatter("floor_area_m2", "kwh_import")';
    await model.apply(
      template('Plot floor_area_m2 against kwh_import', 'e2', '[2]', plot)
    );
    expect(ids(nb).slice(0, 2)).toEqual(['e1', 'e2']);
    expect(nb.cells.get(2).sharedModel.getSource()).toBe(plot);
    expect(model.strips.get('e2').placement.cell).toBe('e2');
    // A cell of the run keeps its answer after the run's last cell.
    await model.apply(
      template('Are tariff and has_ev independent?', 'e5', '[5]', CROSSTAB)
    );
    expect(ids(nb).indexOf('e8')).toBe(ids(nb).length - 2);
    expect(nb.cells.get(ids(nb).length - 1).sharedModel.getSource()).toBe(
      CROSSTAB
    );
  });

  it('goes after a cell that the view ran, while the kernel has not listed it yet', async () => {
    const { nb, model } = session(energy(), { ran: false });
    const plot = 'readings_homes.plot.scatter("floor_area_m2", "kwh_import")';
    await model.apply(
      template('Plot floor_area_m2 against kwh_import', 'e2', '[2]', plot)
    );
    const added = ids(nb)[2];
    // The bridge counts the code as run only after its next listing.
    expect(model.cell(added).lastRun).toBe(true);
    const box = template(
      'Box plot of kwh_import by tariff',
      'e1',
      '[1]',
      'readings_homes.boxplot("kwh_import", by="tariff")'
    );
    expect(model.placementFor(box).label).toBe(
      `new cell after ${model.cell(added).label}`
    );
  });

  it('shows in the list where it will go', () => {
    const { model } = session(energy());
    const option = template(
      'Are tariff and has_ev independent?',
      'e5',
      '[5]',
      CROSSTAB
    );
    expect(model.placementFor(option)).toEqual({
      kind: 'new',
      cell: 'e5',
      label: 'new cell after [8]'
    });
    // A question about the last cell that ran keeps the server's words.
    const last = template('Summarise did', 'e8', '[8]', 'did.describe()');
    expect(model.placementFor(last)).toBe(last.placement);
  });
});

describe('the questions that a model wrote for a request asked again', () => {
  it('go where the questions of the request go now', () => {
    const { model } = session(pain());
    model.settings.modelQuestions = 'always';
    model.settings.offeredQuestions = 10;
    const home = {
      kind: 'new',
      cell: 'r1b',
      label: 'a new cell in Notebook, after [4]'
    };
    const ask: any = {
      id: 1,
      kind: 'drop',
      anchor: null,
      loading: false,
      error: null,
      source: {
        kind: 'column',
        name: 'visits["week"]',
        label: 'week',
        parent: 'visits'
      },
      target: {
        item: {
          kind: 'column',
          name: 'visits["analgesic_dose_mg"]',
          label: 'analgesic_dose_mg',
          parent: 'visits'
        }
      },
      modifiers: { branch: false, parallel: false },
      result: {
        title: 'week + analgesic_dose_mg',
        note: null,
        mode: 'auto',
        options: [
          template(
            'Are week and analgesic_dose_mg associated?',
            'r1b',
            '[4]',
            'whybook.within_between(visits, "week", "analgesic_dose_mg")'
          )
        ],
        placements: [home],
        preselected: []
      },
      checked: [],
      claudeStage: null
    };
    // The model wrote its question when the request's place was after [1].
    const cached = question('Is the dose recorded as taken?', 'load', '[1]');
    model._fromModel = new Map([
      [model._requestKey(ask), { added: [cached], order: null }]
    ]);
    model._askModelToo(ask);
    const shown = ask.result.options.find(
      (option: any) => option.text === 'Is the dose recorded as taken?'
    );
    expect(shown.placement).toEqual(home);
    expect(model.placementFor(shown).label).toBe(
      model.placementFor(ask.result.options[0]).label
    );
  });

  it('show where a cell of theirs goes, even from an old place', () => {
    const { model } = session(pain());
    const cached = question('Is the dose recorded as taken?', 'load', '[1]');
    expect(model.placementFor(cached)).toEqual({
      ...cached.placement,
      label: 'new cell after [4]'
    });
  });
});
