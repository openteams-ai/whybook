import { pyNumber, pyString } from '../model/pycode';

describe('pyString', () => {
  it('keeps a quote, a backslash and a line break inside the literal', () => {
    expect(pyString('sleep hours')).toBe('"sleep hours"');
    expect(pyString('say "hi"')).toBe('"say \\"hi\\""');
    expect(pyString('a\\b')).toBe('"a\\\\b"');
    expect(pyString('two\nlines')).toBe('"two\\nlines"');
  });

  it('cannot close the literal and run code', () => {
    const name = 'sleep", "pain"]].corr(); __import__("os").system("id"); x[["';
    const literal = pyString(name);
    // One literal: every quote inside it is escaped.
    expect(literal.slice(1, -1)).not.toMatch(/(^|[^\\])"/);
    expect(JSON.parse(literal)).toBe(name);
  });
});

describe('pyNumber', () => {
  it('writes a number at full precision', () => {
    expect(pyNumber(0.0012)).toBe('0.0012');
    expect(pyNumber(0.0048)).toBe('0.0048');
    expect(pyNumber(1e-7)).toBe('1e-7');
    expect(pyNumber(42)).toBe('42');
    expect(pyNumber(-3.25)).toBe('-3.25');
    expect(Number(pyNumber(0.1 + 0.2))).toBe(0.1 + 0.2);
  });

  it('writes the numbers that Python has no literal for', () => {
    expect(pyNumber(NaN)).toBe('float("nan")');
    expect(pyNumber(Infinity)).toBe('float("inf")');
    expect(pyNumber(-Infinity)).toBe('-float("inf")');
  });
});
