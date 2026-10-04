import {
  callsText,
  capReached,
  cellParts,
  cellRecord,
  cellSeed,
  cellWriter,
  exactUsd,
  formatSeconds,
  formatUsd,
  leftUnder,
  notebookCost,
  parseCap,
  raisedCap,
  recordTotal,
  ROUTE_KINDS,
  seedRecord,
  unpricedOf,
  unpricedText,
  withCall
} from '../model/cost';
import type { IAgentRunRecord, IEpiCellMeta } from '../tokens';

const AT = '2026-09-28T09:00:00.000Z';

/** A cell that a model wrote as an answer of one cell. */
const answer = (
  cost: number | null | undefined,
  seconds?: number
): IEpiCellMeta => ({
  written_by: 'agent',
  generated_by: {
    agent: 'openrouter',
    model: 'anthropic/claude-sonnet-5',
    ...(cost !== undefined ? { cost_usd: cost } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    at: AT
  }
});

/** A cell of an agent's run: the run's record holds the cost. */
const ofRun = (run: string, step: number): IEpiCellMeta => ({
  written_by: 'agent',
  agent: { run, step },
  generated_by: { agent: 'openrouter', model: 'm', cost_usd: null, at: AT }
});

const run = (
  cost: number | null,
  cells: string[],
  extra: Partial<IAgentRunRecord> = {}
): IAgentRunRecord => ({
  question: 'Does pain differ by arm?',
  provider: 'openrouter',
  model: 'm',
  cost_usd: cost,
  cells,
  files: [],
  state: 'done',
  at: AT,
  ...extra
});

const by = { choice: 'remote', model: 'm', at: AT };

describe('the sums of what calls cost', () => {
  it('adds each call once, and counts a call without a price apart', () => {
    let record = withCall(undefined, 'titles', { usd: 0.00041, seconds: 1.2 });
    record = withCall(record, 'titles', { usd: 0.00037, seconds: 0.9 });
    record = withCall(record, 'labels', { usd: null, seconds: 3 });
    expect(record).toEqual({
      titles: { usd: 0.00078, n: 2, seconds: 2.1 },
      labels: { usd: 0, n: 0, unpriced: 1, seconds: 3 }
    });
    expect(recordTotal(record)).toEqual({
      usd: 0.00078,
      priced: 2,
      unpriced: 1
    });
    // $0 is a known price: a model on this machine.
    expect(withCall(undefined, 'order', { usd: 0 })).toEqual({
      order: { usd: 0, n: 1 }
    });
  });

  it('gives a cell its share of a call for several cells, and leaves out the time when asked', () => {
    const record = withCall(
      {},
      'titles',
      { usd: 0.0008, seconds: 4 },
      1 / 8,
      false
    );
    expect(record).toEqual({ titles: { usd: 0.0001, n: 1 } });
  });

  it('keeps sums of prices short', () => {
    let record = withCall(undefined, 'answers', { usd: 0.1 });
    record = withCall(record, 'answers', { usd: 0.2 });
    expect(record.answers!.usd).toBe(0.3);
    expect(JSON.stringify(record)).toBe('{"answers":{"usd":0.3,"n":2}}');
  });

  it('knows the kind of every route that calls a model', () => {
    expect(ROUTE_KINDS).toEqual({
      solve: 'answers',
      agent: 'answers',
      'cells/title': 'titles',
      'tables/describe': 'labels',
      'frames/describe': 'summaries',
      'questions/rank': 'order',
      'questions/claude': 'questions',
      'decision/values': 'questions',
      'defaults/ask': 'questions',
      'questions/review': 'questions',
      'questions/sort': 'other',
      'dependencies/claude': 'other'
    });
  });
});

describe('where a notebook without sums starts', () => {
  it('adds the answers of one cell and the runs, each once', () => {
    const cost = notebookCost(
      [{}, answer(0.016, 8), ofRun('r1', 1), ofRun('r1', 2), answer(0.2)],
      { r1: run(0.05, ['c2', 'c3'], { seconds: 42 }) }
    );
    expect(cost).toEqual({ usd: 0.266, priced: 3, unpriced: 0, seconds: 50 });
  });

  it('counts a run once, and not again in its cells', () => {
    const marked: IEpiCellMeta = {
      ...ofRun('r1', 1),
      generated_by: { agent: 'openrouter', cost_usd: 0.04, at: AT }
    };
    const cost = notebookCost([marked, ofRun('r1', 2)], {
      r1: run(0.05, ['a', 'b'])
    });
    expect(cost).toMatchObject({ usd: 0.05, priced: 1, unpriced: 0 });
  });

  it('counts the answers without a known price apart, and not as $0', () => {
    const cost = notebookCost(
      [answer(null, 5), answer(undefined), answer(0.016), answer(0)],
      { r1: run(null, ['a']) }
    );
    expect(cost).toMatchObject({ usd: 0.016, priced: 2, unpriced: 3 });
  });

  it('counts the cells of a run that the notebook does not record once', () => {
    const cost = notebookCost(
      [ofRun('gone', 1), ofRun('gone', 2), ofRun('other', 1)],
      {}
    );
    expect(cost).toMatchObject({ usd: 0, priced: 0, unpriced: 2 });
  });

  it('starts the sums from those answers, and from nothing without any', () => {
    expect(
      seedRecord([answer(0.016, 8), answer(null)], {
        r1: run(0.05, ['x'], { seconds: 40 })
      })
    ).toEqual({ answers: { usd: 0.066, n: 2, unpriced: 1, seconds: 48 } });
    expect(seedRecord([{}, { written_by: 'agent' }], undefined)).toEqual({});
  });

  it('starts a cell answered before from its answer, and a cell of a run from nothing', () => {
    expect(cellSeed(answer(0.016, 8))).toEqual({
      answers: { usd: 0.016, n: 1, seconds: 8 }
    });
    expect(cellSeed(ofRun('r1', 1))).toEqual({});
    expect(cellSeed({ written_by: 'agent' })).toEqual({});
    // Once a cell keeps sums, they are its record.
    const kept = {
      ...answer(0.016, 8),
      costs: { titles: { usd: 0.001, n: 1 } }
    };
    expect(cellRecord(kept)).toEqual({ titles: { usd: 0.001, n: 1 } });
  });
});

describe('the cap', () => {
  it('is reached at the cap and past it, and never without one', () => {
    expect(capReached(1.99, 2)).toBe(false);
    expect(capReached(2, 2)).toBe(true);
    expect(capReached(2.01, 2)).toBe(true);
    expect(capReached(0.1 + 0.2, 0.3)).toBe(true);
    expect(capReached(100, null)).toBe(false);
    expect(capReached(0, undefined)).toBe(false);
    // A cap of $0 holds every answer with a price.
    expect(capReached(0, 0)).toBe(true);
  });

  it('leaves a run what is left under it, and never less than nothing', () => {
    expect(leftUnder(0.42, 2)).toBe(1.58);
    expect(leftUnder(0.1 + 0.2, 0.5)).toBe(0.2);
    expect(leftUnder(2.03, 2)).toBe(0);
  });

  it('rises by $1 with Go on, or to $1 past the total when the total has passed that', () => {
    expect(raisedCap(2, 2)).toBe(3);
    expect(raisedCap(2, 2.03)).toBe(3);
    expect(raisedCap(0.5, 0.52)).toBe(1.5);
    // The analyst lowered the cap far under the total: $1 of room all the same.
    expect(raisedCap(1, 3.5)).toBe(4.5);
    expect(raisedCap(1, 3.501)).toBe(4.51);
  });

  it('is typed in US dollars, with or without "$", and an empty field is no cap', () => {
    expect(parseCap('2')).toEqual({ ok: true, value: 2 });
    expect(parseCap(' $2.50 ')).toEqual({ ok: true, value: 2.5 });
    expect(parseCap('.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseCap('0.125')).toEqual({ ok: true, value: 0.13 });
    expect(parseCap('0')).toEqual({ ok: true, value: 0 });
    expect(parseCap('')).toEqual({ ok: true, value: null });
    for (const bad of ['-1', 'two', '1,5', '1e3', '$', '2 dollars']) {
      expect(parseCap(bad)).toEqual({ ok: false });
    }
  });
});

describe('the words', () => {
  it('writes dollars short: cents, and two significant digits under 10 cents', () => {
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(2)).toBe('$2.00');
    expect(formatUsd(0.016)).toBe('$0.016');
    expect(formatUsd(0.05)).toBe('$0.05');
    expect(formatUsd(0.1)).toBe('$0.10');
    expect(formatUsd(0.0041)).toBe('$0.0041');
    expect(formatUsd(0.000412)).toBe('$0.00041');
    expect(formatUsd(0.0004)).toBe('$0.0004');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('gives the exact amount, with its cents below a dollar', () => {
    expect(exactUsd(0.000412)).toBe('$0.000412, 0.041 cents');
    expect(exactUsd(0.42)).toBe('$0.42, 42 cents');
    expect(exactUsd(0.016)).toBe('$0.016, 1.6 cents');
    expect(exactUsd(0.01)).toBe('$0.01, 1 cent');
    expect(exactUsd(2)).toBe('$2.00');
    expect(exactUsd(0)).toBe('$0.00');
  });

  it('writes seconds short', () => {
    expect(formatSeconds(8.2)).toBe('8 s');
    expect(formatSeconds(0.3)).toBe('1 s');
    expect(formatSeconds(72)).toBe('1 min 12 s');
    expect(formatSeconds(120)).toBe('2 min');
  });

  it('says how the code of a cell came to be, with what the answer cost', () => {
    const writer = (meta: IEpiCellMeta) => cellWriter(meta, {}, 'code');
    expect(writer(answer(0.016, 8))).toEqual([
      'Written for ',
      { usd: 0.016 },
      ' in 8 s.'
    ]);
    expect(writer(answer(0.016))).toEqual([
      'Written for ',
      { usd: 0.016 },
      '; its time was not recorded.'
    ]);
    expect(writer(answer(null, 5))).toEqual([
      'Written in 5 s, at no known price.'
    ]);
    expect(writer({ written_by: 'agent', template: true })).toEqual([
      'Written from a template, with no model call.'
    ]);
    // A cell of the view with no mark may be a model's, from an earlier version.
    expect(writer({ written_by: 'agent' })).toEqual([
      'Whybook wrote this code, from a template or with a model; the notebook does not record which.'
    ]);
    expect(writer({})).toEqual(['You wrote this code.']);
    expect(cellWriter({}, {}, 'markdown')).toEqual(['You wrote this text.']);
  });

  it("gives a cell of an agent's run the run's cost and time, for all of its cells", () => {
    const runs = {
      r1: run(0.05, ['a', 'b', 'c'], { seconds: 42 }),
      r2: run(null, ['d'], { seconds: 9 })
    };
    expect(cellWriter(ofRun('r1', 2), runs, 'code')).toEqual([
      "Written in an agent's run, which cost ",
      { usd: 0.05 },
      ' in 42 s for its 3 cells.'
    ]);
    expect(cellWriter(ofRun('r2', 1), runs, 'code')).toEqual([
      "Written in an agent's run, which took 9 s for its one cell, at no known price."
    ]);
    expect(cellWriter(ofRun('r3', 1), runs, 'code')).toEqual([
      "Written in an agent's run whose cost the notebook does not record."
    ]);
    expect(cellWriter(ofRun('r3', 1), runs, 'code', new Set(['r3']))).toEqual([
      "Written in an agent's run that is still working: its cost shows when it ends."
    ]);
  });

  it('lists what models did for a template cell after a drop: its title, the labels of its tables, a summary', () => {
    const template: IEpiCellMeta = {
      written_by: 'agent',
      template: true,
      title_note: { title: 'Pain by arm', key: 'k', by },
      tables: { t1: { description: 'mean pain', headline: '', by } },
      costs: {
        titles: { usd: 0.00041, n: 1 },
        labels: { usd: 0.0021, n: 2, unpriced: 1 }
      }
    };
    expect(cellParts(template, true)).toEqual([
      { kind: 'titles', label: 'Its title', sum: { usd: 0.00041, n: 1 } },
      {
        kind: 'labels',
        label: 'The labels of its tables',
        sum: { usd: 0.0021, n: 2, unpriced: 1 }
      },
      { kind: 'summaries', label: 'The summary of a frame it makes', sum: null }
    ]);
    // Labels that a script wrote in place of a model are not a model's work.
    expect(
      cellParts(
        {
          tables: {
            t1: {
              description: 'x',
              headline: '',
              by: { ...by, choice: 'script' }
            }
          }
        },
        false
      )
    ).toEqual([]);
  });

  it("lists a cell's answers when they are not the one of its first line", () => {
    const twice: IEpiCellMeta = {
      ...answer(0.02, 6),
      costs: { answers: { usd: 0.036, n: 2, seconds: 14 } }
    };
    expect(cellParts(twice, false)).toEqual([
      {
        kind: 'answers',
        label: 'Answers',
        sum: { usd: 0.036, n: 2, seconds: 14 }
      }
    ]);
    expect(cellParts(answer(0.016, 8), false)).toEqual([]);
    // An answer undone: the analyst's code, and a model's answer that cost money.
    const undone: IEpiCellMeta = { costs: { answers: { usd: 0.016, n: 1 } } };
    expect(cellParts(undone, false).map(part => part.kind)).toEqual([
      'answers'
    ]);
  });

  it('counts calls in words', () => {
    expect(callsText({ usd: 0.1, n: 1 })).toBe('1 call');
    expect(callsText({ usd: 0.1, n: 2, unpriced: 1 })).toBe('3 calls');
    expect(unpricedOf({ usd: 0.1, n: 2, unpriced: 1 })).toBe(
      '1 of them without a known price, not in the amount'
    );
    expect(unpricedOf({ usd: 0.1, n: 2 })).toBeNull();
    expect(unpricedText(1)).toBe(
      '1 call without a known price, not counted against the cap.'
    );
    expect(unpricedText(2)).toMatch(/^2 calls without/);
  });
});
