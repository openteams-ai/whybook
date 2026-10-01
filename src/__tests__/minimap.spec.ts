import { minimapSizes } from '../ui/minimap';

/** The height of the minimap with these sizes, as base.css lays it out. */
function height(bands: number[], limit: number, title = 0): number {
  const sizes = minimapSizes(bands, limit, title);
  return (
    12 +
    title +
    bands.reduce(
      (total, cells) =>
        total +
        cells * sizes.bar +
        Math.max(0, cells - 1) * sizes.gap +
        2 * sizes.padding,
      0
    ) +
    Math.max(0, bands.length - 1) * sizes.bandGap
  );
}

describe('minimapSizes', () => {
  it('keeps the full sizes when the notebook fits', () => {
    // Three sections of 3, 1 and 2 cells: 74 px in all.
    expect(minimapSizes([3, 1, 2], 120)).toEqual({
      bar: 6,
      gap: 2,
      padding: 2,
      bandGap: 4
    });
    expect(height([3, 1, 2], 120)).toBe(74);
  });

  it('scales every part by the same factor down to half size', () => {
    const sizes = minimapSizes([3, 1, 2], 67);
    expect(sizes.bar).toBeCloseTo(6 * (53 / 60));
    expect(sizes.gap).toBeCloseTo(2 * (53 / 60));
    expect(height([3, 1, 2], 67)).toBeCloseTo(67);
  });

  it('makes a block of each section below half size, and keeps the limit', () => {
    // 80 cells in 10 sections would be 708 px at full size.
    const bands = Array(10).fill(8);
    const sizes = minimapSizes(bands, 120);
    expect(sizes.gap).toBe(0);
    expect(sizes.bandGap).toBe(3);
    expect(sizes.bar).toBeCloseTo((120 - 12 - 20 - 27) / 80);
    expect(height(bands, 120)).toBeCloseTo(120);
  });

  it('keeps the limit and draws every bar when a notebook has many sections', () => {
    // Five copies of the later demo: 95 code cells in 40 sections, where the
    // gaps between the blocks alone took 209 px and the bars got 0 px.
    const bands = Array(5).fill([1, 3, 2, 3, 4, 2, 3, 1]).flat();
    const sizes = minimapSizes(bands, 120);
    expect(height(bands, 120)).toBeCloseTo(120);
    expect(sizes.bar).toBeCloseTo(54 / 95);
    expect(sizes.bandGap).toBeGreaterThan(0);
    // Pointed at, 60% of an 879 px bench: the blocks keep their gaps.
    expect(height(bands, 527, 18)).toBeCloseTo(527);
    expect(minimapSizes(bands, 527, 18).bandGap).toBe(3);
  });

  it('leaves room for the title when it shows', () => {
    const bands = Array(10).fill(8);
    expect(height(bands, 500, 18)).toBeCloseTo(500);
    expect(minimapSizes(bands, 500, 18).gap).toBeGreaterThan(1);
  });

  it('keeps the full sizes for a notebook without code', () => {
    expect(minimapSizes([], 120).bar).toBe(6);
    expect(minimapSizes([0, 0], 120).bar).toBe(6);
  });
});
