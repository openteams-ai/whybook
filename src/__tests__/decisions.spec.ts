import {
  allCalls,
  attributed,
  callChoice,
  callName,
  chipText,
  chosenValue,
  decisionChips,
  decisionKey,
  libraryOf,
  sameValue,
  sourceNote
} from '../model/decisions';
import type { IDecision, IOption } from '../tokens';

const literal = (
  name: string,
  value: string,
  param: string | null = null
): IDecision => ({
  name,
  value,
  provenance: 'literal',
  param,
  function: param ? 'drop_sparse' : null
});

describe('attributed', () => {
  it('gives the analyst the values of the code they wrote', () => {
    const decisions = attributed([literal('n_boot', '1000', 'n_boot')], {});
    expect(decisions[0].provenance).toBe('you');
  });

  it('gives the AI the values of code the view wrote, and the analyst the value they typed', () => {
    // "What if MIN_DAYS were 21?": a template copied the cell and added the
    // value typed in the box; the copied literals keep the AI's mark.
    const decisions = attributed(
      [
        literal('min_days', '21', 'min_days'),
        literal('n_boot', '1000', 'n_boot'),
        {
          name: 'how',
          value: "'inner'",
          provenance: 'library_default',
          param: 'how'
        }
      ],
      {
        written_by: 'agent',
        user_values: [{ name: 'MIN_DAYS', param: 'min_days', value: '21' }]
      }
    );
    expect(decisions.map(decision => decision.provenance)).toEqual([
      'you',
      'agent',
      'library_default'
    ]);
  });

  it('finds a value in a branch that renamed what its cell defines, and not another value', () => {
    const meta = {
      written_by: 'agent' as const,
      user_values: [{ name: 'ALPHA', param: null, value: '0.3' }]
    };
    expect(
      attributed([literal('ALPHA_if_0_3', '0.3')], meta)[0].provenance
    ).toBe('you');
    // The same name with another value, as after an edit by a model.
    expect(attributed([literal('ALPHA', '0.5')], meta)[0].provenance).toBe(
      'agent'
    );
  });

  it('gives the analyst the path of a file they dropped or clicked, and the AI the other values', () => {
    // "Load visits.csv as visits", from a file dropped on the view: the view
    // wrote the cell, and the analyst chose the file.
    const read = (value: string, param = 'filepath_or_buffer'): IDecision => ({
      name: param,
      value,
      provenance: 'literal',
      param,
      function: 'read_csv',
      calls: [{ line: 1, col: 9, target: 'visits' }]
    });
    const meta = {
      written_by: 'agent' as const,
      user_values: [
        { name: 'visits.csv', value: 'data/visits.csv', file: true }
      ]
    };
    const decisions = attributed(
      [
        read("'data/visits.csv'"),
        read("'\\t'", 'sep'),
        // A model that wrote the load from the notebook's data folder.
        read('"visits.csv"'),
        read("'old/visits.csv'")
      ],
      meta
    );
    expect(decisions.map(decision => decision.provenance)).toEqual([
      'you',
      'agent',
      'you',
      'agent'
    ]);
  });
});

describe('sameValue', () => {
  it('reads one value in the ways Python writes it', () => {
    expect(sameValue('21', '21.0')).toBe(true);
    expect(sameValue('1e3', '1000.0')).toBe(true);
    expect(sameValue(`'left'`, '"left"')).toBe(true);
    expect(sameValue('[7, 14]', '[7,14]')).toBe(true);
    expect(sameValue('21', '22')).toBe(false);
    expect(sameValue(`'left'`, `'right'`)).toBe(false);
  });
});

describe('chosenValue', () => {
  const decision: IDecision = {
    name: 'MIN_DAYS',
    value: '14',
    provenance: 'defaulted',
    param: 'min_days',
    function: 'drop_sparse'
  };
  const option = (text: string): IOption => ({
    id: text,
    text,
    type: 'model',
    origin: 'template',
    probability: 0.6,
    reasons: [],
    placement: null,
    code: 'x = 1'
  });

  it('takes a value typed in the box, or picked from the list', () => {
    expect(
      chosenValue(decision, option('What if MIN_DAYS were 21?'), '21')
    ).toEqual({ name: 'MIN_DAYS', param: 'min_days', value: '21' });
    expect(chosenValue(decision, option('What if MIN_DAYS were 7?'))).toEqual({
      name: 'MIN_DAYS',
      param: 'min_days',
      value: '7'
    });
    // Choosing the default in the cell keeps its value, now the analyst's.
    expect(
      chosenValue(decision, option('Choose MIN_DAYS in [14]'))?.value
    ).toBe('14');
  });

  it('leaves a sweep of values to the template', () => {
    expect(
      chosenValue(decision, option('Compare MIN_DAYS = 7, 14, 21 in one table'))
    ).toBeNull();
  });
});

