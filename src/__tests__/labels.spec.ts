import { labelRefs, namedBy, relabel, splitLabels } from '../model/labels';

describe('labels in texts', () => {
  const cells = [
    { id: 'a', label: '[4]' },
    { id: 'b', label: '[4b]' },
    { id: 'c', label: '[ ]' },
    // After a restart, a cell kept from the last run and a new one share [2].
    { id: 'old', label: '[2]' },
    { id: 'new', label: '[2]' }
  ];

  it('keeps the id of each cell that a text names', () => {
    expect(labelRefs('Does x change the result of [4]?', cells)).toEqual({
      '[4]': 'a'
    });
    expect(labelRefs('Compare [4] with [4b]', cells)).toEqual({
      '[4]': 'a',
      '[4b]': 'b'
    });
    expect(labelRefs('No cell named here', cells)).toBeUndefined();
  });

  it('names a shared label only when the text is about one of its cells', () => {
    expect(
      labelRefs('Does x change the result of [2]?', cells)
    ).toBeUndefined();
    expect(
      labelRefs('Does x change the result of [2]?', cells, ['new'])
    ).toEqual({ '[2]': 'new' });
  });

  it("shows each cell's current label, and keeps the label of a cell that is gone", () => {
    const refs = { '[4]': 'a', '[4b]': 'b' };
    const now: Record<string, string> = { a: '[8]', b: '[8b]' };
    expect(
      relabel('Does x change the result of [4]?', refs, id => now[id] ?? null)
    ).toBe('Does x change the result of [8]?');
    expect(relabel('Compare [4] with [4b]', refs, () => null)).toBe(
      'Compare [4] with [4b]'
    );
    expect(relabel('Compare [4] with [5]', refs, id => now[id] ?? null)).toBe(
      'Compare [8] with [5]'
    );
    expect(relabel('Unchanged [4]', undefined, () => '[9]')).toBe(
      'Unchanged [4]'
    );
  });

  it('leaves a subscript alone', () => {
    // It was taken for the label of cell [2], and rewritten as [5].
    expect(labelRefs('Is values[2] an outlier?', cells)).toBeUndefined();
    expect(relabel('values[2] and [2]', { '[2]': 'new' }, () => '[5]')).toBe(
      'values[2] and [5]'
    );
    expect(splitLabels('table[0][1] of [4], ([4b])')).toEqual([
      'table[0][1] of ',
      '[4]',
      ', (',
      '[4b]',
      ')'
    ]);
  });

  it('names the cell that the refs settle, or every cell that shows the label', () => {
    expect(
      namedBy('[2]', { '[2]': 'new' }, cells).map(cell => cell.id)
    ).toEqual(['new']);
    expect(namedBy('[2]', undefined, cells).map(cell => cell.id)).toEqual([
      'old',
      'new'
    ]);
    expect(namedBy('[4]', undefined, cells).map(cell => cell.id)).toEqual([
      'a'
    ]);
  });
});
