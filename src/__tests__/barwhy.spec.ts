/**
 * The question "Why is arm B higher than the other bars?" about a picked bar
 * (`_barOptions` in src/model/epimodel.ts): it compares the bar with the
 * other bars as whybook.bars drew them (whybook/plots.py).
 */
import type { IPlotPayload } from '../tokens';
import { fakeModel } from './fakes/model-fake';

function barsOf(
  bars: { x: string; y: number; n: number }[],
  y: string | null
): IPlotPayload {
  return {
    version: 1,
    kind: 'bars',
    title: y ? `Mean ${y} by arm` : 'Rows by arm',
    x: { field: 'arm', label: 'arm' },
    y: y ? { field: y, label: y } : null,
    source: { frame: 'visits', x: 'arm', y, by: null, rows: 14 },
    select: 'x',
    bars
  };
}

/** The text of the "why" question about the bar of one arm. */
function why(plot: IPlotPayload, arm: string): string | undefined {
  const { model } = fakeModel([{ id: 'c1', count: 1 }]);
  const options = model._barOptions(
    {
      kind: 'region',
      cellId: 'c1',
      plot,
      x0: 0,
      x1: 0,
      values: [arm],
      y: null,
      summary: null,
      options: []
    },
    undefined
  );
  return options.find((option: { id: string }) => option.id.endsWith(':why'))
    ?.text;
}

describe('the question about a picked bar', () => {
  it('compares a mean with the rows of the other bars that have a value', () => {
    // Arm A: pain 4, 6 and 8 rows with no pain; B: 5, 7; C: 7, 9. whybook.bars
    // counts the rows behind each mean. B's 6 is below the 6.5 of A and C.
    const plot = barsOf(
      [
        { x: 'A', y: 5, n: 2 },
        { x: 'B', y: 6, n: 2 },
        { x: 'C', y: 8, n: 2 }
      ],
      'pain'
    );
    expect(why(plot, 'B')).toBe('Why is arm B lower than the other bars?');
  });

  it('compares a count with the counts of the other bars', () => {
    // B has more rows than three of the four other arms, and fewer than A.
    const plot = barsOf(
      [
        { x: 'A', y: 12, n: 12 },
        { x: 'B', y: 5, n: 5 },
        { x: 'C', y: 1, n: 1 },
        { x: 'D', y: 1, n: 1 },
        { x: 'E', y: 1, n: 1 }
      ],
      null
    );
    expect(why(plot, 'B')).toBe('Why is arm B higher than the other bars?');
  });
});
