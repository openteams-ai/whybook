import type { IDataLink } from '../model/datalinks';
import { dataLinks } from '../model/datalinks';

/** A code cell as dataLinks reads it: its source, and the names it uses and makes. */
function cell(index: number, source: string, uses: string[], defs: string[]) {
  return {
    id: `c${index}`,
    index,
    label: `[${index + 1}]`,
    title: source,
    analysis: { uses, defs },
    model: { sharedModel: { getSource: () => source } }
  };
}

const cells = [
  cell(
    0,
    'import pandas as pd\nfrom prep import drop_sparse',
    [],
    ['pd', 'drop_sparse']
  ),
  cell(1, 'diary = pd.read_csv("diary.csv")', ['pd'], ['diary']),
  cell(2, 'patients = pd.read_csv("patients.csv")', ['pd'], ['patients']),
  cell(
    3,
    'weekly = drop_sparse(diary).merge(patients)',
    ['diary', 'drop_sparse', 'patients'],
    ['weekly']
  ),
  cell(4, 'weekly.plot()', ['weekly'], []),
  cell(5, 'weekly = weekly.dropna()', ['weekly'], ['weekly']),
  cell(6, 'weekly.describe()', ['weekly'], []),
  cell(7, 'diary.head()', ['diary'], [])
];
const model = { codeCells: () => cells } as any;
const text = (links: IDataLink[]) =>
  links.map(link =>
    `${link.names.join(' ')}${link.imported ? ' imported' : ''}: ${link.cells.map(c => c.label).join(' ')}`.trim()
  );

describe('dataLinks', () => {
  it('groups the names a cell uses by the cell that makes or imports them', () => {
    const links = dataLinks(model, cells[3] as any);
    expect(text(links.uses)).toEqual([
      'drop_sparse imported: [1]',
      'diary: [2]',
      'patients: [3]'
    ]);
  });

  it('lists the readers of a name up to the cell that makes it again', () => {
    // [6] reads weekly and makes it again; [7] reads the new one.
    expect(text(dataLinks(model, cells[3] as any).defines)).toEqual([
      'weekly: [5] [6]'
    ]);
    expect(text(dataLinks(model, cells[1] as any).defines)).toEqual([
      'diary: [4] [8]'
    ]);
    expect(text(dataLinks(model, cells[6] as any).defines)).toEqual([]);
  });

  it('keeps the imports of a cell as one group, with the cells that read them', () => {
    expect(text(dataLinks(model, cells[0] as any).defines)).toEqual([
      'pd drop_sparse imported: [2] [3] [4]'
    ]);
  });

  it('groups the names that no later cell reads', () => {
    const last = cell(8, 'a = 1\nb = a + 1', ['a'], ['a', 'b']);
    const links = dataLinks(
      { codeCells: () => [...cells, last] } as any,
      last as any
    );
    // The cell reads a, but a is its own: no use.
    expect(text(links.uses)).toEqual([]);
    expect(text(links.defines)).toEqual(['a b:']);
  });

  it('lists last the names that no cell makes', () => {
    const lone = cell(8, 'print(MIN_DAYS, diary)', ['MIN_DAYS', 'diary'], []);
    const links = dataLinks(
      { codeCells: () => [...cells, lone] } as any,
      lone as any
    );
    expect(text(links.uses)).toEqual(['diary: [2]', 'MIN_DAYS:']);
  });
});