describe('chosenValue for one call of several', () => {
  const how: IDecision = {
    name: 'how',
    value: "'inner'",
    provenance: 'library_default',
    param: 'how',
    function: 'DataFrame.merge'
  };
  const option = (text: string): IOption => ({
    id: text,
    text,
    type: 'model',
    origin: 'template',
    probability: 0.6,
    reasons: [],
    placement: null,
    code: 'x = 1'
  });

  it('reads the value before the place it goes into', () => {
    for (const where of [
      ' in the merge with weather',
      ' in both merges',
      ' in all 3 merges',
      ' in the ribbon of february on line 7'
    ]) {
      expect(
        chosenValue(how, option(`What if how were "left"${where}?`))?.value
      ).toBe('"left"');
    }
    expect(
      chosenValue(how, option('Choose how in [4], in the merge with weather'))
        ?.value
    ).toBe("'inner'");
  });
});

/** Home energy [4]: two merges that leave how='inner', and two constants of energy.py. */
const DAILY: IDecision[] = [
  {
    name: 'BASE_TEMP_C',
    value: '15.5',
    provenance: 'defaulted',
    param: 'base',
    function: 'add_degree_days',
    source: { file: 'energy.py', line: 12 },
    calls: [{ line: 7, col: 10, target: 'readings' }]
  },
  {
    name: 'how',
    value: "'inner'",
    provenance: 'library_default',
    param: 'how',
    function: 'DataFrame.merge',
    note: 'rows without a match in both frames are dropped',
    calls: [
      { line: 5, col: 5, target: 'homes' },
      { line: 6, col: 5, target: 'weather' }
    ]
  }
];

describe('decisionChips', () => {
  it('shows the name and the value, short, and one chip for calls that agree', () => {
    const [base, merges] = decisionChips(DAILY);
    expect([base.text, base.count, base.target]).toEqual([
      'BASE_TEMP_C 15.5',
      1,
      null
    ]);
    expect([merges.text, merges.count, merges.target]).toEqual([
      'inner join',
      2,
      null
    ]);
    // The tooltip is short: the value as code, and the calls "×2" covers.
    // The library, the reason and who flagged the default are in the popover.
    expect(merges.tooltip.split('\n')).toEqual([
      "how = 'inner'",
      'In both merges: the merge with homes (line 5) and the merge with weather (line 6).'
    ]);
    expect(base.tooltip.split('\n')).toEqual([
      'BASE_TEMP_C = 15.5',
      'parameter base of add_degree_days, line 7'
    ]);
  });

  it('names the frame of each call where the calls of a function leave different values', () => {
    // The branch that tried how="left" in the merge with weather alone.
    const chips = decisionChips([
      { ...DAILY[1], calls: [{ line: 5, col: 5, target: 'homes' }] },
      {
        name: 'how',
        value: '"left"',
        provenance: 'you',
        param: 'how',
        function: 'merge',
        calls: [{ line: 6, col: 5, target: 'weather' }]
      }
    ]);
    expect(chips.map(chip => [chip.text, chip.target])).toEqual([
      ['inner join', 'homes'],
      ['left join', 'weather']
    ]);
    expect(chips[1].tooltip.split('\n')).toEqual([
      'how = "left"',
      'In the merge with weather (line 6).'
    ]);
  });

  it('shows the file that a read reads by its name, and does not repeat the frame', () => {
    const read = (value: string, target: string, line: number): IDecision => ({
      name: 'filepath_or_buffer',
      value,
      provenance: 'you',
      param: 'filepath_or_buffer',
      function: 'read_csv',
      calls: [{ line, col: 11, target }]
    });
    const chips = decisionChips([
      read("'homes.csv'", 'homes', 1),
      read("'data/weather.csv'", 'weather', 2),
      {
        name: 'path',
        value: "'readings.parquet'",
        provenance: 'you',
        param: 'path',
        function: 'read_parquet',
        calls: [{ line: 4, col: 14, target: 'readings' }]
      }
    ]);
    expect(chips.map(chip => [chip.text, chip.target])).toEqual([
      ['homes.csv', null],
      ['weather.csv', null],
      ['readings.parquet', null]
    ]);
    // Another literal of a read is not a file.
    expect(
      chipText({
        name: 'encoding',
        value: "'latin-1'",
        provenance: 'you',
        param: 'encoding',
        function: 'read_csv'
      })
    ).toBe('encoding latin-1');
    // A constant that a file defines keeps its name: the variable matters more than its path.
    expect(
      chipText({
        name: 'READINGS_PATH',
        value: "'data/readings.parquet'",
        provenance: 'defaulted',
        param: 'path',
        function: 'read_readings'
      })
    ).toBe('READINGS_PATH data/readings.parquet');
  });

  it('draws a decision kept before the calls were listed as one chip', () => {
    const kept: IDecision[] = [
      {
        name: 'how',
        value: "'inner'",
        provenance: 'library_default',
        param: 'how',
        function: 'DataFrame.merge'
      },
      {
        name: 'min_days_values',
        value: '[7, 14, 21]',
        provenance: 'agent',
        param: null,
        function: null
      }
    ];
    const chips = decisionChips(kept);
    expect(chips.map(chip => [chip.text, chip.count, chip.target])).toEqual([
      ['inner join', 1, null],
      ['min_days_values [7, 14, 21]', 1, null]
    ]);
    // A value that an agent wrote says so: its AI tag has no tooltip of its own.
    expect(chips[1].tooltip.split('\n')).toEqual([
      'min_days_values = [7, 14, 21]',
      'Chosen by AI.'
    ]);
    expect(new Set(kept.map(decisionKey)).size).toBe(2);
  });
});

