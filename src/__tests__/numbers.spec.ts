import {
  boundCode,
  columnCode,
  countText,
  dateText,
  dateTicks,
  estimateText,
  numberText,
  numberTicks,
  pValueText,
  shareText
} from '../model/numbers';

describe('numberTicks', () => {
  it('labels each tick with the decimals of the step', () => {
    expect(numberTicks([0, 0.008], 4)).toMatchObject({
      labels: ['0', '0.002', '0.004', '0.006', '0.008'],
      note: null
    });
    expect(numberTicks([0, 1.5], 3).labels).toEqual(['0', '0.5', '1', '1.5']);
  });

  it('keeps a year as it is written', () => {
    expect(numberTicks([2020, 2021], 5).labels).toEqual([
      '2020',
      '2020.2',
      '2020.4',
      '2020.6',
      '2020.8',
      '2021'
    ]);
  });

  it('groups the digits of large ticks by thousands', () => {
    expect(numberTicks([0, 250000], 5).labels).toEqual([
      '0',
      '50,000',
      '100,000',
      '150,000',
      '200,000',
      '250,000'
    ]);
  });

  it('gives an axis of tiny or huge ticks a shared power of ten', () => {
    expect(numberTicks([1e-7, 9e-7], 4)).toMatchObject({
      labels: ['2', '4', '6', '8'],
      note: '×10⁻⁷'
    });
    expect(numberTicks([0, 3e9], 3)).toMatchObject({
      labels: ['0', '1', '2', '3'],
      note: '×10⁹'
    });
  });
});

describe('numberText', () => {
  it('writes three significant figures', () => {
    expect(numberText(0.002)).toBe('0.002');
    expect(numberText(0.0042)).toBe('0.0042');
    expect(numberText(0.004236)).toBe('0.00424');
    expect(numberText(12.345)).toBe('12.3');
    expect(numberText(-1.5)).toBe('-1.5');
    expect(numberText(0)).toBe('0');
  });

  it('keeps every digit of a whole part from 100 up', () => {
    expect(numberText(123.456)).toBe('123');
    expect(numberText(1234.5)).toBe('1235');
    expect(numberText(1234567.8)).toBe('1,234,568');
  });

  it('writes a power of ten for tiny and huge values', () => {
    expect(numberText(1.234e-7)).toBe('1.23e-7');
    expect(numberText(5e-5)).toBe('5e-5');
    expect(numberText(4.5e9)).toBe('4.5e9');
  });
});

describe('estimateText', () => {
  it('writes an estimate and its interval with the same decimals', () => {
    expect(estimateText(0.0042, 0.0021, 0.0063)).toEqual({
      estimate: '0.0042',
      lo: '0.0021',
      hi: '0.0063'
    });
    expect(estimateText(101.2, 98.1, 104.3)).toEqual({
      estimate: '101.2',
      lo: '98.1',
      hi: '104.3'
    });
    expect(estimateText(0.5, -0.0001, 1.0001)).toEqual({
      estimate: '0.5',
      lo: '0.0',
      hi: '1.0'
    });
  });

  it('shares a power of ten for tiny estimates', () => {
    expect(estimateText(4.2e-9, 2.1e-9, 6.3e-9)).toEqual({
      estimate: '4.2e-9',
      lo: '2.1e-9',
      hi: '6.3e-9'
    });
  });

  it('writes an estimate with no interval as a value', () => {
    expect(estimateText(0.0042, null, null)).toEqual({
      estimate: '0.0042',
      lo: null,
      hi: null
    });
  });
});

describe('pValueText', () => {
  it('writes the usual forms', () => {
    expect(pValueText(0.0004)).toBe('< 0.001');
    expect(pValueText(0.004)).toBe('0.004');
    expect(pValueText(0.031)).toBe('0.03');
    expect(pValueText(0.048)).toBe('0.048');
    expect(pValueText(0.52)).toBe('0.52');
    expect(pValueText(0.996)).toBe('> 0.99');
  });
});

