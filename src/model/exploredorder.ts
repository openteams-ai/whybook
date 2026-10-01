/**
 * The order of the rows of "Variables explored", in the Exploration panel
 * (design iteration 1.82). No model takes part: the view orders the frames
 * by what it counts itself, how many cells use each one and how large it is.
 */

/** The orders, as the setting `exploredOrder` names them. */
export type ExploredOrder = 'auto' | 'used' | 'size' | 'name';

export interface IExploredOrder {
  id: ExploredOrder;
  /** Its name in the head's menu and in the settings editor. */
  title: string;
  /** What comes first, in a few words: the line of its card in the settings editor. */
  caption: string;
}

/** The orders, with the titles and the lines of their choices in schema/plugin.json. */
export const EXPLORED_ORDERS: readonly IExploredOrder[] = [
  {
    id: 'auto',
    title: 'Auto',
    caption: 'The most used first, then the largest'
  },
  { id: 'used', title: 'Most used', caption: 'Used by the most cells first' },
  { id: 'size', title: 'Largest', caption: 'The biggest tables first' },
  { id: 'name', title: 'By name', caption: 'From A to Z' }
];

/** The order of this id, and Auto for any other value. */
export function exploredOrder(value: unknown): IExploredOrder {
  return (
    EXPLORED_ORDERS.find(order => order.id === value) ?? EXPLORED_ORDERS[0]
  );
}

/** What the orders compare in a row of Variables explored. */
export interface IExploredKeys {
  /** The frame's name; null in the row of the derived variables. */
  name: string | null;
  /** How many code cells use the frame. */
  cells: number;
  /** The frame's rows times its columns. */
  size: number;
}

type Compare = (a: IExploredKeys, b: IExploredKeys) => number;

const byUse: Compare = (a, b) => b.cells - a.cells;
const bySize: Compare = (a, b) => b.size - a.size;
const byName: Compare = (a, b) =>
  (a.name ?? '').localeCompare(b.name ?? '', undefined, {
    numeric: true,
    sensitivity: 'base'
  });

const COMPARE: Record<ExploredOrder, Compare> = {
  // The most used first; of those used by as many cells, the largest.
  auto: (a, b) => byUse(a, b) || bySize(a, b),
  used: byUse,
  size: bySize,
  name: byName
};

/**
 * The rows in this order. Rows that the order ranks the same keep the order
 * of the notebook, and the row of the derived variables stays last.
 */
export function orderExplored<T extends IExploredKeys>(
  rows: readonly T[],
  order: ExploredOrder
): T[] {
  const compare = COMPARE[order];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const derived = Number(a.row.name === null) - Number(b.row.name === null);
      return derived || compare(a.row, b.row) || a.index - b.index;
    })
    .map(entry => entry.row);
}
