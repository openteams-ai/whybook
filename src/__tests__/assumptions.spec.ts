/**
 * The open assumptions of a notebook, which the Exploration panel counts and
 * Worth asking next asks about: the defaults of the analyst's or an agent's
 * code, and the library defaults that a rule shows to change a result, those
 * of a read whose frame looks wrong. The chips of the other library defaults
 * show them, and the count leaves them out.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  countOpenAssumptions,
  frameLooksMisread,
  isOpenAssumption
} from '../model/assumptions';
import type { IDecision, IVariable } from '../tokens';

/** The server's cases of the rule (frame_looks_misread): both give the same text. */
const CASES: { frame: string; columns: string[]; sign: string | null }[] =
  JSON.parse(
    readFileSync(
      join(__dirname, '../../whybook/server/tests/data/misread_frames.json'),
      'utf8'
    )
  ).cases;

/** A frame of the kernel with these columns. */
function frame(name: string, columns: string[]): IVariable {
  return {
    name,
    label: name,
    kind: 'dataframe',
    rows: 360,
    columns: columns.map(label => ({
      name: `${name}[${JSON.stringify(label)}]`,
      label,
      parent: name,
      kind: 'numeric',
      tag: 'num'
    }))
  };
}

const FOUND = { by: null, library: 'pandas', version: '3.0.6' };
/** The read of homes.csv, as the kernel's analysis and a model's picks give it. */
const HEADER: IDecision = {
  name: 'header',
  value: "'infer'",
  provenance: 'library_default',
  param: 'header',
  function: 'pandas.read_csv',
  calls: [{ line: 3, col: 8, target: 'homes' }]
};
const SEP: IDecision = {
  name: 'sep',
  value: "','",
  provenance: 'library_default',
  param: 'sep',
  function: 'read_csv',
  calls: [{ line: 3, col: 8, target: 'homes' }],
  found: FOUND
};
const FILE: IDecision = {
  name: 'filepath_or_buffer',
  value: "'homes.csv'",
  provenance: 'you',
  param: 'filepath_or_buffer',
  function: 'read_csv',
  calls: [{ line: 3, col: 8, target: 'homes' }]
};
const HOW: IDecision = {
  name: 'how',
  value: "'inner'",
  provenance: 'library_default',
  param: 'how',
  function: 'DataFrame.merge',
  calls: [{ line: 1, col: 17, target: 'homes' }]
};
const MIN_DAYS: IDecision = {
  name: 'MIN_DAYS',
  value: '14',
  provenance: 'defaulted',
  param: 'min_days',
  function: 'weekly_means',
  source: { file: 'prep.py', line: 12 }
};

describe('frameLooksMisread', () => {
  it.each(CASES.map(item => [JSON.stringify(item.columns), item]))(
    'gives the server’s sign for %s',
    (_columns, item) => {
      expect(frameLooksMisread(item.frame, item.columns)).toBe(item.sign);
    }
  );
});

describe('isOpenAssumption', () => {
  const right = new Map([['homes', ['home_id', 'region', 'heating']]]);
  const wrong = new Map([['homes', ['home_id;region;heating']]]);

  it('takes a default of the analyst’s code', () => {
    expect(isOpenAssumption(MIN_DAYS, ['weekly'], right)).toBe(true);
  });

  it('leaves out a library default that no rule shows to change the result', () => {
    expect(isOpenAssumption(HEADER, ['homes'], right)).toBe(false);
    expect(isOpenAssumption(SEP, ['homes'], right)).toBe(false);
    expect(isOpenAssumption(HOW, ['daily'], right)).toBe(false);
  });

  it('takes the defaults of a read whose frame looks wrong, and no other', () => {
    expect(isOpenAssumption(HEADER, ['homes', 'pd'], wrong)).toBe(true);
    expect(isOpenAssumption(SEP, ['homes'], wrong)).toBe(true);
    // A merge of the frame reads no file.
    expect(isOpenAssumption(HOW, ['homes'], wrong)).toBe(false);
  });

  it('reads the frame that the cell names after the file, when it makes more', () => {
    const frames = new Map([
      ['homes', ['home_id', 'region']],
      ['raw', ['home_id;region']]
    ]);
    expect(isOpenAssumption(HEADER, ['homes', 'raw'], frames)).toBe(false);
    const raw = { ...HEADER, calls: [{ line: 3, col: 6, target: 'raw' }] };
    expect(isOpenAssumption(raw, ['homes', 'raw'], frames)).toBe(true);
  });

  it('leaves out a value that somebody chose', () => {
    expect(isOpenAssumption(FILE, ['homes'], wrong)).toBe(false);
    for (const provenance of ['literal', 'agent', 'template'] as const) {
      expect(isOpenAssumption({ ...HOW, provenance }, ['homes'], wrong)).toBe(
        false
      );
    }
  });
});

describe('countOpenAssumptions', () => {
  const cells = [
    { decisions: [HEADER, SEP, FILE], analysis: { defs: ['homes', 'pd'] } },
    { decisions: [HOW], analysis: { defs: ['daily'] } },
    { decisions: [MIN_DAYS], analysis: null }
  ];

  it('counts the defaults of the analyst’s code alone after a read that looks right', () => {
    expect(
      countOpenAssumptions(cells, [frame('homes', ['home_id', 'region'])])
    ).toBe(1);
  });

  it('counts the defaults of a read whose frame looks wrong', () => {
    expect(
      countOpenAssumptions(cells, [frame('homes', ['home_id;region'])])
    ).toBe(3);
  });

  it('counts no read as wrong before the kernel lists its frame', () => {
    expect(countOpenAssumptions(cells, [])).toBe(1);
  });
});