describe('shareText', () => {
  it('writes one decimal below 1%, and never 0% for a share above 0', () => {
    expect(shareText(0)).toBe('0%');
    expect(shareText(0.0003)).toBe('< 0.1%');
    expect(shareText(0.001)).toBe('0.1%');
    expect(shareText(0.0042)).toBe('0.4%');
    expect(shareText(0.123)).toBe('12%');
    expect(shareText(1)).toBe('100%');
  });

  it('never writes 100% for a share below 1', () => {
    expect(shareText(0.995)).toBe('99.5%');
    expect(shareText(0.9998)).toBe('> 99.9%');
  });
});

describe('countText', () => {
  it('writes a whole number', () => {
    expect(countText(10)).toBe('10');
    expect(countText(1234)).toBe('1,234');
  });
});

const at = (text: string) => Date.parse(`${text}Z`);

describe('dateText', () => {
  it('writes a date to the unit it needs', () => {
    expect(dateText(at('2024-01-03T00:00:00'))).toBe('2024-01-03');
    expect(dateText(at('2024-01-03T06:30:00'))).toBe('2024-01-03 06:30');
    expect(dateText(at('2024-01-03T06:30:15'))).toBe('2024-01-03 06:30:15');
    expect(dateText(at('2024-01-03T06:30:15.250'))).toBe(
      '2024-01-03 06:30:15.250'
    );
  });
});

describe('dateTicks', () => {
  it('puts ticks on days, with the year in the note', () => {
    expect(
      dateTicks([at('2024-01-01T00:00:00'), at('2024-01-05T00:00:00')], 4)
    ).toMatchObject({
      labels: ['Jan 1', 'Jan 2', 'Jan 3', 'Jan 4', 'Jan 5'],
      note: '2024'
    });
  });

  it('puts ticks on Mondays for a month', () => {
    const ticks = dateTicks(
      [at('2024-03-01T00:00:00'), at('2024-03-31T00:00:00')],
      4
    );
    expect(ticks.labels).toEqual(['Mar 4', 'Mar 11', 'Mar 18', 'Mar 25']);
    expect(ticks.ticks.map(tick => new Date(tick).getUTCDay())).toEqual([
      1, 1, 1, 1
    ]);
  });

  it('names the year at January on an axis of months', () => {
    expect(
      dateTicks([at('2023-10-01T00:00:00'), at('2024-03-01T00:00:00')], 5)
        .labels
    ).toEqual(['Oct', 'Nov', 'Dec', '2024', 'Feb', 'Mar']);
  });

  it('names the day at midnight on an axis of hours', () => {
    expect(
      dateTicks([at('2024-01-03T18:00:00'), at('2024-01-04T06:00:00')], 4)
    ).toMatchObject({
      labels: ['18:00', '21:00', 'Jan 4', '03:00', '06:00'],
      note: '2024'
    });
    expect(
      dateTicks([at('2024-01-03T06:00:00'), at('2024-01-03T07:00:00')], 4)
    ).toMatchObject({
      labels: ['06:00', '06:15', '06:30', '06:45', '07:00'],
      note: 'Jan 3 2024'
    });
  });

  it('puts ticks on years for a long span', () => {
    expect(
      dateTicks([at('2015-06-01T00:00:00'), at('2024-06-01T00:00:00')], 5)
        .labels
    ).toEqual(['2016', '2018', '2020', '2022', '2024']);
  });
});

describe('boundCode', () => {
  it('writes a number at full precision and a date as a timestamp', () => {
    expect(boundCode(0.00123456789)).toBe('0.00123456789');
    expect(boundCode(at('2024-01-02T00:00:00'), { type: 'date' })).toBe(
      'pd.Timestamp("2024-01-02")'
    );
    expect(boundCode(at('2024-01-02T06:30:00'), { type: 'date' })).toBe(
      'pd.Timestamp("2024-01-02 06:30")'
    );
    expect(
      boundCode(at('2024-01-02T00:00:00'), {
        type: 'date',
        tz: 'Europe/Warsaw'
      })
    ).toBe('pd.Timestamp("2024-01-02", tz="Europe/Warsaw")');
  });
});

describe('columnCode', () => {
  it('parses a column of dates held as Python objects', () => {
    expect(columnCode('diary', 'day', { objects: true })).toBe(
      'pd.to_datetime(diary["day"])'
    );
    expect(columnCode('diary', 'day', null)).toBe('diary["day"]');
  });
});
