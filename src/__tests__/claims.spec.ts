import type { ISourceText } from '../model/claims';
import { checkNumbers, excerpt, htmlText, numbersIn } from '../model/claims';
import { noteBody } from '../model/notebook';

const SUMMARY =
  'Pain falls faster in arm B, by 0.32 points more per month. More ' +
  'patients stop in the first 12 weeks in arm A (26%) than in arm B (9%). ' +
  'Of the 4,812 proteins, only NGF passes; p = 3.9e-5, with p < 0.05.';

const effects = htmlText(
  '<table><tr><th>analysis</th><th>estimate</th></tr>' +
    '<tr><td>Mixed model</td><td>-0.3183</td></tr></table>'
);

const sources: ISourceText[] = [
  { cellId: 'effects', output: 1, text: effects },
  { cellId: 'without_east', output: 0, text: 'Group Var  0.259' },
  {
    cellId: 'completeness',
    output: 0,
    text: 'treatment_arm  dropped\nA  0.26\nB  0.09'
  },
  { cellId: 'screen', output: 2, text: '4812 rows × 7 columns' },
  {
    cellId: 'dropout',
    output: -1,
    text: 'early = last_week < 12\nalpha = 0.05'
  }
];

describe('numbersIn', () => {
  it('reads decimals, percents, exponents and thousands, and not names', () => {
    expect(
      numbersIn('IL6 and sleep_1 at 26% of 1,428 rows, 3.9e-5').map(n => n.text)
    ).toEqual(['26%', '1,428', '3.9e-5']);
  });

  it('leaves out a threshold after < or >', () => {
    expect(numbersIn('p < 0.05 and p ≥ 0.1, not 0.2').map(n => n.text)).toEqual(
      ['0.2']
    );
  });
});

describe('checkNumbers', () => {
  const result = checkNumbers(SUMMARY, sources);
  const byText = Object.fromEntries(result.checked.map(c => [c.text, c]));

  it('finds a number as the output rounds it, whatever its sign', () => {
    expect(byText['0.32'].found).toEqual([
      { cellId: 'effects', output: 1, shown: '-0.3183' }
    ]);
  });

  it('finds a percent as a share, printed as the text rounds it first', () => {
    expect(byText['26%'].found.map(found => found.shown)).toEqual([
      '0.26',
      '0.259'
    ]);
    expect(byText['9%'].found[0].shown).toBe('0.09');
  });

  it('finds a count written with a thousands separator', () => {
    expect(byText['4,812'].found[0].cellId).toBe('screen');
  });

  it('says when no output shows a number', () => {
    expect(byText['3.9e-5']).toEqual({ text: '3.9e-5', found: [], inCode: [] });
  });

  it('lists small whole numbers without checking them', () => {
    expect(result.skipped).toEqual(['12']);
    expect(result.checked.map(c => c.text)).not.toContain('0.05');
  });
});

describe('noteBody', () => {
  it('is the text under the heading', () => {
    expect(noteBody('## Summary\n\nPain falls.\n')).toBe('Pain falls.');
    expect(noteBody('## Model')).toBe('');
    expect(noteBody('Plain text, no heading.')).toBe('Plain text, no heading.');
  });
});

describe('excerpt', () => {
  it('cuts at a word', () => {
    expect(excerpt('Pain falls over the six months in both arms', 30)).toBe(
      'Pain falls over the six…'
    );
    expect(excerpt('short', 30)).toBe('short');
  });
});
