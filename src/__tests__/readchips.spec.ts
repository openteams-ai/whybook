/**
 * The chips of a file read (design iteration 1.91). A text of one sign, such
 * as the comma that read_csv splits a file at, reads as its name: the chip
 * of `sep = ','` was `sep ,`, and a tab or an empty text showed as nothing.
 */
import type { ISignature } from '../model/founddefaults';
import { foundDecisions } from '../model/founddefaults';
import { chipText, decisionChips } from '../model/decisions';
import type { IDecision } from '../tokens';

function decision(name: string, value: string, extra = {}): IDecision {
  return {
    name,
    value,
    provenance: 'library_default',
    param: name,
    function: 'read_csv',
    ...extra
  };
}

describe('the chip of a text of one sign', () => {
  it('names the sign, as Python and R write it', () => {
    expect(chipText(decision('sep', "','"))).toBe('sep comma');
    expect(chipText(decision('sep', '";"'))).toBe('sep semicolon');
    expect(chipText(decision('sep', "'\\t'"))).toBe('sep tab');
    expect(chipText(decision('sep', '" "'))).toBe('sep space');
    expect(chipText(decision('sep', "'|'"))).toBe('sep pipe');
    expect(chipText(decision('decimal', "'.'"))).toBe('decimal point');
    expect(chipText(decision('na_rep', "''"))).toBe('na_rep empty text');
    // R's read.csv2 splits at semicolons, with a comma for its decimal mark.
    expect(
      chipText(decision('dec', '","', { function: 'utils::read.csv2' }))
    ).toBe('dec comma');
  });

  it('keeps any other value as it is', () => {
    expect(chipText(decision('header', "'infer'"))).toBe('header infer');
    expect(chipText(decision('na_values', 'None'))).toBe('na_values None');
    expect(chipText(decision('sep', "';;'"))).toBe('sep ;;');
    // A name that every object has is no sign.
    expect(chipText(decision('method', "'constructor'"))).toBe(
      'method constructor'
    );
    // A number is no text.
    expect(chipText(decision('alpha', '0.05'))).toBe('alpha 0.05');
  });

  it('names the separator that a model picked from the signature of read_csv', () => {
    // The kernel lists the default that pandas documents, where the
    // signature holds <no_default> (whybook/server/kernel_code/analyze_cells.py).
    const read: ISignature = {
      function: 'pandas.read_csv',
      name: 'read_csv',
      module: 'pandas',
      library: 'pandas',
      version: '3.0.6',
      params: [
        { name: 'sep', default: "','" },
        { name: 'na_values', default: 'None' }
      ],
      calls: [
        {
          line: 3,
          col: 11,
          target: 'nhefs',
          defaulted: ['sep', 'na_values']
        }
      ]
    };
    const found = foundDecisions(
      [read],
      () => ({
        picks: [
          { param: 'sep', why: 'How fields are separated.' },
          { param: 'na_values', why: 'Which values count as missing.' }
        ],
        by: null
      }),
      []
    );
    expect(decisionChips(found).map(chip => chip.text)).toEqual([
      'sep comma',
      'na_values None'
    ]);
    // The tooltip keeps the value as code.
    expect(decisionChips(found)[0].tooltip.split('\n')[0]).toBe("sep = ','");
  });
});