describe('the calls of a chip', () => {
  const merges = DAILY[1];

  it('are named by the frame each joins or reads, with the line where two share one', () => {
    expect(allCalls(merges)).toBe('both merges');
    expect(merges.calls!.map(call => callChoice(merges, call))).toEqual([
      'Merge with homes',
      'Merge with weather'
    ]);
    const three: IDecision = {
      ...merges,
      calls: [...merges.calls!, { line: 9, col: 4, target: 'homes' }]
    };
    expect(allCalls(three)).toBe('all 3 merges');
    expect(callName(three, three.calls![0])).toBe(
      'the merge with homes on line 5'
    );
    // The tooltip gives every line once.
    expect(decisionChips([three])[0].tooltip).toContain(
      'In all 3 merges: the merge with homes (line 5), the merge with weather (line 6) and the merge with homes (line 9).'
    );
    const ribbons: IDecision = {
      name: 'ci',
      value: "'normal'",
      provenance: 'library_default',
      param: 'ci',
      function: 'plots.ribbon',
      calls: [
        { line: 6, col: 8, target: 'february' },
        { line: 7, col: 8, target: null }
      ]
    };
    expect(allCalls(ribbons)).toBe('both calls');
    expect(ribbons.calls!.map(call => callChoice(ribbons, call))).toEqual([
      'ribbon of february',
      'ribbon on line 7'
    ]);
    expect(decisionChips([ribbons])[0].tooltip).toContain(
      'In both calls: the ribbon of february (line 6) and the ribbon (line 7).'
    );
  });
});

describe('where a default comes from', () => {
  const merge: IDecision = {
    ...DAILY[1],
    library: 'pandas',
    version: '3.0.6'
  };
  const found: IDecision = {
    name: 'dropna',
    value: 'True',
    provenance: 'library_default',
    param: 'dropna',
    function: 'DataFrame.groupby',
    note: 'Rows whose key is missing are left out of the groups.',
    found: { by: null, library: 'pandas', version: '3.0.6' }
  };

  it('names the library and its version: the kernel read them for the list, and the model read them in the signature', () => {
    expect(libraryOf(merge)).toBe('pandas 3.0.6');
    expect(libraryOf(found)).toBe('pandas 3.0.6');
    expect(libraryOf({ ...merge, version: null })).toBe('pandas');
    // A decision that a notebook of an earlier version kept has neither.
    expect(libraryOf(DAILY[1])).toBeNull();
  });

  it('reads "default in pandas 3.0.6" for a library default, and the server\u2019s note for any other decision', () => {
    expect(sourceNote(merge, 'a library default')).toBe(
      'default in pandas 3.0.6'
    );
    expect(sourceNote(found, '')).toBe('default in pandas 3.0.6');
    // The library is not known: the server's note stands.
    expect(sourceNote(DAILY[1], 'a library default')).toBe('a library default');
    expect(sourceNote(DAILY[0], 'defaulted in energy.py:12')).toBe(
      'defaulted in energy.py:12'
    );
  });

  it('keeps the library, the reason and the model out of the chip\u2019s tooltip', () => {
    const [chip] = decisionChips([{ ...found, calls: [{ line: 3, col: 4 }] }]);
    expect(chip.tooltip.split('\n')).toEqual([
      'dropna = True',
      'parameter dropna of DataFrame.groupby, line 3'
    ]);
  });
});
