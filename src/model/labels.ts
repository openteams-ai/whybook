/**
 * Labels in texts. A cell's label is its execution count, "[4]", and it
 * changes each time the cell runs; after a restart two cells can share one.
 * A text that names cells, such as a question, keeps the id of each cell
 * beside the label it was written with, and shows the cell's current label.
 */

/**
 * A label in a text: "[4]", or "[4b]" for a branch. A subscript is not one:
 * "values[2]" and "table[0][1]" keep their brackets.
 */
export const LABEL = /(?<![\w\])])\[\d+[a-z]?\]/g;

/**
 * The text cut around its labels: "Does it change [4]?" gives
 * `["Does it change ", "[4]", "?"]`, with a label at each odd index.
 */
export function splitLabels(text: string): string[] {
  return text.split(/((?<![\w\])])\[\d+[a-z]?\])/g);
}

/** A cell with its current label. */
export interface ILabelled {
  id: string;
  label: string;
}

/**
 * The cells that the labels of a text name, as `{"[4]": id}`, among the
 * cells of the moment. A label that several cells share names the one the
 * text is about, among `about`, and otherwise nothing.
 */
export function labelRefs(
  text: string,
  cells: ILabelled[],
  about: (string | null | undefined)[] = []
): Record<string, string> | undefined {
  const refs: Record<string, string> = {};
  for (const label of new Set(text.match(LABEL) ?? [])) {
    const same = cells.filter(cell => cell.label === label);
    const named =
      same.find(cell => about.includes(cell.id)) ??
      (same.length === 1 ? same[0] : undefined);
    if (named) {
      refs[label] = named.id;
    }
  }
  return Object.keys(refs).length ? refs : undefined;
}

/**
 * The text with each label of `refs` replaced by the current label of its
 * cell. A label of a cell that is gone stays as it was written.
 */
export function relabel(
  text: string,
  refs: Record<string, string> | undefined,
  labelOf: (id: string) => string | null
): string {
  if (!refs) {
    return text;
  }
  return text.replace(LABEL, label => {
    const id = refs[label];
    return (id ? labelOf(id) : null) ?? label;
  });
}

/**
 * The cell that a label of a shown text names: through `refs`, the cell
 * whose current label it is, and otherwise the cells that show it. A label
 * that several cells show and `refs` do not settle gives them all.
 */
export function namedBy<T extends ILabelled>(
  label: string,
  refs: Record<string, string> | undefined,
  cells: T[]
): T[] {
  const same = cells.filter(cell => cell.label === label);
  const ids = new Set(Object.values(refs ?? {}));
  const named = same.filter(cell => ids.has(cell.id));
  return named.length === 1 ? named : same;
}
